// 水鱼（Diving-Fish）OAuth：网页授权码模式（PKCE + 机密客户端），回调 /oauth-callback/diving-fish。
// 绑定后保存该用户的 refresh_token（文件权限 0600，与落雪一致），每次使用前轮换并先落盘。
// 仍兼容旧版设备码绑定：没有网页绑定记录的用户走 on-behalf-of 换票。
// 文档：https://maimai.diving-fish.com/manual/docs/developer/oauth-quickstart
import { createHash } from "node:crypto"
import { createOAuthSession, type OAuthSession } from "../oauth-session.js"
import { dfBindings, type DfBinding } from "./bindings.js"

export type DfOAuthConfig = {
  clientId: string
  clientSecret: string
  authUrl: string
}

// Carries the provider's OAuth error code (e.g. invalid_client) so the debug log can say why, without the message text.
export class DfProviderError extends Error {
  constructor(readonly status: number, readonly providerCode: string) { super(`水鱼换票失败（HTTP ${status}，${providerCode}）`) }
}
export class NotBoundError extends Error {
  constructor() { super("该用户尚未绑定水鱼账号（或授权已撤销）") }
}
export class DfRateLimitError extends Error {
  constructor(message = "水鱼授权服务器限流（slow_down），请稍后再试") { super(message) }
}

/** subject_ref = sha256(client_id + ":" + 外部用户标识)，小写 hex；旧版设备码绑定与换票两侧必须一致 */
export function subjectRef(clientId: string, externalId: string): string {
  return createHash("sha256").update(`${clientId}:${externalId}`, "utf8").digest("hex")
}

async function postForm(url: string, body: URLSearchParams, timeoutMs = 15000): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text().catch(() => "")
  let json: Record<string, unknown> | null = null
  try { json = text ? JSON.parse(text) as Record<string, unknown> : null } catch { json = null }
  return { status: res.status, json }
}

// Only prober.* scopes are relevant for this bot (openid/profile are not requested).
function proberScope(scope: string): string {
  return [...new Set(scope.split(/\s+/).filter(s => s.startsWith("prober.")))].join(" ") || "prober.records.read"
}

/** 发起网页授权：返回授权页面地址。用户在水鱼网页同意后回调到 redirectUri，由回调处理完成绑定。 */
export function startDfAuthorization(cfg: DfOAuthConfig, redirectUri: string, scope: string, userId: string, notify?: (content: string) => Promise<unknown>) {
  const { session, challenge } = createOAuthSession("diving-fish", userId, notify)
  const url = new URL("/oauth/authorize", cfg.authUrl)
  url.search = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: redirectUri, scope: proberScope(scope),
    state: session.state, code_challenge: challenge, code_challenge_method: "S256" }).toString()
  return { id: session.id, url: url.toString() }
}

export type DfGrant = { accessToken: string; refreshToken: string; expiresAt: number; scope: string }

function grantFrom(status: number, json: Record<string, unknown> | null): DfGrant {
  if (status === 429 || json?.error === "slow_down") throw new DfRateLimitError()
  if (status !== 200 || !json?.access_token || !json?.refresh_token) {
    throw new DfProviderError(status, String(json?.error ?? (json?.access_token ? "refresh_token_missing" : "invalid_response")))
  }
  const expiresIn = Number(json.expires_in ?? 900)
  return { accessToken: String(json.access_token), refreshToken: String(json.refresh_token),
    expiresAt: Date.now() + Math.max(30, expiresIn - 30) * 1000, scope: String(json.scope ?? "") }
}

/** 回调：用授权码 + code_verifier 换取该用户的令牌（机密客户端同时带 client_secret）。 */
export async function exchangeDfCode(cfg: DfOAuthConfig, redirectUri: string, session: OAuthSession, code: string): Promise<DfGrant> {
  const { status, json } = await postForm(`${cfg.authUrl}/oauth/token`, new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: session.verifier,
  }))
  return grantFrom(status, json)
}

// ---------- 令牌获取（网页绑定 → refresh_token；旧设备码绑定 → on-behalf-of） ----------

export type DfToken = { token: string; scope: string }

const userTokens = new Map<string, { token: string; scope: string; expiresAt: number }>()
const userFlights = new Map<string, Promise<DfToken>>()

