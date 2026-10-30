// 官机式分片下载：Range=bytes=a-b、逐片校验 Content-Range、.part 续传、失败阶梯退避。
// 直连 CDN 失败时由调用方改走迁移服务的 /api/opt/range 代理（同一个 .part 继续）。
import { closeSync, createWriteStream, existsSync, ftruncateSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { OptPackage } from "./client.js"
import { safeFileName } from "./format.js"

export class DownloadCancelled extends Error {
  constructor() { super("download cancelled") }
}
export class DownloadError extends Error {}

const UA = "SDGB;Windows/Lite"
// EdgeOne 对 Accept/Connection 等额外头会返回 504；只保留 UA。
const DOWNLOAD_HEADERS = { "User-Agent": UA } as const
const FALLBACK_INTERVALS = [1000, 2000, 3000, 4000]
const FALLBACK_PART_SIZE = 8192
const CHUNK_TIMEOUT_MS = 30_000

export type DownloadProgress = {
  phase: "start" | "progress" | "retry" | "done" | "skipped"
  written: number
  total: number | null
  speed: number
  message?: string
}
export type ProgressHook = (progress: DownloadProgress) => void

export type Candidate = { kind: "direct" | "proxy"; url: string; headers: Record<string, string> }

export type PackageDownloadOptions = {
  dir: string
  hostAllowlist: readonly string[]
  /** 允许明文 http 的主机（迁移服务在 Tailscale/内网时） */
  allowHttpHosts?: readonly string[]
  transport: "auto" | "direct" | "proxy"
  proxy?: { build: (url: string) => string; apiKey: string }
  partSize?: number
  link: "isdn" | "dsl" | "bb"
  paceMs: number
  maxRetries: number
  signal: AbortSignal
  onProgress?: ProgressHook
}

export type PackageDownloadResult = { name: string; size: number | null; skipped: boolean; via: "direct" | "proxy"; requests: number }

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost")

export function assertFetchable(raw: string, allowHostlist: readonly string[], allowHttpHosts: readonly string[] = []): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new DownloadError(`无效 URL: ${raw}`) }
  const httpHostAllowed = isLoopback(url.hostname) || allowHttpHosts.some(item => item.toLowerCase() === url.hostname.toLowerCase())
  if (url.protocol === "http:" && !httpHostAllowed) throw new DownloadError(`拒绝明文 http（非回环）: ${raw}`)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DownloadError(`不支持的协议: ${url.protocol}`)
  if (url.username || url.password) throw new DownloadError("URL 不得包含用户信息")
  const host = url.hostname.toLowerCase()
  const allowed = allowHostlist.some(suffix => {
    const clean = String(suffix).toLowerCase().trim().replace(/^\./, "").replace(/\.$/, "")
    return clean.length > 0 && (host === clean || host.endsWith(`.${clean}`))
  })
  if (!isLoopback(host) && !allowed && !allowHttpHosts.some(item => item.toLowerCase() === host)) throw new DownloadError(`拒绝访问非允许主机: ${url.hostname}`)
  return url
}

function makeAgent(url: URL) {
  const mod = url.protocol === "https:" ? https : http
  return new mod.Agent({ keepAlive: true, maxSockets: 1 })
}

function requestOnce(target: URL, headers: Record<string, string>, opts: { timeoutMs: number; signal: AbortSignal; agent?: http.Agent }): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === "https:" ? https : http
    const req = mod.request(target, { method: "GET", headers, agent: opts.agent }, resolve)
    req.on("error", error => {
      if (opts.signal.aborted) reject(new DownloadCancelled())
      else reject(error)
    })
    req.setTimeout(opts.timeoutMs, () => req.destroy(new DownloadError(`请求超时（${opts.timeoutMs}ms）`)))
    if (opts.signal.aborted) { req.destroy(); reject(new DownloadCancelled()); return }
    const onAbort = () => req.destroy(new DownloadError("aborted"))
    opts.signal.addEventListener("abort", onAbort, { once: true })
    req.on("close", () => opts.signal.removeEventListener("abort", onAbort))
    req.end()
  })
}

async function openGet(raw: string, headers: Record<string, string>, opts: { timeoutMs: number; signal: AbortSignal; allowHostlist: readonly string[]; allowHttpHosts?: readonly string[]; agent?: http.Agent; maxRedirects?: number }): Promise<http.IncomingMessage> {
  let current = raw
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const target = assertFetchable(current, opts.allowHostlist, opts.allowHttpHosts)
    const res = await requestOnce(target, headers, { timeoutMs: opts.timeoutMs, signal: opts.signal, agent: opts.agent })
    const status = res.statusCode ?? 0
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      res.resume()
      const location = res.headers.location
      if (!location) throw new DownloadError("重定向缺少 Location")
      current = new URL(location, target).toString()
      continue
    }
    return res
  }
  throw new DownloadError("重定向次数过多")
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new DownloadCancelled()) }
    if (signal.aborted) { clearTimeout(timer); reject(new DownloadCancelled()); return }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DownloadCancelled()
}

