import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildChartIndex, type ChartInfo } from "./compute.js"
import { fetchLxnsSongs } from "./songs.js"
import { fetchMusicCatalog } from "../df/client.js"

const DATA = fileURLToPath(new URL("../../assets/data/", import.meta.url))
let statistics: { at: number; charts: Record<string, { fit_diff?: number }[]> } | null = null

export async function fetchFitStatistics(): Promise<Record<string, { fit_diff?: number }[]>> {
  if (statistics && Date.now() - statistics.at < 3600000) return statistics.charts
  try {
    const res = await fetch("https://www.diving-fish.com/api/maimaidxprober/chart_stats", { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`水鱼拟合数据 HTTP ${res.status}`)
    const raw = await res.json() as { charts?: Record<string, { fit_diff?: number }[]> }
    if (!raw.charts || typeof raw.charts !== "object") throw new Error("水鱼拟合数据缺少 charts")
    mkdirSync(DATA, { recursive: true })
    writeFileSync(`${DATA}/fit-stats.json.tmp`, JSON.stringify(raw)); renameSync(`${DATA}/fit-stats.json.tmp`, `${DATA}/fit-stats.json`)
    statistics = { at: Date.now(), charts: raw.charts }
    return raw.charts
  } catch (e) {
    if (statistics) return statistics.charts
    try {
      const raw = JSON.parse(readFileSync(`${DATA}/fit-stats.json`, "utf8"))
      if (raw.charts) { statistics = { at: Date.now(), charts: raw.charts }; return raw.charts }
    } catch { /* absent */ }
    throw e
  }
}

/** 国服 1.56.00 uses the 25500 (舞萌DX2026) content series, not API version 25600. */
export async function loadChartCatalog(version = 25500, apiBase = "https://maimai.lxns.net", withFit = false): Promise<Map<string, ChartInfo>> {
  const [lx, df] = await Promise.allSettled([fetchLxnsSongs(version, apiBase), fetchMusicCatalog()])
  const index = buildChartIndex(lx.status === "fulfilled" ? lx.value : [])
  let local: ChartInfo[] = []
  try { local = JSON.parse(readFileSync(`${DATA}/sdgb-156-charts.json`, "utf8")) } catch { /* optional local fallback */ }
  for (const chart of local) {
    const key = `${chart.musicId}:${chart.level}:${chart.type}`
    if (!index.has(key)) index.set(key, chart)
  }
  if (df.status === "fulfilled") {
    for (const song of df.value.values()) {
      if (song.id >= 100000) continue
      const type = song.type === "DX" ? "DX" : "SD"
      const id = song.id >= 10000 ? song.id - 10000 : song.id
      for (let level = 0; level < (song.ds?.length ?? 0); level++) {
        const key = `${id}:${level}:${type}`
        const prev = index.get(key)
        const ds = Number(song.ds?.[level])
        if (!(ds > 0)) continue
        index.set(key, {
          ...prev, musicId: id, level, type, title: song.title, ds,
          levelLabel: song.level?.[level] ?? prev?.levelLabel ?? "",
          version: prev?.version ?? (song.isNew ? version : version - 1),
          maxDxScore: prev?.maxDxScore ?? song.notes?.[level],
        })
      }
    }
  }
  if (!index.size) throw new Error("曲库不可用，请检查公共曲库网络或 assets/data 快照")
  if (withFit) {
    const fits = await fetchFitStatistics()
    for (const chart of index.values()) {
      if (chart.musicId >= 100000) continue
      const gameId = chart.type === "DX" ? chart.musicId + 10000 : chart.musicId
      const fit = Number(fits[String(gameId)]?.[chart.level]?.fit_diff)
      if (Number.isFinite(fit) && fit > 0) chart.fitDs = fit
    }
  }
  return index
}
