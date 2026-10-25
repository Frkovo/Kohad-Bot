import { createHash } from "node:crypto"
import { existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { createRequire } from "node:module"
import { inflateRawSync } from "node:zlib"
import sharp from "sharp"
import { t } from "../messages.js"
import { UserError } from "../multiserver/registry.js"
import { dataDir } from "../store/paths.js"

const ROOT = fileURLToPath(new URL("../../assets/", import.meta.url))
const IMAGE_CACHE = path.join(dataDir(), "img-cache")
// The SVG is laid out at 1400×1600 and rasterized at RENDER_ZOOM (2800×3200, ~1.6MB WebP), or HD_ZOOM when the
// player asks for it (5600×6400, ~4.6MB, about 4× the CPU time and ~1GB peak memory, so HD renders run one at a time).
export const RENDER_ZOOM = Number(process.env.B50_RENDER_ZOOM) || 2
export const HD_ZOOM = Number(process.env.B50_HD_ZOOM) || 4
const WEBP_QUALITY = 90

const assetCache = new Map<string, string>()
export function asset(file: string) {
  if (!assetCache.has(file)) assetCache.set(file, `data:image/png;base64,${readFileSync(`${ROOT}/maimaiDX/${file}`).toString("base64")}`)
  return assetCache.get(file)!
}

// Images: picture() emits a short "img:N" placeholder; renderSvg swaps in a copy pre-scaled to the exact output
// pixel size. resvg decodes and resamples every <image> on every render, so this halves rasterization time.
// Sources are the same string instances each time (asset/jacket caches), so the Map lookup hashes them once.
const imageIds = new Map<string, number>()
const imageSources: string[] = []
const imageHashes: string[] = []
const scaledImages = new Map<string, string>() // `${id}:${w}x${h}` -> data URI, insertion-ordered for LRU
const SCALED_LIMIT = 1500
export function picture(src: string, x: number, y: number, w: number, h: number) {
  let id = imageIds.get(src)
  if (id === undefined) { id = imageSources.push(src) - 1; imageIds.set(src, id) }
  return `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="img:${id}"/>`
}

// Text: usvg re-shapes and re-outlines every <text> on every render (~0.8s for a B50 with these fonts).
// Lay text out here instead, with each glyph outline read once and reused via <use>. The outlines come from
// glyph stores baked by scripts/build-glyphs.py (M+ Rounded subset, falling back to full Noto Sans CJK SC):
// only the ~650KB index is read up front, so memory holds just the glyphs that were actually drawn.
class GlyphStore {
  private readonly fd: number
  private readonly codepoints: Uint32Array
  private readonly advances: Uint16Array
  private readonly offsets: Uint32Array
  private readonly blobStart: number
  readonly upm: number
  constructor(file: string) {
    this.fd = openSync(file, "r")
    const head = Buffer.alloc(12)
    readSync(this.fd, head, 0, 12, 0)
    if (head.toString("latin1", 0, 4) !== "GLY1") throw new Error(`bad glyph store: ${file}`)
    const count = head.readUInt32LE(4)
    this.upm = head.readUInt32LE(8)
    const index = Buffer.alloc(count * 4 + count * 2 + (count + 1) * 4)
    readSync(this.fd, index, 0, index.length, 12)
    const copy = (start: number, bytes: number) => index.buffer.slice(index.byteOffset + start, index.byteOffset + start + bytes)
    this.codepoints = new Uint32Array(copy(0, count * 4))
    this.advances = new Uint16Array(copy(count * 4, count * 2))
    this.offsets = new Uint32Array(copy(count * 6, (count + 1) * 4))
    this.blobStart = 12 + index.length
  }
  /** Advance (font units) and y-down path data; null when no font has the character. */
  get(cp: number): { advance: number; d: string } | null {
    let lo = 0, hi = this.codepoints.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, value = this.codepoints[mid]
      if (value === cp) {
        const start = this.offsets[mid], length = this.offsets[mid + 1] - start
        const raw = Buffer.alloc(length)
        readSync(this.fd, raw, 0, length, this.blobStart + start)
        return { advance: this.advances[mid], d: inflateRawSync(raw).toString() }
      }
      if (value < cp) lo = mid + 1; else hi = mid - 1
    }
    return null
  }
}
const stores: Partial<Record<"regular" | "bold", GlyphStore>> = {}
const store = (bold: boolean) => stores[bold ? "bold" : "regular"] ??= new GlyphStore(`${ROOT}/fonts/glyphs-${bold ? "bold" : "regular"}.bin`)
type Glyph = { id: string | null; advance: number; upm: number } // advance in font units
const glyphs = new Map<string, Glyph>()
const glyphPaths = new Map<string, string>() // id -> path data in font units, y down
function glyph(char: string, bold: boolean): Glyph {
  const key = (bold ? "b" : "r") + char
  const known = glyphs.get(key)
  if (known) return known
  const source = store(bold), found = source.get(char.codePointAt(0)!)
  // A character no font has keeps a half-em gap and draws nothing.
  const id = found?.d ? `g${glyphPaths.size}` : null
  if (id) glyphPaths.set(id, found!.d)
  const result = { id, advance: found ? found.advance : source.upm / 2, upm: source.upm }
  glyphs.set(key, result)
  return result
}
const num = (n: number) => String(Math.round(n * 1000) / 1000)
export function text(value: unknown, x: number, y: number, size = 16, color = "#ffffff", weight = 700, anchor = "start") {
  // SVG collapses runs of whitespace and trims the ends by default. NFC folds titles like "Åntinomiε" into
  // precomposed letters; any combining mark left over is drawn without advancing, as the shaper would.
  const run = [...String(value).normalize("NFC").replace(/\s+/g, " ").trim()]
    .map(c => /\p{M}/u.test(c) ? { ...glyph(c, weight >= 600), advance: 0 } : glyph(c, weight >= 600))
  const width = run.reduce((n, g) => n + g.advance * size / g.upm, 0)
  let cx = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x
  let out = `<g fill="${color}">`
  for (const g of run) {
    if (g.id) out += `<use href="#${g.id}" transform="translate(${num(cx)} ${y}) scale(${num(size / g.upm)})"/>`
    cx += g.advance * size / g.upm
  }
  return out + "</g>"
}
export const credit = () => text(t("image.credit"), 700, 1570, 21, "#7c81ff", 700, "middle")

