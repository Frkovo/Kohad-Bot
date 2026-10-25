// Storage contracts: MySQL keeps durable player data, Redis keeps shared short-lived state.
// Every method is async so the same interfaces fit MySQL, Redis and the in-memory test doubles.
import type { B50Input } from "../b50/compute.js"
import type { PlayerProfile } from "../local/profile.js"
import type { MigrateSuccess } from "../migrate-client.js"
import type { Credentials, RemoteServer, ServerId, Snapshot } from "../multiserver/registry.js"

/** One Discord user's latest imported account, as rendered by /b50. */
export type StoredAccount = { name: string; gameId: string; importedAt: string; profile: PlayerProfile; inputs: B50Input[] }
export type ScoreStore = {
  /** Replace-or-merge the account and its scores in one transaction; returns the merged account. */
  save(discordId: string, result: MigrateSuccess): Promise<StoredAccount | null>
  has(discordId: string): Promise<boolean>
  get(discordId: string): Promise<StoredAccount | null>
  close(): Promise<void>
}

export type ServerBinding = { revision: number; accountKey: string; name: string; bound: boolean; lastAttempt: number }
export type ServerStore = {
  preferred(user: string): Promise<ServerId>
  savedPreferred(user: string): Promise<ServerId | null>
  /** Servers with live credentials; unbound servers keep their snapshot but do not count. */
  boundServers(user: string): Promise<RemoteServer[]>
  setPreferred(user: string, server: ServerId): Promise<void>
  binding(user: string, server: RemoteServer): Promise<ServerBinding | null>
  credentials(user: string, server: RemoteServer): Promise<Credentials | null>
  bind(user: string, server: RemoteServer, accountKey: string, name: string, auth: Credentials, expectedRevision?: number): Promise<number>
  updateCredentials(user: string, server: RemoteServer, revision: number, auth: Credentials): Promise<void>
  unbind(user: string, server: RemoteServer): Promise<void>
  attempt(user: string, server: RemoteServer, revision: number): Promise<void>
  save(user: string, server: RemoteServer, revision: number, snapshot: Snapshot): Promise<void>
  snapshot(user: string, server: RemoteServer): Promise<Snapshot | null>
  close(): Promise<void>
}

export type DfBinding = { nickname: string; boundAt: string; refreshToken: string; scope: string }
export type DfBindingStore = {
  get(userId: string): Promise<DfBinding | null>
  set(userId: string, binding: DfBinding): Promise<void>
  remove(userId: string): Promise<boolean>
}
export type DfImportToken = { token: string; savedAt: string }
export type DfImportTokenStore = {
  get(userId: string): Promise<DfImportToken | null>
  set(userId: string, token: string): Promise<void>
  remove(userId: string): Promise<boolean>
}
export type LxnsBinding = {
  friendCode: string | number
  name: string
  boundAt: string
  method: "friend_code" | "oauth"
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}
export type LxnsBindingStore = {
  get(userId: string): Promise<LxnsBinding | null>
  set(userId: string, binding: LxnsBinding): Promise<void>
  remove(userId: string): Promise<boolean>
  size(): Promise<number>
}
export type ProviderStores = { df: DfBindingStore; dfImportTokens: DfImportTokenStore; lxns: LxnsBindingStore }

/** Redis key/value subset used by the bot; memory-backed in tests. */
export type Kv = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs?: number): Promise<void>
  /** SET NX: true when this caller created the key. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>
  /** Remaining TTL in ms: -1 = no expiry, -2 = missing. */
  pttl(key: string): Promise<number>
  del(key: string): Promise<void>
  /** Drop every key under a prefix (used to invalidate caches for all users). */
  delByPrefix(prefix: string): Promise<void>
  close(): Promise<void>
}

export type AppStore = {
  driver: "mysql" | "memory"
  scores: ScoreStore
  servers: ServerStore
  providers: ProviderStores
  kv: Kv
  close(): Promise<void>
}