export async function probeSize(url: string, opts: { allowHostlist: readonly string[]; signal: AbortSignal; timeoutMs?: number }): Promise<{ size: number | null; note: string }> {
  let last = { size: null as number | null, note: "探测失败" }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await openGet(url, { ...DOWNLOAD_HEADERS, Range: "bytes=0-0" }, { timeoutMs: opts.timeoutMs ?? CHUNK_TIMEOUT_MS, signal: opts.signal, allowHostlist: opts.allowHostlist })
      const range = String(res.headers["content-range"] ?? "")
      const length = String(res.headers["content-length"] ?? "")
      res.resume()
      if (res.statusCode === 206 && range.includes("/")) {
        const total = Number(range.slice(range.lastIndexOf("/") + 1))
        return { size: Number.isFinite(total) ? total : null, note: "" }
      }
      if (res.statusCode === 200 && /^\d+$/.test(length)) return { size: Number(length), note: "" }
      last = { size: null, note: res.statusCode === 504 ? "HTTP 504（源站超时，可稍后重试）" : `HTTP ${res.statusCode}` }
      if ((res.statusCode ?? 500) < 500) return last
    } catch (error) {
      if (error instanceof DownloadCancelled) throw error
      last = { size: null, note: `探测失败: ${(error as Error).message}` }
    }
    if (attempt < 2) await sleep(800, opts.signal)
  }
  return last
}

export type ResolvedPart = { partSize: number; intervals: number[] }

export function resolvePart(pkg: OptPackage, link: "isdn" | "dsl" | "bb", override?: number): ResolvedPart {
  const sizes = pkg.transfer?.partSizes ?? null
  const index = link === "isdn" ? 0 : link === "dsl" ? 1 : 2
  const fromInstruction = sizes && sizes.length ? sizes[Math.min(index, sizes.length - 1)] ?? 0 : 0
  const partSize = override !== undefined ? override : (fromInstruction > 0 ? fromInstruction : FALLBACK_PART_SIZE)
  const ladder = pkg.transfer?.intervals?.[link]
  return { partSize, intervals: ladder && ladder.length ? ladder : FALLBACK_INTERVALS }
}

