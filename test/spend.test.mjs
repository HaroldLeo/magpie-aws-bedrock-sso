import assert from "node:assert/strict"
import { test } from "node:test"
import plugin, { _internal } from "../index.mjs"
import { SignInExpired } from "../lib/credentials.mjs"
import { memoryStore, spendStore } from "../lib/store.mjs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { catalogEntry } from "../lib/models.mjs"
import { billedDays, budgetOf, priceUsage, seriesOf, tokenUsage, usageWindows, weekStart } from "../lib/spend.mjs"

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example" }
const metadata = {
  "us.anthropic.claude-opus-5-5": { cost: { input: 4.4, output: 22, cache_read: 0.22, cache_write: 5.5 } },
  "openai.gpt-5.4": { cost: { input: 2.75, output: 16.5, cache_read: 0.275 } },
  "us.openai.gpt-6.1-terra": { cost: { input: 1.1, output: 5.5, cache_read: 0.055, cache_write: 1.375, tiers: [{ input: 2.2, output: 8.25, cache_read: 0.11, cache_write: 2.75, tier: { type: "context", size: 272000 } }] } },
}

// A fake AWS JSON endpoint: answers by X-Amz-Target, records each call.
function aws(handlers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const target = new Headers(init.headers).get("x-amz-target")
    const body = JSON.parse(init.body)
    calls.push({ host: url.host, target, body, auth: new Headers(init.headers).get("authorization"), redirect: init.redirect })
    const h = handlers[target]
    if (!h) return new Response("{}", { status: 404 })
    const out = await h(body, calls.length)
    return out instanceof Response ? out : Response.json(out)
  }
  return { fetchImpl, calls }
}

test("the week starts on the configured weekday and UTC hour", () => {
  assert.equal(weekStart(new Date("2026-11-04T12:00:00Z")).toISOString(), "2026-11-01T00:00:00.000Z")
  assert.equal(weekStart(new Date("2026-11-04T12:00:00Z"), { day: 0, hour: 7 }).toISOString(), "2026-11-01T07:00:00.000Z")
  // Before Sunday's reset hour the week is still last week's.
  assert.equal(weekStart(new Date("2026-11-01T06:59:00Z"), { day: 0, hour: 7 }).toISOString(), "2026-10-25T07:00:00.000Z")
  assert.equal(weekStart(new Date("2026-11-04T12:00:00Z"), { day: 1, hour: 0 }).toISOString(), "2026-11-02T00:00:00.000Z")
})

test("metric series: per-model totals and their long-context share only", () => {
  assert.deepEqual(seriesOf([{ Name: "ModelId", Value: "us.x" }]), { model: "us.x", longContext: false })
  assert.deepEqual(seriesOf([{ Name: "ContextWindow", Value: "1M" }, { Name: "ModelId", Value: "us.x" }]), { model: "us.x", longContext: true, contextWindow: "1M" })
  assert.equal(seriesOf([]), undefined)
  assert.equal(seriesOf([{ Name: "ModelId", Value: "us.x" }, { Name: "Other", Value: "y" }]), undefined)
})

test("a geography profile the catalog lacks takes its in-region entry", () => {
  assert.equal(catalogEntry("us.openai.gpt-5.4", metadata), metadata["openai.gpt-5.4"])
  assert.equal(catalogEntry("global.openai.gpt-5.4", metadata), metadata["openai.gpt-5.4"])
  assert.equal(catalogEntry("us.anthropic.claude-opus-5-5", metadata), metadata["us.anthropic.claude-opus-5-5"])
  assert.equal(catalogEntry("us.openai.gpt-9", metadata), undefined)
})

