// Which Bedrock models the profile can call, and how magpie should speak to
// each. Claude goes over Bedrock's Anthropic Messages endpoint. OpenAI models
// are spoken to as chat completions, which the plugin runs on Converse
// (lib/converse.mjs).
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { signRequest } from "./sigv4.mjs"

// Magpie maintains a models.dev cache. Unknown models keep unknown prices.
export async function cachedMetadata() {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  try {
    const data = JSON.parse(await readFile(join(root, "magpie", "models.json"), "utf8"))
    return data["amazon-bedrock"]?.models ?? {}
  } catch {
    return {}
  }
}

export const runtimeHost = (region) => `bedrock-runtime.${region}.amazonaws.com`
export const anthropicBase = (region) => `https://${runtimeHost(region)}/anthropic/v1`
export const openaiBase = (region) => `https://${runtimeHost(region)}/openai/v1`

// What magpie lists before anyone signs in, and if the catalog can't be read.
export const SEED = [
  "us.anthropic.claude-opus-5-5",
  "us.anthropic.claude-sonnet-5-5",
  "us.anthropic.claude-haiku-5-5",
  "us.openai.gpt-6-sol",
  "us.openai.gpt-6-luna",
]

// The geography prefix of cross-region inference profiles for a region.
export function geoOf(region) {
  if (/^us-gov-/.test(region)) return "us-gov"
  const r = region.split("-")[0]
  return { us: "us", ca: "ca", eu: "eu", ap: "apac", sa: "sa" }[r] ?? r
}

function title(id) {
  const bare = id.replace(/^(us|eu|apac|jp|au|global)\./, "").replace(/^(anthropic|openai)\./, "")
  return bare
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/-(\d{8})$/, "")
    .split("-")
    .map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2")
    .replace(/^Gpt/, "GPT")
}

export function isClaude(id) {
  return /(^|\.)anthropic\.claude-/.test(id)
}
export function isOpenAI(id) {
  return /(^|\.)openai\.gpt-/.test(id)
}

/** One model entry in OpenCode's config shape. */
export function modelEntry(id, region, metadata = {}) {
  const catalog = metadata[id] ?? {}
  const name = title(id) + (id.startsWith("global.") ? " (global)" : "")
  if (isClaude(id)) {
    const modern = /claude-[a-z]+-[5-9]/.test(id) // the 5 family and later: 1M context
    return {
      name,
      limit: catalog.limit ?? (modern ? { context: 1_000_000, output: 128_000 } : { context: 200_000, output: 64_000 }),
      ...(catalog.cost ? { cost: catalog.cost } : {}),
      reasoning: catalog.reasoning ?? !/claude-3/.test(id),
      tool_call: catalog.tool_call ?? true,
      attachment: catalog.attachment ?? true,
      modalities: catalog.modalities ?? { input: ["text", "image"], output: ["text"] },
      ...(!/claude-3/.test(id) ? { variants: Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((e) => [e, { reasoningEffort: e }])) } : {}),
    }
  }
  return {
    name,
    limit: catalog.limit ?? (/gpt-6/.test(id) ? { context: 1_050_000, output: 128_000 } : { context: 400_000, output: 128_000 }),
    ...(catalog.cost ? { cost: catalog.cost } : {}),
    reasoning: catalog.reasoning ?? true,
    tool_call: catalog.tool_call ?? true,
    attachment: catalog.attachment ?? true,
    modalities: catalog.modalities ?? { input: ["text", "image"], output: ["text"] },
    variants: Object.fromEntries(gptEfforts(id).map((e) => [e, { reasoningEffort: e }])),
    // Chat completions, which the plugin's fetch runs on Converse.
    provider: { npm: "@ai-sdk/openai-compatible", api: openaiBase(region) },
  }
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]

// What Bedrock takes as reasoning.effort: GPT-6 can't turn reasoning off but
// goes to max, GPT-5 can and stops at xhigh.
export function gptEfforts(id) {
  return /gpt-([6-9]|\d{2,})/.test(id) ? ["low", "medium", "high", "xhigh", "max"] : ["none", "low", "medium", "high", "xhigh"]
}

/**
 * The same model as OpenCode's runtime Model, the shape a provider.models
 * hook hands back (the config shape's provider.{npm,api} is not read there).
 */
export function runtimeModel(id, region, metadata = {}) {
  const c = modelEntry(id, region, metadata)
  const claude = isClaude(id)
  const efforts = c.reasoning ? (claude ? CLAUDE_EFFORTS : gptEfforts(id)) : []
  return {
    id,
    name: c.name,
    api: claude ? { id, url: anthropicBase(region), npm: "@ai-sdk/anthropic" } : { id, url: openaiBase(region), npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: c.cost?.input ?? 0, output: c.cost?.output ?? 0, cache: { read: c.cost?.cache_read ?? 0, write: c.cost?.cache_write ?? 0 } },
    limit: { context: c.limit.context, input: c.limit.input, output: c.limit.output },
    capabilities: {
      temperature: metadata[id]?.temperature ?? false,
      reasoning: c.reasoning,
      attachment: c.attachment,
      toolcall: c.tool_call,
      input: { text: true, image: c.modalities.input?.includes("image") ?? false, audio: false, video: false, pdf: claude && (c.modalities.input?.includes("pdf") ?? false) },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
  }
}

export function seedModels(region, metadata = {}) {
  return Object.fromEntries(SEED.map((id) => [id, modelEntry(id, region, metadata)]))
}

/**
 * The system-defined inference profiles the profile can see, as models.
 * Only Claude and OpenAI chat models, in the region's geography or global,
 * in the runtime shape a provider.models hook returns.
 */
export async function listModels(creds, region, { fetchImpl = fetch, metadata } = {}) {
  metadata ??= await cachedMetadata()
  const geo = geoOf(region)
  const prefixes = new Set([geo, "global"])
  if (region === "ap-northeast-1") prefixes.add("jp")
  if (region === "ap-southeast-2") prefixes.add("au")
  const out = {}
  let next = ""
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://bedrock.${region}.amazonaws.com/inference-profiles`)
    url.searchParams.set("maxResults", "1000")
    url.searchParams.set("type", "SYSTEM_DEFINED")
    if (next) url.searchParams.set("nextToken", next)
    const headers = signRequest({ method: "GET", url, headers: { accept: "application/json" } }, creds, { region, service: "bedrock" })
    const res = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) })
    if (!res.ok) {
      const err = new Error(`Bedrock ListInferenceProfiles answered ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    for (const p of body.inferenceProfileSummaries ?? []) {
      const id = p.inferenceProfileId
      if (typeof id !== "string") throw new Error("Bedrock returned an inference profile without an ID")
      if (p.status && p.status !== "ACTIVE") continue
      if (![...prefixes].some((prefix) => id.startsWith(prefix + "."))) continue
      if (!isClaude(id) && !isOpenAI(id)) continue
      if (/claude-(instant|v2|3-)/.test(id)) continue // retired families
      out[id] = runtimeModel(id, region, metadata)
    }
    if (!body.nextToken) {
      next = ""
      break
    }
    next = body.nextToken
  }
  if (next) throw new Error("Bedrock inference profiles exceeded the page limit")
  if (!Object.keys(out).length) throw new Error("Bedrock listed no Claude or OpenAI inference profiles")
  // The region's own profiles before global ones, newest-looking ids first.
  const rank = (id) => (id.startsWith("global.") ? 1 : 0)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => rank(a) - rank(b) || b.localeCompare(a, "en", { numeric: true })))
}