async function downloadParts(url: string, dir: string, name: string, opts: {
  partSize: number
  intervals: number[]
  paceMs: number
  maxRetries: number
  signal: AbortSignal
  allowHostlist: readonly string[]
  allowHttpHosts: readonly string[]
  extraHeaders: Record<string, string>
  onProgress?: ProgressHook
}): Promise<{ size: number; requests: number }> {
  const dest = path.join(dir, name)
  const partFile = `${dest}.part`
  if (existsSync(dest)) return { size: statSync(dest).size, requests: 0 }
  mkdirSync(dir, { recursive: true })
  const partSize = Math.max(1, Math.floor(opts.partSize))
  let pos = existsSync(partFile) ? statSync(partFile).size : 0
  let total: number | null = null
  let requests = 0
  let failures = 0
  let lastEmit = 0
  let agent = makeAgent(assertFetchable(url, opts.allowHostlist, opts.allowHttpHosts))
  const fd = openSync(partFile, pos ? "r+" : "w")
  const started = Date.now()
  try {
    while (total == null || pos < total) {
      checkAbort(opts.signal)
      const t0 = Date.now()
      const end = pos + partSize - 1
      let body: Buffer | null = null
      let error: unknown = null
      try {
        requests++
        const res = await openGet(url, { ...DOWNLOAD_HEADERS, ...opts.extraHeaders, Range: `bytes=${pos}-${end}` }, { timeoutMs: CHUNK_TIMEOUT_MS, signal: opts.signal, allowHostlist: opts.allowHostlist, allowHttpHosts: opts.allowHttpHosts, agent })
        if (res.statusCode === 416) {
          const cr = res.headers["content-range"] ?? ""
          res.resume()
          const size = Number(String(cr).slice(String(cr).lastIndexOf("/") + 1))
          if (Number.isFinite(size) && pos === size) { total = size; break }
          ftruncateSync(fd, 0)
          pos = 0
          total = null
          throw new DownloadError("HTTP 416（.part 与服务器文件不符，已丢弃重下）")
        }
        if (res.statusCode === 200) {
          res.destroy()
          throw new DownloadError("服务器忽略了 Range（返回 200）")
        }
        if (res.statusCode !== 206) {
          res.resume()
          throw new DownloadError(`HTTP ${res.statusCode}`)
        }
        const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers["content-range"] ?? ""))
        if (!cr) {
          res.resume()
          throw new DownloadError("206 缺少有效的 Content-Range")
        }
        const [from, to, size] = [Number(cr[1]), Number(cr[2]), Number(cr[3])]
        const chunks: Buffer[] = []
        for await (const chunk of res) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        body = Buffer.concat(chunks)
        if (from !== pos || to - from + 1 !== body.length || to > end || (total != null && size !== total) || to >= size) {
          throw new DownloadError(`分片不符: 请求 ${pos}-${end}，收到 ${cr[1]}-${cr[2]}/${cr[3]}（${body.length} B）`)
        }
        if (to !== Math.min(end, size - 1)) throw new DownloadError(`分片被截短: ${cr[1]}-${cr[2]}/${cr[3]}`)
        total = size
      } catch (caught) {
        if (caught instanceof DownloadCancelled || opts.signal.aborted) throw new DownloadCancelled()
        error = caught
      }
      if (error) {
        failures++
        agent.destroy()
        agent = makeAgent(assertFetchable(url, opts.allowHostlist, opts.allowHttpHosts))
        if (failures > opts.maxRetries) {
          throw new DownloadError(`第 ${pos} 字节处连续失败 ${failures} 次（${(error as Error).message}）；.part 已保留，可续传`)
        }
        const wait = opts.intervals[Math.min(failures - 1, opts.intervals.length - 1)] ?? 1000
        opts.onProgress?.({ phase: "retry", written: pos, total, speed: 0, message: `@${pos}: ${(error as Error).message}（第 ${failures} 次，${wait}ms 后重试）` })
        await sleep(wait, opts.signal)
        continue
      }
      failures = 0
      writeSync(fd, body!, 0, body!.length, pos)
      pos += body!.length
      const now = Date.now()
      if (now - lastEmit >= 500) {
        lastEmit = now
        opts.onProgress?.({ phase: "progress", written: pos, total, speed: pos / Math.max((now - started) / 1000, 0.001) })
      }
      const spent = Date.now() - t0
      if (pos < (total ?? pos + 1) && spent < opts.paceMs) await sleep(opts.paceMs - spent, opts.signal)
    }
  } finally {
    agent.destroy()
    closeSync(fd)
  }
  if (pos !== total) throw new DownloadError(`长度不符: 期望 ${total}，实际 ${pos}（.part 已保留，可重试续传）`)
  renameSync(partFile, dest)
  return { size: pos, requests }
}

type WholeOptions = {
  size: number | null
  signal: AbortSignal
  allowHostlist: readonly string[]
  allowHttpHosts: readonly string[]
  extraHeaders: Record<string, string>
  onProgress?: ProgressHook
  maxRetries?: number
  intervals?: number[]
  retried?: boolean
}

async function downloadWhole(url: string, dir: string, name: string, opts: WholeOptions): Promise<{ size: number; requests: number }> {
  const attempts = Math.max(1, Math.min(opts.maxRetries ?? 3, 6))
  // 整文件模式遇到 504/超时时用更长的退避，避免触发 CDN 风控。
  const intervals = [5000, 15000, 30000, 60000]
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await downloadWholeOnce(url, dir, name, opts)
    } catch (error) {
      if (error instanceof DownloadCancelled) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/HTTP 4\d\d/.test(message)) throw error
      lastError = error
      if (attempt < attempts) {
        opts.onProgress?.({ phase: "retry", written: 0, total: opts.size, speed: 0, message })
        await sleep(intervals[Math.min(attempt - 1, intervals.length - 1)] ?? 1000, opts.signal)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new DownloadError("下载失败")
}

