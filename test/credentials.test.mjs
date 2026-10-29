import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { credentialsFor, forget, SignInExpired } from "../lib/credentials.mjs"

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
  } finally {
    forget("test-profile")
    if (prior === undefined) delete process.env.MAGPIE_BEDROCK_AWS_CLI
    else process.env.MAGPIE_BEDROCK_AWS_CLI = prior
    await rm(dir, { recursive: true, force: true })
  }
})
