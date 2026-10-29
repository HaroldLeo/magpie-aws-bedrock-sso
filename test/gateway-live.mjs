import assert from "node:assert/strict"

const base = process.env.MAGPIE_TEST_URL || "http://127.0.0.1:3499"
const gpt = process.env.BEDROCK_GPT_MODEL || "bedrock-sso/us.openai.gpt-6.1-terra"
const claude = process.env.BEDROCK_CLAUDE_MODEL || "bedrock-sso/us.anthropic.claude-haiku-5-5"
const tools = [{ type: "function", function: { name: "clock", description: "Current time", parameters: { type: "object", properties: {} } } }]
async function post(path, body, anthropic = false) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(anthropic ? { "x-api-key": "magpie", "anthropic-version": "2023-06-01" } : { authorization: "Bearer magpie" }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  return response
}
const models = await (await fetch(base + "/v1/models")).json()
assert.ok(models.data.some((m) => m.id === gpt), "GPT model is exposed")
const first = await post("/v1/chat/completions", { model: gpt, max_tokens: 1000, reasoning_effort: "medium", tools, messages: [{ role: "user", content: "What time is it? Call clock." }] })
const answer = await first.json()
assert.equal(first.status, 200, JSON.stringify(answer))
const call = answer.choices[0].message.tool_calls?.[0]
assert.equal(call?.function.name, "clock")
const second = await post("/v1/chat/completions", { model: gpt, stream: true, reasoning_effort: "low", tools, messages: [{ role: "user", content: "What time is it? Call clock." }, answer.choices[0].message, { role: "tool", tool_call_id: call.id, content: "12:34 UTC" }] })
const stream = await second.text()
assert.equal(second.status, 200, stream)
assert.match(stream, /data: \[DONE\]/)
const events = stream.split("\n\n").filter((part) => part.startsWith("data: ") && !part.includes("[DONE]")).map((part) => JSON.parse(part.slice(6)))
const text = events.flatMap((event) => event.choices ?? []).map((choice) => choice.delta?.content ?? "").join("")
assert.match(text, /12:34/)
assert.ok(events.some((event) => event.choices?.some((choice) => choice.finish_reason === "stop")), "tool-result turn completed")
const c = await post("/v1/messages", { model: claude, max_tokens: 20, messages: [{ role: "user", content: "Reply OK." }] }, true)
const cbody = await c.json()
assert.equal(c.status, 200, JSON.stringify(cbody))
assert.equal(cbody.content[0].type, "text")
console.log("PASS model listing, GPT tool call, tool-result streaming, and Claude message")
