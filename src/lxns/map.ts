// 迁移包 → 落雪上传成绩（Score[]）映射
// 规则（对齐落雪「标准/DX 同 id、无 +10000」模型）：
//   宴谱（id≥100000）→ { id 原样, type: utage, level_index: 0 }
//   id≥10000 → { id-10000, type: dx }（如 10030 → 30/dx）
//   否则查曲库：仅 dx → dx；双谱面或未知 → standard（dump 中老曲 DX 版必带 +10000）
// 曲库只用于判定类型，不再作为上传门槛：查分器尚未收录的曲目照样提交（真值优先，由查分器接受或拒绝）。
import { COMBO, SYNC, extractMusicDetails } from "../df/upload.js"
import type { LxnsSong } from "../b50/songs.js"
import type { LxnsUploadScore } from "./client.js"

export type LxnsSkipGroup = { reason: string; count: number; samples: string[] }
export type LxnsUploadPlan = { scores: LxnsUploadScore[]; skipped: LxnsSkipGroup[]; total: number; mapped: number; unknown: number }

export function buildChartPresence(songs: LxnsSong[]): Map<string, { standard: boolean; dx: boolean; utage: boolean }> {
  const map = new Map<string, { standard: boolean; dx: boolean; utage: boolean }>()
  const touch = (k: string) => {
    const cur = map.get(k) ?? { standard: false, dx: false, utage: false }
    map.set(k, cur)
    return cur
  }
  const add = (s: LxnsSong, arr: { difficulty: number }[] | undefined, key: "standard" | "dx") => {
    for (const d of arr ?? []) touch(`${s.id}:${d.difficulty}`)[key] = true
  }
  for (const s of songs) {
    add(s, s.difficulties?.standard, "standard")
    add(s, s.difficulties?.dx, "dx")
    if ((s.difficulties?.utage ?? []).length > 0) touch(`${s.id}:0`).utage = true
  }
  return map
}

export function buildLxnsUploadPlan(pull: unknown, songs: LxnsSong[]): LxnsUploadPlan {
  const details = extractMusicDetails(pull)
  const presence = buildChartPresence(songs)
  const known: LxnsUploadScore[] = [], extra: LxnsUploadScore[] = []
  const skip = new Map<string, { count: number; samples: string[] }>()
  const addSkip = (reason: string, sample: string) => {
    const cur = skip.get(reason) ?? { count: 0, samples: [] }
    cur.count++
    if (cur.samples.length < 3) cur.samples.push(sample)
    skip.set(reason, cur)
  }

  for (const d of details) {
    const mid = Number(d.musicId)
    const ach = Number(d.achievement)
    if (!Number.isInteger(mid) || mid <= 0 || !Number.isFinite(ach) || ach <= 0) {
      addSkip("无效记录", `${d.musicId ?? "?"}:${d.level ?? "?"}`)
      continue
    }
    const combo = Number(d.comboStatus ?? 0)
    const sync = Number(d.syncStatus ?? 0)
    const fc = combo >= 0 && combo < COMBO.length && COMBO[combo] ? COMBO[combo] : null
    const fs = sync >= 0 && sync < SYNC.length && SYNC[sync] ? SYNC[sync] : null
    const base = {
      achievements: Math.round(ach) / 10000,
      fc,
      fs,
      dx_score: Math.max(0, Math.floor(Number(d.deluxscoreMax ?? 0))),
    }
    // 宴谱（id≥100000）：id 原样、type=utage、level_index 固定 0（落雪文档：宴会场不分标准/DX）
    if (mid >= 100000) {
      const score = { id: mid, type: "utage" as const, level_index: 0, ...base }
      ;(presence.get(`${mid}:0`)?.utage ? known : extra).push(score)
      continue
    }
    const level = Number(d.level)
    if (!Number.isInteger(level) || level < 0 || level > 4) { addSkip("无效记录", `${mid}:${d.level ?? "?"}`); continue }
    if (mid >= 10000) {
      const id = mid - 10000
      if (id <= 0) { addSkip("无效记录", String(mid)); continue }
      ;(presence.get(`${id}:${level}`)?.dx ? known : extra).push({ id, type: "dx", level_index: level, ...base })
    } else {
      const p = presence.get(`${mid}:${level}`)
      const type = p && !p.standard && p.dx ? "dx" : "standard"
      ;(p && (p.standard || p.dx) ? known : extra).push({ id: mid, type, level_index: level, ...base })
    }
  }

  return {
    // Known charts go first so a rejected unknown batch never blocks the songs both sides agree on.
    scores: [...known, ...extra],
    skipped: [...skip.entries()].map(([reason, v]) => ({ reason, ...v })),
    total: details.length,
    mapped: known.length + extra.length,
    unknown: extra.length,
  }
}
