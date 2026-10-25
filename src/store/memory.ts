// In-memory doubles used by the test suite (and the offline preview scripts).
// They mirror the MySQL semantics, including revision checks and score merging, so flow tests stay meaningful.
import { randomBytes } from "node:crypto"
import { COMBO, SYNC, extractMusicDetails } from "../df/upload.js"
import { t } from "../messages.js"
import { extractPlayerProfile } from "../local/profile.js"
import { isEnabledServer, requireEnabledServer, UserError, type Credentials, type RemoteServer, type ServerId, type Snapshot } from "../multiserver/registry.js"
import type { MigrateSuccess } from "../migrate-client.js"
import { seal, unseal } from "./mysql-stores.js"
import type {
  DfBinding, DfBindingStore, DfImportToken, DfImportTokenStore, LxnsBinding, LxnsBindingStore,
  ProviderStores, ScoreStore, ServerBinding, ServerStore, StoredAccount,
} from "./types.js"

type AccountRow = { name: string; gameId: string; importedAt: string; profile: StoredAccount["profile"] }
type ScoreRow = { achievement: number; dxScore: number; fc: string; fs: string; playCount: number }
const comboRank = (fc: string) => ({ fc: 1, fcp: 2, ap: 3, app: 4 })[fc as "fc"] ?? 0
const syncRank = (fs: string) => ({ sync: 1, fs: 2, fsp: 3, fsd: 4, fsdp: 5 })[fs as "sync"] ?? 0
const scoreKey = (musicId: number, level: number) => `${musicId}:${level}`

export function createMemoryScoreStore(): ScoreStore {
  const accounts = new Map<string, AccountRow>()
  const scores = new Map<string, Map<string, ScoreRow>>()
  const store: ScoreStore = {
    async save(discordId: string, result: MigrateSuccess) {
      const profile = extractPlayerProfile(result), gameId = String(result.source.userId)
      const previous = accounts.get(discordId)
      if (previous && previous.gameId !== gameId) scores.delete(discordId)
      accounts.set(discordId, {
        name: profile.name, gameId, importedAt: new Date().toISOString(),
        profile: { name: profile.name, iconId: profile.iconId, nameplateId: profile.nameplateId, rating: profile.rating },
      })
      const rows = scores.get(discordId) ?? new Map<string, ScoreRow>()
      for (const row of extractMusicDetails(result.data.pull)) {
        const d = row as Record<string, unknown>
        const mid = Number(d.musicId), level = mid >= 100000 ? 0 : Number(d.level), achievement = Number(d.achievement)
        if (!(Number.isSafeInteger(mid) && mid > 0 && Number.isInteger(level) && level >= 0 && level <= 4 && Number.isFinite(achievement) && achievement >= 0)) continue
        const count = Number(d.playCount ?? 0), dx = Number(d.deluxscoreMax ?? 0)
        const next: ScoreRow = {
          achievement: Math.floor(achievement),
          dxScore: Number.isFinite(dx) ? Math.max(0, Math.floor(dx)) : 0,
          fc: COMBO[Number(d.comboStatus)] ?? "",
          fs: SYNC[Number(d.syncStatus)] ?? "",
          playCount: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
        }
        const key = scoreKey(mid, level), current = rows.get(key)
        rows.set(key, current ? {
          achievement: Math.max(current.achievement, next.achievement),
          dxScore: Math.max(current.dxScore, next.dxScore),
          fc: comboRank(next.fc) > comboRank(current.fc) ? next.fc : current.fc,
          fs: syncRank(next.fs) > syncRank(current.fs) ? next.fs : current.fs,
          playCount: Math.max(current.playCount, next.playCount),
        } : next)
      }
      scores.set(discordId, rows)
      return store.get(discordId)
    },
    async has(discordId) { return accounts.has(discordId) },
    async get(discordId) {
      const account = accounts.get(discordId)
      if (!account) return null
      const rows = scores.get(discordId) ?? new Map<string, ScoreRow>()
      return {
        name: account.name, gameId: account.gameId, importedAt: account.importedAt, profile: { ...account.profile },
        inputs: [...rows.entries()].map(([key, row]) => {
          const [musicId, level] = key.split(":").map(Number)
          return { musicId, level, achievement: row.achievement, dxScore: row.dxScore, fc: row.fc, fs: row.fs, playCount: row.playCount }
        }),
      }
    },
    async close() { /* memory stores live as long as the AppStore */ },
  }
  return store
}

