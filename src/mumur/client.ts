// MuNET read path, modelled on AquaDX's MaimaiDataBroker: AllNet PowerOn -> AimeDB card lookup -> plain API names.
// Read-only. No UserLogin/UserLogout, no writes. Records are resolved against the bundled chart data (dxdata internalId = musicId).
import { deflateSync, inflateSync } from "node:zlib"
import { UserError, type Credentials, type ScoreRecord, type Snapshot } from "../multiserver/registry.js"
import { accountKey } from "../multiserver/net.js"
import { dxData, VERSIONS } from "../multiserver/catalog.js"
import { powerOn, keychipShort } from "./allnet.js"
import { lookupUserId } from "./aimedb.js"
import { t } from "../messages.js"

const DIFFICULTIES = ["basic", "advanced", "expert", "master", "remaster"]
// Mai2 comboStatus / syncStatus: AquaDX's source does not name these values, so this mapping is an inference.
// Verify against a few known scores before trusting fc/fs labels.
const COMBO: Record<number, string> = { 1: "fc", 2: "fcp", 3: "ap", 4: "app" }
const SYNC: Record<number, string> = { 1: "sync", 2: "fs", 3: "fsp", 4: "fsd", 5: "fsdp" }

export type MumurConfig = { powerOnUrl: string; aimeHost: string; keychip: string; game: string; version: string; chartVersion?: string }
export function mumurConfig(env: NodeJS.ProcessEnv = process.env): MumurConfig {
  return {
    powerOnUrl: (env.MUMUR_POWERON_URL ?? "http://play.mumur.net/sys/servlet/PowerOn").trim(),
    aimeHost: (env.MUMUR_AIME_HOST ?? "aime.mumur.net").trim(),
    // Required: MuNET only accepts keychips it has registered. No default, so a missing value is reported as such.
    keychip: (env.MUMUR_KEYCHIP ?? "").trim(),
    game: (env.MUMUR_GAME ?? "SDEZ").trim(),
    version: (env.MUMUR_GAME_VERSION ?? "1.70").trim(),
    chartVersion: env.MUMUR_CHART_VERSION?.trim() || undefined,
  }
}

export type ChartRef = { title: string; type: "SD" | "DX"; ds: number; version: number; isNew: boolean; maxDxScore?: number }

// Keyed by `${musicId}:${level}`. Uses the newest release in the bundled data (or MUMUR_CHART_VERSION) for ds.
export function mumurChartIndex(chartVersion?: string, data = dxData()): { version: string; index: Map<string, ChartRef> } {
  const version = chartVersion || VERSIONS[VERSIONS.length - 1]
  const current = VERSIONS.indexOf(version)
  if (current < 0) throw new UserError(t("catalog.versionInvalid"))
  const index = new Map<string, ChartRef>()
  for (const song of data.songs) for (const sheet of song.sheets) {
    const level = DIFFICULTIES.indexOf(sheet.difficulty), release = VERSIONS.indexOf(sheet.version)
    if (sheet.internalId === undefined || level < 0 || release < 0 || release > current || !["std", "dx"].includes(sheet.type)) continue
    const ds = Number(sheet.multiverInternalLevelValue?.[version] ?? sheet.internalLevelValue)
    if (!(ds > 0)) continue
    index.set(`${sheet.internalId}:${level}`, { title: song.title, type: sheet.type === "dx" ? "DX" : "SD", ds, version: release,
      isNew: current >= 25 ? release >= current - 1 : release === current, maxDxScore: sheet.noteCounts?.total ? sheet.noteCounts.total * 3 : undefined })
  }
  return { version, index }
}

type MumurRecord = { musicId: number; level: number; achievement: number; deluxscoreMax: number; playCount: number; comboStatus: number; syncStatus: number }