// Rasterizing a B50 takes longer than Discord's 3-second ACK window. Keep it off
// the gateway thread; a bounded pool lets other users' interactions ACK promptly.
const rendererPath = createRequire(import.meta.url).resolve("@resvg/resvg-js")
type ScaleItem = { src: string; w: number; h: number }
type Task = { kind: "render"; svg: string; zoom: number } | { kind: "scale"; items: ScaleItem[] }
type WorkerResult = { pngs?: Uint8Array[]; raw?: Uint8Array; width?: number; height?: number }
type Job = { task: Task; resolve: (result: WorkerResult) => void; reject: (error: Error) => void }
const jobs: Job[] = []
const workers = new Set<Worker>()
const idle: Worker[] = []
const active = new Map<Worker, Job>()
const WORKERS = 2
function dispatch() {
  while (jobs.length && (idle.length || workers.size < WORKERS)) {
    let worker = idle.pop()
    if (!worker) {
      // Renders return raw RGBA (transferred, not copied) so the main thread can encode WebP without a PNG round trip.
      worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { Resvg } = require(workerData.rendererPath);
        const options = zoom => ({ font: { loadSystemFonts: false }, fitTo: { mode: 'zoom', value: zoom } });
        parentPort.on('message', task => {
          try {
            if (task.kind === 'render') {
              const image = new Resvg(task.svg, options(task.zoom)).render();
              const result = { raw: image.pixels, width: image.width, height: image.height };
              try { parentPort.postMessage(result, [result.raw.buffer]); } catch { parentPort.postMessage(result); }
            } else {
              parentPort.postMessage({ pngs: task.items.map(({ src, w, h }) => new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><image width="' + w + '" height="' + h + '" preserveAspectRatio="none" href="' + src + '"/></svg>', options(1)).render().asPng()) });
            }
          } catch (error) { parentPort.postMessage({ error: error.message }); }
        });
      `, { eval: true, workerData: { rendererPath } })
      workers.add(worker)
      const current = worker
      current.on("message", (response: WorkerResult & { error?: string }) => {
        const job = active.get(current)
        active.delete(current)
        if (response.error === undefined) job?.resolve(response)
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
    worker.postMessage(job.task)
  }
}
function run(task: Task) {
  return new Promise<WorkerResult>((resolve, reject) => { jobs.push({ task, resolve, reject }); dispatch() })
}

function rememberScaled(key: string, uri: string) {
  scaledImages.set(key, uri)
  if (scaledImages.size > SCALED_LIMIT) scaledImages.delete(scaledImages.keys().next().value!)
  return uri
}
const IMAGE_TAG = /<image x="([^"]*)" y="([^"]*)" width="([^"]*)" height="([^"]*)" preserveAspectRatio="none" href="img:(\d+)"\/>/g
const pixels = (size: string, zoom: number) => Math.max(1, Math.round(Number(size) * zoom))
const MAX_PRESCALE_PIXELS = 12_000_000
export async function resolveImages(svg: string, zoom = RENDER_ZOOM) {
  const wanted = new Map<string, { id: number; w: number; h: number; file: string }>()
  for (const m of svg.matchAll(IMAGE_TAG)) {
    const id = Number(m[5]), w = pixels(m[3], zoom), h = pixels(m[4], zoom)
    const key = `${id}:${w}x${h}`
    // A prescaled HD background (5600×6400) would cost far more memory than resvg's own upscale saves in time.
    if (w * h > MAX_PRESCALE_PIXELS || scaledImages.has(key) || wanted.has(key)) continue
    imageHashes[id] ??= createHash("sha1").update(imageSources[id]).digest("hex")
    const file = `${IMAGE_CACHE}${imageHashes[id]}-${w}x${h}.png`
    try {
      if (existsSync(file)) { rememberScaled(key, `data:image/png;base64,${readFileSync(file).toString("base64")}`); continue }
    } catch { /* rebuild below */ }
    wanted.set(key, { id, w, h, file })
  }
  if (wanted.size) {
    const missing = [...wanted]
    const { pngs = [] } = await run({ kind: "scale", items: missing.map(([, v]) => ({ src: imageSources[v.id], w: v.w, h: v.h })) })
    try { mkdirSync(IMAGE_CACHE, { recursive: true }) } catch { /* memory cache still works */ }
    missing.forEach(([key, v], i) => {
      const png = Buffer.from(pngs[i])
      rememberScaled(key, `data:image/png;base64,${png.toString("base64")}`)
      try { writeFileSync(v.file, png) } catch { /* optional disk cache */ }
    })
  }
  return svg.replace(IMAGE_TAG, (_m, x, y, w, h, id) => {
    const uri = scaledImages.get(`${id}:${pixels(w, zoom)}x${pixels(h, zoom)}`) ?? imageSources[Number(id)]
    return `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="${uri}"/>`
  })
}
export function withGlyphs(svg: string) {
  const ids = new Set<string>()
  for (const m of svg.matchAll(/<use href="#(g\d+)"/g)) ids.add(m[1])
  const defs = [...ids].map(id => `<path id="${id}" d="${glyphPaths.get(id)}"/>`).join("")
  return svg.replace(/<svg[^>]*>/, open => `${open}<defs>${defs}</defs>`)
}

async function rasterize(svg: string, zoom: number) {
  const { raw, width, height } = await run({ kind: "render", svg: await resolveImages(withGlyphs(svg), zoom), zoom })
  // The canvas is fully covered by the opaque background, so premultiplied RGBA equals straight RGBA here.
  return sharp(Buffer.from(raw!.buffer, raw!.byteOffset, raw!.byteLength), { raw: { width: width!, height: height!, channels: 4 } })
    .removeAlpha().webp({ quality: WEBP_QUALITY, effort: 2 }).toBuffer()
}

// Identical requests (same scores, same profile, same resolution) reuse the finished image instead of rendering again.
const results = new Map<string, Promise<Buffer>>()
const RESULT_LIMIT = 6
let inFlight = 0
let hdTurn: Promise<unknown> = Promise.resolve()
/** Renders to WebP. `hd` uses HD_ZOOM; those renders are serialized to bound peak memory. */
export function renderSvg(svg: string, options: { hd?: boolean } = {}): Promise<Buffer> {
  const zoom = options.hd ? HD_ZOOM : RENDER_ZOOM
  const key = createHash("sha1").update(`${zoom}\n${svg}`).digest("hex")
  const hit = results.get(key)
  if (hit) { results.delete(key); results.set(key, hit); return hit }
  if (inFlight >= 12) return Promise.reject(new UserError(t("image.queueFull")))
  inFlight++
  let promise: Promise<Buffer>
  if (zoom > RENDER_ZOOM) {
    promise = hdTurn.then(() => rasterize(svg, zoom))
    hdTurn = promise.catch(() => undefined)
  } else promise = rasterize(svg, zoom)
  promise = promise.finally(() => { inFlight-- })
  results.set(key, promise)
  if (results.size > RESULT_LIMIT) results.delete(results.keys().next().value!)
  promise.catch(() => { if (results.get(key) === promise) results.delete(key) })
  return promise
}
