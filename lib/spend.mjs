// What the AWS account has spent on Bedrock, for magpie's usage hook:
//
//   estimated  this week's token counts from CloudWatch (AWS/Bedrock, every
//              caller in the account and region, not only magpie), priced
//              from magpie's models.dev catalog. Close to real time.
//   billed     Cost Explorer's daily UnblendedCost of every Bedrock service.
//              What AWS charges, but a day or more behind.
import { catalogEntry } from "./models.mjs"
import { signRequest } from "./sigv4.mjs"

export const TOKEN_METRICS = {
  InputTokenCount: "input",
  OutputTokenCount: "output",
  CacheReadInputTokenCount: "cache_read",
  CacheWriteInputTokenCount: "cache_write",
}
const KINDS = Object.values(TOKEN_METRICS)
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const PAGE_LIMIT = 20
// GetMetricData takes at most 500 queries a call.
const QUERIES_PER_CALL = 500

export const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/

const zero = () => Object.fromEntries(KINDS.map((k) => [k, 0]))

/** The start of the week holding `now`: `day` (0 = Sunday) at `hour` UTC. */
export function weekStart(now, { day = 0, hour = 0 } = {}) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - day + 7) % 7))
  if (d > now) d.setUTCDate(d.getUTCDate() - 7)
  return d
}

