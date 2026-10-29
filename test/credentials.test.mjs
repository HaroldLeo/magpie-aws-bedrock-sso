import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { credentialsFor, forget, SignInExpired, listProfiles } from "../lib/credentials.mjs"

test("the picker reads profile sections without starting the AWS CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-profiles-"))
  const config = join(dir, "config")
  try {
    await writeFile(config, "[default]\nregion=us-west-2\n[profile work]\nsso_session=login\n[sso-session login]\nsso_region=us-east-1\n[profile work]\n[profile another]\n")
    const missing = join(dir, "missing")
    assert.deepEqual(await listProfiles({ AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: missing }), ["default", "work", "another"])
    assert.deepEqual(await listProfiles({ AWS_CONFIG_FILE: missing, AWS_SHARED_CREDENTIALS_FILE: missing }), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the picker merges config and credentials profiles without duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-profiles-"))
  const config = join(dir, "config")
  const credentials = join(dir, "credentials")
  try {
    await writeFile(config, "[default]\n[profile work]\n[sso-session login]\n")
    await writeFile(credentials, "[work]\naws_access_key_id=fixture\n[credentials-only]\naws_secret_access_key=fixture\n[default]\n")
    const env = { AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials }
    assert.deepEqual(await listProfiles(env), ["default", "work", "credentials-only"])
    assert.deepEqual(await listProfiles({ ...env, AWS_CONFIG_FILE: join(dir, "missing") }), ["work", "credentials-only", "default"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("AWS CLI credentials are cached and explicitly refreshed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-sso-"))
  const exe = join(dir, "aws")
  const calls = join(dir, "calls")
  const prior = process.env.MAGPIE_BEDROCK_AWS_CLI
  try {
    await writeFile(exe, `#!/bin/sh\nprintf 'x' >> '${calls}'\nprintf '%s' '{"Version":1,"AccessKeyId":"access","SecretAccessKey":"secret","SessionToken":"session","Expiration":"2099-01-01T00:00:00Z"}'\n`)
    await chmod(exe, 0o700)
    process.env.MAGPIE_BEDROCK_AWS_CLI = exe
    forget("test-profile")
    const [a, b] = await Promise.all([credentialsFor("test-profile"), credentialsFor("test-profile")])
    assert.deepEqual(a, { accessKeyId: "access", secretAccessKey: "secret", sessionToken: "session" })
    assert.deepEqual(b, a)
    assert.equal(await readFile(calls, "utf8"), "x")
    forget("test-profile")
    await credentialsFor("test-profile")
    assert.equal(await readFile(calls, "utf8"), "xx")
  } finally {
    forget("test-profile")
    if (prior === undefined) delete process.env.MAGPIE_BEDROCK_AWS_CLI
    else process.env.MAGPIE_BEDROCK_AWS_CLI = prior
    await rm(dir, { recursive: true, force: true })
  }
})

test("expired SSO is actionable but unrelated AWS failures do not mark it expired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-sso-"))
  const exe = join(dir, "aws")
  const prior = process.env.MAGPIE_BEDROCK_AWS_CLI
  try {
    await writeFile(exe, "#!/bin/sh\necho 'Error loading SSO Token: Token has expired' >&2\nexit 1\n")
    await chmod(exe, 0o700)
    process.env.MAGPIE_BEDROCK_AWS_CLI = exe
    forget("test-profile")
    await assert.rejects(credentialsFor("test-profile"), (e) => e instanceof SignInExpired && e.message.includes("aws sso login"))
    await writeFile(exe, "#!/bin/sh\necho 'SSO configuration missing' >&2\nexit 1\n")
    await assert.rejects(credentialsFor("test-profile"), (e) => !(e instanceof SignInExpired) && /export-credentials failed/.test(e.message))
    await writeFile(exe, "#!/bin/sh\necho 'The security token included in the request is invalid' >&2\nexit 1\n")
    await assert.rejects(credentialsFor("test-profile"), (e) => !(e instanceof SignInExpired) && /export-credentials failed/.test(e.message))
  } finally {
    forget("test-profile")
    if (prior === undefined) delete process.env.MAGPIE_BEDROCK_AWS_CLI
    else process.env.MAGPIE_BEDROCK_AWS_CLI = prior
    await rm(dir, { recursive: true, force: true })
  }
})
