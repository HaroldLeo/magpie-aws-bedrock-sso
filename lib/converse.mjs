// OpenAI chat completions <-> Bedrock Converse, for Bedrock's GPT models.
//
// Bedrock's Chat Completions API rejects function tools with reasoning.
// Converse supports both with SigV4 authentication, so GPT requests use it.
import { randomUUID } from "node:crypto"
import { eventFrames } from "./eventstream.mjs"
import { gptEfforts } from "./models.mjs"

const STOP = { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length", model_context_window_exceeded: "length", stop_sequence: "stop", content_filtered: "content_filter", guardrail_intervened: "content_filter" }
function stopReason(reason) {
  if (!Object.hasOwn(STOP, reason)) throw new Error(`Unsupported Bedrock stop reason: ${reason}`)
  return STOP[reason]
}
const IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,(.*)$/s

function textOf(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw new Error("Unsupported message content")
  return content.map((p) => {
    if (typeof p === "string") return p
    if ((p?.type === "text" || p?.type === "input_text") && typeof p.text === "string") return p.text
    throw new Error(`Unsupported message content type: ${p?.type ?? "unknown"}`)
  }).join("")
}

function userBlocks(content) {
  if (typeof content === "string") return content ? [{ text: content }] : []
  if (Array.isArray(content) && content.length === 0) return []
  if (!Array.isArray(content)) throw new Error("Unsupported user message content")
  const out = []
  for (const p of content) {
    if (typeof p === "string") out.push({ text: p })
    else if ((p?.type === "text" || p?.type === "input_text") && typeof p.text === "string") { if (p.text) out.push({ text: p.text }) }
    else if (p?.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
      const m = IMAGE.exec(url)
      if (m) out.push({ image: { format: m[1] === "jpg" ? "jpeg" : m[1], source: { bytes: m[2] } } })
      else throw new Error("Unsupported image: provide a base64 data URL")
    } else throw new Error(`Unsupported user content type: ${p?.type ?? "unknown"}`)
  }
  return out
}

function parseArgs(s) {
  try {
    const v = JSON.parse(s)
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object")
    return v
  } catch {
    throw new Error("Tool arguments must be a valid JSON object")
  }
}

// Converse wants user and assistant turns to alternate, so neighbours of one
// role (a run of tool results and the user message after them) become one.
function push(messages, role, content) {
  if (!content.length) return
  const last = messages.at(-1)
  if (last?.role === role) last.content.push(...content)
  else messages.push({ role, content })
}

function toolChoiceOf(choice) {
  if (choice === "required") return { any: {} }
  if (choice?.type === "function" && choice.function?.name) return { tool: { name: choice.function.name } }
  if (choice == null || choice === "auto") return { auto: {} }
  throw new Error("Unsupported tool_choice")
}

/** A chat completions body as a Converse request; `model` is its model id. */
export function toConverse(chat) {
  if (!chat || typeof chat !== "object" || Array.isArray(chat) || !Array.isArray(chat.messages) || !chat.messages.length) throw new Error("messages must be a non-empty array")
  if (chat.tools != null && !Array.isArray(chat.tools)) throw new Error("tools must be an array")
  if (chat.stream_options && (typeof chat.stream_options !== "object" || Array.isArray(chat.stream_options) || Object.keys(chat.stream_options).some((key) => key !== "include_usage"))) throw new Error("Unsupported stream_options")
  if (chat.response_format && chat.response_format.type !== "text") throw new Error("Unsupported response_format")
  if (chat.parallel_tool_calls === false) throw new Error("Unsupported parallel_tool_calls: false")
  if (chat.audio != null || (chat.modalities != null && (!Array.isArray(chat.modalities) || chat.modalities.some((value) => value !== "text")))) throw new Error("Unsupported audio or output modalities")
  if (chat.n != null && chat.n !== 1) throw new Error("Unsupported n: only one completion is supported")
  for (const key of ["frequency_penalty", "presence_penalty", "logit_bias", "logprobs", "top_logprobs", "seed", "service_tier", "functions", "function_call", "verbosity"]) {
    if (chat[key] != null) throw new Error(`Unsupported request option: ${key}`)
  }
  const system = []
  const messages = []
  for (const m of chat.messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("Invalid message")
    if (m.name != null) throw new Error("Unsupported message name")
    if (m.role === "system" || m.role === "developer") {
      if (messages.length) throw new Error("System and developer messages must precede conversation messages")
      const t = textOf(m.content)
      if (t) system.push({ text: t })
    } else if (m.role === "user") {
      push(messages, "user", userBlocks(m.content))
    } else if (m.role === "assistant") {
      if (m.refusal != null) throw new Error("Unsupported assistant refusal history")
      if (m.audio != null) throw new Error("Unsupported assistant audio history")
      if (m.function_call != null) throw new Error("Unsupported legacy function_call history")
      const content = []
      const t = textOf(m.content)
      if (t) content.push({ text: t })
      if (m.tool_calls != null && !Array.isArray(m.tool_calls)) throw new Error("tool_calls must be an array")
      for (const c of m.tool_calls ?? []) {
        if (c?.type !== "function" || typeof c.id !== "string" || !c.id || typeof c.function?.name !== "string" || !c.function.name || typeof c.function?.arguments !== "string") throw new Error("Invalid function tool call")
        content.push({ toolUse: { toolUseId: c.id, name: c.function.name, input: parseArgs(c.function.arguments) } })
      }
      push(messages, "assistant", content)
    } else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || !m.tool_call_id) throw new Error("tool_call_id is required")
      push(messages, "user", [{ toolResult: { toolUseId: m.tool_call_id, content: [{ text: textOf(m.content) }] } }])
    } else {
      throw new Error(`Unsupported message role: ${m.role}`)
    }
  }

  const req = { messages }
  if (system.length) req.system = system
  const inference = {}
  const max = chat.max_completion_tokens ?? chat.max_tokens
  if (max != null) inference.maxTokens = max
  if (chat.temperature != null) inference.temperature = chat.temperature
  if (chat.top_p != null) inference.topP = chat.top_p
  if (chat.stop != null) inference.stopSequences = Array.isArray(chat.stop) ? chat.stop : [chat.stop]
  if (Object.keys(inference).length) req.inferenceConfig = inference

  const tools = chat.tools ?? []
  if (tools.some((t) => t?.type !== "function" || !t.function?.name)) throw new Error("Unsupported tool definition")
  if (tools.some((t) => t.function.strict === true)) throw new Error("Unsupported tool function strict mode")
  const hasToolHistory = messages.some((m) => m.content.some((b) => b.toolUse || b.toolResult))
  if (!tools.length && chat.tool_choice != null && chat.tool_choice !== "none" && chat.tool_choice !== "auto") throw new Error("tool_choice requires tool definitions")
  if (chat.tool_choice === "none" && hasToolHistory) throw new Error("tool_choice none with tool history is not supported by Converse")
  if (hasToolHistory && !tools.length) throw new Error("Tool definitions are required when the conversation contains tool history")
  if (tools.length && chat.tool_choice !== "none") {
    req.toolConfig = {
      tools: tools.map((t) => ({ toolSpec: { name: t.function.name, description: t.function.description || t.function.name, inputSchema: { json: t.function.parameters ?? { type: "object", properties: {} } } } })),
      toolChoice: toolChoiceOf(chat.tool_choice),
    }
  }

  const effort = chat.reasoning_effort ?? chat.reasoning?.effort
  if (effort != null) {
    if (typeof effort !== "string" || !gptEfforts(chat.model ?? "").includes(effort)) throw new Error("Unsupported reasoning effort")
    req.additionalModelRequestFields = { reasoning: { effort } }
  }
  return req
}

