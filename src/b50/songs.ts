// 落雪公共曲库（免鉴权）：定数 level_value / 版本 / 曲名，10 分钟缓存。
// 仅作为数据资产（b50 定数、B15 版本判定、上传映射）；落雪平台接入（绑定/上传/读账号）见 lxns/client.ts + lxns/bindings.ts。
export type LxnsDifficulty = {
  type?: string
  difficulty: number
  level: string
  level_value: number
  version: number
  /** 宴谱专属字段（id≥100000 的曲目） */
  kanji?: string
  description?: string
  is_buddy?: boolean
  notes?: { total?: number; tap?: number; hold?: number; slide?: number; touch?: number; break?: number }
}
export type LxnsSong = {
  id: number
  title: string
  artist?: string
  genre?: string
  bpm?: number
  version: number
  disabled?: boolean
  difficulties: { standard?: LxnsDifficulty[]; dx?: LxnsDifficulty[]; utage?: LxnsDifficulty[] }
}

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

const DATA = fileURLToPath(new URL("../../assets/data/", import.meta.url))
const cache = new Map<string, { at: number; songs: LxnsSong[] }>()
const TTL_MS = 10 * 60 * 1000

export async function fetchLxnsSongs(version = 25500, apiBase = "https://maimai.lxns.net"): Promise<LxnsSong[]> {
  const key = `${apiBase}:${version}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.songs
  try {
  const res = await fetch(`${apiBase}/api/v0/maimai/song/list?version=${version}&notes=true`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`落雪曲库请求失败（HTTP ${res.status}）`)
  const j = await res.json() as { songs?: unknown }
  if (!Array.isArray(j.songs)) throw new Error("落雪曲库响应结构异常（无 songs 数组）")
  const songs = j.songs as LxnsSong[]
  cache.set(key, { at: Date.now(), songs })
  mkdirSync(DATA, { recursive: true })
  const file = `${DATA}/lxns-${version}.json`
  writeFileSync(`${file}.tmp`, JSON.stringify(j)); renameSync(`${file}.tmp`, file)
  return songs
  } catch (error) {
    if (hit) return hit.songs
    try {
      const saved = JSON.parse(readFileSync(`${DATA}/lxns-${version}.json`, "utf8"))
      if (Array.isArray(saved.songs) && saved.songs.length) { cache.set(key, { at: Date.now(), songs: saved.songs }); return saved.songs }
    } catch { /* no offline catalog for this version */ }
    throw error
  }
}
