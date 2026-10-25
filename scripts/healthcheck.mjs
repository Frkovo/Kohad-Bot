// Container healthcheck: the bot is useful only when both MySQL and Redis answer.
// Kept independent of dist/ so it also works on the build stage. Exit code 0 = healthy.
import { createConnection } from "mysql2/promise"
import { Redis } from "ioredis"

function mysqlSettings() {
  const url = process.env.MYSQL_URL?.trim()
  if (url) {
    const parsed = new URL(url)
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username) || "kohad",
      password: decodeURIComponent(parsed.password),
      database: (parsed.pathname || "/kohad").replace(/^\//, "") || "kohad",
    }
  }
  return {
    host: (process.env.MYSQL_HOST ?? "127.0.0.1").trim(),
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: (process.env.MYSQL_USER ?? "kohad").trim(),
    password: process.env.MYSQL_PASSWORD ?? "",
    database: (process.env.MYSQL_DATABASE ?? "kohad").trim() || "kohad",
  }
}

const checks = {
  async mysql() {
    const connection = await createConnection({ ...mysqlSettings(), connectTimeout: 4000 })
    try { await connection.query("SELECT 1") } finally { await connection.end() }
  },
  async redis() {
    const client = new Redis(process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379/0", {
      lazyConnect: true, connectTimeout: 4000, maxRetriesPerRequest: 1, retryStrategy: () => null,
    })
    try { await client.connect(); await client.ping() } finally { client.disconnect() }
  },
}

let failed = false
for (const [name, check] of Object.entries(checks)) {
  try { await check() }
  catch (error) { failed = true; console.error(`[healthcheck] ${name}: ${error.message}`) }
}
process.exit(failed ? 1 : 0)
