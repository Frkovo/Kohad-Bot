// 迁移包 → 水鱼 update_records 记录（规则与 scripts 时代 pu.pu 同源）
// 过滤：musicId>0、achievement>0、必须命中水鱼曲库；普通谱面 level 0-4，宴谱（id≥100000）level_index 固定 0
// 宴谱：水鱼建模为 type=DX + level_index 0（官方参考数据 /player/test_data 实证，level_label="Utage"）
// 映射：achievements=ach/10000、dxScore=deluxscoreMax、fc/fs 枚举、title/type 取自水鱼曲库
import type { DfMusic } from "./client.js"

export type DfUploadRecord = {
  achievements: number
  dxScore: number
  fc: string
  fs: string
  level_index: number
  title: string
  type: string
}

export type SkipGroup = { reason: string; count: number; samples: string[] }
export type UploadPlan = { records: DfUploadRecord[]; skipped: SkipGroup[]; total: number; mapped: number }

export const COMBO = ["", "fc", "fcp", "ap", "app"]
export const SYNC = ["", "fs", "fsp", "fsd", "fsdp", "sync"]

type RawDetail = {
  musicId?: unknown
  level?: unknown
  achievement?: unknown
  deluxscoreMax?: unknown
  comboStatus?: unknown
  syncStatus?: unknown
}

/** 展平 pull.music 的 userMusicDetailList（兼容 userMusicList[] 包裹与直挂两种形态） */
export function extractMusicDetails(pull: unknown): RawDetail[] {
  const music = (pull as { music?: unknown } | null)?.music as
    { userMusicList?: unknown[]; userMusicDetailList?: unknown[] } | null | undefined
  const out: RawDetail[] = []
  const push = (list: unknown) => {
    if (Array.isArray(list)) for (const d of list) if (d && typeof d === "object") out.push(d as RawDetail)
  }
  if (Array.isArray(music?.userMusicList)) {
    for (const w of music.userMusicList) push((w as { userMusicDetailList?: unknown })?.userMusicDetailList)
  }
  push(music?.userMusicDetailList)
  return out
}

export function buildUploadPlan(pull: unknown, catalog: Map<number, DfMusic>): UploadPlan {
  const details = extractMusicDetails(pull)
  const records: DfUploadRecord[] = []
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
    const song = catalog.get(mid)
    if (!song) { addSkip("水鱼曲库缺失", String(mid)); continue }
    // 宴谱（id≥100000）：type 用曲库值（DX）+ level_index 固定 0；普通谱面校验 level 0-4
    let levelIndex: number
    if (mid >= 100000) {
      levelIndex = 0
    } else {
      const level = Number(d.level)
      if (!Number.isInteger(level) || level < 0 || level > 4) { addSkip("无效记录", `${mid}:${d.level ?? "?"}`); continue }
      levelIndex = level
    }
    const combo = Number(d.comboStatus ?? 0)
    const sync = Number(d.syncStatus ?? 0)
    records.push({
      achievements: ach / 10000,
      dxScore: Math.max(0, Math.floor(Number(d.deluxscoreMax ?? 0))),
      fc: combo >= 0 && combo < COMBO.length ? COMBO[combo] : "",
      fs: sync >= 0 && sync < SYNC.length ? SYNC[sync] : "",
      level_index: levelIndex,
      title: song.title,
      type: song.type,
    })
  }
  return {
    records,
    skipped: [...skip.entries()].map(([reason, v]) => ({ reason, ...v })),
    total: details.length,
    mapped: records.length,
  }
}
