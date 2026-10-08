// Shared PKCE session store for the web OAuth flows (落雪 / 水鱼). Sessions are in memory and expire after 10 minutes.
// A session is created when the user presses the authorize button; the browser comes back to /oauth-callback/<provider>
// with ?state=..&code=.. and the session is found by state. Nothing from a session is logged.
import { randomBytes, createHash } from "node:crypto"

export type OAuthProvider = "lxns" | "diving-fish"
export type OAuthSession = {
  id: string
  provider: OAuthProvider
  userId: string
  verifier: string
  state: string
  expiresAt: number
  /** Edits the Discord reply that started the flow, so the callback result appears without copy-paste. */
  notify?: (content: string) => Promise<unknown>
}

const SESSION_MS = 10 * 60 * 1000
const sessions = new Map<string, OAuthSession>()

function purgeExpired() {
  const now = Date.now()
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id)
}

export function createOAuthSession(provider: OAuthProvider, userId: string, notify?: (content: string) => Promise<unknown>): { session: OAuthSession; challenge: string } {
  purgeExpired()
  // One pending authorization per user and provider: a new button press replaces the old one.
  for (const [id, s] of sessions) if (s.provider === provider && s.userId === userId) sessions.delete(id)
  const session: OAuthSession = {
    id: randomBytes(12).toString("hex"), provider, userId,
    verifier: randomBytes(48).toString("base64url"), state: randomBytes(24).toString("hex"),
    expiresAt: Date.now() + SESSION_MS, notify,
  }
  sessions.set(session.id, session)
  return { session, challenge: createHash("sha256").update(session.verifier).digest("base64url") }
}

/** Callback path. Single use: the session is removed as soon as it is found. */
export function takeOAuthSessionByState(provider: OAuthProvider, state: string): OAuthSession | undefined {
  purgeExpired()
  for (const [id, s] of sessions) {
    if (s.provider === provider && s.state === state) { sessions.delete(id); return s }
  }
  return undefined
}

/** Paste fallback: looks the session up without consuming it, so a mistyped paste can be retried. */
export function peekOAuthSession(provider: OAuthProvider, id: string, userId: string): OAuthSession | undefined {
  purgeExpired()
  const s = sessions.get(id)
  return s && s.provider === provider && s.userId === userId ? s : undefined
}

export function deleteOAuthSession(id: string): void {
  sessions.delete(id)
}