export function monthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export function nextMonth(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

export const ymd = (d) => d.toISOString().slice(0, 10)

export class AwsError extends Error {
  constructor(message, { status, type } = {}) {
    super(message)
    this.status = status
    this.type = type
  }
  get expiredCredentials() {
    return /ExpiredToken|RequestExpired/i.test(this.type || "")
  }
}

// One AWS JSON-protocol call (CloudWatch, Cost Explorer), signed with SigV4.
async function awsJson(creds, { host, region, service, target, contentType, label }, body, fetchImpl) {
  const url = new URL(`https://${host}/`)
  const text = JSON.stringify(body)
  const headers = signRequest({ method: "POST", url, headers: { "content-type": contentType, "x-amz-target": target, accept: "application/json" }, body: text }, creds, { region, service })
  const res = await fetchImpl(url, { method: "POST", headers, body: text, redirect: "error", signal: AbortSignal.timeout(20_000) })
  const out = await res.text()
  if (!res.ok) {
    let type = ""
    try {
      const j = JSON.parse(out)
      type = String(j.__type || j.code || "").split("#").pop()
    } catch {}
    throw new AwsError(`${label} answered ${res.status}${type ? ` (${type})` : ""}`, { status: res.status, type })
  }
  try {
    return JSON.parse(out)
  } catch {
    throw new AwsError(`${label} answered something that isn't JSON`)
  }
}

/**
 * The AWS account the credentials are for, from STS GetCallerIdentity
 * (free). Readings are kept by account, so a profile pointed at another
 * account doesn't reuse the first one's spend.
 */
export async function callerAccount(creds, { region, fetchImpl = fetch }) {
  const url = new URL(`https://sts.${region}.amazonaws.com/`)
  const body = "Action=GetCallerIdentity&Version=2011-06-15"
  const headers = signRequest({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/json" }, body }, creds, { region, service: "sts" })
  const res = await fetchImpl(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(20_000) })
  const out = await res.text()
  // JSON as asked for; STS's own XML too, in case it answers in that.
  let j
  try {
    j = JSON.parse(out)
  } catch {}
  const xml = (tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(out)?.[1]
  if (!res.ok) {
    const type = String(j?.Error?.Code || j?.__type || xml("Code") || "").split("#").pop()
    throw new AwsError(`STS answered ${res.status}${type ? ` (${type})` : ""}`, { status: res.status, type })
  }
  const account = j?.GetCallerIdentityResponse?.GetCallerIdentityResult?.Account ?? xml("Account")
  if (!/^\d{12}$/.test(account ?? "")) throw new AwsError("STS gave no account id")
  return account
}

const cloudWatch = (region) => ({
  host: `monitoring.${region}.amazonaws.com`,
  region,
  service: "monitoring",
  contentType: "application/x-amz-json-1.0",
  label: "CloudWatch",
})

// The model a metric's dimensions count, and whether they are its
// long-context share. Any other split (none, or one with more dimensions)
// would count the same tokens twice, so it is left out.
export function seriesOf(dimensions = []) {
  const byName = Object.fromEntries(dimensions.map((d) => [d.Name, d.Value]))
  const names = Object.keys(byName).sort().join(",")
  if (names === "ModelId") return { model: byName.ModelId, longContext: false }
  if (names === "ContextWindow,ModelId") return { model: byName.ModelId, longContext: true, contextWindow: byName.ContextWindow }
  return undefined
}

/** The Bedrock token metrics the region has had data for in the past two weeks. */
export async function listTokenMetrics(creds, region, { fetchImpl = fetch } = {}) {
  const found = []
  let next
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const body = { Namespace: "AWS/Bedrock", ...(next ? { NextToken: next } : {}) }
    const res = await awsJson(creds, { ...cloudWatch(region), target: "GraniteServiceVersion20100801.ListMetrics" }, body, fetchImpl)
    for (const m of res.Metrics ?? []) {
      const kind = TOKEN_METRICS[m.MetricName]
      const series = kind && seriesOf(m.Dimensions)
      if (series) found.push({ metric: m.MetricName, kind, dimensions: m.Dimensions, ...series })
    }
    next = res.NextToken
    if (!next) return found
  }
  throw new AwsError("CloudWatch ListMetrics went past its page limit")
}

/**
 * Token sums per model between `start` and `end`, from CloudWatch:
 * { [modelId]: { all: {input, output, cache_read, cache_write}, long: {…} } }.
 * `long` is the share billed at the model's long-context rate.
 */
export async function tokenUsage(creds, region, { start, end, fetchImpl = fetch, metrics } = {}) {
  metrics ??= await listTokenMetrics(creds, region, { fetchImpl })
  const usage = {}
  for (let i = 0; i < metrics.length; i += QUERIES_PER_CALL) {
    const batch = metrics.slice(i, i + QUERIES_PER_CALL)
    const queries = batch.map((m, j) => ({
      Id: `m${i + j}`,
      MetricStat: { Metric: { Namespace: "AWS/Bedrock", MetricName: m.metric, Dimensions: m.dimensions }, Period: 3600, Stat: "Sum" },
      ReturnData: true,
    }))
    const byId = Object.fromEntries(queries.map((q, j) => [q.Id, batch[j]]))
    let next
    let page = 0
    for (; page < PAGE_LIMIT; page++) {
      const body = {
        StartTime: Math.floor(start.getTime() / 1000),
        EndTime: Math.ceil(end.getTime() / 1000),
        MetricDataQueries: queries,
        ...(next ? { NextToken: next } : {}),
      }
      const res = await awsJson(creds, { ...cloudWatch(region), target: "GraniteServiceVersion20100801.GetMetricData" }, body, fetchImpl)
      for (const r of res.MetricDataResults ?? []) {
        const m = byId[r.Id]
        if (!m) continue
        // PartialData means more pages follow; these two mean the sums are wrong.
        if (r.StatusCode === "InternalError" || r.StatusCode === "Forbidden") throw new AwsError(`CloudWatch GetMetricData answered ${r.StatusCode}`)
        const sum = (r.Values ?? []).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0)
        const u = (usage[m.model] ??= { all: zero(), long: zero() })
        u[m.longContext ? "long" : "all"][m.kind] += sum
      }
      next = res.NextToken
      if (!next) break
    }
    if (page === PAGE_LIMIT) throw new AwsError("CloudWatch GetMetricData went past its page limit")
  }
  return usage
}

const rateOf = (cost, kind) => Number(cost?.[kind]) || 0
const priced = (cost) => KINDS.some((k) => rateOf(cost, k) > 0)

/**
 * US dollars for token usage at the catalog's rates. The long-context share
 * is charged at the catalog's first context tier, the rest at the base rate.
 * Models the catalog has no price for are counted in `unpriced`.
 */
export function priceUsage(usage, metadata = {}) {
  let usd = 0
  const unpriced = []
  const byModel = {}
  for (const [model, { all, long }] of Object.entries(usage)) {
    const tokens = KINDS.reduce((a, k) => a + all[k], 0)
    if (tokens <= 0) continue
    const cost = catalogEntry(model, metadata)?.cost
    if (!priced(cost)) {
      unpriced.push(model)
      continue
    }
    const tier = (cost.tiers ?? []).find((t) => t?.tier?.type === "context") ?? cost.context_over_200k
    let dollars = 0
    for (const k of KINDS) {
      const longTokens = Math.min(long[k], all[k])
      dollars += ((all[k] - longTokens) * rateOf(cost, k) + longTokens * (tier ? rateOf(tier, k) || rateOf(cost, k) : rateOf(cost, k))) / 1e6
    }
    byModel[model] = dollars
    usd += dollars
  }
  return { usd, unpriced: unpriced.sort(), byModel }
}

/**
 * Cost Explorer's daily Bedrock cost between `start` and `end` (dates,
 * end exclusive): { days: { "YYYY-MM-DD": usd } }. Every service whose name
 * has "Bedrock" in it counts: Bedrock itself and each model's Marketplace
 * edition ("Claude Opus 5.5 (Amazon Bedrock Edition)").
 */
export async function billedDays(creds, { start, end, fetchImpl = fetch } = {}) {
  const endpoint = { host: "ce.us-east-1.amazonaws.com", region: "us-east-1", service: "ce", contentType: "application/x-amz-json-1.1", label: "Cost Explorer", target: "AWSInsightsIndexService.GetCostAndUsage" }
  const days = {}
  let next
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const body = {
      TimePeriod: { Start: ymd(start), End: ymd(end) },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      ...(next ? { NextPageToken: next } : {}),
    }
    const res = await awsJson(creds, endpoint, body, fetchImpl)
    for (const r of res.ResultsByTime ?? []) {
      const day = r.TimePeriod?.Start
      if (!day) continue
      days[day] ??= 0
      for (const g of r.Groups ?? []) {
        if (!/bedrock/i.test(g.Keys?.[0] ?? "")) continue
        const amount = Number(g.Metrics?.UnblendedCost?.Amount)
        if (Number.isFinite(amount)) days[day] += amount
      }
    }
    next = res.NextPageToken
    if (!next) return { days }
  }
  throw new AwsError("Cost Explorer went past its page limit")
}