function usageOf(u) {
  if (!u) return undefined
  const read = u.cacheReadInputTokens ?? 0
  const write = u.cacheWriteInputTokens ?? 0
  const prompt = (u.inputTokens ?? 0) + read + write
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens ?? 0,
    total_tokens: prompt + (u.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: read },
    ...(write ? { cache_write_tokens: write } : {}),
  }
}

/** A Converse response as a chat completion. */
export function fromConverse(res, model) {
  let text = ""
  let reasoning = ""
  const toolCalls = []
  for (const b of res.output?.message?.content ?? []) {
    if (b.text) text += b.text
    else if (b.reasoningContent?.reasoningText?.text) reasoning += b.reasoningContent.reasoningText.text
    else if (b.toolUse) toolCalls.push({ id: b.toolUse.toolUseId, type: "function", function: { name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) } })
  }
  const message = { role: "assistant", content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: stopReason(res.stopReason) }],
    usage: usageOf(res.usage),
  }
}

/** Bedrock's error answer ({message}, x-amzn-errortype) in OpenAI's shape. */
export function openaiError(status, message, type) {
  const typeName = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error"
  return JSON.stringify({ error: { message, type: typeName, code: type || null, param: null } })
}

const dec = new TextDecoder("utf-8", { fatal: true })