export function toScoreRecord(raw: MumurRecord, index: Map<string, ChartRef>): ScoreRecord {
  if (!Number.isSafeInteger(raw.musicId) || raw.musicId <= 0 || !Number.isInteger(raw.level) || raw.level < 0 || raw.level > 4 ||
    !Number.isSafeInteger(raw.achievement) || raw.achievement < 0 || raw.achievement > 1010000 ||
    !Number.isSafeInteger(raw.deluxscoreMax) || raw.deluxscoreMax < 0 || !Number.isSafeInteger(raw.playCount) || raw.playCount < 0)
    throw new UserError(t("mumur.recordInvalid"))
  const base = { musicId: raw.musicId, level: raw.level, achievement: raw.achievement, dxScore: raw.deluxscoreMax, playCount: raw.playCount,
    fc: COMBO[raw.comboStatus] ?? "", fs: SYNC[raw.syncStatus] ?? "" }
  const chart = index.get(`${raw.musicId}:${raw.level}`)
  if (!chart) return { ...base, title: `#${raw.musicId}`, type: raw.musicId >= 10000 ? "DX" : "SD" }
  return { ...base, title: chart.title, type: chart.type, ds: chart.ds, version: chart.version, isNew: chart.isNew, maxDxScore: chart.maxDxScore }
}

// One API call. The request is deflated JSON; the response is plain JSON or deflated JSON (AquaDX's bodyMaybeZ).
export async function callMumurApi(gameUrl: string, api: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
  const response = await fetch(`${gameUrl}Maimai2Servlet/${api}`, {
    method: "POST", redirect: "error", body: deflateSync(Buffer.from(JSON.stringify(body), "utf8")),
    headers: { "Content-Type": "application/json", "Content-Encoding": "deflate", "User-Agent": "sdgb-tools-discord-bot/0.1" },
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) throw new UserError(t("mumur.apiFailed", { api, status: response.status }))
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new UserError(t("mumur.apiFailed", { api, status: response.status }))
  const text = bytes[0] === 0x7b || bytes[0] === 0x5b ? bytes.toString("utf8") : inflateSync(bytes).toString("utf8")
  try { return JSON.parse(text) } catch { throw new UserError(t("mumur.apiFailed", { api, status: response.status })) }
}

export async function fetchMumurSnapshot(auth: Credentials, signal?: AbortSignal, config = mumurConfig()): Promise<Snapshot> {
  const card = (auth.accessCode ?? "").replace(/\s/g, "")
  if (!/^\d{20}$/.test(card)) throw new UserError(t("mumur.cardInvalid"))
  if (!config.keychip) throw new UserError(t("mumur.keychipMissing"))
  const gameUrl = await powerOn({ url: config.powerOnUrl, keychip: config.keychip, game: config.game, version: config.version, signal })
  const userId = await lookupUserId({ host: config.aimeHost, game: config.game, keychipShortId: keychipShort(config.keychip), card })
  if (userId === undefined) throw new UserError(t("mumur.cardNotFound"))
  const profile = (await callMumurApi(gameUrl, "GetUserDataApi", { userId }, signal)).userData
  if (!profile || typeof profile.userName !== "string" || !profile.userName.trim()) throw new UserError(t("mumur.profileMissing"))
  const music = await callMumurApi(gameUrl, "GetUserMusicApi", { userId, nextIndex: 0, maxCount: 10000000 }, signal)
  const details: MumurRecord[] = (music.userMusicList ?? []).flatMap((wrapper: { userMusicDetailList?: MumurRecord[] }) => wrapper.userMusicDetailList ?? [])
  const { version, index } = mumurChartIndex(config.chartVersion)
  return {
    accountKey: accountKey("mumur", String(userId)),
    profile: { name: profile.userName.slice(0, 100), ...(Number.isFinite(profile.playerRating) ? { rating: profile.playerRating } : {}) },
    records: details.map(raw => toScoreRecord(raw, index)),
    fetchedAt: new Date().toISOString(), countsComplete: true, source: "private_api", version,
  }
}
