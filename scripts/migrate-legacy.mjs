// One-off migration from the SQLite + JSON layout (pre-Docker) to MySQL.
// Reads .data/scores.sqlite, df-bindings.json, df-import-tokens.json, lxns-bindings.json and re-seals the
// encrypted server credentials with the target key. Safe to re-run: scores merge by max, existing rows win.
//
// Usage (run where Node >= 22 and node:sqlite is available, e.g. inside the bot container):
//   MYSQL_URL=mysql://user:pass@host:3306/kohad \
//   node scripts/migrate-legacy.mjs --data-dir /legacy --new-key-file /app/.data/binding-master.key
//   ... --dry-run   only print what would be migrated
//
// Never prints credentials, tokens or key material.
import { DatabaseSync } from "node:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import path from "node:path"
import mysql from "mysql2/promise"

const args = process.argv.slice(2)
const arg = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const dryRun = args.includes("--dry-run")
const dataDir = path.resolve(arg("data-dir", ".data"))
const newKeyFile = arg("new-key-file")
const legacyKeyFile = path.resolve(arg("old-key-file", path.join(dataDir, "binding-master.key")))

const config = (() => {
  const url = process.env.MYSQL_URL?.trim()
  if (url) {
    const parsed = new URL(url)
    return {
      host: parsed.hostname || "127.0.0.1", port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username) || "kohad", password: decodeURIComponent(parsed.password),
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
})()

const COMBO = ["", "fc", "fcp", "ap", "app"]
void COMBO // kept for readers: fc strings are copied verbatim, the mapping index is not needed

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return null }
}
function keyFrom(envName, file) {
  const configured = process.env[envName]?.trim()
  if (configured) {
    const key = Buffer.from(configured, "base64")
    if (key.length !== 32) throw new Error(`${envName} 不是 32 字节 Base64`)
    return key
  }
  if (!file || !existsSync(file)) return null
  const key = readFileSync(file)
  if (key.length !== 32) throw new Error(`${file} 不是 32 字节密钥`)
  return key
}
function unseal(value, key, context) {
  const envelope = JSON.parse(value)
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.body, "base64")), decipher.final()]).toString("utf8"))
}
function seal(value, key, context) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), body: body.toString("base64") })
}