test("tokens are priced at base and long-context rates; unknown models are listed", () => {
  const z = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  const usage = {
    "us.anthropic.claude-opus-5-5": { all: { input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6 }, long: z },
    "us.openai.gpt-6.1-terra": { all: { ...z, output: 2e6 }, long: { ...z, output: 1e6 } },
    "us.openai.gpt-5.4": { all: { ...z, input: 1e6 }, long: z },
    "us.mystery.model": { all: { ...z, input: 5 }, long: z },
    "us.idle.model": { all: z, long: z },
  }
  const p = priceUsage(usage, metadata)
  assert.equal(p.byModel["us.anthropic.claude-opus-5-5"].toFixed(4), (4.4 + 22 + 0.22 + 5.5).toFixed(4))
  assert.equal(p.byModel["us.openai.gpt-6.1-terra"].toFixed(4), (5.5 + 8.25).toFixed(4))
  assert.equal(p.byModel["us.openai.gpt-5.4"].toFixed(4), "2.7500")
  assert.deepEqual(p.unpriced, ["us.mystery.model"])
  assert.equal(p.usd.toFixed(4), (32.12 + 13.75 + 2.75).toFixed(4))
})

test("CloudWatch: lists token metrics, then sums every page of their data", async () => {
  const { fetchImpl, calls } = aws({
    "GraniteServiceVersion20100801.ListMetrics": (b) =>
      b.NextToken
        ? { Metrics: [{ MetricName: "OutputTokenCount", Dimensions: [{ Name: "ContextWindow", Value: "1M" }, { Name: "ModelId", Value: "m" }] }] }
        : { Metrics: [{ MetricName: "OutputTokenCount", Dimensions: [{ Name: "ModelId", Value: "m" }] }, { MetricName: "Invocations", Dimensions: [{ Name: "ModelId", Value: "m" }] }, { MetricName: "InputTokenCount", Dimensions: [] }], NextToken: "p2" },
    "GraniteServiceVersion20100801.GetMetricData": (b) => {
      const [all, long] = b.MetricDataQueries.map((q) => q.Id)
      return b.NextToken
        ? { MetricDataResults: [{ Id: all, Values: [5] }, { Id: long, Values: [2] }] }
        : { MetricDataResults: [{ Id: all, Values: [10, 20] }, { Id: long, Values: [], StatusCode: "PartialData" }], NextToken: "more" }
    },
  })
  const usage = await tokenUsage(creds, "us-west-2", { start: new Date("2026-11-01T07:00:00Z"), end: new Date("2026-11-04T00:00:00Z"), fetchImpl })
  assert.equal(usage.m.all.output, 35)
  assert.equal(usage.m.long.output, 2)
  assert.ok(calls.every((c) => c.host === "monitoring.us-west-2.amazonaws.com" && c.redirect === "error" && /Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/monitoring\//.test(c.auth)))
  assert.ok(calls.every((c) => /x-amz-target/.test(c.auth)), "the target header is signed")
  const data = calls.find((c) => c.target.endsWith("GetMetricData")).body
  assert.equal(data.StartTime, Date.parse("2026-11-01T07:00:00Z") / 1000)
  assert.equal(data.MetricDataQueries[0].MetricStat.Period, 3600)
})

test("CloudWatch: a forbidden series fails instead of summing short", async () => {
  const { fetchImpl } = aws({
    "GraniteServiceVersion20100801.GetMetricData": (b) => ({ MetricDataResults: [{ Id: b.MetricDataQueries[0].Id, Values: [1], StatusCode: "Forbidden" }] }),
  })
  const metrics = [{ metric: "InputTokenCount", kind: "input", dimensions: [{ Name: "ModelId", Value: "m" }], model: "m", longContext: false }]
  await assert.rejects(tokenUsage(creds, "us-west-2", { start: new Date(0), end: new Date(), fetchImpl, metrics }), /Forbidden/)
})

test("Cost Explorer: sums every Bedrock service per day, across pages", async () => {
  const { fetchImpl, calls } = aws({
    "AWSInsightsIndexService.GetCostAndUsage": (b) =>
      b.NextPageToken
        ? { ResultsByTime: [{ TimePeriod: { Start: "2026-11-02" }, Groups: [{ Keys: ["Amazon Bedrock"], Metrics: { UnblendedCost: { Amount: "1" } } }] }] }
        : {
            ResultsByTime: [{ TimePeriod: { Start: "2026-11-01" }, Groups: [
              { Keys: ["Claude Opus 5.5 (Amazon Bedrock Edition)"], Metrics: { UnblendedCost: { Amount: "2.5" } } },
              { Keys: ["Amazon Elastic Compute Cloud - Compute"], Metrics: { UnblendedCost: { Amount: "99" } } },
              { Keys: ["Amazon Bedrock"], Metrics: { UnblendedCost: { Amount: "0.5" } } },
            ] }],
            NextPageToken: "p2",
          },
  })
  const { days } = await billedDays(creds, { start: new Date("2026-11-01"), end: new Date("2026-11-05"), fetchImpl })
  assert.deepEqual(days, { "2026-11-01": 3, "2026-11-02": 1 })
  assert.equal(calls[0].host, "ce.us-east-1.amazonaws.com")
  assert.deepEqual(calls[0].body.TimePeriod, { Start: "2026-11-01", End: "2026-11-05" })
})

test("options are checked; budgets are optional", () => {
  assert.deepEqual(budgetOf({}).problems, [])
  assert.equal(budgetOf({}).weekly, undefined)
  const b = budgetOf({ weeklyBudget: "300", weekResetDay: "Sunday", weekResetHour: 7, metricRegions: ["us-west-2", "us-east-1"] })
  assert.equal(b.weekly, 300)
  assert.deepEqual(b.week, { day: 0, hour: 7 })
  assert.deepEqual(b.regions, ["us-east-1", "us-west-2"], "sorted, so the order doesn't make another reading")
  assert.deepEqual(budgetOf({ metricRegions: [] }).regions, undefined, "none listed: the sign-in region")
  assert.match(budgetOf({ metricRegions: [] }).problems[0], /empty/)
  const bad = budgetOf({ weeklyBudget: -1, weekResetDay: "someday", weekResetHour: 24, refreshMinutes: 1, metricRegions: ["nowhere"] })
  assert.equal(bad.problems.length, 5)
  // what can't be read falls back to its default
  assert.deepEqual([bad.weekly, bad.week, bad.refreshMs, bad.regions], [undefined, { day: 0, hour: 0 }, 15 * 60 * 1000, undefined])
})

test("no budget is the default, and the package's suggestion sets none", async () => {
  const { readFile } = await import("node:fs/promises")
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  for (const options of [{}, pkg.magpie.options, { weeklyBudget: null, monthlyBudget: 0 }, { weeklyBudget: "" }]) {
    const b = budgetOf(options)
    assert.deepEqual([b.weekly, b.monthly, b.problems], [undefined, undefined, []], JSON.stringify(options))
  }
  assert.equal(budgetOf({ weeklyBudget: "$1,200" }).weekly, 1200)
  assert.equal(budgetOf({ monthlyBudget: " 500 " }).monthly, 500)
})

test("windows: a budget is a window routing reads; no budget is shown only", () => {
  const now = new Date("2026-11-04T12:00:00Z")
  const estimate = { usd: 75, unpriced: ["x"] }
  const billed = { days: { "2026-10-31": 10, "2026-11-01": 20, "2026-11-03": 5 } }
  const [week, billedWeek, month] = usageWindows({ now, budget: budgetOf({ weeklyBudget: 300, monthlyBudget: 1000, weekResetHour: 7 }), estimate, billed, enforce: true })
  assert.deepEqual(week, { name: "Weekly", used: 25, amount: 75, limit: 300, unit: "USD", display: "$75.00+ / $300", resetsAt: "2026-11-08T07:00:00.000Z", span: 604800 })
  assert.equal(billedWeek.aside, true)
  assert.match(billedWeek.display, /^\$25\.00/)
  assert.equal(month.used, 2.5)
  assert.equal(month.aside, true, "the monthly budget is shown only, even with Stop at weekly budget on")
  assert.equal(month.resetsAt, "2026-12-01T00:00:00.000Z")
  const shown = usageWindows({ now, budget: budgetOf({}), estimate, billed })
  assert.ok(shown.every((w) => w.aside === true && w.used === undefined))
})

// A fake AWS that counts what it is asked: 1M openai.gpt-5.4 input tokens
// a reading ($2.75), a bill of $1.50 on 11-03, and STS's account.
function counted({ accountId = "111122223333" } = {}) {
  const n = { cw: 0, ce: 0, sts: 0 }
  const { fetchImpl, calls } = aws({
    "GraniteServiceVersion20100801.ListMetrics": () => (n.cw++, { Metrics: [{ MetricName: "InputTokenCount", Dimensions: [{ Name: "ModelId", Value: "openai.gpt-5.4" }] }] }),
    "GraniteServiceVersion20100801.GetMetricData": (b) => ({ MetricDataResults: [{ Id: b.MetricDataQueries[0].Id, Values: [1e6] }] }),
    "AWSInsightsIndexService.GetCostAndUsage": () => (n.ce++, { ResultsByTime: [{ TimePeriod: { Start: "2026-11-03" }, Groups: [{ Keys: ["Amazon Bedrock"], Metrics: { UnblendedCost: { Amount: "1.5" } } }] }] }),
  })
  const withSts = async (url, init) => {
    if (url.host.startsWith("sts.")) {
      n.sts++
      return Response.json({ GetCallerIdentityResponse: { GetCallerIdentityResult: { Account: typeof accountId === "function" ? accountId() : accountId } } })
    }
    return fetchImpl(url, init)
  }
  return { n, fetchImpl: withSts, calls }
}
const settings = { profile: "p", region: "us-west-2" }
const at = (iso) => () => new Date(iso)
const reader = (fetchImpl, more = {}) =>
  _internal.spendReader({ fetchImpl, now: at("2026-11-04T12:00:00Z"), credentials: async () => creds, metadata: async () => metadata, store: memoryStore(), wait: async () => {}, ...more })

test("billed totals are off unless asked for, so Cost Explorer isn't charged", async () => {
  const { n, fetchImpl } = counted()
  const read = reader(fetchImpl)
  const r = await read(settings, {})
  assert.deepEqual(r.windows.map((w) => w.name), ["This week"])
  assert.deepEqual([n.cw, n.ce], [1, 0])
  const withBill = await read(settings, { billed: true })
  assert.deepEqual(withBill.windows.map((w) => w.name), ["This week", "Billed this week", "Billed this month"])
  assert.equal(n.ce, 1)
})

test("a weekly budget is shown either way; only the switch makes routing stop at it", async () => {
  const { fetchImpl } = counted()
  const read = reader(fetchImpl)
  const shown = (await read(settings, { weeklyBudget: 100 })).windows[0]
  assert.equal(shown.display, "$2.75 / $100")
  assert.equal(shown.used, 2.75)
  assert.equal(shown.aside, true, "not enforced: routing doesn't read it")
  const held = (await read(settings, { weeklyBudget: 100, enforce: true })).windows[0]
  assert.equal(held.aside, undefined, "enforced: routing stops the account at 100%")
  const monthly = (await read(settings, { monthlyBudget: 10, billed: true, enforce: true })).windows.find((w) => w.name === "Monthly (billed)")
  assert.deepEqual([monthly.used, monthly.aside], [15, true], "the monthly budget is never enforced")
})

test("readings are cached: each source on its own clock, and calls at once share one trip", async () => {
  const { n, fetchImpl } = counted()
  let t = new Date("2026-11-04T12:00:00Z")
  const read = reader(fetchImpl, { now: () => t })
  await Promise.all([read(settings, { billed: true }), read(settings, { billed: true }), read(settings, { billed: true })])
  assert.deepEqual([n.cw, n.ce], [1, 1], "three at once ask AWS once")
  await read(settings, { billed: true })
  assert.deepEqual([n.cw, n.ce, n.sts], [1, 1, 1], "within the refresh time AWS isn't asked")
  t = new Date(t.getTime() + 16 * 60 * 1000)
  await read(settings, { billed: true })
  assert.deepEqual([n.cw, n.ce], [2, 1], "token metrics refresh after 15 minutes, the bill after 6 hours")
  // another week start or region set is another estimate, but not another bill
  await read(settings, { billed: true, weekResetDay: "mon", metricRegions: ["us-east-1", "us-west-2"] })
  assert.deepEqual([n.cw, n.ce], [4, 1])
  t = new Date(t.getTime() + 6 * 60 * 60 * 1000)
  await read(settings, { billed: true })
  assert.deepEqual([n.cw, n.ce], [5, 2])
  t = new Date("2026-11-10T12:00:00Z")
  await read(settings, {})
  assert.equal(n.cw, 6, "a new week is a new estimate")
})

test("a billed reading that joins an estimate-only one still gets the bill", async () => {
  const { n, fetchImpl } = counted()
  const read = reader(fetchImpl)
  const [plain, withBill] = await Promise.all([read(settings, {}), read(settings, { billed: true })])
  assert.deepEqual(plain.windows.map((w) => w.name), ["This week"])
  assert.deepEqual(withBill.windows.map((w) => w.name), ["This week", "Billed this week", "Billed this month"])
  assert.deepEqual([n.cw, n.ce], [1, 1])
})

test("STS's XML answer and errors are read too", async () => {
  const { callerAccount } = await import("../lib/spend.mjs")
  const xml = async () => new Response("<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>")
  assert.equal(await callerAccount(creds, { region: "us-west-2", fetchImpl: xml }), "123456789012")
  const denied = async () => new Response("<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>", { status: 403 })
  await assert.rejects(callerAccount(creds, { region: "us-west-2", fetchImpl: denied }), /STS answered 403 \(AccessDenied\)/)
})

test("an account STS can't confirm isn't guessed", async () => {
  const { fetchImpl } = counted()
  const down = async (url, init) => (url.host.startsWith("sts.") ? new Response("<x/>", { status: 500 }) : fetchImpl(url, init))
  const r = await reader(down)(settings, { weeklyBudget: 100, enforce: true })
  assert.match(r.error, /STS answered 500/)
  assert.deepEqual(r.windows.map((w) => w.name), ["Not read"], "no budget window routing could act on")
})

test("readings are kept by AWS account, not profile name", async () => {
  let id = "111122223333"
  const { n, fetchImpl } = counted({ accountId: () => id })
  const t = new Date("2026-11-04T12:00:00Z")
  const store = memoryStore()
  await reader(fetchImpl, { now: () => t, store })(settings, { billed: true })
  await reader(fetchImpl, { now: () => t, store })(settings, { billed: true })
  assert.deepEqual([n.sts, n.cw, n.ce], [1, 1, 1], "same credentials, same account: kept")
  // the profile now signs in to another account, with other credentials
  id = "444455556666"
  const other = { ...creds, accessKeyId: "AKIDOTHER" }
  const repointed = reader(fetchImpl, { now: () => t, store, credentials: async () => other })
  await repointed(settings, { billed: true })
  assert.deepEqual([n.sts, n.cw, n.ce], [2, 2, 2], "the other account's spend is read at once, not reused")
})

test("readings on disk are reused by a new process, and hold no secrets or account ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-spend-"))
  try {
    const path = join(dir, "bedrock-sso-spend.json")
    const { n, fetchImpl } = counted()
    await reader(fetchImpl, { store: spendStore(path) })(settings, { billed: true })
    // magpie restarted, or `magpie quota` in another process
    let asked = 0
    const r = await reader(fetchImpl, { store: spendStore(path), credentials: async () => (asked++, creds) })(settings, { billed: true })
    assert.deepEqual([n.cw, n.ce, n.sts], [1, 1, 1], "AWS isn't asked again")
    assert.equal(asked, 1, "only the local AWS CLI, for which account the credentials are")
    assert.equal(r.windows[0].display, "$2.75 (estimated)")
    const text = await readFile(path, "utf8")
    assert.doesNotMatch(text, /AKID|secret|111122223333|"p"/)
    assert.equal(JSON.parse(text).version, 2)
    // a broken file reads as empty and is written over
    await writeFile(path, "{not json")
    assert.equal((await reader(fetchImpl, { store: spendStore(path) })(settings, {})).windows[0].name, "This week")
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the store: writers at once keep every entry, and a stale lock is taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-spend-"))
  try {
    const path = join(dir, "s.json")
    const stores = [spendStore(path), spendStore(path), spendStore(path)]
    await Promise.all(Array.from({ length: 24 }, (_, i) => stores[i % 3].update(`k${i}`, () => ({ at: i, data: i }))))
    const entries = JSON.parse(await readFile(path, "utf8")).entries
    assert.equal(Object.keys(entries).length, 24)
    const { readdir, utimes } = await import("node:fs/promises")
    assert.deepEqual((await readdir(dir)).sort(), ["s.json"], "no lock or temp file left behind")
    await writeFile(`${path}.lock`, "")
    const old = new Date(Date.now() - 60_000)
    await utimes(`${path}.lock`, old, old)
    await spendStore(path).update("late", () => ({ at: 99, data: 1 }))
    assert.equal(JSON.parse(await readFile(path, "utf8")).entries.late.data, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("two processes at once: one pays for the reading, the other waits for it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bedrock-spend-"))
  try {
    const path = join(dir, "s.json")
    const { n, fetchImpl } = counted()
    // the first process's Cost Explorer call takes a while
    let release
    const gate = new Promise((r) => (release = r))
    const slow = async (url, init) => {
      if (new Headers(init.headers).get("x-amz-target") === "AWSInsightsIndexService.GetCostAndUsage") await gate
      return fetchImpl(url, init)
    }
    const a = reader(slow, { store: spendStore(path), wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    const b = reader(fetchImpl, { store: spendStore(path), wait: async (ms) => { if (n.ce === 0) release(); await new Promise((r) => setTimeout(r, Math.min(ms, 5))) } })
    const first = a(settings, { billed: true, estimate: false })
    await new Promise((r) => setTimeout(r, 20))
    const [ra, rb] = await Promise.all([first, b(settings, { billed: true, estimate: false })])
    assert.equal(n.ce, 1, "Cost Explorer is asked once")
    assert.deepEqual([ra.windows[0].display, rb.windows[0].display].map((d) => d.slice(0, 5)), ["$1.50", "$1.50"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a bad setting is said on the card, and the reading goes on without it", async () => {
  const { fetchImpl } = counted()
  const read = reader(fetchImpl)
  const bad = await read(settings, { weeklyBudget: "lots" })
  assert.equal(bad.error, undefined)
  assert.equal(bad.windows[0].name, "This week")
  assert.match(bad.windows.at(-1).display, /not used: weeklyBudget/)
  assert.deepEqual((await read(settings, { estimate: false })).windows, [])
})

test("an expired SSO session marks the account, also when it runs out mid-reading", async () => {
  const expired = reader(counted().fetchImpl, { credentials: async () => { throw new SignInExpired("run aws sso login") } })
  const e = await expired(settings, {})
  assert.equal(e.signIn, "expired")
  assert.deepEqual(e.windows.map((w) => [w.name, w.display]), [["Not read", "run aws sso login"]])
  // the account was known, then the token ran out and the SSO session too
  const { fetchImpl } = counted()
  let calls = 0
  const store = memoryStore()
  let t = new Date("2026-11-04T12:00:00Z")
  await reader(fetchImpl, { store, now: () => t })(settings, {})
  t = new Date(t.getTime() + 16 * 60 * 1000)
  const runsOut = async (url, init) =>
    url.host.startsWith("monitoring.") ? new Response(JSON.stringify({ __type: "ExpiredTokenException" }), { status: 400 }) : fetchImpl(url, init)
  const r = await reader(runsOut, { store, now: () => t, credentials: async () => { if (calls++) throw new SignInExpired("run aws sso login"); return creds } })(settings, {})
  assert.equal(r.signIn, "expired")
  assert.equal(r.windows[0].display, "$2.75 (estimated)", "the last good reading stays")
  assert.match(r.windows.find((w) => w.name === "Not read").display, /token metrics/)
})

test("a failed source keeps the other; with nothing read, the card still says why", async () => {
  const { fetchImpl } = counted()
  const denied = async (url, init) =>
    new Headers(init.headers).get("x-amz-target") === "AWSInsightsIndexService.GetCostAndUsage" ? new Response(JSON.stringify({ __type: "AccessDeniedException" }), { status: 400 }) : fetchImpl(url, init)
  const r = await reader(denied)(settings, { billed: true })
  assert.equal(r.signIn, "kept")
  assert.equal(r.windows[0].name, "This week")
  assert.match(r.windows.at(-1).display, /Cost Explorer answered 400 \(AccessDeniedException\)/)
  const none = await reader(denied)(settings, { billed: true, estimate: false })
  assert.match(none.error, /AccessDenied/)
  assert.deepEqual(none.windows.map((w) => w.name), ["Not read"])
})

test("the editor's switches are declared off, and feed the reading", async () => {
  const p = await plugin.server({})
  const opts = p.auth.options
  assert.deepEqual(opts.map((o) => [o.key, o.default ?? false]), [["stop_at_budget", false], ["billed_totals", false]])
  assert.ok(opts.every((o) => /^[a-z0-9_-]{1,40}$/.test(o.key) && o.label.length <= 60 && o.description.length <= 300 && o.placement === undefined))
  assert.match(opts[1].confirm, /\$0\.01/)
})

test("sign-in asks for an optional budget, and the reset only once one is given", async () => {
  const p = await plugin.server({})
  const prompts = p.auth.methods[0].prompts
  const budget = prompts.find((q) => q.key === "weeklyBudget")
  assert.equal(budget.validate(""), undefined)
  assert.equal(budget.validate("$1,200"), undefined)
  assert.match(budget.validate("lots"), /amount/)
  assert.match(budget.validate("-5"), /amount/)
  const day = prompts.find((q) => q.key === "weekResetDay")
  assert.deepEqual(day.when, { key: "weeklyBudget", op: "neq", value: "" })
  assert.equal(day.options[0].value, "mon")
  const hour = prompts.find((q) => q.key === "weekResetHour")
  assert.equal(hour.validate("7"), undefined)
  assert.match(hour.validate("24"), /0 to 23/)
  assert.deepEqual(_internal.budgetFromAuth({ weeklyBudget: "200", weekResetDay: "sun", weekResetHour: "7", profile: "x" }), { weeklyBudget: "200", weekResetDay: "sun", weekResetHour: "7" })
  assert.deepEqual(_internal.budgetFromAuth({ weeklyBudget: "", profile: "x" }), {})
})

test("settings: sign-in answers, JSON values over them (nulls left out), money and routing only by switch", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const switches = new Set()
  const p = await plugin.server({ magpie: { option: (id, k) => id === "bedrock-sso" && switches.has(k) } }, pkg.magpie.options)
  const opts = p._usageOptions
  const auth = { profile: "p", weeklyBudget: "250", weekResetDay: "mon", weekResetHour: "8" }
  assert.deepEqual(opts(auth), { weeklyBudget: "250", weekResetDay: "mon", weekResetHour: "8", enforce: false, billed: false }, "the saved example keeps the sign-in's week")
  const q = await plugin.server({ magpie: { option: () => false } }, { weeklyBudget: 300, weekResetHour: 7, billed: true, enforce: true })
  const o = q._usageOptions(auth)
  assert.deepEqual([o.weeklyBudget, o.weekResetDay, o.weekResetHour, o.billed, o.enforce], [300, "mon", 7, false, false], "JSON can't turn on paid calls or routing stops")
  assert.equal(o.notes.length, 2)
  switches.add("billed_totals").add("stop_at_budget")
  assert.deepEqual([opts(auth).billed, opts(auth).enforce], [true, true])
  // an option that throws reads as off
  const r = await plugin.server({ magpie: { option: () => { throw new Error("no") } } })
  assert.deepEqual([r._usageOptions({}).billed, r._usageOptions({}).enforce], [false, false])
})

test("the icon is a whole data URI, and its licence ships with the package", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const icon = pkg.magpie.icon
  assert.match(icon, /^data:image\/svg\+xml,/)
  assert.doesNotMatch(icon, /[#\s"<>]/, "# would end the URI at a fragment")
  assert.match(decodeURIComponent(icon.slice(icon.indexOf(",") + 1)), /<\/svg>$/)
  assert.ok(pkg.files.includes("THIRD_PARTY_NOTICES.md"))
  assert.match(await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"), /Copyright \(c\) 2023 LobeHub/)
})
