// Only whitelisted score fields are stored; no QR, session, cookie or raw migration package.
import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { MigrateSuccess } from "../migrate-client.js"
import { extractMusicDetails, COMBO, SYNC } from "../df/upload.js"
import type { B50Input } from "../b50/compute.js"
import { extractPlayerProfile, type PlayerProfile } from "./profile.js"

const DEFAULT = fileURLToPath(new URL("../../.data/scores.sqlite", import.meta.url))

export function createScoreDatabase(file = DEFAULT) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts(discord_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, name TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scores(discord_id TEXT NOT NULL, music_id INTEGER NOT NULL, level INTEGER NOT NULL,
      achievement INTEGER NOT NULL, dx_score INTEGER NOT NULL, fc TEXT NOT NULL, fs TEXT NOT NULL, play_count INTEGER NOT NULL,
      PRIMARY KEY(discord_id,music_id,level), FOREIGN KEY(discord_id) REFERENCES accounts(discord_id) ON DELETE CASCADE);`)
  const columns = new Set(db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name))
  for (const column of ["icon_id", "nameplate_id", "rating"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE accounts ADD COLUMN ${column} INTEGER`)
  }
  return {
    save(discordId: string, result: MigrateSuccess) {
      const inputs = extractMusicDetails(result.data.pull)
      const now = new Date().toISOString()
      const profile = extractPlayerProfile(result)
      db.exec("BEGIN IMMEDIATE")
      try {
        const old = db.prepare("SELECT game_id FROM accounts WHERE discord_id=?").get(discordId)
        if (old && old.game_id !== String(result.source.userId)) db.prepare("DELETE FROM scores WHERE discord_id=?").run(discordId)
        db.prepare(`INSERT INTO accounts(discord_id,game_id,name,imported_at,icon_id,nameplate_id,rating) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(discord_id) DO UPDATE SET game_id=excluded.game_id,name=excluded.name,imported_at=excluded.imported_at,
          icon_id=CASE WHEN accounts.game_id=excluded.game_id THEN COALESCE(excluded.icon_id,accounts.icon_id) ELSE excluded.icon_id END,
          nameplate_id=CASE WHEN accounts.game_id=excluded.game_id THEN COALESCE(excluded.nameplate_id,accounts.nameplate_id) ELSE excluded.nameplate_id END,
          rating=CASE WHEN accounts.game_id=excluded.game_id THEN COALESCE(excluded.rating,accounts.rating) ELSE excluded.rating END`)
          .run(discordId, String(result.source.userId), profile.name, now, profile.iconId ?? null, profile.nameplateId ?? null, profile.rating ?? null)
        const insert = db.prepare(`INSERT INTO scores VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(discord_id,music_id,level) DO UPDATE SET
          achievement=MAX(scores.achievement,excluded.achievement),dx_score=MAX(scores.dx_score,excluded.dx_score),
          fc=CASE WHEN (CASE excluded.fc WHEN 'fc' THEN 1 WHEN 'fcp' THEN 2 WHEN 'ap' THEN 3 WHEN 'app' THEN 4 ELSE 0 END)>
            (CASE scores.fc WHEN 'fc' THEN 1 WHEN 'fcp' THEN 2 WHEN 'ap' THEN 3 WHEN 'app' THEN 4 ELSE 0 END) THEN excluded.fc ELSE scores.fc END,
          fs=CASE WHEN (CASE excluded.fs WHEN 'sync' THEN 1 WHEN 'fs' THEN 2 WHEN 'fsp' THEN 3 WHEN 'fsd' THEN 4 WHEN 'fsdp' THEN 5 ELSE 0 END)>
            (CASE scores.fs WHEN 'sync' THEN 1 WHEN 'fs' THEN 2 WHEN 'fsp' THEN 3 WHEN 'fsd' THEN 4 WHEN 'fsdp' THEN 5 ELSE 0 END) THEN excluded.fs ELSE scores.fs END,
          play_count=MAX(scores.play_count,excluded.play_count)`)
        for (const row of inputs) {
          const d = row as Record<string, unknown>
          const mid = Number(d.musicId), level = mid >= 100000 ? 0 : Number(d.level), achievement = Number(d.achievement)
          if (!(Number.isSafeInteger(mid) && mid > 0 && Number.isInteger(level) && level >= 0 && level <= 4 && Number.isFinite(achievement) && achievement >= 0)) continue
          const count = Number(d.playCount ?? 0), dx = Number(d.deluxscoreMax ?? 0)
          insert.run(discordId, mid, level, Math.floor(achievement), Number.isFinite(dx) ? Math.max(0, Math.floor(dx)) : 0,
            COMBO[Number(d.comboStatus)] ?? "", SYNC[Number(d.syncStatus)] ?? "", Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0)
        }
        db.exec("COMMIT")
      } catch (e) { db.exec("ROLLBACK"); throw e }
      return this.get(discordId)
    },
    get(discordId: string): { name: string; gameId: string; importedAt: string; profile: PlayerProfile; inputs: B50Input[] } | null {
      const account = db.prepare("SELECT * FROM accounts WHERE discord_id=?").get(discordId)
      if (!account) return null
      const rows = db.prepare("SELECT * FROM scores WHERE discord_id=?").all(discordId)
      return { name: String(account.name), gameId: String(account.game_id), importedAt: String(account.imported_at),
        profile: { name: String(account.name), iconId: account.icon_id == null ? undefined : Number(account.icon_id),
          nameplateId: account.nameplate_id == null ? undefined : Number(account.nameplate_id), rating: account.rating == null ? undefined : Number(account.rating) }, inputs: rows.map(r => ({
        musicId: Number(r.music_id), level: Number(r.level), achievement: Number(r.achievement), dxScore: Number(r.dx_score),
        fc: String(r.fc), fs: String(r.fs), playCount: Number(r.play_count),
      })) }
    },
    close() { db.close() },
  }
}
let instance: ReturnType<typeof createScoreDatabase> | null = null
export function scoreDatabase() { return instance ??= createScoreDatabase(process.env.LOCAL_SCORE_DB || DEFAULT) }
