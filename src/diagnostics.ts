import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import path from "node:path"
import { t } from "./messages.js"
import { dataDir } from "./store/paths.js"
import { HttpStatusError, UserError } from "./multiserver/registry.js"

export const STAGES = ["interaction", "binding.read", "credentials.read", "credentials.save", "auth.form", "auth.submit", "auth.redirect", "cards.parse", "card.select", "profile.read", "profile.parse", "records.fetch", "records.parse", "snapshot.save", "rating.calculate", "image.render", "reply", "import", "provider", "runtime"] as const
export type Stage = typeof STAGES[number]
export const CATEGORIES = ["validation", "http", "dns", "tls", "timeout", "connection", "network", "cancelled", "discord", "storage", "provider", "internal"] as const
// Error codes returned by upstream providers (OAuth / prober APIs). Only these strings are ever logged.
const PROVIDER_CODES = new Set(["invalid_client", "invalid_grant", "invalid_scope", "invalid_request", "unauthorized_client", "access_denied", "expired_token", "authorization_pending", "slow_down", "invalid_response", "token_missing", "scope_missing", "agreement_missing", "forbidden", "rate_limited", "oauth_disabled", "token_rejected", "records_http", "refresh_token_missing", "binding_changed"])
export type Category = typeof CATEGORIES[number]
export type Operation = "bind" | "select" | "confirm" | "sync" | "b50" | "command" | "import" | "runtime"
export type TraceServer = "cn" | "jp" | "intl" | "mumur" | "missless" | "bot"
export type TraceEvent = "start" | "stage" | "http-start" | "http-response" | "http-error" | "page-shape" | "records" | "relogin" | "complete" | "cache-fallback" | "reply-failed" | "failed"
export type Host = "maimaidx.jp" | "maimaidx-eng.com" | "lng-tgk-aime-gw.am-all.net" | "blocked"
export type Route = "login-page" | "login-submit" | "gateway-login" | "gateway-submit" | "aime-list" | "aime-select" | "home" | "music-records" | "net-other" | "blocked"

// Local data files the bot reads. Only these basenames may appear in logs (never full paths).
const KNOWN_FILES = new Set(["binding-master.key", "dxdata.json", "df-music.json", "fit-stats.json", "sdgb-156-charts.json", "dxdata-source.json", "maimai-net-intermediates.pem", "keys.json"])
// Allowlisted metadata only. Callers must never pass URLs, headers, bodies, HTML, usernames, passwords, tokens or cookie values.
export type SafeMeta = {
  host?: Host; route?: Route; method?: "GET" | "POST"; status?: number; elapsedMs?: number; bytes?: number; redirects?: number
  cookiesReceived?: number; cookiesSent?: number; level?: number; records?: number; cards?: number
  forms?: number; passwordFields?: number; tokenFields?: number; recordNodes?: number; maintenance?: boolean
  difficulty?: string; code?: string; category?: Category
  nodes?: number; noTitle?: number; noScore?: number; unplayed?: number; failedCheck?: string; file?: string
}

const META_KEYS = ["host", "route", "method", "status", "elapsedMs", "bytes", "redirects", "cookiesReceived", "cookiesSent", "level", "records", "cards",
  "forms", "passwordFields", "tokenFields", "recordNodes", "maintenance", "difficulty", "code", "category",
  "nodes", "noTitle", "noScore", "unplayed", "failedCheck", "file"] as const
