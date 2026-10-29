import assert from "node:assert/strict"
import { test } from "node:test"
import { fromConverse, streamChat, toConverse } from "../lib/converse.mjs"
import { crc32 } from "../lib/eventstream.mjs"
import { gptEfforts } from "../lib/models.mjs"

const tools = [{ type: "function", function: { name: "get_time", description: "current time", parameters: { type: "object", properties: {} } } }]

test("a chat request with tools and effort becomes one Converse request", () => {
  const req = toConverse({
    model: "us.openai.gpt-6.1-sol",
    reasoning_effort: "medium",
    max_tokens: 100,
    stop: "END",
    tools,
    tool_choice: "required",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "12:34" },
      { role: "user", content: "thanks" },
    ],
  })
  assert.deepEqual(req.system, [{ text: "be brief" }])
  assert.deepEqual(req.inferenceConfig, { maxTokens: 100, stopSequences: ["END"] })
  assert.deepEqual(req.additionalModelRequestFields, { reasoning: { effort: "medium" } })
  assert.deepEqual(req.toolConfig.toolChoice, { any: {} })
  assert.equal(req.toolConfig.tools[0].toolSpec.name, "get_time")
  assert.deepEqual(req.messages.map((m) => m.role), ["user", "assistant", "user"])
  assert.deepEqual(req.messages[0].content[1], { image: { format: "png", source: { bytes: "AAAA" } } })
  assert.deepEqual(req.messages[1].content[0].toolUse, { toolUseId: "c1", name: "get_time", input: { tz: "UTC" } })
  assert.deepEqual(req.messages[2].content, [{ toolResult: { toolUseId: "c1", content: [{ text: "12:34" }] } }, { text: "thanks" }])
})

test("a Converse answer becomes a chat completion", () => {
  const c = fromConverse({
    output: { message: { content: [{ reasoningContent: { redactedContent: "x" } }, { toolUse: { toolUseId: "c1", name: "get_time", input: { tz: "UTC" } } }] } },
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 4 },
  }, "m")
  assert.equal(c.choices[0].finish_reason, "tool_calls")
  assert.equal(c.choices[0].message.content, null)
  assert.deepEqual(c.choices[0].message.tool_calls, [{ id: "c1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }])
  assert.deepEqual(c.usage, { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19, prompt_tokens_details: { cached_tokens: 4 } })
})

// An event stream frame with string headers, as Bedrock sends them.
function frame(eventType, payload) {
  const enc = new TextEncoder()
  const hs = [[":event-type", eventType], [":message-type", "event"]].map(([k, v]) => {
    const kb = enc.encode(k), vb = enc.encode(v)
    const b = new Uint8Array(1 + kb.length + 1 + 2 + vb.length)
    b[0] = kb.length; b.set(kb, 1); b[1 + kb.length] = 7
    new DataView(b.buffer).setUint16(2 + kb.length, vb.length); b.set(vb, 4 + kb.length)
    return b
  })
  const headers = new Uint8Array(hs.reduce((n, h) => n + h.length, 0))
  let o = 0
  for (const h of hs) { headers.set(h, o); o += h.length }
  const body = enc.encode(JSON.stringify(payload))
  const out = new Uint8Array(16 + headers.length + body.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, out.length); v.setUint32(4, headers.length)
  v.setUint32(8, crc32(out.subarray(0, 8)))
  out.set(headers, 12); out.set(body, 12 + headers.length)
  v.setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)))
  return out
}

test("a ConverseStream becomes chat completion chunks, split anywhere", async () => {
  const frames = [
    frame("messageStart", { role: "assistant" }),
    frame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "x" } } }),
    frame("contentBlockStop", { contentBlockIndex: 0 }),
    frame("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { name: "get_time", toolUseId: "c1" } } }),
    frame("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"tz":' } } }),
    frame("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '"UTC"}' } } }),
    frame("contentBlockStop", { contentBlockIndex: 1 }),
    frame("messageStop", { stopReason: "tool_use" }),
    frame("metadata", { usage: { inputTokens: 3, outputTokens: 2 } }),
  ]
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0))
  let o = 0
  for (const f of frames) { all.set(f, o); o += f.length }
  // Seven-byte pieces cross every frame boundary.
  const body = new ReadableStream({ start(c) { for (let i = 0; i < all.length; i += 7) c.enqueue(all.subarray(i, i + 7)); c.close() } })
  const text = await new Response(streamChat(body, "m", undefined, true)).text()
  const events = text.split("\n\n").filter(Boolean).map((e) => e.slice(6))
  assert.equal(events.at(-1), "[DONE]")
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e))
  const args = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).map((t) => t.function.arguments).join("")
  assert.equal(args, '{"tz":"UTC"}')
  const first = chunks.map((c) => c.choices[0]?.delta.tool_calls?.[0]).find((t) => t?.id)
  assert.deepEqual([first.index, first.id, first.function.name], [0, "c1", "get_time"])
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason, "tool_calls")
  assert.equal(chunks.at(-1).usage.total_tokens, 5)
})

