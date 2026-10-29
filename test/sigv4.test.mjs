import assert from "node:assert/strict"
import { test } from "node:test"
import { signRequest } from "../lib/sigv4.mjs"

test("matches the AWS SDK signature for a fixed IAM request", () => {
  const headers = signRequest(
    { method: "GET", url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" } },
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    { region: "us-east-1", service: "iam", now: new Date("2015-08-30T12:36:00Z") },
  )
  assert.equal(headers.get("authorization"), "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=dd479fa8a80364edf2119ec24bebde66712ee9c9cb2b0d92eb3ab9ccdc0c3947")
})
