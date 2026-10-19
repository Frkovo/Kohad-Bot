import { load } from "cheerio"
import { CookieJar } from "tough-cookie"
import { createHash } from "node:crypto"
import { UserError, HttpStatusError, NetMaintenanceError, type Credentials, type ScoreRecord, type Snapshot } from "./registry.js"
import { t } from "../messages.js"
import { debugLogPath, safeRoute, type SafeMeta, type Trace } from "../diagnostics.js"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { netFetch } from "./transport.js"

const HOSTS = new Set(["maimaidx.jp", "maimaidx-eng.com", "lng-tgk-aime-gw.am-all.net"])
export const DIFFICULTIES = ["basic", "advanced", "expert", "master", "remaster"] as const
export type Card = { index: number; label: string }
export function accountKey(server: string, identity: string) { return createHash("sha256").update(JSON.stringify([server, identity])).digest("hex") }
export function parseCards(html: string, base: string): Card[] {
  const $ = load(html), cards = new Map<number, Card>()
  $('a[href*="aimeList/submit"], form[action*="aimeList/submit"]').each((_, element) => {
    const node = $(element), url = new URL(node.attr("href") || node.attr("action") || "", base)
    if (url.origin !== new URL(base).origin) return
    const index = Number(url.searchParams.get("idx") ?? node.find('[name="idx"]').attr("value"))
    if (!Number.isInteger(index) || index < 0 || index > 99) return
    // Do not echo card access codes or arbitrary page text to Discord.
    cards.set(index, { index, label: t("bind.cardOption", { index: index + 1 }) })
  })
  return [...cards.values()]
}
// Structural counts only: never page text, titles, forms or attribute values.
export function pageShape(html: string): SafeMeta {
  const $ = load(html)
  return { forms: $("form").length, passwordFields: $('[name="password"]').length, tokenFields: $('input[name="token"]').length,
    recordNodes: $(".w_450.m_15.p_r.f_0").length, maintenance: /maintenance|メンテナンス|系统维护/i.test($("title").text()) || $(".maintenance").length > 0 }
}
function cookieCount(header: string) { return header ? header.split(";").length : 0 }
// Markup skeleton of the first song nodes: tag names, class names and text LENGTHS only. No text, values or links.
export function musicNodeShape(html: string, maxNodes = 2): string {
  const $ = load(html), lines: string[] = []
  const walk = (el: Parameters<typeof $>[0], depth: number) => {
    if (depth > 7 || lines.length > 160) return
    $(el).contents().each((_, child) => {
      if (child.type === "text") { const len = ($(child).text()).trim().length; if (len) lines.push(`${"  ".repeat(depth)}#text(${len})`); return }
      if (child.type !== "tag") return
      const cls = $(child).attr("class") ?? "", tag = child.tagName ?? "?"
      const src = tag === "img" ? ` src=${($(child).attr("src") ?? "").split("/").at(-1)?.split("?")[0]}` : ""
      lines.push(`${"  ".repeat(depth)}<${tag}${cls ? ` class="${cls}"` : ""}${src}>`)
      walk(child, depth + 1)
    })
  }
  // Sample played cards (they carry a score block); unplayed cards have none, so the first two alone say little.
  const played = $(".w_450.m_15.p_r.f_0").filter((_, el) => $(el).find('[class*="music_score_block"]').length > 0 || /%/.test($(el).text()))
  const sample = played.length ? played : $(".w_450.m_15.p_r.f_0")
  sample.slice(0, maxNodes).each((i, el) => { lines.push(`--- node ${i + 1} (played=${played.length ? "yes" : "no"})`); walk(el, 0) })
  lines.push(`--- totals: nodes=${$(".w_450.m_15.p_r.f_0").length} withScoreBlock=${played.length}`)
  return lines.join("\n")
}
// `stats` receives structural counters only (no titles or text), so a failed parse can be explained from the debug log.
export type ParseStats = { nodes: number; noTitle: number; noScore: number; unplayed: number; failedCheck?: string }
export function parseMusicPage(html: string, expectedLevel: number, stats?: ParseStats): ScoreRecord[] {
  const $ = load(html)
  if ($('[name="password"]').length) throw new UserError(t("net.sessionExpired"))
  if (/maintenance|メンテナンス|系统维护/i.test($("title").text()) || $(".maintenance").length) throw new NetMaintenanceError()
  const nodes = $(".w_450.m_15.p_r.f_0")
  if (!nodes.length && $(".music_name_block").length) throw new UserError(t("net.containerChanged"))
  if (!nodes.length && !$("[name=genre], img[src*=btn_music], .music_name_block").length) throw new UserError(t("net.structureUnknown"))
  const counts: ParseStats = { nodes: nodes.length, noTitle: 0, noScore: 0, unplayed: 0 }
  Object.assign(stats ?? {}, counts)
  const fail = (key: string, check: string) => { if (stats) stats.failedCheck = check; return new UserError(t(key)) }
  const records: ScoreRecord[] = []
  nodes.each((_, element) => {
    const node = $(element), title = node.find(".music_name_block").text().trim()
    if (!title) { if (stats) stats.noTitle++; return }
    const score = node.find(".music_score_block.w_112").text().trim()
    if (!score) { if (stats) stats.noScore++; return }
    if (/^[-—\s]+$/.test(score)) { if (stats) stats.unplayed++; return }
    const rate = score.replaceAll(",", "").match(/(\d+(?:\.\d+)?)\s*%/)
    if (!rate) throw fail("net.rateUnknown", "rate")
    const icon = node.find(".music_kind_icon").attr("src") ?? ""
    const dxOn = node.find('.music_kind_icon_dx[class*="_btn_on"]').length > 0
    const sdOn = node.find('.music_kind_icon_standard[class*="_btn_on"]').length > 0
    const type = dxOn || /music_dx\.png/.test(icon) ? "DX" : sdOn || /music_standard\.png/.test(icon) ? "SD" : null
    const diff = node.find(".h_20.f_l").attr("src")?.match(/diff_(basic|advanced|expert|master|remaster)\.png/)?.[1]
    const level = diff ? DIFFICULTIES.indexOf(diff as typeof DIFFICULTIES[number]) : expectedLevel
    const pair = node.find(".music_score_block.w_190").text().replaceAll(",", "").match(/(\d+)\s*\/\s*(\d+)/)
    if (!type) throw fail("net.fieldInvalid", "type")
    if (!pair) throw fail("net.fieldInvalid", "dxScore")
    if (level !== expectedLevel) throw fail("net.fieldInvalid", "level")
    // Achievements above 100.5% (SSS+ range) are normal, and the game stores 101.0000% for AP+ all-perfect plays.
    // Only values above 101% are invalid.
    if (Number(rate[1]) > 101) throw fail("net.valueInvalid", "achievement")
    if (Number(pair[1]) > Number(pair[2])) throw fail("net.valueInvalid", "dxScoreRange")
    const images = node.find("img").toArray().map(img => $(img).attr("src")?.split("/").at(-1)?.split("?")[0])
    const fc = images.includes("applus.png") ? "app" : images.includes("ap.png") ? "ap" : images.includes("fcplus.png") ? "fcp" : images.includes("fc.png") ? "fc" : ""
    const fs = images.includes("fsdplus.png") ? "fsdp" : images.includes("fsd.png") ? "fsd" : images.includes("fsplus.png") ? "fsp" : images.includes("fs.png") ? "fs" : images.includes("sync.png") ? "sync" : ""
    records.push({ title, type, level, achievement: Math.round(Number(rate[1]) * 10000), dxScore: Number(pair[1]), maxDxScore: Number(pair[2]), fc, fs })
  })
  return records
}
export class NetClient {
  private jar: CookieJar
  readonly base: string
  constructor(readonly region: "jp" | "intl", cookies?: string, readonly signal?: AbortSignal, private readonly trace?: Trace) {
    this.base = region === "jp" ? "https://maimaidx.jp/maimai-mobile/" : "https://maimaidx-eng.com/maimai-mobile/"
    try { this.jar = cookies ? CookieJar.deserializeSync(cookies) : new CookieJar() }
    catch { this.jar = new CookieJar() }
  }
  cookies() { return JSON.stringify(this.jar.serializeSync()) }
  // Writes tags/classes only (never text or values) to <server>-records-shape.txt beside the debug log. Overwritten each time.
  private writeShape(html: string, level: number) {
    const logFile = debugLogPath()
    if (!logFile) return
    try { writeFileSync(join(dirname(logFile), `${this.region}-records-shape.txt`), `difficulty=${DIFFICULTIES[level]}\n${musicNodeShape(html)}\n`) } catch {}
  }
  // Network errors are deliberately NOT wrapped in UserError: fetchSnapshot re-logs in only for UserError.
  async request(url: string, init: RequestInit = {}, follow = true): Promise<{ html: string; url: string; status: number; location: string | null }> {
    let destination = new URL(url, this.base), method = init.method ?? "GET", body = init.body
    const verb = (): "GET" | "POST" => method.toUpperCase() === "POST" ? "POST" : "GET"
    for (let redirects = 0; redirects < 12; redirects++) {
      const route = safeRoute(destination)
      if (destination.protocol !== "https:" || !HOSTS.has(destination.hostname) || destination.port || destination.username || destination.password) {
        this.trace?.note("http-response", { host: "blocked", route: "blocked", method: verb(), redirects })
        throw new UserError(t("net.redirectBlocked"))
      }
      const cookie = this.jar.getCookieStringSync(destination.href), started = Date.now()
      this.trace?.note("http-start", { ...route, method: verb(), redirects })
      let response: Response
      try {
        response = await netFetch(destination, { ...init, method, body, redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(45000), ...(this.signal ? [this.signal] : [])]),
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html", ...init.headers, Cookie: cookie, Referer: destination.origin } })
      } catch (error) {
        this.trace?.note("http-error", { ...route, method: verb(), redirects, elapsedMs: Date.now() - started })
        throw error
      }
      const setCookies = response.headers.getSetCookie()
      for (const setCookie of setCookies) this.jar.setCookieSync(setCookie, destination.href)
      const html = await response.text(), location = response.headers.get("location")
      this.trace?.note("http-response", { ...route, method: verb(), status: response.status, elapsedMs: Date.now() - started, bytes: Buffer.byteLength(html), redirects,
        cookiesReceived: setCookies.length, cookiesSent: cookieCount(cookie) })
      if (html.length > 12_000_000) throw new UserError(t("net.pageTooLarge"))
      if (response.status >= 300 && response.status < 400 && location && follow) {
        const next = new URL(location, destination)
        if ([307, 308].includes(response.status) && body && next.origin !== destination.origin) throw new UserError(t("net.crossOrigin"))
        if (![307, 308].includes(response.status)) { method = "GET"; body = undefined }
        destination = next; continue
      }
      if (response.status >= 400) throw new HttpStatusError(response.status)
      if (/maintenance|メンテナンス/.test(load(html)("title").text().toLowerCase())) throw new NetMaintenanceError()
      this.trace?.note("page-shape", pageShape(html))
      return { html, url: destination.href, status: response.status, location }
    }
    throw new UserError(t("net.redirectLoop"))
  }
  async start(auth: Credentials): Promise<Card[]> {
    if (!auth.username || !auth.password) throw new UserError(t("net.credentialsMissing"))
    this.jar = new CookieJar()
    let page
    if (this.region === "jp") {
      this.trace?.step("auth.form")
      const login = await this.request(this.base), token = load(login.html)('input[name="token"]').attr("value")
      if (!token) throw new UserError(t("net.jpTokenMissing"))
      this.trace?.step("auth.submit")
      const submitted = await this.request(`${this.base}submit/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ segaId: auth.username, password: auth.password, save_cookie: "on", token }) })
      if (load(submitted.html)('[name="password"]').length || /\/error\//.test(submitted.url)) throw new UserError(t("net.loginFailed"))
      this.trace?.step("auth.redirect")
      page = await this.request(`${this.base}aimeList/`)
    } else {
      const gateway = "https://lng-tgk-aime-gw.am-all.net/common_auth/"
      this.trace?.step("auth.form")
      await this.request(`${gateway}login?site_id=maimaidxex&redirect_url=${encodeURIComponent(this.base)}&back_url=https%3A%2F%2Fmaimai.sega.com%2F`)
      this.trace?.step("auth.submit")
      const submitted = await this.request(`${gateway}login/sid`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ sid: auth.username, password: auth.password, retention: "1" }) }, false)
      if (submitted.status !== 302 || !submitted.location) throw new UserError(t("net.gatewayFailed"))
      this.trace?.step("auth.redirect")
      page = await this.request(new URL(submitted.location, gateway).href)
      if (new URL(page.url).hostname !== "maimaidx-eng.com" || /\/error\//.test(page.url)) throw new UserError(t("net.gatewayRejected"))
    }
    this.trace?.step("cards.parse")
    const cards = parseCards(page.html, this.base)
    this.trace?.note("page-shape", { cards: cards.length })
    if (cards.length) return cards
    if (load(page.html)(".name_block").length) return [{ index: -1, label: t("bind.currentCard") }]
    throw new UserError(t("net.cardsMissing"))
  }
  async select(index: number) {
    if (index >= 0) {
      this.trace?.step("card.select")
      await this.request(`${this.base}aimeList/submit/?idx=${index}`)
    }
    this.trace?.step("profile.read")
    const home = await this.request(`${this.base}home/`), $ = load(home.html)
    this.trace?.step("profile.parse")
    const name = $(".name_block").first().text().trim()
    if (!name || $('[name="password"]').length || /\/error\//.test(home.url)) throw new UserError(t("net.profileInvalid"))
    const rating = Number($(".rating_block").text().replace(/[^0-9]/g, ""))
    return { name: name.slice(0, 100), ...(rating > 0 ? { rating } : {}) }
  }
  async fetchSnapshot(auth: Credentials, progress?: (text: string) => Promise<unknown>): Promise<Snapshot> {
    const index = auth.cardIndex ?? -1
    let profile
    try { profile = await this.select(index) }
    catch (error) {
      // Only session-type failures re-login. Network, TLS, DNS, HTTP status and maintenance errors are surfaced without another login.
      if (!(error instanceof UserError) || error instanceof HttpStatusError || error instanceof NetMaintenanceError) throw error
      this.trace?.note("relogin")
      const cards = await this.start(auth)
      if (!cards.some(card => card.index === index)) throw new UserError(t("net.cardUnavailable"))
      profile = await this.select(index)
    }
    // Aime list indices can change when cards are removed. Require reconfirmation
    // if the chosen profile changes instead of silently syncing a different card.
    if (auth.playerName && auth.playerName !== profile.name) throw new UserError(t("net.profileChanged"))
    const records: ScoreRecord[] = []
    // All five difficulty pages must parse before the caller saves anything.
    for (let level = 0; level <= 4; level++) {
      this.trace?.step("records.fetch", { level })
      await progress?.(t("progress.readingDifficulty", { difficulty: t(`difficulty.${DIFFICULTIES[level]}`) }))
      const page = await this.request(`${this.base}record/musicGenre/search/?genre=99&diff=${level}`)
      this.trace?.step("records.parse", { level })
      const stats: ParseStats = { nodes: 0, noTitle: 0, noScore: 0, unplayed: 0 }
      let parsed: ScoreRecord[]
      try { parsed = parseMusicPage(page.html, level, stats) }
      catch (error) {
        // Record which structural check failed before the error reaches the player.
        this.trace?.note("records", { level, records: 0, ...stats })
        this.writeShape(page.html, level)
        throw error
      }
      this.trace?.note("records", { level, records: parsed.length, ...stats })
      // Zero records from a non-empty page means the selectors no longer match this layout.
      if (!parsed.length && stats.nodes) this.writeShape(page.html, level)
      records.push(...parsed)
    }
    return { accountKey: accountKey(this.region, JSON.stringify([auth.username, index])), profile, records,
      fetchedAt: new Date().toISOString(), countsComplete: false, source: "net" }
  }
}
