// 水鱼查分器 API 客户端（www.diving-fish.com/api/maimaidxprober）
// - music_data：免鉴权曲库（缓存 1 小时；id 为字符串需 Number()，DX 版老曲 id+10000，宴谱 id>=100000）
// - player/records：OAuth Bearer（scope prober.records.read）读取
// - update_records：OAuth Bearer（prober.records.write）或用户 Import-Token 写入
export const DF_PROBER = "https://www.diving-fish.com/api/maimaidxprober"

export class DfUnauthorizedError extends Error {
  constructor() { super("水鱼 access token 已失效（401）") }
}

export type DfMusic = {
  id: number
  title: string
  type: string
  ds?: number[]
  level?: string[]
  isNew?: boolean
  notes?: number[]
}

export type DfRecord = {
  achievements?: number
  dxScore?: number
  fc?: string
  fs?: string
  level_index?: number
  level_label?: string
  ra?: number
  rate?: string
  song_id?: number
  title?: string
  type?: string
}

export type DfPlayerRecords = {
  username?: string
  nickname?: string
  rating?: number
  additional_rating?: number
  plate?: string
  records?: DfRecord[]
}

let musicCache: { at: number; map: Map<number, DfMusic> } | null = null
const MUSIC_TTL_MS = 60 * 60 * 1000
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { t } from "../messages.js"
const DATA = fileURLToPath(new URL("../../assets/data/", import.meta.url))

/** 水鱼曲库（id → {title, type, ds, level}）；上传映射与 b50 兜底均用 */
export async function fetchMusicCatalog(): Promise<Map<number, DfMusic>> {
  if (musicCache && Date.now() - musicCache.at < MUSIC_TTL_MS) return musicCache.map
  let raw: unknown
  try {
  const res = await fetch(`${DF_PROBER}/music_data`, { signal: AbortSignal.timeout(30000), headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`水鱼曲库请求失败（HTTP ${res.status}）`)
  raw = await res.json() as unknown
  if (!Array.isArray(raw) || !raw.length) throw new Error("水鱼曲库响应结构异常")
  mkdirSync(DATA, { recursive: true })
  writeFileSync(`${DATA}/df-music.json.tmp`, JSON.stringify(raw)); renameSync(`${DATA}/df-music.json.tmp`, `${DATA}/df-music.json`)
  } catch (error) {
    if (musicCache) return musicCache.map
    try { raw = JSON.parse(readFileSync(`${DATA}/df-music.json`, "utf8")) } catch { throw error }
  }
  if (!Array.isArray(raw)) throw new Error("水鱼曲库响应结构异常（非数组）")
  const map = new Map<number, DfMusic>()
  for (const item of raw as Array<Record<string, unknown>>) {
    const id = Number(item.id)
    if (!Number.isFinite(id)) continue
    map.set(id, {
      id,
      title: String(item.title ?? ""),
      type: String(item.type ?? "SD"),
      ds: Array.isArray(item.ds) ? item.ds as number[] : undefined,
      level: Array.isArray(item.level) ? item.level as string[] : undefined,
      isNew: (item.basic_info as { is_new?: boolean } | undefined)?.is_new,
      notes: Array.isArray(item.charts) ? item.charts.map(c => {
        const notes = (c as { notes?: number[] }).notes ?? []
        return notes.reduce((s, n) => s + Number(n), 0) * 3
      }) : undefined,
    })
  }
  musicCache = { at: Date.now(), map }
  return map
}

export async function fetchPlayerRecords(token: string): Promise<DfPlayerRecords> {
  const res = await fetch(`${DF_PROBER}/player/records`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  })
  if (res.status === 401) throw new DfUnauthorizedError()
  if (!res.ok) {
    // Documented error bodies: 403 "access token 缺少权限" / "该用户未同意用户协议", 429 "已超出今日请求上限", 503 "服务端未启用 OAuth".
    // Only a fixed code is kept; the provider message is never logged.
    let message = ""
    try { message = String((await res.json() as { message?: unknown }).message ?? "") } catch { /* no json body */ }
    const providerCode = res.status === 403 ? (message.includes("缺少权限") ? "scope_missing" : message.includes("用户协议") ? "agreement_missing" : "forbidden")
      : res.status === 429 ? "rate_limited" : res.status === 503 ? "oauth_disabled" : res.status === 401 ? "token_rejected" : `records_http_${res.status}`
    throw Object.assign(new Error(`水鱼成绩读取失败（HTTP ${res.status}，${providerCode}）`), { status: res.status, providerCode: providerCode.startsWith("records_http_") ? "records_http" : providerCode })
  }
  return await res.json() as DfPlayerRecords
}

export type UpdateAuth = { token?: string; importToken?: string }
export type UpdateResult = { ok: boolean; status: number; message: string }

/** 上传成绩（update_records）：records 为水鱼导入格式（pu.pu 同款映射见 df/upload.ts） */
export async function updateRecords(records: unknown[], auth: UpdateAuth): Promise<UpdateResult> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" }
  if (auth.token) headers.authorization = `Bearer ${auth.token}`
  else if (auth.importToken) headers["Import-Token"] = auth.importToken
  const res = await fetch(`${DF_PROBER}/player/update_records`, {
    method: "POST",
    headers,
    body: JSON.stringify(records),
    signal: AbortSignal.timeout(120000),
  })
  // Don't echo arbitrary response bodies which can reflect request credentials.
  return { ok: res.ok, status: res.status, message: res.ok ? t("df.upload.accepted") : t("df.upload.rejected", { status: res.status, hint: res.status === 401 || res.status === 403 ? t("df.upload.authHint") : "" }) }
}
