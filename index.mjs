// Amazon Bedrock for magpie (and OpenCode), signed with AWS SigV4 from an AWS
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

async function server() {
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
      methods: [
        {
          type: "oauth",
          label: "AWS SSO profile (aws sso login)",
          prompts: [
            profilePrompt,
            { type: "text", key: "region", message: "Bedrock region (blank: the profile's, else us-west-2)", placeholder: DEFAULT_REGION, validate: (v) => (!v || REGION.test(v) ? undefined : "Like us-west-2") },
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

export const _internal = { ID, server }
export default { id: ID, server }
