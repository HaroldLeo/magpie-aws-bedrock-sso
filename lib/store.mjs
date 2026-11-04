// Last good spend readings, kept on disk so a restart or another magpie
// process (`magpie quota` in a terminal) reuses them instead of asking AWS,
// which charges for Cost Explorer and GetMetricData calls. Only sums and
// times are kept: no credentials, request bodies or account ids.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const VERSION = 1
const MAX_ENTRIES = 32

export function defaultStorePath(env = process.env) {
  const root = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(root, "magpie", "bedrock-sso-spend.json")
}

/**
 * A small JSON store of readings by key. A file that's missing, unreadable
 * or from another version reads as empty; a failed write is ignored (the
 * in-memory readings still apply).
 */
export function spendStore(path = defaultStorePath()) {
  let loaded
  let writing = Promise.resolve()
  async function load() {
    if (loaded) return loaded
    try {
      const data = JSON.parse(await readFile(path, "utf8"))
      loaded = data?.version === VERSION && data.entries && typeof data.entries === "object" ? data.entries : {}
    } catch {
      loaded = {}
    }
    return loaded
  }
  return {
    path,
    async get(key) {
      // Read again each time: another process may have written since.
      loaded = undefined
      return (await load())[key]
    },
    async set(key, entry) {
      const entries = { ...(await load()), [key]: entry }
      // Keep the newest few: one per profile, region set and week start.
      const kept = Object.entries(entries)
        .sort(([, a], [, b]) => Math.max(b.estimateAt ?? 0, b.billedAt ?? 0) - Math.max(a.estimateAt ?? 0, a.billedAt ?? 0))
        .slice(0, MAX_ENTRIES)
      loaded = Object.fromEntries(kept)
      const text = JSON.stringify({ version: VERSION, entries: loaded })
      writing = writing.then(async () => {
        try {
          await mkdir(dirname(path), { recursive: true })
          const tmp = `${path}.${process.pid}.tmp`
          await writeFile(tmp, text, { mode: 0o600 })
          await rename(tmp, path)
        } catch {}
      })
      return writing
    },
  }
}

/** A store that keeps nothing past the process, for tests. */
export function memoryStore() {
  const m = new Map()
  return { path: "", async get(k) { return m.get(k) }, async set(k, v) { m.set(k, structuredClone(v)) } }
}