async function tokenFromBinding(cfg: DfOAuthConfig, userId: string, binding: DfBinding): Promise<DfToken> {
  const hit = userTokens.get(userId)
  if (hit && Date.now() < hit.expiresAt) return { token: hit.token, scope: hit.scope }
  const flight = userFlights.get(userId)
  if (flight) return flight
  const task = (async () => {
    const { status, json } = await postForm(`${cfg.authUrl}/oauth/token`, new URLSearchParams({
      grant_type: "refresh_token", refresh_token: binding.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret,
    }))
    // Refresh tokens are single-use and rotate; a reused token revokes the chain, so the binding is dropped.
    if (status === 400 && json?.error === "invalid_grant") { dfBindings.remove(userId); throw new NotBoundError() }
    const grant = grantFrom(status, json)
    const current = dfBindings.get(userId)
    if (!current || current.refreshToken !== binding.refreshToken) throw new DfProviderError(0, "binding_changed")
    dfBindings.set(userId, { ...current, refreshToken: grant.refreshToken, scope: grant.scope }) // persist the rotated token before use
    userTokens.set(userId, { token: grant.accessToken, scope: grant.scope, expiresAt: grant.expiresAt })
    return { token: grant.accessToken, scope: grant.scope }
  })()
  userFlights.set(userId, task)
  try { return await task } finally { userFlights.delete(userId) }
}

// 旧设备码绑定：换票缓存令牌 5 分钟有效，留 30s 余量；同用户同 scope 复用（换票限流 60 次/小时/用户）
type CachedToken = { token: string; scope: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()
const tokenFlights = new Map<string, Promise<DfToken>>()

async function legacyOnBehalfToken(cfg: DfOAuthConfig, externalId: string, scope: string): Promise<DfToken> {
  const cacheKey = `${externalId}|${cfg.authUrl}|${cfg.clientId}|${scope}`
  const hit = tokenCache.get(cacheKey)
  if (hit && Date.now() < hit.expiresAt) return { token: hit.token, scope: hit.scope }
  const flight = tokenFlights.get(cacheKey)
  if (flight) return flight
  const task = exchangeToken(cfg, externalId, scope, cacheKey)
  tokenFlights.set(cacheKey, task)
  try { return await task } finally { tokenFlights.delete(cacheKey) }
}

async function exchangeToken(cfg: DfOAuthConfig, externalId: string, scope: string, cacheKey: string): Promise<DfToken> {
  const { status, json } = await postForm(`${cfg.authUrl}/oauth/token`, new URLSearchParams({
    grant_type: "urn:diving-fish:params:oauth:grant-type:on-behalf-of",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    subject: `ref:${subjectRef(cfg.clientId, externalId)}`,
    scope,
  }))
  if (status === 400 && json?.error === "consent_required") throw new NotBoundError()
  if (status === 429 || json?.error === "slow_down") throw new DfRateLimitError()
  if (status !== 200 || !json?.access_token) {
    throw new DfProviderError(status, json?.access_token ? "token_missing" : String(json?.error ?? "invalid_response"))
  }
  const token = String(json.access_token)
  const granted = String(json.scope ?? scope)
  const expiresIn = Number(json.expires_in ?? 300)
  tokenCache.set(cacheKey, { token, scope: granted, expiresAt: Date.now() + Math.max(30, expiresIn - 30) * 1000 })
  return { token, scope: granted }
}

/** 取得该 Discord 用户的水鱼访问令牌。网页绑定优先，其次旧设备码绑定。 */
export async function getDfAccessToken(cfg: DfOAuthConfig, externalId: string, scope: string): Promise<DfToken> {
  const binding = dfBindings.get(externalId)
  if (binding) return tokenFromBinding(cfg, externalId, binding)
  return legacyOnBehalfToken(cfg, externalId, scope)
}

/** 401 时清缓存（令牌可能已失效）；不传 externalId 则全清 */
export function clearDfTokenCache(externalId?: string): void {
  if (!externalId) { tokenCache.clear(); userTokens.clear(); return }
  for (const k of [...tokenCache.keys()]) if (k.startsWith(`${externalId}|`)) tokenCache.delete(k)
  userTokens.delete(externalId)
}