/** A ConverseStream body as chat completions server-sent events. */
export function streamChat(body, model, signal, includeUsage = false) {
  const enc = new TextEncoder()
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`
  const delta = (d, finish = null) => chunk([{ index: 0, delta: d, finish_reason: finish }])
  const upstream = new AbortController()
  const abortUpstream = () => upstream.abort()
  signal?.addEventListener("abort", abortUpstream, { once: true })
  if (signal?.aborted) abortUpstream()
  const frames = eventFrames(body, upstream.signal)
  // Converse numbers content blocks; chat numbers tool calls.
  const toolIndex = new Map()
  const activeTools = new Map()
  const activeBlocks = new Set()
  let started = false
  let stopped = false

  // One frame as SSE text, "" for a frame chat has nothing to say for.
  function eventOf(headers, e) {
    switch (headers[":event-type"]) {
      case "messageStart":
        return delta({ role: "assistant", content: "" })
      case "contentBlockStart": {
        const t = e.start?.toolUse
        if (!t) return ""
        const index = toolIndex.size
        toolIndex.set(e.contentBlockIndex, index)
        return delta({ tool_calls: [{ index, id: t.toolUseId, type: "function", function: { name: t.name, arguments: "" } }] })
      }
      case "contentBlockDelta": {
        const d = e.delta ?? {}
        if (d.text) return delta({ content: d.text })
        if (d.toolUse) return delta({ tool_calls: [{ index: toolIndex.get(e.contentBlockIndex) ?? 0, function: { arguments: d.toolUse.input ?? "" } }] })
        if (d.reasoningContent?.text) return delta({ reasoning_content: d.reasoningContent.text })
        return ""
      }
      case "messageStop":
        return delta({}, stopReason(e.stopReason))
      case "metadata":
        return includeUsage ? chunk([], { usage: usageOf(e.usage) }) : ""
      default:
        return ""
    }
  }

  // A pull that enqueues nothing is not called again, so each one reads
  // frames until one of them says something.
  return new ReadableStream({
    async pull(ctl) {
      try {
        for (;;) {
          const { value, done } = await frames.next()
          if (done) {
            if (!started || !stopped) throw new Error("Incomplete event stream message")
            signal?.removeEventListener("abort", abortUpstream)
            ctl.enqueue(enc.encode("data: [DONE]\n\n"))
            return ctl.close()
          }
          const { headers, payload } = value
          const e = payload.length ? JSON.parse(dec.decode(payload)) : {}
          if (headers[":message-type"] === "exception" || headers[":message-type"] === "error") {
            const error = { message: e.message ?? headers[":error-message"] ?? "Bedrock stream error", type: headers[":exception-type"] ?? headers[":error-code"] ?? "server_error" }
            abortUpstream()
            await frames.return()
            signal?.removeEventListener("abort", abortUpstream)
            throw new Error(`Bedrock stream error: ${error.message}`)
          }
          if (headers[":message-type"] !== "event") throw new Error("Invalid event stream message type")
          const type = headers[":event-type"]
          if (type === "messageStart") {
            if (started) throw new Error("Duplicate event stream message start")
            started = true
          } else if (!started) throw new Error("Event stream message start is missing")
          if (type === "contentBlockStart") {
            if (!Number.isInteger(e.contentBlockIndex) || activeBlocks.has(e.contentBlockIndex)) throw new Error("Invalid content block start")
            activeBlocks.add(e.contentBlockIndex)
          } else if (type === "contentBlockDelta") {
            if (!Number.isInteger(e.contentBlockIndex)) throw new Error("Invalid content block delta")
            activeBlocks.add(e.contentBlockIndex)
          } else if (type === "contentBlockStop") {
            if (!activeBlocks.has(e.contentBlockIndex)) throw new Error("Invalid content block stop")
            activeBlocks.delete(e.contentBlockIndex)
          } else if (type === "messageStop" && activeBlocks.size) throw new Error("Incomplete content block")
          if (type === "contentBlockStart" && e.start?.toolUse) {
            if (!Number.isInteger(e.contentBlockIndex) || activeTools.has(e.contentBlockIndex)) throw new Error("Invalid tool block start")
            activeTools.set(e.contentBlockIndex, "")
          } else if (type === "contentBlockDelta" && e.delta?.toolUse) {
            if (!activeTools.has(e.contentBlockIndex) || typeof e.delta.toolUse.input !== "string") throw new Error("Invalid tool block delta")
            const input = activeTools.get(e.contentBlockIndex) + e.delta.toolUse.input
            if (input.length > 4 * 1024 * 1024) throw new Error("Tool arguments exceed the client limit")
            activeTools.set(e.contentBlockIndex, input)
          } else if (type === "contentBlockStop" && activeTools.has(e.contentBlockIndex)) {
            parseArgs(activeTools.get(e.contentBlockIndex))
            activeTools.delete(e.contentBlockIndex)
          } else if (type === "messageStop" && activeTools.size) throw new Error("Incomplete tool block")
          if (type === "messageStop") {
            if (stopped) throw new Error("Duplicate event stream message stop")
            stopped = true
          } else if (stopped && type !== "metadata") throw new Error("Unexpected event after message stop")
          const out = eventOf(headers, e)
          if (out) return ctl.enqueue(enc.encode(out))
        }
      } catch (error) {
        abortUpstream()
        await frames.return().catch(() => {})
        signal?.removeEventListener("abort", abortUpstream)
        ctl.error(error)
      }
    },
    async cancel() {
      abortUpstream()
      await frames.return().catch(() => {})
      signal?.removeEventListener("abort", abortUpstream)
    },
  })
}
