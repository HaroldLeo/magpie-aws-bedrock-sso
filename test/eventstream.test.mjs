import assert from "node:assert/strict"
import { test } from "node:test"
import { crc32, eventFrames } from "../lib/eventstream.mjs"

function frame(headers) {
  const body = new TextEncoder().encode('{}')
  const out = new Uint8Array(16 + headers.length + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  view.setUint32(4, headers.length)
  view.setUint32(8, crc32(out.subarray(0, 8)))
  out.set(headers, 12)
  out.set(body, 12 + headers.length)
  view.setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)))
  return new ReadableStream({ start(c) { c.enqueue(out); c.close() } })
}

test("a boolean extension header does not hide following control headers", async () => {
  const encoder = new TextEncoder()
  const name = encoder.encode(":message-type"), value = encoder.encode("event")
  const headers = new Uint8Array(3 + 4 + name.length + value.length)
  headers.set([1, 120, 0, name.length], 0)
  headers.set(name, 4)
  headers[4 + name.length] = 7
  new DataView(headers.buffer).setUint16(5 + name.length, value.length)
  headers.set(value, 7 + name.length)
  const iter = eventFrames(frame(headers))
  const first = await iter.next()
  assert.equal(first.value.headers.x, true)
  assert.equal(first.value.headers[":message-type"], "event")
  await iter.return()
})