export function createMemoryServerStore(options: { key?: Buffer; preferences?: Array<[string, string]> } = {}): ServerStore {
  const preferences = new Map<string, ServerId>((options.preferences ?? []) as Array<[string, ServerId]>)
  const bindings = new Map<string, { revision: number; accountKey: string; name: string; encrypted: string | null; lastAttempt: number }>()
  const snapshots = new Map<string, Snapshot>()
  const key = options.key ?? randomBytes(32)
  const bindingKey = (user: string, server: string) => `${user}|${server}`
  const context = (user: string, server: RemoteServer, revision: number) => JSON.stringify([user, server, revision])
  const store: ServerStore = {
    async preferred(user) { return (await store.savedPreferred(user)) ?? "cn" },
    async savedPreferred(user) {
      const value = preferences.get(user)
      return isEnabledServer(value) ? value : null
    },
    async boundServers(user) {
      return [...bindings.entries()]
        .filter(([k, v]) => k.startsWith(`${user}|`) && v.encrypted !== null)
        .map(([k]) => k.slice(user.length + 1))
        .filter((server): server is RemoteServer => isEnabledServer(server) && server !== "cn")
    },
    async setPreferred(user, server) { requireEnabledServer(server); preferences.set(user, server) },
    async binding(user, server) {
      const row = bindings.get(bindingKey(user, server))
      return row ? { revision: row.revision, accountKey: row.accountKey, name: row.name, bound: row.encrypted !== null, lastAttempt: row.lastAttempt } as ServerBinding : null
    },
    async credentials(user, server) {
      const row = bindings.get(bindingKey(user, server))
      if (!row?.encrypted) return null
      return unseal(row.encrypted, key, context(user, server, row.revision))
    },
    async bind(user, server, accountKey, name, auth: Credentials, expectedRevision) {
      const previous = await store.binding(user, server)
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new UserError(t("store.revisionChanged"))
      const revision = (previous?.revision ?? 0) + 1
      bindings.set(bindingKey(user, server), { revision, accountKey, name, encrypted: seal(auth, key, context(user, server, revision)), lastAttempt: 0 })
      if (previous?.accountKey !== accountKey) snapshots.delete(bindingKey(user, server))
      return revision
    },
    async updateCredentials(user, server, revision, auth) {
      const row = bindings.get(bindingKey(user, server))
      if (!row || row.revision !== revision || row.encrypted === null) return
      row.encrypted = seal(auth, key, context(user, server, revision))
    },
    async unbind(user, server) {
      const current = bindings.get(bindingKey(user, server))
      bindings.set(bindingKey(user, server), { revision: (current?.revision ?? 0) + 1, accountKey: "", name: "", encrypted: null, lastAttempt: 0 })
    },
    async attempt(user, server, revision) {
      const row = bindings.get(bindingKey(user, server))
      if (row && row.revision === revision) row.lastAttempt = Date.now()
    },
    async save(user, server, revision, snapshot: Snapshot) {
      const binding = await store.binding(user, server)
      if (!binding?.bound || binding.revision !== revision || binding.accountKey !== snapshot.accountKey) throw new UserError(t("store.staleSync"))
      snapshots.set(bindingKey(user, server), snapshot)
    },
    async snapshot(user, server) { return snapshots.get(bindingKey(user, server)) ?? null },
    async close() { /* memory stores live as long as the AppStore */ },
  }
  return store
}

export function createMemoryProviderStores(): ProviderStores {
  const dfBindings = new Map<string, DfBinding>()
  const importTokens = new Map<string, DfImportToken>()
  const lxns = new Map<string, LxnsBinding>()
  const df: DfBindingStore = {
    async get(userId) { return dfBindings.get(userId) ?? null },
    async set(userId, binding) { dfBindings.set(userId, binding) },
    async remove(userId) { return dfBindings.delete(userId) },
  }
  const dfImportTokens: DfImportTokenStore = {
    async get(userId) { return importTokens.get(userId) ?? null },
    async set(userId, token) { importTokens.set(userId, { token, savedAt: new Date().toISOString() }) },
    async remove(userId) { return importTokens.delete(userId) },
  }
  const lxnsStore: LxnsBindingStore = {
    async get(userId) { return lxns.get(userId) ?? null },
    async set(userId, binding) { lxns.set(userId, binding) },
    async remove(userId) { return lxns.delete(userId) },
    async size() { return lxns.size },
  }
  return { df, dfImportTokens, lxns: lxnsStore }
}
