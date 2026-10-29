// AWS credentials for an SSO (IAM Identity Center) profile, through the AWS
// CLI. The CLI owns the SSO token cache (~/.aws/sso/cache) and turns it into
// short-lived role credentials; this module never reads or writes that cache
// itself, and never logs command output (it contains secrets).
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { homedir } from "node:os"

const EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(homedir() ? [join(homedir(), ".local/bin")] : [])]
// Refresh this long before the role credentials run out.
const LEAD_MS = 5 * 60 * 1000

export class SignInExpired extends Error {
  constructor(message) {
    super(message)
    this.signIn = "expired"
  }
}

// magpie.app is started by launchd, whose PATH has no Homebrew in it.
export function awsBinary(env = process.env) {
  if (env.MAGPIE_BEDROCK_AWS_CLI && existsSync(env.MAGPIE_BEDROCK_AWS_CLI)) return env.MAGPIE_BEDROCK_AWS_CLI
  for (const dir of [...(env.PATH || "").split(delimiter), ...EXTRA_PATHS]) {
    if (!dir) continue
    const candidate = join(dir, "aws")
    if (existsSync(candidate)) return candidate
  }
  throw new Error("The AWS CLI (aws) was not found; install it (brew install awscli) or set MAGPIE_BEDROCK_AWS_CLI")
}

function run(args, { timeout = 30_000 } = {}) {
  const binary = awsBinary()
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8", env: { ...process.env, AWS_PAGER: "" } }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || "")
        return reject(error)
      }
      resolve(String(stdout).trim())
    })
  })
}

// An SSO token that ran out (or never was) is something only `aws sso login`
// fixes; everything else is a plain failure.
function looksExpired(stderr) {
  return /(?:sso session.{0,80}(?:expired|invalid)|sso token.{0,80}(?:expired|invalid)|token (?:has )?expired|unable to refresh sso|error loading sso token|sso login)/i.test(stderr)
}

const cache = new Map() // profile -> { creds, until, pending }

/** Role credentials for `profile`, cached until shortly before they expire. */
export async function credentialsFor(profile) {
  const now = Date.now()
  const entry = cache.get(profile)
  if (entry?.creds && entry.until - LEAD_MS > now) return entry.creds
  if (entry?.pending) return entry.pending
  const pending = (async () => {
    let out
    try {
      out = await run(["configure", "export-credentials", "--profile", profile, "--format", "process"])
    } catch (error) {
      if (error.message?.startsWith("The AWS CLI (aws) was not found")) throw error
      if (looksExpired(error.stderr)) throw new SignInExpired(`The AWS SSO session for profile "${profile}" has run out; sign in to Bedrock (AWS SSO) again in magpie, or run: aws sso login --profile ${profile}`)
      throw new Error(`aws configure export-credentials failed for profile "${profile}" (exit ${error.code ?? "?"})`)
    }
    let j
    try { j = JSON.parse(out) } catch { throw new Error(`AWS CLI returned invalid credentials for profile "${profile}"`) }
    const creds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.SessionToken }
    if (typeof creds.accessKeyId !== "string" || !creds.accessKeyId || typeof creds.secretAccessKey !== "string" || !creds.secretAccessKey) throw new Error(`Profile "${profile}" gave no credentials`)
    const until = j.Expiration ? Date.parse(j.Expiration) : Date.now() + 60 * 60 * 1000
    if (!Number.isFinite(until) || until <= Date.now()) throw new Error(`Profile "${profile}" gave expired or invalid credentials`)
    cache.set(profile, { creds, until })
    return creds
  })()
  cache.set(profile, { ...(entry ?? {}), pending })
  try {
    return await pending
  } catch (error) {
    cache.delete(profile)
    throw error
  }
}

export function forget(profile) {
  cache.delete(profile)
}

/** The AWS caller's role ARN. */
export async function callerArn(profile) {
  return run(["sts", "get-caller-identity", "--profile", profile, "--query", "Arn", "--output", "text"])
}

/** Runs `aws sso login`, which opens the browser; resolves when it exits 0. */
export function ssoLogin(profile, { timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(awsBinary(), ["sso", "login", "--profile", profile], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
    let err = ""
    child.stderr.on("data", (d) => (err += d))
    child.stdout.on("data", () => {})
    const timer = setTimeout(() => child.kill(), timeout)
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      forget(profile)
      if (code === 0) resolve()
      else reject(new Error(`aws sso login --profile ${profile} exited ${code}${/timed out|expired/i.test(err) ? " (the browser sign-in timed out)" : ""}`))
    })
  })
}

/** Profile section names for the picker. Credential values remain CLI-owned. */
export async function listProfiles(env = process.env) {
  const path = env.AWS_CONFIG_FILE || join(homedir(), ".aws/config")
  let text
  try { text = await readFile(path, "utf8") } catch { return [] }
  const profiles = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line)
    if (!match) continue
    const section = match[1].trim()
    const name = section === "default" ? section : section.startsWith("profile ") ? section.slice(8).trim() : ""
    if (name) profiles.add(name)
  }
  return [...profiles]
}

/** The region a profile names, if any. */
export async function profileRegion(profile) {
  try {
    return (await run(["configure", "get", "region", "--profile", profile], { timeout: 10_000 })) || undefined
  } catch {
    return undefined
  }
}
