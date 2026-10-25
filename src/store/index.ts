// Process-wide storage handle. MySQL + Redis in production, in-memory doubles for tests and previews.
import { connectMysql, mysqlConfig } from "./mysql.js"
import { createMysqlProviderStores, createMysqlScoreStore, createMysqlServerStore } from "./mysql-stores.js"
import { createMemoryProviderStores, createMemoryScoreStore, createMemoryServerStore } from "./memory.js"
import { connectRedis, createMemoryKv } from "./redis.js"
import type { AppStore } from "./types.js"

export type StoreDriver = "mysql" | "memory"
export type OpenStoreOptions = {
  driver?: StoreDriver
  redisUrl?: string
  /** Connection retry budget; the API starts before MySQL/Redis are ready. */
  attempts?: number
  delayMs?: number
  log?: (message: string) => void
  /** Test-only seeding for the memory driver (e.g. a preference row written by an older version). */
  seed?: { serverPreferences?: Array<[string, string]> }
}

let current: AppStore | null = null
let opening: Promise<AppStore> | null = null

/** Open (or return) the process-wide store. Safe to call from several modules at startup. */
export function openAppStore(options: OpenStoreOptions = {}): Promise<AppStore> {
  if (current) return Promise.resolve(current)
  if (opening) return opening
  opening = (async () => {
    const driver: StoreDriver = options.driver ?? (process.env.STORE_DRIVER?.trim() === "memory" ? "memory" : "mysql")
    const log = options.log ?? ((message: string) => console.warn(message))
    if (driver === "memory") {
      current = {
        driver, scores: createMemoryScoreStore(), servers: createMemoryServerStore({ preferences: options.seed?.serverPreferences }), providers: createMemoryProviderStores(),
        kv: createMemoryKv(), close: async () => { current = null },
      }
      return current
    }
    const attempts = options.attempts ?? Number(process.env.STORE_CONNECT_ATTEMPTS ?? 30)
    const delayMs = options.delayMs ?? Number(process.env.STORE_CONNECT_DELAY_MS ?? 2000)
    const sql = await connectMysql(mysqlConfig(), { attempts, delayMs, log })
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL?.trim() ?? "redis://127.0.0.1:6379/0"
    let redis
    try {
      redis = await connectRedis(redisUrl, { attempts, delayMs, log })
    } catch (error) {
      await sql.close()
      throw error
    }
    const store: AppStore = {
      driver,
      scores: createMysqlScoreStore(sql),
      servers: createMysqlServerStore(sql),
      providers: createMysqlProviderStores(sql),
      kv: redis.kv,
      async close() {
        await Promise.allSettled([sql.close(), redis.close()])
        current = null
      },
    }
    current = store
    return store
  })()
  return opening.finally(() => { opening = null })
}

export function appStore(): AppStore {
  if (!current) throw new Error("存储尚未初始化：启动时需先 await openAppStore()")
  return current
}

/** Shut the pool and Redis down; also used between test files. */
export async function closeAppStore(): Promise<void> {
  const store = current
  current = null
  await store?.close()
}