test("stream usage is emitted only when requested", async () => {
  function source() {
    const events = [frame("messageStart", { role: "assistant" }), frame("messageStop", { stopReason: "end_turn" }), frame("metadata", { usage: { inputTokens: 3, outputTokens: 2 } })]
    return new ReadableStream({ start(c) { for (const event of events) c.enqueue(event); c.close() } })
  }
  const plain = await new Response(streamChat(source(), "m")).text()
  const withUsage = await new Response(streamChat(source(), "m", undefined, true)).text()
  assert.doesNotMatch(plain, /"usage"/)
  assert.match(withUsage, /"total_tokens":5/)
})

test("a corrupted event-stream prelude and body are rejected", async () => {
  const prelude = frame("messageStart", { role: "assistant" })
  prelude[8] ^= 1
  const payload = frame("messageStart", { role: "assistant" })
  payload[payload.length - 5] ^= 1
  for (const [bytes, pattern] of [[prelude, /prelude checksum/i], [payload, /message checksum/i]]) {
    const body = new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } })
    await assert.rejects(new Response(streamChat(body, "m")).text(), pattern)
  }
})

test("a stream that ends without messageStop fails", async () => {
  const bytes = frame("messageStart", { role: "assistant" })
  const body = new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } })
  await assert.rejects(new Response(streamChat(body, "m")).text(), /incomplete/i)
})

test("canceling the output cancels the Bedrock stream", async () => {
  let canceled = false
  const bytes = frame("messageStart", { role: "assistant" })
  const body = new ReadableStream({ start(c) { c.enqueue(bytes) }, cancel() { canceled = true } })
  const reader = streamChat(body, "m").getReader()
  await reader.read()
  await reader.cancel()
  assert.equal(canceled, true)
})

test("abort interrupts a pending Bedrock stream read", async () => {
  const abort = new AbortController()
  let canceled = false
  const body = new ReadableStream({ cancel() { canceled = true } })
  const reader = streamChat(body, "m", abort.signal).getReader()
  const pending = reader.read()
  abort.abort()
  await assert.rejects(pending, /incomplete/i)
  assert.equal(canceled, true)
})

test("cancel interrupts a pending upstream read", async () => {
  let canceled = false
  let releaseRead
  const readStarted = new Promise((resolve) => { releaseRead = resolve })
  const body = new ReadableStream({ pull() { releaseRead(); return new Promise(() => {}) }, cancel() { canceled = true } })
  const reader = streamChat(body, "m").getReader()
  const pending = reader.read()
  await readStarted
  const result = await Promise.race([reader.cancel().then(() => "canceled"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 100))])
  assert.equal(result, "canceled")
  assert.equal(canceled, true)
  await pending
})

test("a stream exception closes the upstream body", async () => {
  let canceled = false
  const bytes = frame("messageStart", "{")
  const marker = new TextEncoder().encode('"{"')
  const offset = bytes.findIndex((_, index) => marker.every((v, j) => bytes[index + j] === v))
  bytes[offset + 1] = 0
  new DataView(bytes.buffer).setUint32(bytes.length - 4, crc32(bytes.subarray(0, bytes.length - 4)))
  const body = new ReadableStream({ start(c) { c.enqueue(bytes) }, cancel() { canceled = true } })
  await assert.rejects(new Response(streamChat(body, "m")).text(), /JSON|unexpected|token/i)
  assert.equal(canceled, true)
  assert.equal(body.locked, false)
})

test("unfinished tool blocks do not complete successfully", async () => {
  const events = [frame("messageStart", { role: "assistant" }), frame("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { name: "clock", toolUseId: "x" } } }), frame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"x":' } } }), frame("messageStop", { stopReason: "tool_use" })]
  const body = new ReadableStream({ start(c) { for (const event of events) c.enqueue(event); c.close() } })
  await assert.rejects(new Response(streamChat(body, "m")).text(), /block|incomplete/i)
})

test("empty streamed tool arguments do not become an empty object", async () => {
  const events = [frame("messageStart", { role: "assistant" }), frame("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { name: "clock", toolUseId: "x" } } }), frame("contentBlockStop", { contentBlockIndex: 0 }), frame("messageStop", { stopReason: "tool_use" })]
  const body = new ReadableStream({ start(c) { for (const event of events) c.enqueue(event); c.close() } })
  await assert.rejects(new Response(streamChat(body, "m")).text(), /argument/i)
})

test("unfinished text blocks do not complete successfully", async () => {
  const events = [frame("messageStart", { role: "assistant" }), frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }), frame("messageStop", { stopReason: "end_turn" })]
  const body = new ReadableStream({ start(c) { for (const event of events) c.enqueue(event); c.close() } })
  await assert.rejects(new Response(streamChat(body, "m")).text(), /block|incomplete/i)
})

test("unknown stop reasons do not masquerade as success", async () => {
  assert.throws(() => fromConverse({ output: { message: { content: [] } }, stopReason: "new_failure" }, "m"), /stop reason/i)
  const events = [frame("messageStart", { role: "assistant" }), frame("messageStop", { stopReason: "new_failure" })]
  const body = new ReadableStream({ start(c) { for (const event of events) c.enqueue(event); c.close() } })
  await assert.rejects(new Response(streamChat(body, "m")).text(), /stop reason/i)
})

test("effort levels follow the GPT generation", () => {
  assert.deepEqual(gptEfforts("us.openai.gpt-6.1-sol"), ["low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(gptEfforts("us.openai.gpt-5.4"), ["none", "low", "medium", "high", "xhigh"])
})