async function main() {
  const sqliteFile = path.join(dataDir, "scores.sqlite")
  if (!existsSync(sqliteFile)) throw new Error(`找不到旧数据库：${sqliteFile}`)
  const oldKey = keyFrom("LEGACY_B50_AUTH_KEY", legacyKeyFile)
  const newKey = keyFrom("B50_AUTH_KEY", newKeyFile) ?? oldKey
  if (!newKey) throw new Error("缺少目标密钥：设置 B50_AUTH_KEY 或 --new-key-file")
  const db = new DatabaseSync(sqliteFile, { readOnly: true })
  // --dry-run parses and re-seals the legacy data without touching MySQL.
  const connection = dryRun ? null : await mysql.createConnection(config)
  const counts = { accounts: 0, accountSkipped: 0, scores: 0, preferences: 0, bindings: 0, bindingConflicts: 0, snapshots: 0, df: 0, dfTokens: 0, lxns: 0, lxnsConflicts: 0 }
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
    if (!tables.has("accounts")) throw new Error("旧数据库没有 accounts 表，可能不是本项目的数据库")

    const has = async (text, params) => !!connection && (await connection.query(text, params))[0].length > 0
    const run = async (text, params) => {
      if (!connection) return
      await connection.query(text, params)
    }

    const accounts = db.prepare("SELECT * FROM accounts").all()
    for (const account of accounts) {
      const discordId = String(account.discord_id), gameId = String(account.game_id)
      const previous = connection ? await connection.query("SELECT game_id, imported_at FROM accounts WHERE discord_id=?", [discordId]) : [[]]
      const existing = previous[0][0]
      // The target already imported a different (or newer) game account: that is the player's current data,
      // so keep it and do not replace it with an older snapshot from the legacy machine.
      if (existing && existing.game_id !== gameId && String(existing.imported_at) > String(account.imported_at)) {
        counts.accountSkipped++
        continue
      }
      const ownsDifferentAccount = existing && existing.game_id !== gameId
      if (ownsDifferentAccount) await connection.query("DELETE FROM scores WHERE discord_id=?", [discordId])
      await run(`INSERT INTO accounts(discord_id,game_id,name,imported_at,icon_id,nameplate_id,rating) VALUES(?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          icon_id=IF(game_id=VALUES(game_id),COALESCE(VALUES(icon_id),icon_id),VALUES(icon_id)),
          nameplate_id=IF(game_id=VALUES(game_id),COALESCE(VALUES(nameplate_id),nameplate_id),VALUES(nameplate_id)),
          rating=IF(game_id=VALUES(game_id),COALESCE(VALUES(rating),rating),VALUES(rating)),
          game_id=VALUES(game_id),name=VALUES(name),imported_at=VALUES(imported_at)`,
        [discordId, gameId, String(account.name), String(account.imported_at), account.icon_id ?? null, account.nameplate_id ?? null, account.rating ?? null])
      counts.accounts++

      const rows = db.prepare("SELECT * FROM scores WHERE discord_id=?").all(discordId)
      const detail = (row) => {
        const musicId = Number(row.music_id), level = Number(row.level)
        return [discordId, musicId, level, Number(row.achievement), Number(row.dx_score),
          String(row.fc ?? ""), String(row.fs ?? ""), Number(row.play_count)]
      }
      for (let start = 0; start < rows.length; start += 200) {
        const batch = rows.slice(start, start + 200).map(detail)
        if (!batch.length) break
        const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?)").join(",")
        await run(`INSERT INTO scores(discord_id,music_id,level,achievement,dx_score,fc,fs,play_count) VALUES ${placeholders}
          ON DUPLICATE KEY UPDATE
            achievement=GREATEST(scores.achievement,VALUES(achievement)),
            dx_score=GREATEST(scores.dx_score,VALUES(dx_score)),
            fc=CASE WHEN (CASE VALUES(fc) WHEN 'fc' THEN 1 WHEN 'fcp' THEN 2 WHEN 'ap' THEN 3 WHEN 'app' THEN 4 ELSE 0 END)>
              (CASE scores.fc WHEN 'fc' THEN 1 WHEN 'fcp' THEN 2 WHEN 'ap' THEN 3 WHEN 'app' THEN 4 ELSE 0 END) THEN VALUES(fc) ELSE scores.fc END,
            fs=CASE WHEN (CASE VALUES(fs) WHEN 'sync' THEN 1 WHEN 'fs' THEN 2 WHEN 'fsp' THEN 3 WHEN 'fsd' THEN 4 WHEN 'fsdp' THEN 5 ELSE 0 END)>
              (CASE scores.fs WHEN 'sync' THEN 1 WHEN 'fs' THEN 2 WHEN 'fsp' THEN 3 WHEN 'fsd' THEN 4 WHEN 'fsdp' THEN 5 ELSE 0 END) THEN VALUES(fs) ELSE scores.fs END,
            play_count=GREATEST(scores.play_count,VALUES(play_count))`, batch.flat())
        counts.scores += batch.length
      }
    }

    if (tables.has("server_preferences")) {
      for (const row of db.prepare("SELECT * FROM server_preferences").all()) {
        await run("INSERT INTO server_preferences(discord_id,server) VALUES(?,?) ON DUPLICATE KEY UPDATE server=VALUES(server)", [String(row.discord_id), String(row.server)])
        counts.preferences++
      }
    }

    if (tables.has("server_bindings")) {
      for (const row of db.prepare("SELECT * FROM server_bindings").all()) {
        const user = String(row.discord_id), server = String(row.server), revision = Number(row.revision)
        const exists = await has("SELECT 1 FROM server_bindings WHERE discord_id=? AND server=?", [user, server])
        if (exists) { counts.bindingConflicts++; continue }
        let encrypted = row.encrypted_auth == null ? null : String(row.encrypted_auth)
        if (encrypted) {
          if (!oldKey) throw new Error("旧数据含有加密凭据，但找不到旧密钥（LEGACY_B50_AUTH_KEY 或 --old-key-file）")
          encrypted = seal(unseal(encrypted, oldKey, JSON.stringify([user, server, revision])), newKey, JSON.stringify([user, server, revision]))
          // Fail loudly here rather than leaving a binding the target cannot decrypt.
          unseal(encrypted, newKey, JSON.stringify([user, server, revision]))
        }
        await run(`INSERT INTO server_bindings(discord_id,server,revision,account_key,name,encrypted_auth,last_attempt) VALUES(?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE revision=VALUES(revision),account_key=VALUES(account_key),name=VALUES(name),encrypted_auth=VALUES(encrypted_auth),last_attempt=VALUES(last_attempt)`,
          [user, server, revision, String(row.account_key ?? ""), String(row.name ?? ""), encrypted, Number(row.last_attempt ?? 0)])
        counts.bindings++
      }
    }

    if (tables.has("server_snapshots")) {
      for (const row of db.prepare("SELECT * FROM server_snapshots").all()) {
        await run("INSERT INTO server_snapshots(discord_id,server,account_key,data) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE account_key=VALUES(account_key),data=VALUES(data)",
          [String(row.discord_id), String(row.server), String(row.account_key), String(row.data)])
        counts.snapshots++
      }
    }

    const dfBindings = readJson(path.join(dataDir, "df-bindings.json")) ?? {}
    for (const [user, value] of Object.entries(dfBindings)) {
      if (!value || typeof value.refreshToken !== "string" || !value.refreshToken) continue
      if (await has("SELECT 1 FROM df_bindings WHERE discord_id=?", [user])) continue
      await run("INSERT INTO df_bindings(discord_id,nickname,bound_at,refresh_token,scope) VALUES(?,?,?,?,?)",
        [user, String(value.nickname ?? ""), String(value.boundAt ?? ""), value.refreshToken, String(value.scope ?? "")])
      counts.df++
    }

    const importTokens = readJson(path.join(dataDir, "df-import-tokens.json")) ?? {}
    for (const [user, value] of Object.entries(importTokens)) {
      if (!value || typeof value.token !== "string" || !value.token) continue
      if (await has("SELECT 1 FROM df_import_tokens WHERE discord_id=?", [user])) continue
      await run("INSERT INTO df_import_tokens(discord_id,token,saved_at) VALUES(?,?,?)", [user, value.token, String(value.savedAt ?? "")])
      counts.dfTokens++
    }

    const lxns = readJson(path.join(dataDir, "lxns-bindings.json")) ?? {}
    for (const [user, value] of Object.entries(lxns)) {
      if (!value || !/^\d{15}$/.test(String(value.friendCode))) continue
      if (await has("SELECT 1 FROM lxns_bindings WHERE discord_id=?", [user])) { counts.lxnsConflicts++; continue }
      const oauth = value.method === "oauth"
      await run(`INSERT INTO lxns_bindings(discord_id,friend_code,name,bound_at,method,access_token,refresh_token,expires_at,scope) VALUES(?,?,?,?,?,?,?,?,?)`,
        [user, String(value.friendCode), String(value.name ?? ""), String(value.boundAt ?? ""), oauth ? "oauth" : "friend_code",
          oauth ? value.accessToken ?? null : null, oauth ? value.refreshToken ?? null : null, oauth ? value.expiresAt ?? null : null, oauth ? value.scope ?? null : null])
      counts.lxns++
    }

    console.log(`${dryRun ? "[dry-run] " : ""}迁移完成：${JSON.stringify(counts)}`)
    if (counts.bindingConflicts) console.log(`注意：${counts.bindingConflicts} 条远程服绑定在目标库已存在，已保留目标库版本。`)
    if (counts.accountSkipped) console.log(`注意：${counts.accountSkipped} 个 Discord 用户在目标库已有更新的游戏账号，已保留目标数据。`)
    if (counts.lxnsConflicts) console.log(`注意：${counts.lxnsConflicts} 条落雪绑定在目标库已存在，已保留目标库版本。`)
  } finally {
    db.close()
    await connection?.end()
  }
}

main().catch(error => { console.error(`[migrate] 失败：${error.message}`); process.exitCode = 1 })
