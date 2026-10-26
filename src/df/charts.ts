// Local chart names from the game snapshot (assets/data/sdgb-156-charts.json).
// 水鱼 update_records matches songs by title+type, so a song missing from the prober catalog can still be
// uploaded with the game's own title instead of being dropped.
import { readFileSync } from "node:fs"
import path from "node:path"
import { ROOT } from "../store/paths.js"

export type LocalChart = { title: string; type: "DX" | "SD" }
let cache: Map<number, LocalChart> | null = null

/** musicId → title/type. Empty when the snapshot is absent (image without mounted assets). */
export function localCharts(): Map<number, LocalChart> {
  if (cache) return cache
  const charts = new Map<number, LocalChart>()
  try {
    const rows = JSON.parse(readFileSync(path.join(ROOT, "assets", "data", "sdgb-156-charts.json"), "utf8")) as unknown
    if (Array.isArray(rows)) {
      for (const row of rows as Array<Record<string, unknown>>) {
        const id = Number(row.musicId)
        const title = String(row.title ?? "").trim()
        if (!Number.isSafeInteger(id) || id <= 0 || !title) continue
        charts.set(id, { title, type: row.type === "DX" ? "DX" : "SD" })
      }
    }
  } catch { /* no snapshot: callers fall back to the prober catalog only */ }
  cache = charts
  return charts
}
