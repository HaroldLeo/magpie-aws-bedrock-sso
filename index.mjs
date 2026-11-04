// Amazon Bedrock for Magpie, signed with AWS SigV4 from an AWS
// SSO / IAM Identity Center profile. Unlike magpie's built-in Bedrock preset,
// it needs no Bedrock API key, so it works for roles that lack
// bedrock:CallWithBearerToken.
//
//   Claude  -> https://bedrock-runtime.<region>.amazonaws.com/anthropic/v1/messages
//   OpenAI  -> magpie speaks chat completions; the plugin sends them to
//              https://bedrock-runtime.<region>.amazonaws.com/model/<id>/converse[-stream]
import { fromConverse, openaiError, streamChat, toConverse } from "./lib/converse.mjs"
import { callerArn, credentialsFor, forget, listProfiles, profileRegion, SignInExpired, ssoLogin } from "./lib/credentials.mjs"
import { anthropicBase, cachedMetadata, listModels, seedModels, isSupportedGpt } from "./lib/models.mjs"
import { signRequest } from "./lib/sigv4.mjs"
import { billedDays, budgetOf, monthStart, priceUsage, tokenUsage, usageWindows, weekStart } from "./lib/spend.mjs"
import { spendStore } from "./lib/store.mjs"

const ID = "bedrock-sso"
const DEFAULT_REGION = "us-west-2"
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/
const PROFILE = /^[A-Za-z0-9_.@+=-]{1,128}$/

// These are the incoming SDK routes served by the plugin.
const ROUTES = [/^\/anthropic\/v1\/messages(\/count_tokens)?$/, /^\/openai\/v1\/chat\/completions$/]

function settingsOf(auth) {
  const profile = auth?.profile || process.env.AWS_PROFILE || "default"
  const region = auth?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION
  if (!PROFILE.test(profile)) throw new Error(`"${profile}" isn't an AWS profile name`)
  if (!REGION.test(region)) throw new Error(`"${region}" isn't an AWS region`)
  return { profile, region }
}

function errorResponse(status, message, signIn) {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "invalid_request_error", message } }), { status, headers })
}

// Only headers needed by the Anthropic endpoint may leave the plugin.
const ALLOWED_CLAUDE_HEADERS = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent", "x-request-id"])
function claudeHeaders(headers) {
  return new Headers([...headers].filter(([name]) => ALLOWED_CLAUDE_HEADERS.has(name)))
}

// A GPT chat completion, run on Converse and answered as chat completions.
async function gptChat(request, body, settings) {
  let chat
  try {
    chat = JSON.parse(body)
  } catch {
    return new Response(openaiError(400, "a request that isn't JSON"), { status: 400, headers: { "content-type": "application/json" } })
  }
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) {
    return new Response(openaiError(400, "Expected a JSON object"), { status: 400, headers: { "content-type": "application/json" } })
  }
  if (chat.stream != null && typeof chat.stream !== "boolean") {
    return new Response(openaiError(400, "stream must be a boolean"), { status: 400, headers: { "content-type": "application/json" } })
  }
  const model = chat.model
  if (!isSupportedGpt(model)) {
    return new Response(openaiError(400, "Unsupported model ID"), { status: 400, headers: { "content-type": "application/json" } })
  }
  const url = new URL(`https://bedrock-runtime.${settings.region}.amazonaws.com/model/${encodeURIComponent(model)}/${chat.stream ? "converse-stream" : "converse"}`)
  const headers = { "content-type": "application/json", accept: chat.stream ? "application/vnd.amazon.eventstream" : "application/json" }
  let converse
  try {
    converse = toConverse(chat)
  } catch (error) {
    return new Response(openaiError(400, error.message), { status: 400, headers: { "content-type": "application/json" } })
  }
  const res = await signedFetch(new Request(url, { method: "POST", headers, signal: request.signal }), JSON.stringify(converse), settings)
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      const j = JSON.parse(text)
      message = j.message ?? j.Message ?? j.error?.message ?? text
    } catch {}
    const out = { "content-type": "application/json" }
    const requestId = res.headers.get("x-amzn-requestid")
    if (requestId) out["x-amzn-requestid"] = requestId
    const retryAfter = res.headers.get("retry-after")
    if (retryAfter) out["retry-after"] = retryAfter
    const signIn = res.headers.get("X-Magpie-Sign-In")
    if (signIn) out["X-Magpie-Sign-In"] = signIn
    return new Response(openaiError(res.status, message, res.headers.get("x-amzn-errortype")?.split(":")[0]), { status: res.status, headers: out })
  }
  if (chat.stream) return new Response(streamChat(res.body, model, request.signal, chat.stream_options?.include_usage === true), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  return new Response(JSON.stringify(fromConverse(await res.json(), model)), { status: 200, headers: { "content-type": "application/json" } })
}

