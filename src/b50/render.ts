// Original artwork and layout: Yuri-YuzuChaN/maimaiDX, MIT. Keep the designers' credit.
import { getJackets, getNetJackets, getCollectionArt } from "./assets.js"
import type { B50Entry, B50Result } from "./compute.js"
import type { PlayerProfile } from "../local/profile.js"
import { asset, picture, text, credit, renderSvg } from "./theme.js"
import { t } from "../messages.js"

export type B50RenderInput = { title: string; subtitle?: string; accountRating?: number | null; result: B50Result; footerNote?: string; profile?: PlayerProfile; serverLabel?: string; useCnArtwork?: boolean }
function shorten(value: string, max: number) {
  let n = 0, out = ""
  for (const c of value) { n += c.codePointAt(0)! > 255 ? 2 : 1; if (n > max) return out + t("value.ellipsis"); out += c }
  return out
}
const DIFF = ["basic", "advanced", "expert", "master", "remaster"]
// FC/FS values are icon asset identifiers (UI_MSS_MBase_Icon_*.png), not displayed text, so they stay as code constants.
const FC: Record<string, string> = { fc: "FC", fcp: "FCp", ap: "AP", app: "APp" }
const FS: Record<string, string> = { fs: "FS", fsp: "FSp", fsd: "FSD", fsdp: "FSDp", sync: "Sync" }
// Rank values name the UI_TTR_Rank_* icon assets (not displayed text), so they stay as code constants.
function rate(ach: number) {
  const points: [number, string][] = [[1005000,"SSSp"],[1000000,"SSS"],[995000,"SSp"],[990000,"SS"],[980000,"Sp"],[970000,"S"],[940000,"AAA"],[900000,"AA"],[800000,"A"],[750000,"BBB"],[700000,"BB"],[600000,"B"],[500000,"C"],[0,"D"]]
  return points.find(([v]) => ach >= v)![1]
}
function card(entry: B50Entry, i: number, top: number, jacket: string | null, pc: boolean, remote: boolean) {
  const x = 16 + (i % 5) * 276, y = top + Math.floor(i / 5) * 114
  const color = entry.level === 4 ? "#8a00e2" : "#ffffff"
  const utage = !remote && entry.musicId >= 100000
  const id = remote ? entry.displayId : !utage && entry.type === "DX" ? entry.musicId + 10000 : entry.musicId
  const clip = `card-${top}-${i}`
  let out = `<defs><clipPath id="${clip}"><rect x="${x}" y="${y}" width="264" height="109"/></clipPath></defs><g clip-path="url(#${clip})">`
  out += picture(asset(`pic/b50_score_${DIFF[entry.level]}.png`), x, y, 264, 109)
  out += picture(jacket ?? asset("pic/UI_Icon_509506.png"), x + 12, y + 12, 75, 75)
  out += utage ? text(t("chart.utage"), x + 51, y + 103, 10, "#8a00e2") : picture(asset(`pic/${entry.type}.png`), x + 51, y + 91, 37, 14)
  out += text(shorten(entry.title, 19), x + 93, y + 19, 14, color)
  out += text(`${(entry.achievement / 10000).toFixed(4)}%`, x + 92, y + 53, 25, color)
  out += text(pc ? t("b50.render.pcCount", { count: entry.playCount ?? 0 }) : entry.unknown ? t("b50.render.unknownChart") : t("b50.render.dsRa", { ds: entry.officialDs !== undefined && entry.officialDs !== entry.ds ? entry.ds.toFixed(2) : entry.ds.toFixed(1), ra: entry.ra }), x + 93, y + 72, 14, color)
  out += text(entry.maxDxScore ? `${entry.dxScore}/${entry.maxDxScore}` : t("b50.render.dxScore", { score: entry.dxScore }), x + 255, y + 72, 12, color, 400, "end")
  out += picture(asset(`pic/prism_plus/UI_TTR_Rank_${rate(entry.achievement)}.png`), x + 92, y + 78, 63, 28)
  if (FC[entry.fc]) out += picture(asset(`pic/UI_MSS_MBase_Icon_${FC[entry.fc]}.png`), x + 154, y + 77, 34, 34)
  if (FS[entry.fs]) out += picture(asset(`pic/UI_MSS_MBase_Icon_${FS[entry.fs]}.png`), x + 185, y + 77, 34, 34)
  if (entry.maxDxScore) {
    const percent = entry.dxScore / entry.maxDxScore * 100
    const stars = percent < 85 ? 0 : percent < 90 ? 1 : percent < 93 ? 2 : percent < 95 ? 3 : percent < 97 ? 4 : 5
    if (stars) out += picture(asset(`pic/UI_GAM_Gauge_DXScoreIcon_0${stars}.png`), x + 217, y + 80, 47, 26)
  }
  if (id !== undefined) out += text(shorten(String(id),16), x + 28, y + 101, 10, "#2b245e", 700, "middle")
  return out + "</g>"
}

