// MySQL implementations of the storage contracts. Player data is the only durable state besides the master key.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import path from "node:path"
import { extractMusicDetails, COMBO, SYNC } from "../df/upload.js"
import { t } from "../messages.js"
import { extractPlayerProfile } from "../local/profile.js"
import { isEnabledServer, requireEnabledServer, UserError, type Credentials, type RemoteServer, type ServerId, type Snapshot } from "../multiserver/registry.js"
import type { MigrateSuccess } from "../migrate-client.js"
import { dataDir } from "./paths.js"
import { loadMasterKey } from "./key.js"
import type { Sql } from "./mysql.js"
import type {
  DfBinding, DfBindingStore, DfImportToken, DfImportTokenStore, LxnsBinding, LxnsBindingStore,
  ProviderStores, ScoreStore, ServerBinding, ServerStore, StoredAccount,
} from "./types.js"

/** AES-256-GCM envelope; the context binds a ciphertext to one user, server and binding revision. */
export function seal(value: Credentials, key: Buffer, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), body: body.toString("base64") })
}
export function unseal(value: string, key: Buffer, context: string): Credentials {
  try {
    const envelope = JSON.parse(value)
    if (envelope.v !== 1) throw new Error()
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
    cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.body, "base64")), cipher.final()]).toString("utf8"))
  } catch { throw new UserError(t("store.decryptFailed")) }
}

const SCORE_BATCH = 200

