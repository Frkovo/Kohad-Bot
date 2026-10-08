// 落雪 /bests 响应 → B50Result 映射
// 注意：响应中的 standard/dx 数组是「旧曲 Best35 / 新曲 Best15」（按歌曲版本划分），
// 与谱面类型 SD/DX 无关——单曲谱面类型以 Score.type 为准（standard/dx/utage）。
import { computeB50, type B50Result, type ChartInfo } from "../b50/compute.js"
import type { LxnsScore } from "./client.js"

export type LxnsBestsLike = {
  standard?: LxnsScore[]
  dx?: LxnsScore[]
  standard_total?: number
  dx_total?: number
  standard_selections?: LxnsScore[]
  dx_selections?: LxnsScore[]
}

export function lxnsBestsToB50(bests: LxnsBestsLike, chartIndex: Map<string, ChartInfo>, opts: { newVersionFrom: number }): B50Result {
  const rows = [...bests.standard ?? [], ...bests.dx ?? [], ...bests.standard_selections ?? [], ...bests.dx_selections ?? []]
  // Reclassify chart versions and rerank every returned candidate; cached platform totals may lag behind.
  return computeB50(rows.filter(s => s.type !== "utage").map(s => ({
    musicId: s.id, level: s.level_index, type: s.type === "dx" ? "DX" : "SD",
    achievement: Math.round(Number(s.achievements) * 10000), dxScore: Math.max(0, Math.floor(Number(s.dx_score) || 0)),
    fc: s.fc ?? "", fs: s.fs ?? "",
  })), chartIndex, { ...opts, versionTo: opts.newVersionFrom + 500 })
}
