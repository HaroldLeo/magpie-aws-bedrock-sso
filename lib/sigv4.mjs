// AWS Signature Version 4, with node:crypto only (runs in Bun and Node).
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
import { createHash, createHmac } from "node:crypto"

const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const hmac = (key, data) => createHmac("sha256", key).update(data).digest()

// RFC 3986 encoding as SigV4 wants it: everything but unreserved characters.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())

// Non-S3 services sign each path segment encoded twice: the path as sent is
// already encoded once, and the canonical form encodes it again.
function canonicalPath(pathname) {
  if (!pathname || pathname === "/") return "/"
  return pathname.split("/").map((seg) => enc(seg)).join("/")
}

function canonicalQuery(params) {
  return [...params.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&")
}

/**
 * Sign a request. Returns a new Headers with authorization, x-amz-date,
 * x-amz-content-sha256 and (for temporary credentials) x-amz-security-token.
 *
 * @param {{method:string,url:URL|string,headers?:HeadersInit,body?:string|Uint8Array}} req
 * @param {{accessKeyId:string,secretAccessKey:string,sessionToken?:string}} creds
 * @param {{region:string,service:string,now?:Date}} scope
 */
export function signRequest(req, creds, { region, service, now = new Date() }) {
  const url = typeof req.url === "string" ? new URL(req.url) : req.url
  const method = (req.method || "GET").toUpperCase()
  const body = req.body ?? ""
  const payloadHash = sha256(body)
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "") // YYYYMMDD'T'HHMMSS'Z'
  const date = amzDate.slice(0, 8)

  const headers = new Headers(req.headers)
  headers.set("host", url.host)
  headers.set("x-amz-date", amzDate)
  headers.set("x-amz-content-sha256", payloadHash)
  if (creds.sessionToken) headers.set("x-amz-security-token", creds.sessionToken)
  else headers.delete("x-amz-security-token")
  headers.delete("authorization")

  // Sign only the headers that matter and that no proxy or runtime rewrites.
  const signed = ["host", "x-amz-date", "x-amz-content-sha256", "content-type"]
  if (creds.sessionToken) signed.push("x-amz-security-token")
  const names = signed.filter((h) => headers.has(h)).sort()
  const canonicalHeaders = names.map((h) => `${h}:${headers.get(h).trim().replace(/\s+/g, " ")}\n`).join("")
  const signedHeaders = names.join(";")

  const canonicalRequest = [method, canonicalPath(url.pathname), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, payloadHash].join("\n")
  const credentialScope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n")

  const kDate = hmac("AWS4" + creds.secretAccessKey, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")

  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`)
  // fetch sets Host itself; leaving it in can trip runtimes that forbid it.
  headers.delete("host")
  return headers
}
