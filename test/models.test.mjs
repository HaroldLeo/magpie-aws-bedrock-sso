import assert from "node:assert/strict"
import { test } from "node:test"
import { listModels } from "../lib/models.mjs"

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example" }

test("discovery follows pages and filters inactive, incompatible, and out-of-region models", async () => {
  const pages = [
    { inferenceProfileSummaries: [{ inferenceProfileId: "us.openai.gpt-6.1-terra", status: "ACTIVE" }, { inferenceProfileId: "us.amazon.nova-2-lite-v1:0", status: "ACTIVE" }], nextToken: "second" },
    { inferenceProfileSummaries: [{ inferenceProfileId: "global.anthropic.claude-opus-5-5", status: "ACTIVE" }, { inferenceProfileId: "eu.openai.gpt-6.1-terra", status: "ACTIVE" }, { inferenceProfileId: "us.openai.gpt-6-sol", status: "INACTIVE" }] },
  ]
  const seen = []
  const list = await listModels(creds, "us-west-2", { metadata: {}, fetchImpl: async (url, options) => {
    seen.push([url.searchParams.get("nextToken"), options.redirect])
    return Response.json(pages.shift())
  } })
  assert.deepEqual(Object.keys(list), ["us.openai.gpt-6.1-terra", "global.anthropic.claude-opus-5-5"])
  assert.deepEqual(seen, [[null, "error"], ["second", "error"]])
})

test("discovery fails instead of returning an incomplete catalog after the page limit", async () => {
  await assert.rejects(listModels(creds, "us-west-2", { metadata: {}, fetchImpl: async () => Response.json({ inferenceProfileSummaries: [{ inferenceProfileId: "us.openai.gpt-6.1-terra", status: "ACTIVE" }], nextToken: "more" }) }), /page limit/)
})