// Runtime checks matter even when a caller bypasses TypeScript. Short alphanumeric
// strings can still be passwords: each string field accepts only fixed values.
export function safeFields(meta: SafeMeta): Record<string, string | number | boolean> {
  const source = meta as Record<string, unknown>, out: Record<string, string | number | boolean> = {}
  for (const key of META_KEYS) {
    const value = source[key]
    if (key === "maintenance") { if (typeof value === "boolean") out[key] = value; continue }
    if (STRING_FIELDS[key]) {
      if (typeof value === "string" && STRING_FIELDS[key]!.has(value)) out[key] = value
      continue
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue
    if (key === "status" && (value < 100 || value > 599)) continue
    if (key === "level" && value > 4) continue
    out[key] = value
  }
  return out
}

const HOSTS: readonly Host[] = ["maimaidx.jp", "maimaidx-eng.com", "lng-tgk-aime-gw.am-all.net"]
const DNS = new Set(["ENOTFOUND", "EAI_AGAIN"])
const TLS = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID"])
const TIMEOUT = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])
const CONNECTION = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "EPIPE"])
const STORAGE = new Set(["EACCES", "EPERM", "ENOENT", "ENOSPC", "EROFS", "EBUSY", "ER_ACCESS_DENIED_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY", "PROTOCOL_CONNECTION_LOST"])
const DISCORD = new Set(["10003", "10062", "40060", "50001", "50013", "InteractionAlreadyReplied", "InteractionNotReplied"])
const STRING_FIELDS: Partial<Record<typeof META_KEYS[number], ReadonlySet<string>>> = {
  host: new Set([...HOSTS, "blocked"]),
  route: new Set(["login-page", "login-submit", "gateway-login", "gateway-submit", "aime-list", "aime-select", "home", "music-records", "net-other", "blocked"]),
  method: new Set(["GET", "POST"]),
  difficulty: new Set(["basic", "advanced", "expert", "master", "remaster"]),
  file: KNOWN_FILES,
  failedCheck: new Set(["rate", "type", "dxScore", "level", "achievement", "dxScoreRange"]),
  category: new Set(CATEGORIES),
  code: new Set([...DNS, ...TLS, ...TIMEOUT, ...CONNECTION, ...STORAGE, ...DISCORD, "TimeoutError", "AbortError"]),
}

// Walk Error.cause (bounded) and return only allowlisted codes; unknown codes and messages are never returned.
export function classifyError(error: unknown): { category: Category; code?: string; file?: string } {
  const provider = (error as { providerCode?: unknown } | null)?.providerCode
  if (typeof provider === "string" && PROVIDER_CODES.has(provider)) return { category: "provider", code: provider }
  if (error instanceof HttpStatusError) return { category: "http" }
  if (httpStatus(error) !== undefined) return { category: "http" }
  if (error instanceof UserError) return { category: "validation" }
  let current: unknown = error
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth++) {
    const item = current as { code?: unknown; name?: unknown; cause?: unknown }
    // Only allowlisted values are ever returned: an arbitrary code/name from a provider or cause is dropped, never echoed.
    const code = typeof item.code === "string" || typeof item.code === "number" ? String(item.code) : ""
    if (DNS.has(code)) return { category: "dns", code }
    if (TLS.has(code)) return { category: "tls", code }
    if (TIMEOUT.has(code)) return { category: "timeout", code }
    if (item.name === "TimeoutError") return { category: "timeout", code: "TimeoutError" }
    if (CONNECTION.has(code)) return { category: "connection", code }
    if (STORAGE.has(code)) {
      const base = typeof (item as { path?: unknown }).path === "string" ? String((item as { path?: string }).path).split(/[\/]/).pop() : undefined
      return { category: "storage", code, file: base && KNOWN_FILES.has(base) ? base : undefined }
    }
    if (DISCORD.has(code)) return { category: "discord", code }
    if (item.name === "AbortError") return { category: "cancelled", code: "AbortError" }
    current = item.cause
  }
  if (error instanceof TypeError && error.message === "fetch failed") return { category: "network" }
  return { category: "internal" }
}

function httpStatus(error: unknown): number | undefined {
  const value = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined
}

