// DX Rating 单曲计算（自旧 client lib/rating.ts 迁移；水鱼 records 的 ra 字段可作基准校验）
// achievement 使用线上单位：1,010,000 = 101.0000%
export type ScoreDetail = {
  musicId: number
  level: number
  playCount?: number
  achievement?: number
  deluxscoreMax?: number
  comboStatus?: number
  syncStatus?: number
  scoreRank?: number
  extNum1?: number
  extNum2?: number
  [key: string]: unknown
}

const MULTIPLIERS: [number, number][] = [
  [1_005_000, 0.224], [1_000_000, 0.216], [995_000, 0.211],
  [990_000, 0.208], [980_000, 0.203], [970_000, 0.200],
  [940_000, 0.168], [900_000, 0.152], [800_000, 0.136],
  [750_000, 0.120], [700_000, 0.112], [600_000, 0.096], [500_000, 0.080], [0, 0.070],
]

export function dxRatingMultiplier(achievement: number): number {
  const value = Number.isFinite(achievement) ? Math.floor(achievement) : 0
  return MULTIPLIERS.find(([threshold]) => value >= threshold)?.[1] ?? 0
}

export function calculateDxRating(levelValue: number | null | undefined, achievement: number | null | undefined): number {
  if (!Number.isFinite(levelValue) || !Number.isFinite(achievement) || Number(levelValue) <= 0) return 0
  const ach = Math.min(1_005_000, Math.max(0, Math.floor(Number(achievement))))
  return Math.floor(Number(levelValue) * (ach / 10_000) * dxRatingMultiplier(ach) + 1e-9)
}

export function flattenMusicDetails(raw: unknown): ScoreDetail[] {
  const music = (raw as { music?: unknown } | null)?.music ?? raw
  const obj = music as { userMusicList?: unknown[]; userMusicDetailList?: unknown[] } | null
  const wrappers = Array.isArray(obj?.userMusicList) ? obj.userMusicList : []
  const nested = wrappers.flatMap(w => {
    const list = (w as { userMusicDetailList?: unknown[] } | null)?.userMusicDetailList
    return Array.isArray(list) ? list : []
  })
  const direct = Array.isArray(obj?.userMusicDetailList) ? obj.userMusicDetailList : []
  return [...nested, ...direct].filter((d): d is ScoreDetail => {
    const v = d as ScoreDetail | null
    return !!v && typeof v === "object" && Number.isInteger(v.musicId) && Number.isInteger(v.level)
  })
}

export function scoreKey(musicId: number, level: number) {
  return `${musicId}:${level}`
}
