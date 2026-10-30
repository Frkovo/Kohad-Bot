// 受签名保护的更新包下载：/opt-files/<name>?exp=&sig=
// 只读、单段 Range、防目录穿越；链接由 links.ts 生成。
import { createReadStream } from "node:fs"
import { statSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import type { BotConfig } from "../config.js"
import { safeFileName } from "./format.js"
import { linkSecret, verifyLink } from "./links.js"

export const OPT_FILES_PREFIX = "/opt-files/"

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) })
  res.end(text)
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return "invalid"
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid"
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return "invalid"
  return { start, end: Math.min(end, size - 1) }
}

/** 返回 true 表示该请求由本模块处理（无论成功或失败）。 */
export async function serveOptFile(req: IncomingMessage, res: ServerResponse, url: URL, cfg: BotConfig): Promise<boolean> {
  if (!url.pathname.startsWith(OPT_FILES_PREFIX)) return false
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end()
    return true
  }

  let name: string
  try {
    name = decodeURIComponent(url.pathname.slice(OPT_FILES_PREFIX.length))
  } catch {
    sendJson(res, 400, { ok: false, error: "bad name" })
    return true
  }
  if (!name || name.includes("/") || name.includes("\\") || name.endsWith(".part") || safeFileName(name) !== name) {
    sendJson(res, 404, { ok: false, error: "not found" })
    return true
  }
  if (!verifyLink(name, url.searchParams.get("exp"), url.searchParams.get("sig"), linkSecret(cfg))) {
    sendJson(res, 403, { ok: false, error: "link expired or invalid" })
    return true
  }

  const file = path.join(cfg.optUpdateDir, name)
  let stat
  try {
    stat = statSync(file)
  } catch {
    sendJson(res, 404, { ok: false, error: "not found" })
    return true
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { ok: false, error: "not found" })
    return true
  }

  const range = parseRange(req.headers.range, stat.size)
  if (range === "invalid") {
    res.writeHead(416, { "content-range": `bytes */${stat.size}`, "accept-ranges": "bytes" }).end()
    return true
  }
  const start = range ? range.start : 0
  const end = range ? range.end : stat.size - 1
  const length = end - start + 1
  const headers: Record<string, string | number> = {
    "content-type": "application/octet-stream",
    "content-length": length,
    "accept-ranges": "bytes",
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "private, max-age=0",
    "x-content-type-options": "nosniff",
    etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    "last-modified": new Date(stat.mtimeMs).toUTCString(),
  }
  if (range) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`
  res.writeHead(range ? 206 : 200, headers)
  if (req.method === "HEAD" || length === 0) {
    res.end()
    return true
  }

  const stream = createReadStream(file, { start, end })
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500).end()
    else res.destroy()
  })
  req.on("close", () => stream.destroy())
  stream.pipe(res)
  return true
}
