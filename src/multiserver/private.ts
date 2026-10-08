import { accountKey } from "./net.js"
import { UserError, SERVER_NAMES, type Credentials, type ScoreRecord, type Snapshot } from "./registry.js"
import { t } from "../messages.js"

export function privateEndpoint(server: "mumur" | "missless") {
  const value = process.env[`${server.toUpperCase()}_SCORE_ENDPOINT`]?.trim()
  if (!value) throw new UserError(t("private.unconfigured", { server: SERVER_NAMES[server] }))
  let url: URL
  try { url = new URL(value) } catch { throw new UserError(t("private.invalidEndpoint")) }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new UserError(t("private.httpsRequired"))
  return url.href
}
/** Explicit read-only adapter contract. This is not a guessed private game endpoint. */
export async function fetchPrivateSnapshot(server: "mumur" | "missless", auth: Credentials, signal?: AbortSignal): Promise<Snapshot> {
  const url = privateEndpoint(server)
  if (!auth.accessCode) throw new UserError(t("private.accessCodeMissing"))
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
    headers: { "Content-Type": "application/json", ...(process.env[`${server.toUpperCase()}_ADAPTER_TOKEN`] ? { Authorization: `Bearer ${process.env[`${server.toUpperCase()}_ADAPTER_TOKEN`]}` } : {}) },
    body: JSON.stringify({ accessCode: auth.accessCode }) })
  if (!response.ok) throw new UserError(t("private.httpStatus", { status: response.status }))
  const text = await response.text()
  if (text.length > 12_000_000) throw new UserError(t("private.tooLarge"))
  let raw: Record<string, any>
  try { raw = JSON.parse(text) } catch { throw new UserError(t("private.invalidJson")) }
  if (!raw || typeof raw !== "object" || raw.authenticated !== true || !raw.account?.id || !["string","number"].includes(typeof raw.account.id) || typeof raw.account.name !== "string" || !raw.account.name.trim() || !Array.isArray(raw.records) || raw.complete !== true) throw new UserError(t("private.notAuthenticated"))
  const records: ScoreRecord[] = raw.records.map((r: Record<string, any>) => {
    if (!r || typeof r.title !== "string" || !r.title.trim() || !["SD", "DX"].includes(r.type) || !Number.isInteger(r.level) || r.level < 0 || r.level > 4 || !Number.isSafeInteger(r.achievement) || r.achievement < 0 || r.achievement > 1010000 || !Number.isSafeInteger(r.dxScore) || r.dxScore < 0 || !Number.isFinite(r.ds) || r.ds <= 0 || !Number.isFinite(r.version) || typeof r.isNew !== "boolean") throw new UserError(t("private.recordIncomplete"))
    const playCount = r.playCount
    if (playCount !== undefined && (!Number.isSafeInteger(playCount) || playCount < 0)) throw new UserError(t("private.playCountInvalid"))
    if (r.maxDxScore !== undefined && (!Number.isSafeInteger(r.maxDxScore) || r.maxDxScore <= 0 || r.dxScore > r.maxDxScore)) throw new UserError(t("private.dxScoreInvalid"))
    if (!["", "fc", "fcp", "ap", "app"].includes(r.fc ?? "") || !["", "sync", "fs", "fsp", "fsd", "fsdp"].includes(r.fs ?? "")) throw new UserError(t("private.markInvalid"))
    return { title: r.title.slice(0, 300), type: r.type, level: r.level, achievement: Math.round(r.achievement), dxScore: Math.floor(r.dxScore), fc: r.fc ?? "", fs: r.fs ?? "",
      ds: r.ds, version: r.version, isNew: r.isNew, ...(Number.isSafeInteger(r.musicId) && r.musicId > 0 ? { musicId: r.musicId } : {}),
      ...(playCount !== undefined ? { playCount } : {}), ...(Number.isFinite(r.maxDxScore) && r.maxDxScore > 0 ? { maxDxScore: r.maxDxScore } : {}) }
  })
  return { accountKey: accountKey(server, String(raw.account.id)), profile: { name: raw.account.name.slice(0, 100), ...(Number.isFinite(raw.account.rating) ? { rating: raw.account.rating } : {}) },
    records, fetchedAt: new Date().toISOString(), source: "private_api", countsComplete: raw.countsComplete === true && records.every(record => record.playCount !== undefined),
    ...(typeof raw.version === "string" ? { version: raw.version.slice(0, 100) } : {}) }
}
