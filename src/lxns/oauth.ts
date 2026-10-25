import type { LxnsBindingStore } from "./bindings.js"
import type { LxnsConfig } from "./client.js"
import { createOAuthSession, takeOAuthSessionByState, peekOAuthSession, deleteOAuthSession, type OAuthSession } from "../oauth-session.js"

export type LxOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string; apiBase: string }
export type LxTokens = { accessToken: string; refreshToken: string; expiresAt: number; scope: string }

const refreshes = new Map<string, Promise<LxnsConfig>>()

export function startLxAuthorization(cfg: LxOAuthConfig, userId: string, notify?: (content: string) => Promise<unknown>) {
  const { session, challenge } = createOAuthSession("lxns", userId, notify)
  const url = new URL("/oauth/authorize", cfg.apiBase)
  url.search = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, ...(cfg.redirectUri ? { redirect_uri: cfg.redirectUri } : {}),
    scope: "read_user_profile read_player write_player", state: session.state, code_challenge: challenge, code_challenge_method: "S256" }).toString()
  return { id: session.id, url: url.toString() }
}

async function tokenRequest(cfg: LxOAuthConfig, body: Record<string, string>): Promise<LxTokens> {
  const res = await fetch(`${cfg.apiBase}/api/v0/oauth/token`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }), signal: AbortSignal.timeout(15000) })
  const j = await res.json().catch(() => null) as { error?: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } | null
  if (!res.ok || !j?.access_token || !j.refresh_token || !(Number(j.expires_in) > 0)) throw new Error(`落雪 OAuth 失败（HTTP ${res.status}，${j?.error ?? "invalid_response"}），请重新 /bindlx`)
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + Number(j.expires_in) * 1000, scope: j.scope ?? "" }
}

/** Callback path: the session is found by state and consumed. */
export function takeLxSessionByState(state: string): OAuthSession | undefined {
  return takeOAuthSessionByState("lxns", state)
}

export function exchangeLxCode(cfg: LxOAuthConfig, session: OAuthSession, code: string): Promise<LxTokens> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, ...(cfg.redirectUri ? { redirect_uri: cfg.redirectUri } : {}), code_verifier: session.verifier })
}

/** Paste fallback for when the callback cannot be used. */
export async function completeLxAuthorization(cfg: LxOAuthConfig, userId: string, id: string, value: string): Promise<LxTokens> {
  const session = peekOAuthSession("lxns", id, userId)
  if (!session || session.expiresAt <= Date.now()) throw new Error("授权会话已过期，请重新 /bindlx")
  let code = value.trim()
  if (/^https?:\/\//.test(code)) {
    const url = new URL(code)
    if (!cfg.redirectUri) throw new Error("本应用未配置回调地址，请直接粘贴授权码")
    const target = new URL(cfg.redirectUri)
    if (url.origin !== target.origin || url.pathname !== target.pathname || url.searchParams.get("state") !== session.state) throw new Error("回调地址或 state 不匹配，请使用本次授权后的完整地址")
    code = url.searchParams.get("code") ?? ""
  } else if (cfg.redirectUri) throw new Error("请粘贴授权后地址栏中的完整回调 URL，以校验本次授权身份")
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(code)) throw new Error("授权码格式不正确")
  deleteOAuthSession(id)
  return exchangeLxCode(cfg, session, code)
}

export async function authorizedLxConfig(cfg: LxOAuthConfig, userId: string, store: LxnsBindingStore): Promise<LxnsConfig> {
  const binding = await store.get(userId)
  if (!binding || binding.method !== "oauth" || !binding.refreshToken) throw new Error("请先 /bindlx 完成落雪 OAuth 授权")
  if (binding.accessToken && Date.now() < Number(binding.expiresAt) - 30000) return { devToken: "", apiBase: cfg.apiBase, accessToken: binding.accessToken }
  const key = `${cfg.apiBase}:${cfg.clientId}:${userId}`
  const running = refreshes.get(key)
  if (running) return running
  const task = (async () => {
    const token = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: binding.refreshToken! })
    const current = await store.get(userId)
    if (!current || current.refreshToken !== binding.refreshToken) throw new Error("绑定已改变，请重试")
    await store.set(userId, { ...binding, ...token }) // persist rotated token before any API request
    return { devToken: "", apiBase: cfg.apiBase, accessToken: token.accessToken }
  })()
  refreshes.set(key, task)
  try { return await task } finally { refreshes.delete(key) }
}