export async function renderB50(input: B50RenderInput): Promise<Buffer> {
  return renderSvg(await buildB50Svg(input))
}

export async function buildB50Svg(input: B50RenderInput): Promise<string> {
  const { result } = input
  const entries = [...result.b35, ...result.b15]
  const [jackets, icon, plate, netJackets] = await Promise.all([
    getJackets(input.useCnArtwork === false ? [] : entries.map(e => e.musicId)), getCollectionArt("icon", input.useCnArtwork === false ? undefined : input.profile?.iconId), getCollectionArt("plate", input.useCnArtwork === false ? undefined : input.profile?.nameplateId),
    getNetJackets(entries.flatMap(e => e.jacketHash ? [e.jacketHash] : [])),
  ])
  const pc = result.mode === "pc50", fit = result.mode === "fitb50"
  const totalPC = entries.reduce((n, e) => n + (e.playCount ?? 0), 0)
  const display = pc ? totalPC : result.total
  const sum = (rows: B50Entry[]) => rows.reduce((n,e) => n + (pc ? e.playCount ?? 0 : e.ra), 0)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1600" viewBox="0 0 1400 1600">`
  svg += picture(asset("pic/prism_plus/b50.png"), 0, 0, 1400, 1600)
  svg += input.useCnArtwork === false ? text(input.serverLabel ?? t("label.netDefault"), 25, 130, 34, "#7c81ff") : picture(asset("pic/prism_plus/logo.png"), 14, 60, 249, 120)
  svg += picture(plate ?? asset("pic/UI_Plate_550101.png"), 300, 60, 800, 130)
  svg += picture(icon ?? asset("pic/UI_Icon_509506.png"), 305, 65, 120, 120)
  if (!pc) {
    const thresholds = [1000,2000,4000,7000,10000,12000,13000,14000,14500,15000]
    const num = thresholds.findIndex(v => display < v)
    svg += picture(asset(`pic/prism_plus/UI_CMN_DXRating_${String(num < 0 ? 11 : num + 1).padStart(2,"0")}.png`), 435, 72, 186, 35)
    for (const [i, n] of String(display).padStart(5,"0").split("").entries()) svg += picture(asset(`pic/UI_NUM_Drating_${n}.png`), 520 + i * 15, 80, 17, 20)
  } else {
    svg += `<rect x="435" y="72" width="265" height="35" rx="8" fill="#ffffff" fill-opacity="0.95"/>`
    svg += text(t("b50.render.pcPlays", { display }), 445, 98, 23, "#8a00e2")
  }
  svg += picture(asset("pic/Name.png"), 435, 112, 272, 42)
  svg += text(shorten(input.profile?.name ?? input.title, 18), 445, 140, 20, "#242036")
  // The original banner is 276×36: match the name field without stretching it.
  svg += picture(asset("shougou/UI_CMN_Shougou_Rainbow.png"), 435, 154, 272, 272 * 36 / 276)
  svg += text(pc ? t("b50.render.pcHeader") : t("b50.render.sumLine", { b35: result.b35.reduce((n,e)=>n+e.ra,0), b15: result.b15.reduce((n,e)=>n+e.ra,0), display }), 571, 177, 12, "#242036", 700, "middle")
  svg += text(pc ? t("b50.render.pcTitle") : fit ? t("b50.render.fitTitle") : t("b50.render.best"), 1350, 92, 26, "#7c81ff", 700, "end")
  svg += text(input.serverLabel ?? t("label.cnDefault"), 1350, 125, 18, "#524b7d", 700, "end")
  if (input.serverLabel) svg += text(shorten(input.footerNote ?? input.subtitle ?? "", 130), 700, 1515, 14, "#524b7d", 400, "middle")
  svg += text(pc ? t("b50.render.pcSum1", { sum: sum(result.b35) }) : t("b50.render.b35Sum", { sum: sum(result.b35) }), 25, 222, 23, "#655da8")
  svg += text(pc ? t("b50.render.pcSum2", { sum: sum(result.b15) }) : t("b50.render.b15Sum", { sum: sum(result.b15) }), 25, 1072, 23, "#655da8")
  const jacket = (e: B50Entry) => (e.jacketHash ? netJackets.get(e.jacketHash) : jackets.get(e.musicId)) ?? null
  result.b35.forEach((e, i) => { svg += card(e, i, 235, jacket(e), pc, input.useCnArtwork === false) })
  result.b15.forEach((e, i) => { svg += card(e, i, 1085, jacket(e), pc, input.useCnArtwork === false) })
  svg += credit()
  return svg + "</svg>"
}
