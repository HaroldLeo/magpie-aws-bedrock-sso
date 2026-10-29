import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin, { _internal } from "../index.mjs"
import * as entry from "../index.mjs"
import { forget, SignInExpired } from "../lib/credentials.mjs"
import { geoOf, modelEntry, runtimeModel } from "../lib/models.mjs"
import { signRequest } from "../lib/sigv4.mjs"

const auth = { type: "success", profile: "nobody", region: "us-west-2" }
const server = plugin.server

test("the entry is one OpenCode v1 plugin; helpers live on _internal", () => {
  assert.equal(plugin.id, "bedrock-sso")
  assert.equal(typeof plugin.server, "function")
  assert.equal(_internal.server, plugin.server)
  assert.equal(_internal.ID, "bedrock-sso")
  assert.equal(typeof plugin, "object")
  assert.deepEqual(Object.values(entry).filter((v) => typeof v === "function"), [])
})

test("config seeds Claude on Messages and GPT on chat completions", async () => {
  const p = await server({})
  const cfg = {}
  await p.config(cfg)
  const prov = cfg.provider["bedrock-sso"]
  assert.equal(prov.npm, "@ai-sdk/anthropic")
  assert.match(prov.api, /\/anthropic\/v1$/)
  assert.equal(prov.models["us.openai.gpt-6-luna"].provider.npm, "@ai-sdk/openai-compatible")
  assert.match(prov.models["us.openai.gpt-6-luna"].provider.api, /\/openai\/v1$/)
})

test("the loader refuses other hosts and routes before signing anything", async () => {
  const p = await server({})
  const l = await p.auth.loader(async () => auth)
  assert.equal((await l.fetch("https://example.com/anthropic/v1/messages", { method: "POST", body: "{}" })).status, 400)
  assert.equal((await l.fetch("https://bedrock-runtime.us-west-2.amazonaws.com/model/x/invoke", { method: "POST", body: "{}" })).status, 404)
  assert.equal((await l.fetch("https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/responses", { method: "POST", body: "{}" })).status, 404)
})

test("model names, limits and runtime shape", () => {
  assert.equal(modelEntry("us.anthropic.claude-opus-4-1-20250805-v1:0", "us-west-2").name, "Claude Opus 4.1")
  assert.equal(modelEntry("global.anthropic.claude-haiku-5-5", "us-west-2").name, "Claude Haiku 5.5 (global)")
  assert.equal(modelEntry("us.anthropic.claude-opus-5-5", "us-west-2").limit.context, 1_000_000)
  assert.equal(modelEntry("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "us-west-2").limit.context, 200_000)
  const r = runtimeModel("us.openai.gpt-6-sol", "eu-west-1")
  assert.deepEqual(r.api, { id: "us.openai.gpt-6-sol", url: "https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1", npm: "@ai-sdk/openai-compatible" })
  assert.equal(geoOf("us-west-2"), "us")
  assert.equal(geoOf("eu-central-1"), "eu")
})

test("model metadata uses the exact Bedrock catalog entry", () => {
  const meta = { "us.openai.gpt-6.1-terra": { limit: { context: 9000, input: 8000, output: 1000 }, cost: { input: 1.5, output: 2.5, cache_read: 0.1, cache_write: 0.2 }, temperature: false, modalities: { input: ["text"], output: ["text"] }, tool_call: false } }
  const m = runtimeModel("us.openai.gpt-6.1-terra", "us-west-2", meta)
  assert.deepEqual(m.limit, { context: 9000, input: 8000, output: 1000 })
  assert.deepEqual(m.cost, { input: 1.5, output: 2.5, cache: { read: 0.1, write: 0.2 } })
  assert.equal(m.capabilities.temperature, false)
  assert.equal(m.capabilities.toolcall, false)
  assert.equal(m.capabilities.input.image, false)
  assert.equal(runtimeModel("us.openai.gpt-6.1-sol", "us-west-2", meta).cost.input, 0)
})

test("sigv4 signs the scope, the session token and the body hash", () => {
  const h = signRequest(
    { method: "POST", url: "https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages", headers: { "content-type": "application/json" }, body: "{}" },
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "tok" },
    { region: "us-west-2", service: "bedrock", now: new Date("2026-01-02T03:04:05Z") },
  )
  assert.equal(h.get("x-amz-date"), "20260102T030405Z")
  assert.equal(h.get("x-amz-security-token"), "tok")
  assert.equal(h.get("x-amz-content-sha256"), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
  assert.match(h.get("authorization"), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/)
  assert.equal(h.has("host"), false)
})

test("authorize is a prompt-only auto flow with no URL for magpie to open", async () => {
  const p = await server({})
  const a = await p.auth.methods[0].authorize({ profile: "work", region: "us-west-2" })
  assert.equal(a.method, "auto")
  assert.equal(Object.hasOwn(a, "url"), false)
  assert.match(a.instructions, /work/)
})

test("provider.models throws SignInExpired with signIn expired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-models-"))
  const exe = join(dir, "aws")
  const prior = process.env.MAGPIE_BEDROCK_AWS_CLI
  try {
    await writeFile(exe, "#!/bin/sh\necho 'Error loading SSO Token: Token has expired' >&2\nexit 1\n")
    await chmod(exe, 0o700)
    process.env.MAGPIE_BEDROCK_AWS_CLI = exe
    forget("nobody")
    const p = await server({})
    await assert.rejects(p.provider.models({ models: { seed: 1 } }, { auth }), (e) => e instanceof SignInExpired && e.signIn === "expired")
  } finally {
    forget("nobody")
    if (prior === undefined) delete process.env.MAGPIE_BEDROCK_AWS_CLI
    else process.env.MAGPIE_BEDROCK_AWS_CLI = prior
    await rm(dir, { recursive: true, force: true })
  }
})

test("provider.models returns the given list when the vendor cannot be reached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-models-"))
  const exe = join(dir, "aws")
  const prior = process.env.MAGPIE_BEDROCK_AWS_CLI
  const given = { "us.anthropic.claude-haiku-5-5": { name: "kept" } }
  try {
    await writeFile(exe, "#!/bin/sh\necho 'SSO configuration missing' >&2\nexit 1\n")
    await chmod(exe, 0o700)
    process.env.MAGPIE_BEDROCK_AWS_CLI = exe
    forget("nobody")
    const p = await server({})
    const out = await p.provider.models({ models: given }, { auth })
    assert.equal(out, given)
  } finally {
    forget("nobody")
    if (prior === undefined) delete process.env.MAGPIE_BEDROCK_AWS_CLI
    else process.env.MAGPIE_BEDROCK_AWS_CLI = prior
    await rm(dir, { recursive: true, force: true })
  }
})
