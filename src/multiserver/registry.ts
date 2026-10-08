import type { PlayerProfile } from "../local/profile.js"
import { t } from "../messages.js"

export const SERVERS = ["cn", "jp", "intl", "mumur", "missless"] as const
// missless stays bypassed. mumur (MuNET) reads through the card-based AllNet path in src/mumur/.
export const ENABLED_SERVERS = ["cn", "jp", "intl", "mumur"] as const
export type ServerId = typeof SERVERS[number]
export type RemoteServer = Exclude<ServerId, "cn">
export const SERVER_NAMES: Record<ServerId, string> = { cn: t("server.cn"), jp: t("server.jp"), intl: t("server.intl"), mumur: t("server.mumur"), missless: t("server.missless") }
// Short tag printed on the B50 card header; the full names above stay for prose.
export const SERVER_BADGE: Record<ServerId, string> = { cn: t("label.cnDefault"), jp: t("badge.jp"), intl: t("badge.intl"), mumur: t("badge.mumur"), missless: t("badge.missless") }
export const SERVER_CHOICES = ENABLED_SERVERS.map(value => ({ name: SERVER_NAMES[value], value }))
export function isServer(value: unknown): value is ServerId { return typeof value === "string" && SERVERS.includes(value as ServerId) }
export function isEnabledServer(value: unknown): value is typeof ENABLED_SERVERS[number] {
  return isServer(value) && (ENABLED_SERVERS as readonly ServerId[]).includes(value)
}
export function requireEnabledServer(server: ServerId) {
  if (!isEnabledServer(server)) throw new UserError(t("server.bypassed"))
}
export function resolveServer(explicit: string | null, preferred: ServerId): ServerId {
  if (!explicit) return isEnabledServer(preferred) ? preferred : "cn"
  if (!isServer(explicit)) throw new UserError(t("server.invalidOption"))
  requireEnabledServer(explicit)
  return explicit
}
export class UserError extends Error {}
// A provider HTTP status failure: first-party text plus the numeric status only (never the response body).
// It is not a session problem, so callers must not re-login on it.
export class HttpStatusError extends UserError {
  constructor(readonly status: number) { super(t("net.httpStatus", { status })) }
}
export type Credentials = { username?: string; password?: string; accessCode?: string; cardIndex?: number; playerName?: string; cookies?: string }
export type ScoreRecord = {
  title: string; type: "SD" | "DX"; level: number; achievement: number; dxScore: number;
  fc: string; fs: string; musicId?: number; playCount?: number; maxDxScore?: number;
  ds?: number; version?: number; isNew?: boolean;
}
export type Snapshot = {
  accountKey: string; profile: PlayerProfile; records: ScoreRecord[]; fetchedAt: string;
  countsComplete: boolean; source: "net" | "private_api"; version?: string;
}
export function checkAccess(userId: string, allowed: Set<string>) {
  if (allowed.size && !allowed.has(userId)) throw new UserError(t("access.denied"))
}
