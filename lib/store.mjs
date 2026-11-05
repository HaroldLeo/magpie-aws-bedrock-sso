// Last good spend readings, kept on disk so a restart or another magpie
// process (`magpie quota` in a terminal) reuses them instead of asking AWS,
// which charges for Cost Explorer and GetMetricData calls. Only sums, times
// and hashed keys are kept: no credentials, account ids or request bodies.
//
// Every change is a read-modify-write under a lock file, so processes and
// store instances writing at once don't lose each other's entries.
import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const VERSION = 2
const MAX_ENTRIES = 32
// A lock older than this was left by a process that died holding it.
const STALE_LOCK_MS = 10_000
const LOCK_WAIT_MS = 5_000

export function defaultStorePath(env = process.env) {
  const root = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(root, "magpie", "bedrock-sso-spend.json")
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const newest = (e) => Math.max(e?.at ?? 0, e?.claimAt ?? 0)

function prune(entries) {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, a], [, b]) => newest(b) - newest(a))
      .slice(0, MAX_ENTRIES),
  )
}

/**
 * A small JSON store of readings by key.
 *   get(key)          the entry as on disk now
 *   update(key, fn)   fn(entry) gives the new entry (or the same one), under
 *                     the lock; resolves to what was kept
 * A file that's missing, unreadable or of another version reads as empty.
 * If the folder can't be written at all, the store keeps entries in memory
 * for the process instead, so readings still work.
 */
export function spendStore(path = defaultStorePath()) {
  const lockPath = `${path}.lock`
  let memory // set once the disk turns out to be unusable

  async function readAll() {
    try {
      const data = JSON.parse(await readFile(path, "utf8"))
      return data?.version === VERSION && data.entries && typeof data.entries === "object" ? data.entries : {}
    } catch {
      return {}
    }
  }

  async function writeAll(entries) {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify({ version: VERSION, entries }), { mode: 0o600 })
      await rename(tmp, path)
    } catch (error) {
      await unlink(tmp).catch(() => {})
      throw error
    }
  }

  // The lock is a file holding its owner's token: only the owner removes
  // it, and a stale one (its owner died) is moved aside atomically, so two
  // waiters can't both take it over.
  async function locked(fn) {
    const token = randomUUID()
    const started = Date.now()
    await mkdir(dirname(path), { recursive: true })
    for (;;) {
      try {
        await writeFile(lockPath, token, { flag: "wx", mode: 0o600 })
        break
      } catch (error) {
        if (error.code !== "EEXIST") throw error
      }
      const seen = await readFile(lockPath, "utf8").catch(() => undefined)
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0)
      if (seen !== undefined && age > STALE_LOCK_MS) {
        const aside = `${lockPath}.${randomUUID()}.stale`
        if (await rename(lockPath, aside).then(() => true, () => false)) {
          // Another waiter may have replaced it just before: put theirs back.
          if ((await readFile(aside, "utf8").catch(() => seen)) !== seen) await link(aside, lockPath).catch(() => {})
          await unlink(aside).catch(() => {})
        }
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("the spend store stayed locked")
      await sleep(10 + Math.random() * 40)
    }
    try {
      return await fn()
    } finally {
      if ((await readFile(lockPath, "utf8").catch(() => undefined)) === token) await unlink(lockPath).catch(() => {})
    }
  }

  return {
    path,
    async get(key) {
      if (memory) return memory.get(key)
      return (await readAll())[key]
    },
    async update(key, fn) {
      if (memory) return memory.update(key, fn)
      try {
        return await locked(async () => {
          const entries = await readAll()
          const next = fn(entries[key])
          if (next === entries[key]) return next
          if (next === undefined) delete entries[key]
          else entries[key] = next
          await writeAll(prune(entries))
          return next
        })
      } catch {
        // Not writable (or stuck): keep going in memory, from what's on disk.
        memory = memoryStore(await readAll())
        return memory.update(key, fn)
      }
    },
  }
}

/** A store that keeps nothing past the process, for tests and as a fallback. */
export function memoryStore(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    path: "",
    async get(key) {
      return structuredClone(m.get(key))
    },
    async update(key, fn) {
      const cur = m.get(key)
      const next = fn(structuredClone(cur))
      if (next === undefined) m.delete(key)
      else m.set(key, structuredClone(next))
      return structuredClone(next)
    },
  }
}
