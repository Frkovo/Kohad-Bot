// 下载完成后的分享链接：HMAC 签名 + 过期时间，无需登录；文件由 Bot 的 HTTP 监听器流式输出。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BotConfig } from "../config.js"
import { dataDir } from "../store/paths.js"
import { safeFileName } from "./format.js"

let cachedSecret: Buffer | null = null

/** SDGB_OPT_LINK_SECRET > B50_AUTH_KEY(含 base64 文本) > .data/opt-link.key（0600，首次自动生成）。 */
export function linkSecret(cfg: BotConfig): Buffer {
  if (cachedSecret) return cachedSecret
  const configured = (cfg.optLinkSecret ?? "").trim()
  if (configured) {
    cachedSecret = Buffer.from(configured, "utf8")
    return cachedSecret
  }
  const keyFile = path.join(dataDir(), "opt-link.key")
  if (!existsSync(keyFile)) {
    mkdirSync(path.dirname(keyFile), { recursive: true })
    try {
      writeFileSync(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 })
    } catch (error) {
      if (!existsSync(keyFile)) throw error
    }
  }
  cachedSecret = readFileSync(keyFile)
  return cachedSecret
}

export function signName(name: string, exp: number, secret: Buffer): string {
  return createHmac("sha256", secret).update(`opt-files\n${name}\n${exp}`).digest("base64url")
}

/** exp=0 表示不过期；签名覆盖文件名与 exp，改任一字段都会失效。 */
export function verifyLink(name: string, expRaw: string | null, sig: string | null, secret: Buffer, now = Date.now()): boolean {
  if (!sig || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false
  const exp = Number(expRaw ?? "0")
  if (!Number.isSafeInteger(exp) || exp < 0) return false
  if (exp !== 0 && exp * 1000 < now) return false
  const expected = Buffer.from(signName(name, exp, secret))
  const actual = Buffer.from(sig)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function linkFor(cfg: BotConfig, name: string, now = Date.now()): string {
  const exp = cfg.optLinkTtlMs > 0 ? Math.floor((now + cfg.optLinkTtlMs) / 1000) : 0
  const sig = signName(name, exp, linkSecret(cfg))
  return `${cfg.optPublicBase}/opt-files/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`
}

export type DownloadedFile = { name: string; size: number; mtimeMs: number }

/** 磁盘上的完整文件（排除 .part 与非安全文件名），按修改时间倒序。 */
export function listDownloaded(cfg: BotConfig): DownloadedFile[] {
  let entries
  try {
    entries = readdirSync(cfg.optUpdateDir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: DownloadedFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".part")) continue
    if (safeFileName(entry.name) !== entry.name) continue
    try {
      const stat = statSync(path.join(cfg.optUpdateDir, entry.name))
      files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch { /* 文件在遍历时消失 */ }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 供 /opt 面板与任务消息使用的文本清单（每行一个链接）。 */
export function linkLines(cfg: BotConfig, files: DownloadedFile[], limit = 20): string[] {
  return files.slice(0, limit).map(file => `${file.name}\n${linkFor(cfg, file.name)}`)
}

export function resetLinkSecretForTests() {
  cachedSecret = null
}