export const sumDays = (days, from, to) => Object.entries(days).reduce((a, [d, v]) => (d >= ymd(from) && d < ymd(to) ? a + v : a), 0)

const dollars = (n) => "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2))

/**
 * The budget settings from the plugin's options, checked. No budget is the
 * default: null, 0 or leaving it out all mean none, and "$1,200" reads as
 * 1200. A setting that can't be read is listed in `problems` and left at
 * its default, so the rest still apply.
 */
export function budgetOf(options = {}) {
  const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(typeof v === "string" ? v.replace(/[$,\s]/g, "") : v))
  const money = (v) => (num(v) === 0 ? undefined : num(v))
  const weekly = money(options.weeklyBudget)
  const monthly = money(options.monthlyBudget)
  const day = options.weekResetDay === undefined || options.weekResetDay === null || options.weekResetDay === "" ? 0 : WEEKDAYS.indexOf(String(options.weekResetDay).slice(0, 3).toLowerCase())
  const hour = num(options.weekResetHour) ?? 0
  const refresh = num(options.refreshMinutes) ?? 15
  const problems = []
  if (weekly !== undefined && !(weekly > 0)) problems.push("weeklyBudget must be an amount in US$, or null for none")
  if (monthly !== undefined && !(monthly > 0)) problems.push("monthlyBudget must be an amount in US$, or null for none")
  if (day < 0) problems.push("weekResetDay must be a weekday, like sun")
  if (!(Number.isInteger(hour) && hour >= 0 && hour <= 23)) problems.push("weekResetHour must be a whole hour from 0 to 23 (UTC)")
  if (!(refresh >= 5)) problems.push("refreshMinutes must be 5 or more")
  let regions = options.metricRegions === undefined || options.metricRegions === null ? undefined : [...new Set([].concat(options.metricRegions).map(String))].sort()
  if (regions && !regions.length) {
    problems.push("metricRegions is empty; the sign-in region is counted")
    regions = undefined
  } else if (regions && !regions.every((r) => AWS_REGION.test(r))) {
    problems.push("metricRegions must be AWS regions, like us-west-2")
    regions = undefined
  }
  return {
    weekly: weekly > 0 ? weekly : undefined,
    monthly: monthly > 0 ? monthly : undefined,
    week: { day: day < 0 ? 0 : day, hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0 },
    refreshMs: (refresh >= 5 ? refresh : 15) * 60 * 1000,
    regions,
    problems,
  }
}

/**
 * magpie's usage windows for what the readings came to. A budget is shown
 * as a share of it either way. `enforce` (the "Stop at weekly budget"
 * switch) decides whether routing reads the weekly one and stops the
 * account at 100%; otherwise it's shown only (aside). The monthly budget,
 * read from a bill a day behind, is always shown only.
 */
export function usageWindows({ now, budget, estimate, billed, enforce = true }) {
  const windows = []
  const held = enforce ? {} : { aside: true }
  const start = weekStart(now, budget.week)
  const resetsAt = new Date(start.getTime() + WEEK_MS).toISOString()
  if (estimate) {
    const more = estimate.unpriced.length ? "+" : ""
    const spent = estimate.usd
    windows.push(
      budget.weekly
        ? { name: "Weekly", used: (100 * spent) / budget.weekly, amount: spent, limit: budget.weekly, unit: "USD", display: `${dollars(spent)}${more} / ${dollars(budget.weekly)}`, resetsAt, span: WEEK_MS / 1000, ...held }
        : { name: "This week", display: `${dollars(spent)}${more} (estimated)`, resetsAt, span: WEEK_MS / 1000, aside: true },
    )
  }
  if (billed) {
    const month = sumDays(billed.days, monthStart(now), nextMonth(now))
    const week = sumDays(billed.days, new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())), new Date(now.getTime() + 24 * 60 * 60 * 1000))
    const monthReset = nextMonth(now).toISOString()
    windows.push({ name: "Billed this week", display: `${dollars(week)} (Cost Explorer, lags a day)`, resetsAt, aside: true })
    windows.push(
      budget.monthly
        ? { name: "Monthly (billed)", used: (100 * month) / budget.monthly, amount: month, limit: budget.monthly, unit: "USD", display: `${dollars(month)} / ${dollars(budget.monthly)}`, resetsAt: monthReset, aside: true }
        : { name: "Billed this month", display: dollars(month), resetsAt: monthReset, aside: true },
    )
  }
  return windows
}
