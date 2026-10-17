import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { createRequire } from "node:module"
import { t } from "../messages.js"
import { UserError } from "../multiserver/registry.js"

const ROOT = fileURLToPath(new URL("../../assets/", import.meta.url))
const assetCache = new Map<string, string>()
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!)
export function asset(file: string) {
  if (!assetCache.has(file)) assetCache.set(file, `data:image/png;base64,${readFileSync(`${ROOT}/maimaiDX/${file}`).toString("base64")}`)
  return assetCache.get(file)!
}
export function picture(src: string, x: number, y: number, w: number, h: number) {
  return `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="${src}"/>`
}
export function text(value: unknown, x: number, y: number, size = 16, color = "#ffffff", weight = 700, anchor = "start") {
  return `<text x="${x}" y="${y}" font-family="Noto Sans CJK SC" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escape(value)}</text>`
}
export const credit = () => text(t("image.credit"), 700, 1570, 21, "#7c81ff", 700, "middle")
// Rasterizing a B50 takes longer than Discord's 3-second ACK window. Keep it off
// the gateway thread; a bounded pool lets other users' interactions ACK promptly.
const rendererPath = createRequire(import.meta.url).resolve("@resvg/resvg-js")
type RenderJob = { svg: string; resolve: (png: Buffer) => void; reject: (error: Error) => void }
const jobs: RenderJob[] = []
const workers = new Set<Worker>()
const idle: Worker[] = []
const active = new Map<Worker, RenderJob>()
const WORKERS = 2
// The SVG is laid out at 1400×1600; rasterize at 2.5× (3500×4000) for sharpness, falling back to 2× when the PNG would exceed Discord's upload limit.
const RENDER_ZOOM = 2
// usvg 对每个 <text> 都会重新处理整张字体，16MB 的完整 CJK 字体会让解析耗时 10s+。
// 先放 ~1.5MB 的常用字子集（ASCII/假名/GB2312），完整字体只作缺字回退（解析 ~0.5s）。
const FONT_FILES = ["Sub-Regular", "Sub-Bold", "Regular", "Bold"].map(n => `${ROOT}/fonts/NotoSansCJKsc-${n}.otf`)
function dispatch() {
  while (jobs.length && (idle.length || workers.size < WORKERS)) {
    let worker = idle.pop()
    if (!worker) {
      worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { Resvg } = require(workerData.rendererPath);
        const draw = (svg, zoom) => new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: workerData.fontFiles }, fitTo: { mode: 'zoom', value: zoom } }).render().asPng();
        parentPort.on('message', svg => {
          try {
            let png = draw(svg, workerData.zoom);
            // Discord 默认上传上限 10MB：超限则降到 2×。
            if (png.length > workerData.maxBytes) png = draw(svg, 2);
            parentPort.postMessage({ png });
          } catch (error) { parentPort.postMessage({ error: error.message }); }
        });
      `, { eval: true, workerData: { rendererPath, zoom: RENDER_ZOOM, maxBytes: 9_000_000, fontFiles: FONT_FILES } })
      workers.add(worker)
      const current = worker
      current.on("message", (response: { png?: Uint8Array; error?: string }) => {
        const job = active.get(current)
        active.delete(current)
        if (response.png) job?.resolve(Buffer.from(response.png))
        else job?.reject(new Error(response.error || t("image.failed")))
        current.unref()
        idle.push(current)
        dispatch()
      })
      const failed = (error: Error) => {
        if (!workers.delete(current)) return
        const job = active.get(current)
        active.delete(current)
        const index = idle.indexOf(current)
        if (index >= 0) idle.splice(index, 1)
        job?.reject(error)
        dispatch()
      }
      current.on("error", failed)
      current.on("exit", code => failed(new Error(t("image.workerExited", { code }))))
    }
    const job = jobs.shift()!
    active.set(worker, job)
    worker.ref()
    worker.postMessage(job.svg)
  }
}
export function renderSvg(svg: string): Promise<Buffer> {
  if (jobs.length + active.size >= 12) return Promise.reject(new UserError(t("image.queueFull")))
  return new Promise((resolve, reject) => { jobs.push({ svg, resolve, reject }); dispatch() })
}