export function createMysqlScoreStore(sql: Sql): ScoreStore {
  return {
    async save(discordId: string, result: MigrateSuccess) {
      const inputs = extractMusicDetails(result.data.pull)
      const now = new Date().toISOString()
      const profile = extractPlayerProfile(result)
      const gameId = String(result.source.userId)
      await sql.transaction(async tx => {
        const previous = await tx.query<{ game_id: string }>("SELECT game_id FROM accounts WHERE discord_id=?", [discordId])
        // A different game account replaces the old scores so two players are never merged.
        if (previous[0] && previous[0].game_id !== gameId) await tx.execute("DELETE FROM scores WHERE discord_id=?", [discordId])
        await tx.execute(`INSERT INTO accounts(discord_id,game_id,name,imported_at,icon_id,nameplate_id,rating) VALUES(?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE
            icon_id=IF(game_id=VALUES(game_id),COALESCE(VALUES(icon_id),icon_id),VALUES(icon_id)),
            nameplate_id=IF(game_id=VALUES(game_id),COALESCE(VALUES(nameplate_id),nameplate_id),VALUES(nameplate_id)),
            rating=IF(game_id=VALUES(game_id),COALESCE(VALUES(rating),rating),VALUES(rating)),
            game_id=VALUES(game_id),name=VALUES(name),imported_at=VALUES(imported_at)`,
          [discordId, gameId, profile.name, now, profile.iconId ?? null, profile.nameplateId ?? null, profile.rating ?? null])
        const rows: unknown[][] = []
        for (const row of inputs) {
          const d = row as Record<string, unknown>
          const mid = Number(d.musicId), level = mid >= 100000 ? 0 : Number(d.level), achievement = Number(d.achievement)
          if (!(Number.isSafeInteger(mid) && mid > 0 && Number.isInteger(level) && level >= 0 && level <= 4 && Number.isFinite(achievement) && achievement >= 0)) continue
          const count = Number(d.playCount ?? 0), dx = Number(d.deluxscoreMax ?? 0)
          rows.push([discordId, mid, level, Math.floor(achievement), Number.isFinite(dx) ? Math.max(0, Math.floor(dx)) : 0,
            COMBO[Number(d.comboStatus)] ?? "", SYNC[Number(d.syncStatus)] ?? "", Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0])
        }
        for (let start = 0; start < rows.length; start += SCORE_BATCH) {
          const batch = rows.slice(start, start + SCORE_BATCH)
          const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?)").join(",")
          await tx.execute(`INSERT INTO scores(discord_id,music_id,level,achievement,dx_score,fc,fs,play_count) VALUES ${placeholders}
            ON DUPLICATE KEY UPDATE
              achievement=GREATEST(scores.achievement,VALUES(achievement)),
              dx_score=GREATEST(scores.dx_score,VALUES(dx_score)),
              fc=CASE WHEN (CASE VALUES(fc) WHEN 'fc' THEN 1 WHEN 'fcp' THEN 2 WHEN 'ap' THEN 3 WHEN 'app' THEN 4 ELSE 0 END)>
                (CASE scores.fc WHEN 'fc' THEN 1 WHEN 'fcp' THEN 2 WHEN 'ap' THEN 3 WHEN 'app' THEN 4 ELSE 0 END) THEN VALUES(fc) ELSE scores.fc END,
              fs=CASE WHEN (CASE VALUES(fs) WHEN 'sync' THEN 1 WHEN 'fs' THEN 2 WHEN 'fsp' THEN 3 WHEN 'fsd' THEN 4 WHEN 'fsdp' THEN 5 ELSE 0 END)>
                (CASE scores.fs WHEN 'sync' THEN 1 WHEN 'fs' THEN 2 WHEN 'fsp' THEN 3 WHEN 'fsd' THEN 4 WHEN 'fsdp' THEN 5 ELSE 0 END) THEN VALUES(fs) ELSE scores.fs END,
              play_count=GREATEST(scores.play_count,VALUES(play_count))`, batch.flat())
        }
      })
      return this.get(discordId)
    },
    async has(discordId: string) {
      const rows = await sql.query("SELECT 1 FROM accounts WHERE discord_id=?", [discordId])
      return rows.length > 0
    },
    async get(discordId: string) {
      const accounts = await sql.query<{ name: string; game_id: string; imported_at: string; icon_id: number | null; nameplate_id: number | null; rating: number | null }>(
        "SELECT name,game_id,imported_at,icon_id,nameplate_id,rating FROM accounts WHERE discord_id=?", [discordId])
      const account = accounts[0]
      if (!account) return null
      const rows = await sql.query<{ music_id: number; level: number; achievement: number; dx_score: number; fc: string; fs: string; play_count: number }>(
        "SELECT music_id,level,achievement,dx_score,fc,fs,play_count FROM scores WHERE discord_id=?", [discordId])
      const stored: StoredAccount = {
        name: account.name,
        gameId: account.game_id,
        importedAt: account.imported_at,
        profile: {
          name: account.name,
          iconId: account.icon_id == null ? undefined : Number(account.icon_id),
          nameplateId: account.nameplate_id == null ? undefined : Number(account.nameplate_id),
          rating: account.rating == null ? undefined : Number(account.rating),
        },
        inputs: rows.map(row => ({
          musicId: Number(row.music_id), level: Number(row.level), achievement: Number(row.achievement),
          dxScore: Number(row.dx_score), fc: row.fc, fs: row.fs, playCount: Number(row.play_count),
        })),
      }
      return stored
    },
    async close() { /* the shared pool closes once, at shutdown */ },
  }
}

