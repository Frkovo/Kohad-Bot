// Shared short-lived state in Redis: scan cooldown, QR de-duplication and 水鱼 token cache.
// Everything here is disposable; losing Redis only costs an extra login, never player data.
import { Redis } from "ioredis"
import type { Kv } from "./types.js"

export type RedisHandle = { kv: Kv; ping: () => Promise<void>; close: () => Promise<void> }

/** Keys are prefixed and short so several bots can share one Redis database. */
export const kvKeys = {
  cooldown: (user: string) => `bot:cooldown:${user}`,
  scanDigest: (digest: string) => `bot:scan:digest:${digest}`,
  scanUser: (user: string) => `bot:scan:user:${user}`,
  dfToken: (externalId: string) => `bot:df:token:${externalId}`,
  dfLegacyToken: (cacheKey: string) => `bot:df:legacy:${cacheKey}`,
}

export function createRedis(url: string, options: { retries?: number; log?: (message: string) => void } = {}): RedisHandle {
  const retries = Math.max(1, options.retries ?? 10)
  const client = new Redis(url, {
    // Fail fast instead of queueing commands forever when Redis is down; the bot is useless without it.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10_000,
    retryStrategy: times => (times > retries ? null : Math.min(times * 200, 2000)),
  })
  client.on("error", error => {
    const message = `[store] redis: ${(error as Error).message}`
    if (options.log) options.log(message)
    else console.error(message)
  })
  const kv: Kv = {
    async get(key) { return client.get(key) },
    async set(key, value, ttlMs) {
      if (ttlMs) await client.set(key, value, "PX", Math.max(1, Math.floor(ttlMs)))
      else await client.set(key, value)
    },
    async setIfAbsent(key, value, ttlMs) {
      const result = await client.set(key, value, "PX", Math.max(1, Math.floor(ttlMs)), "NX")
      return result === "OK"
    },
    async pttl(key) { return client.pttl(key) },
    async del(key) { await client.del(key) },
    async delByPrefix(prefix) {
      let cursor = "0"
      do {
        const [next, keys] = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200)
        if (keys.length) await client.del(...keys)
        cursor = next
      } while (cursor !== "0")
    },
    async close() { await client.quit().catch(() => client.disconnect()) },
  }
  return { kv, ping: async () => { await client.ping() }, close: () => kv.close() }
}

/** Connect with bounded retries so a slow container start does not kill the bot process. */
export async function connectRedis(url: string, options: { attempts?: number; delayMs?: number; log?: (message: string) => void } = {}): Promise<RedisHandle> {
  const attempts = Math.max(1, options.attempts ?? 30), delay = Math.max(0, options.delayMs ?? 2000)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const handle = createRedis(url, { log: options.log })
    try {
      await Promise.race([
        handle.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000).unref()),
      ])
      return handle
    } catch (error) {
      lastError = error
      await handle.close().catch(() => undefined)
      if (attempt === attempts) break
      options.log?.(`[store] Redis ${url} not ready (${(error as Error).message}); retry ${attempt}/${attempts - 1}`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error(`无法连接 Redis（${url}）：${(lastError as Error)?.message ?? "unknown error"}`)
}

/** In-memory Kv for tests and the preview scripts; never used when Redis is configured. */
export function createMemoryKv(now: () => number = Date.now): Kv {
  const entries = new Map<string, { value: string; expiresAt: number | null }>()
  const alive = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== null && entry.expiresAt <= now()) { entries.delete(key); return undefined }
    return entry
  }
  return {
    async get(key) { return alive(key)?.value ?? null },
    async set(key, value, ttlMs) { entries.set(key, { value, expiresAt: ttlMs ? now() + ttlMs : null }) },
    async setIfAbsent(key, value, ttlMs) {
      if (alive(key)) return false
      entries.set(key, { value, expiresAt: now() + ttlMs }); return true
    },
    async pttl(key) {
      const entry = alive(key)
      if (!entry) return -2
      return entry.expiresAt === null ? -1 : Math.max(0, entry.expiresAt - now())
    },
    async del(key) { entries.delete(key) },
    async delByPrefix(prefix) { for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key) },
    async close() { entries.clear() },
  }
}