async function downloadWholeOnce(url: string, dir: string, name: string, opts: WholeOptions): Promise<{ size: number; requests: number }> {
  const dest = path.join(dir, name)
  const part = `${dest}.part`
  if (existsSync(dest)) return { size: statSync(dest).size, requests: 0 }
  mkdirSync(dir, { recursive: true })
  let done = existsSync(part) ? statSync(part).size : 0
  const end = opts.size && opts.size > done ? opts.size - 1 : ""
  const res = await openGet(url, { ...DOWNLOAD_HEADERS, ...opts.extraHeaders, Range: `bytes=${done}-${end}` }, { timeoutMs: 120_000, signal: opts.signal, allowHostlist: opts.allowHostlist, allowHttpHosts: opts.allowHttpHosts })
  if (res.statusCode === 416) {
    const cr = String(res.headers["content-range"] ?? "")
    res.resume()
    const total = Number(cr.slice(cr.lastIndexOf("/") + 1))
    if (Number.isFinite(total) && done === total) {
      renameSync(part, dest)
      return { size: total, requests: 1 }
    }
    rmSync(part, { force: true })
    if (!opts.retried) return downloadWholeOnce(url, dir, name, { ...opts, retried: true, size: null })
    throw new DownloadError("HTTP 416（Range 不被接受）")
  }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume()
    throw new DownloadError(`HTTP ${res.statusCode}`)
  }
  if (done && res.statusCode === 200) done = 0
  let total: number | null = null
  const cr = String(res.headers["content-range"] ?? "")
  const cl = String(res.headers["content-length"] ?? "")
  if (cr.includes("/")) total = Number(cr.slice(cr.lastIndexOf("/") + 1))
  else if (/^\d+$/.test(cl)) total = done + Number(cl)
  if (opts.size && total != null && total !== opts.size) {
    res.resume()
    rmSync(part, { force: true })
    if (!opts.retried) return downloadWholeOnce(url, dir, name, { ...opts, retried: true, size: null })
    throw new DownloadError(`包大小与探测值不一致: 探测 ${opts.size}，实际 ${total}`)
  }
  let written = done
  const started = Date.now()
  let lastEmit = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      written += chunk.length
      const now = Date.now()
      if (now - lastEmit >= 500) {
        lastEmit = now
        opts.onProgress?.({ phase: "progress", written, total, speed: written / Math.max((now - started) / 1000, 0.001) })
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(res, meter, createWriteStream(part, { flags: done ? "a" : "w" }))
  } catch (caught) {
    if (opts.signal.aborted) throw new DownloadCancelled()
    throw caught
  }
  if (total != null && written !== total) throw new DownloadError(`长度不符: 期望 ${total}，实际 ${written}（.part 已保留，可重试续传）`)
  renameSync(part, dest)
  return { size: written, requests: 1 }
}

function candidatesFor(pkg: OptPackage, options: PackageDownloadOptions): Candidate[] {
  const direct: Candidate = { kind: "direct", url: pkg.url, headers: {} }
  const proxy: Candidate | null = options.proxy
    ? { kind: "proxy", url: options.proxy.build(pkg.url), headers: options.proxy.apiKey ? { "x-api-key": options.proxy.apiKey } : {} }
    : null
  if (options.transport === "proxy") return proxy ? [proxy] : [direct]
  if (options.transport === "direct") return [direct]
  return proxy ? [direct, proxy] : [direct]
}

/** 下载一个包；auto 模式下直连失败会带着同一个 .part 改走代理。 */
export async function downloadPackage(pkg: OptPackage, options: PackageDownloadOptions): Promise<PackageDownloadResult> {
  const name = safeFileName(pkg.name)
  const dest = path.join(options.dir, name)
  if (existsSync(dest)) {
    options.onProgress?.({ phase: "skipped", written: statSync(dest).size, total: statSync(dest).size, speed: 0 })
    return { name, size: statSync(dest).size, skipped: true, via: "direct", requests: 0 }
  }
  const part = resolvePart(pkg, options.link, options.partSize)
  const candidates = candidatesFor(pkg, options)
  let lastError: unknown = null
  let requests = 0
  for (const candidate of candidates) {
    checkAbort(options.signal)
    try {
      const started = Date.now()
      options.onProgress?.({ phase: "start", written: 0, total: pkg.size, speed: 0 })
      const result = part.partSize > 0
        ? await downloadParts(candidate.url, options.dir, name, {
            partSize: part.partSize, intervals: part.intervals, paceMs: options.paceMs,
            maxRetries: options.maxRetries, signal: options.signal, allowHostlist: options.hostAllowlist, allowHttpHosts: options.allowHttpHosts ?? [],
            extraHeaders: candidate.headers, onProgress: options.onProgress,
          })
        : await downloadWhole(candidate.url, options.dir, name, {
            size: pkg.size, signal: options.signal, allowHostlist: options.hostAllowlist, allowHttpHosts: options.allowHttpHosts ?? [],
            extraHeaders: candidate.headers, onProgress: options.onProgress,
            maxRetries: candidate.kind === "direct" ? Math.min(options.maxRetries, 2) : Math.min(options.maxRetries, 4),
            intervals: part.intervals,
          })
      requests += result.requests
      const size = existsSync(dest) ? statSync(dest).size : result.size
      options.onProgress?.({ phase: "done", written: size, total: size, speed: size / Math.max((Date.now() - started) / 1000, 0.001) })
      return { name, size, skipped: false, via: candidate.kind, requests }
    } catch (error) {
      if (error instanceof DownloadCancelled) throw error
      lastError = error
      requests++
    }
  }
  throw lastError instanceof Error ? lastError : new DownloadError("下载失败")
}