export function createMysqlServerStore(sql: Sql, options: { keyFile?: string; configuredKey?: string } = {}): ServerStore {
  let key: Buffer | undefined
  async function encryptionKey(): Promise<Buffer> {
    if (key) return key
    const keyFile = options.keyFile ?? (process.env.B50_AUTH_KEY_FILE?.trim() || path.join(dataDir(), "binding-master.key"))
    const count = await sql.query<{ n: number | string }>("SELECT COUNT(*) AS n FROM server_bindings WHERE encrypted_auth IS NOT NULL")
    key = loadMasterKey({ configured: options.configuredKey ?? process.env.B50_AUTH_KEY, keyFile, hasEncryptedBindings: Number(count[0]?.n ?? 0) > 0 })
    return key
  }
  const context = (user: string, server: RemoteServer, revision: number) => JSON.stringify([user, server, revision])
  const store: ServerStore = {
    async preferred(user) {
      const value = (await store.savedPreferred(user))
      return value ?? "cn"
    },
    async savedPreferred(user) {
      const rows = await sql.query<{ server: string }>("SELECT server FROM server_preferences WHERE discord_id=?", [user])
      const value = rows[0]?.server
      return isEnabledServer(value) ? value : null
    },
    async boundServers(user) {
      const rows = await sql.query<{ server: string }>("SELECT server FROM server_bindings WHERE discord_id=? AND encrypted_auth IS NOT NULL", [user])
      return rows.map(row => row.server).filter((server): server is RemoteServer => isEnabledServer(server) && server !== "cn")
    },
    async setPreferred(user, server: ServerId) {
      requireEnabledServer(server)
      await sql.execute("INSERT INTO server_preferences(discord_id,server) VALUES(?,?) ON DUPLICATE KEY UPDATE server=VALUES(server)", [user, server])
    },
    async binding(user, server) {
      const rows = await sql.query<{ revision: number; account_key: string; name: string; encrypted_auth: string | null; last_attempt: number }>(
        "SELECT revision,account_key,name,encrypted_auth,last_attempt FROM server_bindings WHERE discord_id=? AND server=?", [user, server])
      const row = rows[0]
      return row ? { revision: Number(row.revision), accountKey: row.account_key, name: row.name, bound: row.encrypted_auth != null, lastAttempt: Number(row.last_attempt) } : null
    },
    async credentials(user, server) {
      const rows = await sql.query<{ revision: number; encrypted_auth: string | null }>(
        "SELECT revision,encrypted_auth FROM server_bindings WHERE discord_id=? AND server=?", [user, server])
      const row = rows[0]
      if (!row?.encrypted_auth) return null
      return unseal(row.encrypted_auth, await encryptionKey(), context(user, server, Number(row.revision)))
    },
    async bind(user, server, accountKey, name, auth, expectedRevision) {
      const previous = await store.binding(user, server)
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new UserError(t("store.revisionChanged"))
      const revision = (previous?.revision ?? 0) + 1
      const encrypted = seal(auth, await encryptionKey(), context(user, server, revision))
      await sql.transaction(async tx => {
        await tx.execute(`INSERT INTO server_bindings(discord_id,server,revision,account_key,name,encrypted_auth,last_attempt) VALUES(?,?,?,?,?,?,0)
          ON DUPLICATE KEY UPDATE revision=VALUES(revision),account_key=VALUES(account_key),name=VALUES(name),encrypted_auth=VALUES(encrypted_auth),last_attempt=0`,
          [user, server, revision, accountKey, name, encrypted])
        if (previous?.accountKey !== accountKey) await tx.execute("DELETE FROM server_snapshots WHERE discord_id=? AND server=?", [user, server])
      })
      return revision
    },
    async updateCredentials(user, server, revision, auth) {
      const encrypted = seal(auth, await encryptionKey(), context(user, server, revision))
      await sql.execute("UPDATE server_bindings SET encrypted_auth=? WHERE discord_id=? AND server=? AND revision=? AND encrypted_auth IS NOT NULL", [encrypted, user, server, revision])
    },
    async unbind(user, server) {
      await sql.execute(`INSERT INTO server_bindings(discord_id,server,revision,account_key,name,encrypted_auth,last_attempt) VALUES(?,?,1,'','',NULL,0)
        ON DUPLICATE KEY UPDATE encrypted_auth=NULL,revision=server_bindings.revision+1`, [user, server])
    },
    async attempt(user, server, revision) {
      await sql.execute("UPDATE server_bindings SET last_attempt=? WHERE discord_id=? AND server=? AND revision=?", [Date.now(), user, server, revision])
    },
    async save(user, server, revision, snapshot: Snapshot) {
      const binding: ServerBinding | null = await store.binding(user, server)
      if (!binding?.bound || binding.revision !== revision || binding.accountKey !== snapshot.accountKey) throw new UserError(t("store.staleSync"))
      await sql.execute("INSERT INTO server_snapshots(discord_id,server,account_key,data) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE account_key=VALUES(account_key),data=VALUES(data)",
        [user, server, snapshot.accountKey, JSON.stringify(snapshot)])
    },
    async snapshot(user, server) {
      const rows = await sql.query<{ data: string }>("SELECT data FROM server_snapshots WHERE discord_id=? AND server=?", [user, server])
      const row = rows[0]
      return row ? JSON.parse(row.data) as Snapshot : null
    },
    async close() { key = undefined },
  }
  return store
}

