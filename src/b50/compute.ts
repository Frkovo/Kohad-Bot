// B50 计算：B35（旧曲 top35）+ B15（当前版本新曲 top15）
// - 所有来源都按当前定数重新计算；拟合模式用 fit_diff 的原始精度
// - 新曲按谱面版本判定；PC50 按全库 playCount 排序（含宴谱）
import { calculateDxRating } from "./rating.js"
import { netRating } from "../multiserver/rating.js"
import type { LxnsDifficulty, LxnsSong } from "./songs.js"

export type ChartInfo = {
  displayId?: string
  jacketHash?: string
  musicId: number
  level: number
  type: "SD" | "DX"
  title: string
  ds: number
  levelLabel: string
  version: number
  maxDxScore?: number
  disabled?: boolean
  isNew?: boolean
  fitDs?: number
}

export function buildChartIndex(songs: LxnsSong[]): Map<string, ChartInfo> {
  const map = new Map<string, ChartInfo>()
  const add = (s: LxnsSong, arr: LxnsDifficulty[], t: "SD" | "DX") => {
    for (const d of arr) {
      map.set(`${s.id}:${d.difficulty}:${t}`, {
        musicId: s.id,
        level: d.difficulty,
        type: t,
        title: s.title,
        ds: Number(d.level_value ?? 0),
        levelLabel: String(d.level ?? ""),
        version: Number(d.version ?? 0),
        maxDxScore: Number(d.notes?.total ?? 0) * 3,
        disabled: s.disabled === true,
      })
    }
  }
  for (const s of songs) {
    add(s, s.difficulties?.standard ?? [], "SD")
    add(s, s.difficulties?.dx ?? [], "DX")
    if (s.id >= 100000) {
      for (const d of s.difficulties?.utage ?? []) map.set(`${s.id}:0:DX`, {
        musicId: s.id, level: 0, type: "DX", title: s.title, ds: 0, levelLabel: d.level,
        version: d.version ?? s.version, disabled: s.disabled, maxDxScore: Number(d.notes?.total ?? 0) * 3,
      })
    }
  }
  return map
}

export type B50Input = {
  /** Stable provider/catalogue key; avoids applying CN numeric ID rules to NET. */
  chartKey?: string
  musicId: number
  level: number
  type?: "SD" | "DX"
  achievement: number
  dxScore: number
  fc: string
  fs: string
  ra?: number
  title?: string
  playCount?: number
}

export type B50Entry = {
  displayId?: string
  jacketHash?: string
  isNew?: boolean
  musicId: number
  level: number
  type: "SD" | "DX"
  title: string
  ds: number
  levelLabel: string
  achievement: number
  dxScore: number
  fc: string
  fs: string
  ra: number
  version: number
  playCount?: number
  maxDxScore?: number
  officialDs?: number
  /** A play whose chart the bundled data does not know (MuNET). Shown as 未知歌曲 with rating 0; never ranked. */
  unknown?: boolean
}

export type B50Result = {
  b35: B50Entry[]
  b15: B50Entry[]
  total: number
  /** 曲库中查不到谱面的记录数（不参与 B50） */
  missing: number
  newVersionFrom: number
  mode?: "b50" | "fitb50" | "pc50"
  fitMissing?: number
}

/** Game / DF IDs carry +10000 for DX; LXNS uses the shared base ID. Never fall back to a different explicit type. */
export function resolveChart(index: Map<string, ChartInfo>, rec: Pick<B50Input, "musicId" | "level" | "type">): ChartInfo | undefined {
  if (rec.musicId >= 100000) return undefined
  const encodedDx = rec.musicId >= 10000
  const id = encodedDx ? rec.musicId - 10000 : rec.musicId
  const type = encodedDx ? "DX" : rec.type
  if (type) return index.get(`${id}:${rec.level}:${type}`)
  return index.get(`${id}:${rec.level}:SD`) ?? index.get(`${id}:${rec.level}:DX`)
}

export function computeB50(inputs: B50Input[], chartIndex: Map<string, ChartInfo>, opts: { newVersionFrom: number; mode?: "b50" | "fitb50" | "pc50"; versionTo?: number; useChartBuckets?: boolean; ratingPolicy?: "cn" | "net" }): B50Result {
  const entries = new Map<string, B50Entry>()
  let missing = 0
  let fitMissing = 0
  for (const rec of inputs) {
    if ((!rec.chartKey && rec.musicId >= 100000 && opts.mode !== "pc50") || !(Number.isFinite(rec.achievement) && rec.achievement >= 0)) continue
    if (opts.mode !== "pc50" && rec.achievement === 0) continue
    const chart = rec.chartKey ? chartIndex.get(rec.chartKey) : rec.musicId >= 100000 ? chartIndex.get(`${rec.musicId}:0:DX`) : resolveChart(chartIndex, rec)
    if (!chart) { missing++; continue }
    if (opts.mode !== "pc50" && (chart.disabled || chart.version >= (opts.versionTo ?? Infinity))) continue
    const fitted = opts.mode === "fitb50"
    if (fitted && !(Number.isFinite(chart.fitDs) && Number(chart.fitDs) > 0)) { fitMissing++; continue }
    const ds = fitted ? Number(chart.fitDs) : chart.ds
    // Recompute against the current constants, including platform records with stale ra.
    const ra = opts.ratingPolicy === "net" ? netRating(ds, rec.achievement, rec.fc) : calculateDxRating(ds, rec.achievement)
    const entry: B50Entry = {
      displayId: chart.displayId,
      jacketHash: chart.jacketHash,
      musicId: chart.musicId,
      level: rec.level,
      type: chart.type,
      title: chart.title,
      ds,
      officialDs: chart.ds,
      levelLabel: chart.levelLabel,
      achievement: rec.achievement,
      dxScore: rec.dxScore,
      fc: rec.fc,
      fs: rec.fs,
      ra,
      version: chart.version,
      playCount: rec.playCount ?? 0,
      maxDxScore: chart.maxDxScore,
      isNew: chart.isNew,
    }
    const key = rec.chartKey ?? `${chart.musicId}:${rec.level}:${chart.type}`
    const prior = entries.get(key)
    if (!prior) entries.set(key, entry)
    else entries.set(key, { ...(entry.achievement > prior.achievement ? entry : prior), playCount: Math.max(entry.playCount ?? 0, prior.playCount ?? 0) })
  }
  const all = [...entries.values()]
  const isNew = (e: B50Entry) => opts.useChartBuckets ? e.isNew === true : opts.newVersionFrom > 0 && e.version >= opts.newVersionFrom
  const order = (a: B50Entry, b: B50Entry) => b.ra - a.ra || b.achievement - a.achievement || b.ds - a.ds || a.musicId - b.musicId || a.level - b.level
  const pcs = opts.mode === "pc50" ? all.filter(e => (e.playCount ?? 0) > 0).sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0) || order(a, b)).slice(0, 50) : null
  const b15 = pcs ? pcs.slice(35) : all.filter(isNew).sort(order).slice(0, 15)
  const b35 = pcs ? pcs.slice(0, 35) : all.filter(e => !isNew(e)).sort(order).slice(0, 35)
  const total = [...b35, ...b15].reduce((s, e) => s + e.ra, 0)
  return { b35, b15, total, missing, fitMissing, newVersionFrom: opts.newVersionFrom, mode: opts.mode ?? "b50" }
}
