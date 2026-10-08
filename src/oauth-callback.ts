// Local HTTP listener for OAuth redirects. The reverse proxy forwards the whole domain to this process, e.g.
//   https://kohad-bot.frkovo.uk/oauth-callback/lxns          -> http://127.0.0.1:3729/oauth-callback/lxns
//   https://kohad-bot.frkovo.uk/oauth-callback/diving-fish   -> http://127.0.0.1:3729/oauth-callback/diving-fish
// The bot never echoes query values back to the browser and never logs codes, states or tokens.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { BotConfig } from "./config.js"
import { t } from "./messages.js"
import { Trace } from "./diagnostics.js"
import { dfCfg, lxOAuthCfg } from "./provider-config.js"
import { takeOAuthSessionByState, type OAuthSession } from "./oauth-session.js"
import { takeLxSessionByState, exchangeLxCode } from "./lxns/oauth.js"
import { fetchOwnPlayer } from "./lxns/client.js"
import { lxnsBindings } from "./lxns/bindings.js"
import { exchangeDfCode } from "./df/oauth.js"
import { fetchPlayerRecords } from "./df/client.js"
import { dfBindings } from "./df/bindings.js"

export const LX_CALLBACK_PATH = "/oauth-callback/lxns"
export const DF_CALLBACK_PATH = "/oauth-callback/diving-fish"

type Page = { status: number; title: string; body: string }
type Outcome = { page: Page; notice: string }

const CODE_RE = /^[A-Za-z0-9_-]{8,256}$/
const STATE_RE = /^[a-f0-9]{48}$/
const failPage = (body: string): Page => ({ status: 400, title: t("oauth.page.failTitle"), body })

// Both providers share the same steps: validate state, consume the session, exchange the code, store the binding,
// then edit the Discord reply that started the flow. Only the exchange and the stored record differ.
async function finish(session: OAuthSession | undefined, providerName: string, url: URL, run: (s: OAuthSession, code: string) => Promise<Outcome>): Promise<Page> {
  const code = url.searchParams.get("code") ?? ""
  const notify = async (content: string) => { if (session?.notify) await session.notify(content).catch(() => undefined) }
  if (!session) return failPage(t("oauth.page.expired"))
  if (url.searchParams.has("error")) { await notify(t("oauth.denied", { provider: providerName })); return failPage(t("oauth.page.denied")) }
  if (!CODE_RE.test(code)) { await notify(t("oauth.badCode")); return failPage(t("oauth.page.badRequest")) }
  try {
    const outcome = await run(session, code)
    await notify(outcome.notice)
    return outcome.page
  } catch (e) {
    // The trace is created only on failure, so successful callbacks do not add log noise.
    const failure = new Trace("bind", "bot").fail(e)
    await notify(t("oauth.failed", { provider: providerName, reason: failure.reason, id: t("oauth.failedId", { id: failure.id }) }))
    return { status: 502, title: t("oauth.page.failTitle"), body: t("oauth.page.failBody", { id: failure.id }) }
  }
}

const OK_PAGE: Page = { status: 200, title: t("oauth.page.okTitle"), body: t("oauth.page.okBody") }

async function handleLxCallback(url: URL, cfg: BotConfig): Promise<Page> {
  const state = url.searchParams.get("state") ?? ""
  if (!STATE_RE.test(state)) return failPage(t("oauth.page.badRequest"))
  const session = takeLxSessionByState(state)
  const oauth = lxOAuthCfg(cfg)
  if (session && !oauth) { await session.notify?.(t("lx.noDevToken")).catch(() => undefined); return { status: 500, title: t("oauth.page.failTitle"), body: t("oauth.page.notConfigured") } }
  return finish(session, t("provider.lx"), url, async (s, code) => {
    const tokens = await exchangeLxCode(oauth!, s, code)
    const player = await fetchOwnPlayer({ devToken: "", apiBase: oauth!.apiBase, accessToken: tokens.accessToken })
    lxnsBindings.set(s.userId, { friendCode: player.friend_code, name: player.name, boundAt: new Date().toISOString(), method: "oauth",
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scope: tokens.scope })
    return { page: OK_PAGE, notice: t("oauth.bound", { provider: t("provider.lx"), name: player.name, detail: t("oauth.detail.friendCode", { friendCode: String(player.friend_code) }) }) }
  })
}

async function handleDfCallback(url: URL, cfg: BotConfig): Promise<Page> {
  const state = url.searchParams.get("state") ?? ""
  if (!STATE_RE.test(state)) return failPage(t("oauth.page.badRequest"))
  const session = takeOAuthSessionByState("diving-fish", state)
  const df = dfCfg(cfg)
  if (session && !df) { await session.notify?.(t("err.dfUnconfigured")).catch(() => undefined); return { status: 500, title: t("oauth.page.failTitle"), body: t("oauth.page.notConfigured") } }
  return finish(session, t("provider.df"), url, async (s, code) => {
    const grant = await exchangeDfCode(df!, cfg.dfRedirectUri, s, code)
    const records = await fetchPlayerRecords(grant.accessToken)
    const name = records.nickname ?? records.username ?? t("value.dfPlayer")
    dfBindings.set(s.userId, { nickname: name, boundAt: new Date().toISOString(), refreshToken: grant.refreshToken, scope: grant.scope })
    return { page: OK_PAGE, notice: t("oauth.bound", { provider: t("provider.df"), name, detail: "" }) }
  })
}

function send(res: ServerResponse, page: Page) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.title}</title>` +
    `<body style="font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:520px;margin:48px auto;padding:0 16px;line-height:1.6"><h2>${page.title}</h2><p>${page.body}</p></body>`
  res.writeHead(page.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" })
  res.end(html)
}

const NOT_FOUND: Page = { status: 404, title: t("oauth.page.notFoundTitle"), body: t("oauth.page.notFound") }

async function route(req: IncomingMessage, res: ServerResponse, cfg: BotConfig) {
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }).end(); return }
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.search.length > 4096) { send(res, { status: 414, title: t("oauth.page.failTitle"), body: t("oauth.page.badRequest") }); return }
  if (url.pathname === LX_CALLBACK_PATH) { send(res, await handleLxCallback(url, cfg)); return }
  if (url.pathname === DF_CALLBACK_PATH) { send(res, await handleDfCallback(url, cfg)); return }
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return }
  send(res, NOT_FOUND)
}

export function startOAuthServer(cfg: BotConfig): void {
  const server = createServer((req, res) => {
    route(req, res, cfg).catch(e => {
      // Failures are logged by reference only; the request URL is never written to the log.
      new Trace("runtime").fail(e)
      if (!res.headersSent) send(res, { status: 500, title: t("oauth.page.failTitle"), body: t("oauth.page.notFound") })
    })
  })
  server.on("error", e => { console.error(`[oauth] listener failed on ${cfg.oauthHost}:${cfg.oauthPort}: ${(e as Error).message}`) })
  server.listen(cfg.oauthPort, cfg.oauthHost, () => console.log(`[oauth] listening on ${cfg.oauthHost}:${cfg.oauthPort} (${LX_CALLBACK_PATH}, ${DF_CALLBACK_PATH})`))
}