const LOG_LIMIT_BYTES = 5 * 1024 * 1024
export function debugLogPath(): string | undefined {
  if (process.env.B50_DEBUG_LOG === "off") return undefined
  if (process.env.B50_DEBUG_LOG) return path.resolve(process.env.B50_DEBUG_LOG)
  // node --test sets NODE_TEST_CONTEXT; tests must not create logs unless they pass B50_DEBUG_LOG explicitly.
  if (process.env.NODE_TEST_CONTEXT) return undefined
  return path.resolve(path.join(dataDir(), "logs", "bot-debug.jsonl"))
}
// Bounded: at most one rotated backup, so the total stays near 2 x LOG_LIMIT_BYTES.
function write(record: object, failed = false) {
  const line = JSON.stringify(record)
  ;(failed ? console.error : console.info)(`[bot-debug] ${line}`)
  const filename = debugLogPath()
  if (!filename) return
  try {
    mkdirSync(path.dirname(filename), { recursive: true })
    if (existsSync(filename) && statSync(filename).size >= LOG_LIMIT_BYTES) {
      if (existsSync(`${filename}.1`)) unlinkSync(`${filename}.1`)
      renameSync(filename, `${filename}.1`)
    }
    appendFileSync(filename, `${line}\n`, { mode: 0o600 })
  } catch { console.warn("[bot-debug] log-file-write-failed; safe metadata remains in console") }
}

export class DiagnosticFailure extends Error {
  constructor(readonly id: string, readonly stage: Stage, readonly category: Category, readonly reason: string, readonly code?: string, readonly status?: number) { super(reason) }
}

export class Trace {
  readonly id = `B50-${randomUUID().slice(0, 8).toUpperCase()}`
  stage: Stage = "interaction"
  private readonly started = Date.now()
  constructor(readonly operation: Operation, public server: TraceServer = "bot") { this.note("start") }
  step(stage: Stage, meta: SafeMeta = {}) { this.stage = stage; this.note("stage", meta) }
  note(event: TraceEvent, meta: SafeMeta = {}) {
    write({ time: new Date().toISOString(), id: this.id, operation: this.operation, server: this.server, stage: this.stage, event, totalMs: Date.now() - this.started, ...safeFields(meta) })
  }
  fail(error: unknown, meta: SafeMeta = {}): DiagnosticFailure {
    if (error instanceof DiagnosticFailure) return error
    const classified = classifyError(error)
    const candidate = meta.status ?? httpStatus(error)
    const status = typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : undefined
    const category: Category = status !== undefined && status >= 400 ? "http" : classified.category
    const reason = error instanceof UserError ? error.message : t(`diagnostic.reason.${category}`)
    const failure = new DiagnosticFailure(this.id, this.stage, category, reason, classified.code, status)
    write({ time: new Date().toISOString(), id: this.id, operation: this.operation, server: this.server, stage: this.stage, event: "failed", category, code: failure.code, totalMs: Date.now() - this.started, ...safeFields({ ...meta, status, file: classified.file }) }, true)
    return failure
  }
}

export function failureText(failure: DiagnosticFailure) {
  const details = t("diagnostic.details", {
    id: failure.id, stage: t(`diagnostic.stage.${failure.stage}`), stageCode: failure.stage, category: failure.category,
    code: failure.code ? t("diagnostic.code", { code: failure.code }) : "", http: failure.status ? t("diagnostic.http", { status: failure.status }) : "",
  })
  return t("diagnostic.private", { reason: failure.reason, details })
}

// Nested failures that are shown inline (e.g. one source among several) use only first-party reasons, never raw Error text.
export function safeReason(error: unknown): string {
  if (error instanceof UserError) return error.message
  return t(`diagnostic.reason.${classifyError(error).category}`)
}

// Fixed route names and allowlisted hosts only; path/query/redirect URLs are never returned.
const ROUTES: Record<string, Route> = {
  "/common_auth/login": "gateway-login", "/common_auth/login/sid": "gateway-submit",
  "/maimai-mobile/": "login-page", "/maimai-mobile/submit/": "login-submit",
  "/maimai-mobile/aimeList/": "aime-list", "/maimai-mobile/aimeList/submit/": "aime-select",
  "/maimai-mobile/home/": "home", "/maimai-mobile/record/musicGenre/search/": "music-records",
}
export function safeRoute(url: URL): Pick<SafeMeta, "host" | "route"> {
  const host = HOSTS.find(item => item === url.hostname)
  if (!host) return { host: "blocked", route: "blocked" }
  return { host, route: ROUTES[url.pathname] ?? "net-other" }
}