export function createMysqlProviderStores(sql: Sql): ProviderStores {
  const df: DfBindingStore = {
    async get(userId) {
      const rows = await sql.query<DfBinding>("SELECT nickname,bound_at AS boundAt,refresh_token AS refreshToken,scope FROM df_bindings WHERE discord_id=?", [userId])
      const row = rows[0]
      return row && row.refreshToken ? { nickname: row.nickname, boundAt: row.boundAt, refreshToken: row.refreshToken, scope: row.scope } : null
    },
    async set(userId, binding) {
      await sql.execute(`INSERT INTO df_bindings(discord_id,nickname,bound_at,refresh_token,scope) VALUES(?,?,?,?,?)
        ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),bound_at=VALUES(bound_at),refresh_token=VALUES(refresh_token),scope=VALUES(scope)`,
        [userId, binding.nickname, binding.boundAt, binding.refreshToken, binding.scope])
    },
    async remove(userId) { return (await sql.execute("DELETE FROM df_bindings WHERE discord_id=?", [userId])) > 0 },
  }
  const dfImportTokens: DfImportTokenStore = {
    async get(userId) {
      const rows = await sql.query<DfImportToken>("SELECT token,saved_at AS savedAt FROM df_import_tokens WHERE discord_id=?", [userId])
      return rows[0] ?? null
    },
    async set(userId, token) {
      const savedAt = new Date().toISOString()
      await sql.execute("INSERT INTO df_import_tokens(discord_id,token,saved_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE token=VALUES(token),saved_at=VALUES(saved_at)", [userId, token, savedAt])
    },
    async remove(userId) { return (await sql.execute("DELETE FROM df_import_tokens WHERE discord_id=?", [userId])) > 0 },
  }
  const lxns: LxnsBindingStore = {
    async get(userId) {
      const rows = await sql.query<{ friendCode: string | number; name: string; boundAt: string; method: string; accessToken: string | null; refreshToken: string | null; expiresAt: number | null; scope: string | null }>(
        `SELECT friend_code AS friendCode,name,bound_at AS boundAt,method,access_token AS accessToken,refresh_token AS refreshToken,expires_at AS expiresAt,scope
         FROM lxns_bindings WHERE discord_id=?`, [userId])
      const row = rows[0]
      if (!row) return null
      const binding: LxnsBinding = { friendCode: row.friendCode, name: row.name, boundAt: row.boundAt, method: row.method === "oauth" ? "oauth" : "friend_code" }
      if (binding.method === "oauth") {
        binding.accessToken = row.accessToken ?? undefined
        binding.refreshToken = row.refreshToken ?? undefined
        binding.expiresAt = row.expiresAt == null ? undefined : Number(row.expiresAt)
        binding.scope = row.scope ?? undefined
      }
      return binding
    },
    async set(userId, binding) {
      await sql.execute(`INSERT INTO lxns_bindings(discord_id,friend_code,name,bound_at,method,access_token,refresh_token,expires_at,scope) VALUES(?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE friend_code=VALUES(friend_code),name=VALUES(name),bound_at=VALUES(bound_at),method=VALUES(method),
          access_token=VALUES(access_token),refresh_token=VALUES(refresh_token),expires_at=VALUES(expires_at),scope=VALUES(scope)`,
        [userId, String(binding.friendCode), binding.name, binding.boundAt, binding.method,
          binding.method === "oauth" ? binding.accessToken ?? null : null,
          binding.method === "oauth" ? binding.refreshToken ?? null : null,
          binding.method === "oauth" ? binding.expiresAt ?? null : null,
          binding.method === "oauth" ? binding.scope ?? null : null])
    },
    async remove(userId) { return (await sql.execute("DELETE FROM lxns_bindings WHERE discord_id=?", [userId])) > 0 },
    async size() {
      const rows = await sql.query<{ n: number | string }>("SELECT COUNT(*) AS n FROM lxns_bindings")
      return Number(rows[0]?.n ?? 0)
    },
  }
  return { df, dfImportTokens, lxns }
}
