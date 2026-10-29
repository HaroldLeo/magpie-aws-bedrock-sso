// Live smoke test against Bedrock with a real SSO profile:
//   AWS_PROFILE=your-profile node test/live.mjs
import assert from "node:assert/strict"
import plugin from "../index.mjs"
const p = await plugin({})
const cfg = {}; await p.config(cfg)
console.log("seed models:", Object.keys(cfg.provider["bedrock-sso"].models))
const m = p.auth.methods[0]
console.log("prompt:", m.prompts[0].type, (m.prompts[0].options || []).map(o => o.value))
const a = await m.authorize({ profile: process.env.AWS_PROFILE, region: "" })
const auth = await a.callback()
assert.equal(auth.type, "success", auth.error)
const models = await p.provider.models({}, { auth })
console.log("listed:", Object.keys(models).length, Object.keys(models).slice(0, 40))
const l = await p.auth.loader(async () => auth)
const base = cfg.provider["bedrock-sso"].api
let r = await l.fetch(base + "/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "aws-sigv4", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "us.anthropic.claude-haiku-5-5", max_tokens: 10, messages: [{ role: "user", content: "say ok" }] }) })
const claude = await r.json()
assert.equal(r.status, 200, JSON.stringify(claude))
assert.equal(claude.content?.[0]?.type, "text")
console.log("claude:", r.status)
r = await l.fetch(base + "/messages", { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "us.anthropic.claude-haiku-5-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "say ok" }] }) })
const t = await r.text()
assert.equal(r.status, 200, t)
assert.match(t, /event: message_stop/)
console.log("claude stream:", r.status)
const oa = cfg.provider["bedrock-sso"].models["us.openai.gpt-6-luna"].provider.api
r = await l.fetch(oa + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer aws-sigv4" }, body: JSON.stringify({ model: "us.openai.gpt-6-luna", max_completion_tokens: 40, messages: [{ role: "user", content: "say ok" }] }) })
const gpt = await r.json()
assert.equal(r.status, 200, JSON.stringify(gpt))
assert.equal(gpt.choices?.[0]?.message?.role, "assistant")
console.log("openai:", r.status)
r = await l.fetch("https://evil.example.com/anthropic/v1/messages", { method: "POST", body: "{}" })
assert.equal(r.status, 400)
console.log("refuse:", r.status)