async function signedFetch(request, body, settings, retried = false) {
  let creds
  try {
    creds = await credentialsFor(settings.profile)
  } catch (error) {
    if (error instanceof SignInExpired) return errorResponse(401, error.message, "expired")
    return errorResponse(502, error.message)
  }
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  headers.delete("authorization")
  headers.delete("x-amz-security-token")
  headers.delete("x-amz-date")
  headers.delete("x-amz-content-sha256")
  // Bun's fetch decodes gzip but keeps content-encoding; ask for none.
  headers.set("accept-encoding", "identity")
  if (body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const signed = signRequest({ method: request.method, url, headers, body }, creds, { region: settings.region, service: "bedrock" })
  const res = await fetch(url, { method: request.method, headers: signed, body: body || undefined, signal: request.signal, redirect: "error" })

  // Role credentials can run out between our cache check and AWS's: once,
  // forget them and sign again.
  if (res.status === 403 && !retried) {
    const text = await res.text()
    if (/ExpiredToken|security token included in the request is expired/i.test(text)) {
      forget(settings.profile)
      return signedFetch(request, body, settings, true)
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  return res
}

// Cost Explorer charges for each call, so its reading is kept this long.
const BILLED_TTL_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// The provider editor's switches (magpie's own, read with
// input.magpie.option). Both are off unless the user turns them on.
const SWITCHES = {
  enforce: "stop_at_budget",
  billed: "billed_totals",
}

// magpie's usage reading for one account: this week's spend estimated from
// CloudWatch token counts and, when asked for, what Cost Explorer has
// billed. Readings are kept in memory and on disk (store), so restarts and
// other magpie processes reuse them; each source is refreshed on its own
// and fails on its own, keeping its last good reading.
function spendReader({ fetchImpl = fetch, now = () => new Date(), credentials = credentialsFor, metadata = cachedMetadata, store = spendStore() } = {}) {
  const pending = new Map() // key -> a reading in flight, shared by callers
  return async function read(settings, options = {}) {
    const budget = budgetOf(options)
    const at = now()
    const regions = budget.regions ?? [settings.region]
    const start = weekStart(at, budget.week)
    const key = JSON.stringify([settings.profile, regions, start.toISOString()])
    const wantEstimate = options.estimate !== false
    const wantBilled = options.billed === true
    const fresh = (t, ttl) => t && at.getTime() - t >= 0 && at.getTime() - t < ttl

    const refresh = async () => {
      const entry = { ...((await store.get(key)) ?? {}) }
      const needEstimate = wantEstimate && !fresh(entry.estimateAt, budget.refreshMs)
      const needBilled = wantBilled && !fresh(entry.billedAt, BILLED_TTL_MS)
      if (!needEstimate && !needBilled) return { entry, problems: [] }
      let creds
      try {
        creds = await credentials(settings.profile)
      } catch (error) {
        return { entry, problems: [], signInError: error }
      }
      const problems = []
      const retry = async (fn) => {
        try {
          return await fn(creds)
        } catch (error) {
          if (!error.expiredCredentials) throw error
          forget(settings.profile)
          creds = await credentials(settings.profile)
          return fn(creds)
        }
      }
      if (needEstimate) {
        try {
          const usage = {}
          for (const region of regions) {
            for (const [model, u] of Object.entries(await retry((c) => tokenUsage(c, region, { start, end: at, fetchImpl })))) {
              const sum = (usage[model] ??= { all: {}, long: {} })
              for (const part of ["all", "long"]) for (const [k, v] of Object.entries(u[part])) sum[part][k] = (sum[part][k] ?? 0) + v
            }
          }
          const priced = priceUsage(usage, await metadata())
          entry.estimate = { usd: priced.usd, unpriced: priced.unpriced }
          entry.estimateAt = at.getTime()
        } catch (error) {
          problems.push(`token metrics: ${error.message}`)
        }
      }
      if (needBilled) {
        try {
          const from = new Date(Math.min(monthStart(at).getTime(), start.getTime()))
          entry.billed = await retry((c) => billedDays(c, { start: from, end: new Date(at.getTime() + DAY_MS), fetchImpl }))
          entry.billedAt = at.getTime()
        } catch (error) {
          problems.push(`Cost Explorer: ${error.message}`)
        }
      }
      if (entry.estimateAt || entry.billedAt) await store.set(key, entry)
      return { entry, problems }
    }

    // Readings asked for at once (magpie's card and its routing) share one
    // trip to AWS.
    let job = pending.get(key)
    if (!job) {
      job = refresh().finally(() => pending.delete(key))
      pending.set(key, job)
    }
    const { entry, problems, signInError } = await job
    const estimate = wantEstimate ? entry.estimate : undefined
    const billed = wantBilled ? entry.billed : undefined
    if (signInError && !estimate && !billed) {
      return { error: signInError.message, windows: [], signIn: signInError instanceof SignInExpired ? "expired" : "kept" }
    }
    const windows = usageWindows({ now: at, budget, estimate, billed, enforce: options.enforce === true })
    if (!windows.length && problems.length) return { error: problems.join("; "), windows: [], signIn: "kept" }
    if (problems.length) windows.push({ name: "Not read", display: problems.join("; "), aside: true })
    // A setting that can't be read is left at its default, and said so.
    if (budget.problems.length) windows.push({ name: "Options", display: `not used: ${budget.problems.join("; ")}`, aside: true })
    return { windows, signIn: signInError instanceof SignInExpired ? "expired" : "kept" }
  }
}

// The budget answers a sign-in keeps on the account (the sign-in questions
// below), as the option names budgetOf reads.
function budgetFromAuth(auth = {}) {
  const out = {}
  if (auth.weeklyBudget !== undefined && auth.weeklyBudget !== "") out.weeklyBudget = auth.weeklyBudget
  if (auth.weekResetDay) out.weekResetDay = auth.weekResetDay
  if (auth.weekResetHour !== undefined && auth.weekResetHour !== "") out.weekResetHour = auth.weekResetHour
  return out
}

// Sign-in questions for an optional budget. The reset is asked only once a
// budget is given.
const BUDGET_PROMPTS = [
  {
    type: "text",
    key: "weeklyBudget",
    message: "Weekly Bedrock budget in US$ (optional, blank for none)",
    placeholder: "none",
    validate: (v) => (!v || budgetOf({ weeklyBudget: v }).weekly ? undefined : "An amount like 200, or blank"),
  },
  {
    type: "select",
    key: "weekResetDay",
    message: "The budget's week starts on (UTC)",
    when: { key: "weeklyBudget", op: "neq", value: "" },
    options: ["mon", "sun", "sat", "tue", "wed", "thu", "fri"].map((d) => ({ label: { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" }[d], value: d })),
  },
  {
    type: "text",
    key: "weekResetHour",
    message: "At this hour, UTC (0-23)",
    placeholder: "0",
    when: { key: "weeklyBudget", op: "neq", value: "" },
    validate: (v) => (!v || /^(\d|1\d|2[0-3])$/.test(String(v).trim()) ? undefined : "A whole hour from 0 to 23"),
  },
]

async function server(input, pluginOptions) {
  const readSpend = spendReader()
  // A provider-editor switch as the user set it; off outside magpie.
  const on = (key) => {
    try {
      return input?.magpie?.option?.(ID, key) === true
    } catch {
      return false
    }
  }
  // The usage settings, later ones winning: the account's sign-in answers,
  // the plugin's JSON options (`magpie plugin options …`, for the rest),
  // then the editor's switches.
  const usageOptions = (auth) => {
    const json = pluginOptions && typeof pluginOptions === "object" && !Array.isArray(pluginOptions) ? pluginOptions : {}
    // A blank JSON value (the Options example's null) leaves the account's own.
    const set = Object.fromEntries(Object.entries(json).filter(([, v]) => v !== null && v !== undefined && v !== ""))
    const out = { ...budgetFromAuth(auth), ...set }
    if (on(SWITCHES.enforce)) out.enforce = true
    if (on(SWITCHES.billed)) out.billed = true
    return out
  }
  // The sign-in offers profile sections from both AWS files.
  const profiles = await listProfiles()
  const envProfile = process.env.AWS_PROFILE
  const ordered = envProfile && profiles.includes(envProfile) ? [envProfile, ...profiles.filter((p) => p !== envProfile)] : profiles

  const profilePrompt = ordered.length
    ? { type: "select", key: "profile", message: "AWS profile (config or credentials file)", options: ordered.map((p) => ({ label: p, value: p })) }
    : { type: "text", key: "profile", message: "AWS profile (config or credentials file)", placeholder: "default", validate: (v) => (!v || PROFILE.test(v) ? undefined : "Not a profile name") }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const p = (cfg.provider[ID] ??= {})
      p.name ??= "AWS Bedrock SSO"
      p.npm ??= "@ai-sdk/anthropic"
      p.api ??= anthropicBase(DEFAULT_REGION)
      p.models = { ...seedModels(DEFAULT_REGION, await cachedMetadata()), ...(p.models ?? {}) }
    },

    provider: {
      id: ID,
      // What this account's role can see in its region.
      async models(provider, { auth } = {}) {
        if (!auth) return provider?.models ?? {}
        const settings = settingsOf(auth)
        const creds = await credentialsFor(settings.profile)
        return listModels(creds, settings.region)
      },
    },

    auth: {
      provider: ID,
      // magpie's own hook: what the account has spent on Bedrock.
      async usage(getAuth) {
        let auth
        let settings
        try {
          auth = await getAuth()
          if (!auth) return { windows: [] }
          settings = settingsOf(auth)
        } catch (error) {
          return { error: error.message, windows: [], signIn: "kept" }
        }
        const opts = usageOptions(auth)
        if (opts.usage === false) return { windows: [] }
        return readSpend(settings, opts)
      },
      // magpie's own switches, in the provider's editor. Off by default.
      options: [
        {
          key: SWITCHES.enforce,
          label: "Stop at weekly budget",
          description: "Once this week's estimated spend reaches the weekly budget, magpie moves requests to your fallbacks until the week resets. Off: the budget is shown only. Set the budget when you sign in, or in the plugin's Options.",
        },
        {
          key: SWITCHES.billed,
          label: "Billed totals from Cost Explorer",
          description: "Shows what AWS has billed this week and month. AWS charges $0.01 for each Cost Explorer call; the plugin calls it at most every 6 hours, about $1.20 a month. Needs ce:GetCostAndUsage.",
          confirm: "AWS charges the account $0.01 for each Cost Explorer call. The plugin calls it at most every 6 hours, about $1.20 a month.",
        },
      ],
      methods: [
        {
          type: "oauth",
          label: "AWS SSO profile (aws sso login)",
          prompts: [
            profilePrompt,
            { type: "text", key: "region", message: "Bedrock region (blank: the profile's, else us-west-2)", placeholder: DEFAULT_REGION, validate: (v) => (!v || REGION.test(v) ? undefined : "Like us-west-2") },
            ...BUDGET_PROMPTS,
          ],
          async authorize(inputs = {}) {
            const profile = inputs.profile || envProfile || "default"
            const region = inputs.region || (await profileRegion(profile)) || DEFAULT_REGION
            const settings = settingsOf({ profile, region })
            return {
              method: "auto",
              instructions: `Uses the AWS CLI's SSO sign-in for profile "${settings.profile}" (${settings.region}). If its session has run out, the AWS sign-in page opens in your browser; approve it there.`,
              async callback() {
                try {
                  try {
                    await credentialsFor(settings.profile)
                  } catch (error) {
                    if (!(error instanceof SignInExpired)) throw error
                    await ssoLogin(settings.profile)
                    await credentialsFor(settings.profile)
                  }
                  const arn = await callerArn(settings.profile).catch(() => "")
                  const who = arn.split("/").pop() || settings.profile
                  const account = arn.split(":")[4]
                  return {
                    type: "success",
                    access: "",
                    refresh: "",
                    expires: 0, // no token for auth.refresh; AWS creds stay in-process
                    accountId: account ? `${who} (${account})` : who,
                    profile: settings.profile,
                    region: settings.region,
                    // the optional budget, kept with the account
                    ...budgetFromAuth({
                      weeklyBudget: typeof inputs.weeklyBudget === "string" ? inputs.weeklyBudget.trim() : undefined,
                      weekResetDay: inputs.weeklyBudget ? inputs.weekResetDay : undefined,
                      weekResetHour: inputs.weeklyBudget && typeof inputs.weekResetHour === "string" ? inputs.weekResetHour.trim() : undefined,
                    }),
                  }
                } catch (error) {
                  return { type: "failed", error: error.message }
                }
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        const settings = settingsOf(auth)
        return {
          // No baseURL: Claude models use the provider's api (Anthropic
          // Messages), OpenAI models their own provider.api (chat completions,
          // which gptChat runs on Converse).
          apiKey: "aws-sigv4",
          async fetch(input, init) {
            let request
            try {
              request = new Request(input, init)
            } catch {
              return errorResponse(400, "Invalid request URL or options")
            }
            const url = new URL(request.url)
            if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || !/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) return errorResponse(400, "Refusing to sign an untrusted Bedrock destination")
            if (request.method !== "POST") return errorResponse(405, "Only POST requests are supported")
            if (!ROUTES.some((r) => r.test(url.pathname))) return errorResponse(404, `AWS Bedrock SSO doesn't serve ${url.pathname}`)
            // The account's region, whatever region the seed list was written for.
            url.hostname = `bedrock-runtime.${settings.region}.amazonaws.com`
            const body = request.body ? await request.text() : ""
            if (url.pathname.startsWith("/openai/")) return gptChat(request, body, settings)
            return signedFetch(new Request(url, { method: request.method, headers: claudeHeaders(request.headers), signal: request.signal }), body, settings)
          },
        }
      },
    },
  }
}

export const _internal = { ID, server, spendReader, budgetFromAuth, SWITCHES }
export default { id: ID, server }
