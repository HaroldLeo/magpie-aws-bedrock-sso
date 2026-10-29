import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../index.mjs"
import { toConverse, streamChat } from "../lib/converse.mjs"

const tools = [{ type: "function", function: { name: "clock", parameters: { type: "object", properties: {} } } }]
const chat = (fields = {}) => ({ model: "us.openai.gpt-6.1-terra", messages: [{ role: "user", content: "Hello" }], ...fields })

test("unsupported search and image detail are rejected", () => {
  assert.throws(() => toConverse(chat({ web_search_options: { search_context_size: "high" } })), /web_search_options/i)
  assert.throws(() => toConverse(chat({ prediction: { type: "content", content: "answer" } })), /prediction/i)
  assert.throws(() => toConverse(chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } }] }] })), /image_url.detail/i)
})

test("tool descriptions are preserved without inventing text", () => {
  const req = toConverse(chat({ tools }))
  assert.equal(Object.hasOwn(req.toolConfig.tools[0].toolSpec, "description"), false)
  const description = "Return the current time"
  const withDescription = toConverse(chat({ tools: [{ type: "function", function: { ...tools[0].function, description } }] }))
  assert.equal(withDescription.toolConfig.tools[0].toolSpec.description, description)
})

test("tool_choice none cannot become auto", () => {
  const result = toConverse(chat({ tools, tool_choice: "none" }))
  assert.equal(result.toolConfig, undefined)
})

test("remote image URLs are rejected instead of changing the prompt to text", () => {
  assert.throws(() => toConverse(chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] })), /image|unsupported/i)
})

test("malformed tool arguments fail rather than inventing new arguments", () => {
  assert.throws(() => toConverse(chat({ messages: [{ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "clock", arguments: "{bad" } }] }] })), /argument/i)
  assert.throws(() => toConverse(chat({ messages: [{ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "clock", arguments: "" } }] }] })), /argument/i)
})

test("unsupported output constraints fail rather than being dropped", () => {
  assert.throws(() => toConverse(chat({ response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } } })), /response_format/i)
  assert.throws(() => toConverse(chat({ parallel_tool_calls: false, tools })), /parallel_tool_calls/i)
})

test("late system messages and unsupported effort fail before invocation", () => {
  assert.throws(() => toConverse(chat({ messages: [{ role: "user", content: "hi" }, { role: "developer", content: "new instructions" }] })), /precede/i)
  assert.throws(() => toConverse(chat({ reasoning_effort: "none" })), /effort/i)
  assert.throws(() => toConverse(chat({ verbosity: "low" })), /verbosity/i)
})

test("named participants and audio output fail rather than losing information", () => {
  assert.throws(() => toConverse(chat({ messages: [{ role: "user", name: "alice", content: "yes" }] })), /name/i)
  assert.throws(() => toConverse(chat({ modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" } })), /audio|modalities/i)
  assert.throws(() => toConverse(chat({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: null, audio: { id: "audio_1" } }, { role: "user", content: "Summarize" }] })), /audio/i)
})

test("missing tool choices and unsupported historical function calls are rejected", () => {
  assert.throws(() => toConverse(chat({ tool_choice: "required" })), /tool_choice/i)
  assert.throws(() => toConverse(chat({ functions: [{ name: "clock" }], function_call: "auto" })), /function/i)
  assert.throws(() => toConverse(chat({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: null, refusal: "no" }] })), /refusal/i)
})

test("tool history without definitions cannot be sent as a different conversation", () => {
  assert.throws(() => toConverse(chat({ messages: [{ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "clock", arguments: "{}" } }] }] })), /tool definitions/i)
})

test("malformed GPT requests are rejected at the plugin boundary", async () => {
  const p = await plugin({})
  const l = await p.auth.loader(async () => ({ profile: "nobody", region: "us-west-2" }))
  const url = "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions"
  for (const data of [null, [], chat({ stream: "yes" }), chat({ messages: "bad" })]) {
    const r = await l.fetch(url, { method: "POST", body: JSON.stringify(data) })
    assert.equal(r.status, 400)
    assert.equal((await r.json()).error.type, "invalid_request_error")
  }
})

test("signed GPT calls accept only model IDs, not URL paths", async () => {
  const p = await plugin({})
  const l = await p.auth.loader(async () => ({ profile: "nobody", region: "us-west-2" }))
  const r = await l.fetch("https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions", { method: "POST", body: JSON.stringify(chat({ model: "../other" })) })
  assert.equal(r.status, 400)
})

test("a truncated event stream fails instead of reporting DONE", async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(0, 0, 0, 16, 0, 0)); c.close() } })
  await assert.rejects(new Response(streamChat(body, "model")).text(), /truncat|incomplete/i)
})

test("an empty event stream fails instead of reporting DONE", async () => {
  const body = new ReadableStream({ start(c) { c.close() } })
  await assert.rejects(new Response(streamChat(body, "model")).text(), /incomplete|message/i)
})

test("the request boundary rejects unencrypted and nonstandard destinations", async () => {
  const p = await plugin({})
  const l = await p.auth.loader(async () => ({ profile: "nobody", region: "us-west-2" }))
  for (const url of ["http://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages", "https://bedrock-runtime.us-west-2.amazonaws.com:8443/anthropic/v1/messages", "https://user:secret@bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages", "https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages?redirect=evil"]) {
    const r = await l.fetch(url, { method: "POST", body: "{}" })
    assert.equal(r.status, 400, url)
  }
})
