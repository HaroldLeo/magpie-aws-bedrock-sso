// AWS event-stream frames contain a CRC32 for the prelude and the full message.
// https://smithy.io/2.0/aws/amazon-eventstream.html
export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

const decode = new TextDecoder("utf-8", { fatal: true })

function frameHeaders(bytes) {
  const headers = {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = 0
  while (i < bytes.length) {
    const nameLength = bytes[i++]
    if (!nameLength || i + nameLength + 1 > bytes.length) throw new Error("Invalid event stream header")
    const name = decode.decode(bytes.subarray(i, i + nameLength))
    i += nameLength
    const type = bytes[i++]
    if (Object.hasOwn(headers, name)) throw new Error("Duplicate event stream header")
    if (name.startsWith(":") && type !== 7) throw new Error("Event stream control headers must be strings")
    if (type === 0 || type === 1) {
      headers[name] = type === 0
      continue
    }
    let length
    if (type === 6 || type === 7) {
      if (i + 2 > bytes.length) throw new Error("Truncated event stream header")
      length = view.getUint16(i)
      i += 2
    } else {
      length = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }[type]
      if (length === undefined) throw new Error("Unsupported event stream header type")
    }
    if (i + length > bytes.length) throw new Error("Truncated event stream header")
    headers[name] = type === 7 ? decode.decode(bytes.subarray(i, i + length)) : bytes.slice(i, i + length)
    i += length
  }
  return headers
}

/** Read and validate individual frames without consuming more than one at a time. */
export async function* eventFrames(stream, signal) {
  const reader = stream.getReader()
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  let buf = new Uint8Array(0)
  let complete = false
  try {
    for (;;) {
      while (buf.length >= 12) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
        const total = view.getUint32(0)
        const headersLength = view.getUint32(4)
        if (crc32(buf.subarray(0, 8)) !== view.getUint32(8)) throw new Error("Invalid event stream prelude checksum")
        if (total < 16 || headersLength > total - 16) throw new Error("Invalid event stream frame length")
        // Bound allocation on an untrusted length even if its checksum is valid.
        if (total > 32 * 1024 * 1024) throw new Error("Event stream frame exceeds the 32 MiB client limit")
        if (buf.length < total) break
        if (crc32(buf.subarray(0, total - 4)) !== view.getUint32(total - 4)) throw new Error("Invalid event stream message checksum")
        yield { headers: frameHeaders(buf.subarray(12, 12 + headersLength)), payload: buf.subarray(12 + headersLength, total - 4) }
        buf = buf.subarray(total)
      }
      const { value, done } = await reader.read()
      if (done) {
        if (buf.length) throw new Error("Truncated event stream frame")
        complete = true
        return
      }
      const next = new Uint8Array(buf.length + value.length)
      next.set(buf)
      next.set(value, buf.length)
      buf = next
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
