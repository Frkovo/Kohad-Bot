// MySQL is the system of record: player imports, server bindings and provider credentials.
// The pool is created once at startup; every statement is parameterised.
import mysql from "mysql2/promise"
import type { RowDataPacket } from "mysql2"

export type MysqlConfig = { host: string; port: number; user: string; password: string; database: string }

/** MYSQL_URL wins; the discrete variables match docker-compose service names. */
export function mysqlConfig(env: NodeJS.ProcessEnv = process.env): MysqlConfig {
  const url = env.MYSQL_URL?.trim()
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
  const port = Number(env.MYSQL_PORT ?? 3306)
  return {
    host: (env.MYSQL_HOST ?? "127.0.0.1").trim(),
    port: Number.isInteger(port) && port > 0 ? port : 3306,
    user: (env.MYSQL_USER ?? "kohad").trim(),
    password: env.MYSQL_PASSWORD ?? "",
    database: (env.MYSQL_DATABASE ?? "kohad").trim() || "kohad",
  }
}

export type Sql = {
  query<T = RowDataPacket>(text: string, params?: unknown[]): Promise<T[]>
  execute(text: string, params?: unknown[]): Promise<number>
  transaction<T>(run: (tx: Sql) => Promise<T>): Promise<T>
  ping(): Promise<void>
  close(): Promise<void>
}

function wrap(connection: { query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]> }, release?: () => void): Sql {
  const query = async <T>(text: string, params: unknown[] = []) => {
    const [rows] = await connection.query(text, params)
    return rows as T[]
  }
  const sql: Sql = {
    query,
    async execute(text, params = []) {
      const [result] = await connection.query(text, params)
      const affected = (result as { affectedRows?: number }).affectedRows
      return typeof affected === "number" ? affected : 0
    },
    async transaction<T>(run: (tx: Sql) => Promise<T>) {
      if (release) throw new Error("nested transactions are not supported")
      return run(sql)
    },
    async ping() { await query("SELECT 1") },
    async close() { release?.() },
  }
  return sql
}

export async function openMysql(config: MysqlConfig): Promise<Sql> {
  const pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: Math.max(2, Math.min(10, Number(process.env.MYSQL_POOL_SIZE ?? 5) || 5)),
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: false,
    supportBigNumbers: true,
  })
  const base = wrap(pool as unknown as { query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]> })
  const sql: Sql = {
    query: base.query,
    execute: base.execute,
    async transaction<T>(run: (tx: Sql) => Promise<T>) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const result = await run(wrap(connection as unknown as { query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]> }))
        await connection.commit()
        return result
      } catch (error) {
        await connection.rollback().catch(() => undefined)
        throw error
      } finally {
        connection.release()
      }
    },
    ping: base.ping,
    close: async () => { await pool.end() },
  }
  return sql
}

// Idempotent DDL. No legacy MySQL schema exists, so CREATE TABLE IF NOT EXISTS is the whole migration.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts(
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    game_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    imported_at VARCHAR(32) NOT NULL,
    icon_id INT NULL,
    nameplate_id INT NULL,
    rating INT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS scores(
    discord_id VARCHAR(32) NOT NULL,
    music_id INT NOT NULL,
    level TINYINT NOT NULL,
    achievement INT NOT NULL,
    dx_score INT NOT NULL,
    fc VARCHAR(8) NOT NULL,
    fs VARCHAR(8) NOT NULL,
    play_count INT NOT NULL,
    PRIMARY KEY(discord_id, music_id, level),
    CONSTRAINT fk_scores_account FOREIGN KEY(discord_id) REFERENCES accounts(discord_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS server_preferences(
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    server VARCHAR(16) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS server_bindings(
    discord_id VARCHAR(32) NOT NULL,
    server VARCHAR(16) NOT NULL,
    revision INT NOT NULL,
    account_key VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    encrypted_auth TEXT NULL,
    last_attempt BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY(discord_id, server)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS server_snapshots(
    discord_id VARCHAR(32) NOT NULL,
    server VARCHAR(16) NOT NULL,
    account_key VARCHAR(255) NOT NULL,
    data LONGTEXT NOT NULL,
    PRIMARY KEY(discord_id, server)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS df_bindings(
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    nickname VARCHAR(255) NOT NULL,
    bound_at VARCHAR(32) NOT NULL,
    refresh_token TEXT NOT NULL,
    scope VARCHAR(255) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS df_import_tokens(
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    token TEXT NOT NULL,
    saved_at VARCHAR(32) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS lxns_bindings(
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    friend_code VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    bound_at VARCHAR(32) NOT NULL,
    method VARCHAR(16) NOT NULL,
    access_token TEXT NULL,
    refresh_token TEXT NULL,
    expires_at BIGINT NULL,
    scope VARCHAR(255) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
] as const

export async function migrateSchema(sql: Sql): Promise<void> {
  for (const statement of SCHEMA) await sql.execute(statement)
}

/** Retry until MySQL accepts connections; the container starts before the database is ready. */
export async function connectMysql(config: MysqlConfig, options: { attempts?: number; delayMs?: number; log?: (message: string) => void } = {}): Promise<Sql> {
  const attempts = Math.max(1, options.attempts ?? 30), delay = Math.max(0, options.delayMs ?? 2000)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let sql: Sql | undefined
    try {
      sql = await openMysql(config)
      await sql.ping()
      await migrateSchema(sql)
      return sql
    } catch (error) {
      lastError = error
      await sql?.close().catch(() => undefined)
      if (attempt === attempts) break
      options.log?.(`[store] MySQL ${config.host}:${config.port}/${config.database} not ready (${(error as Error).message}); retry ${attempt}/${attempts - 1}`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error(`无法连接 MySQL（${config.host}:${config.port}/${config.database}）：${(lastError as Error)?.message ?? "unknown error"}`)
}
