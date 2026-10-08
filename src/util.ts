// 通用小工具：二维码串归一/校验 + 迁移失败文案（index 与 handlers 共用）
import type { MigrateFailure } from "./migrate-client.js"
import { t } from "./messages.js"
import { failureText, Trace } from "./diagnostics.js"
import { UserError } from "./multiserver/registry.js"

/** Local parsing only: never visit a one-use QR URL. Keep in sync with server migrate-core. */
export function normalizeSgwc(raw: string): string {
  let value = raw.trim()
  const markdown = value.match(/^\[[\s\S]*?\]\((https?:\/\/[^\s]+)\)$/i)
  if (markdown) value = markdown[1].replace(/\\&/g, "&")
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1)
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "wq.wahlap.net" || (url.port && url.port !== "443") || url.username || url.password) return ""
      const path = decodeURIComponent(url.pathname)
      const match = path.match(/^\/qrcode\/req\/((?:SGWC)?MAID\d{12}[0-9a-f]{64})\.html$/i)
      if (!match) return ""
      value = match[1]
    } catch { return "" }
  }
  value = value.toUpperCase()
  if (/^MAID\d{12}[0-9A-F]{64}$/.test(value)) return `SGWC${value}`
  if (/^\d{12}[0-9A-F]{64}$/.test(value)) return `SGWCMAID${value}`
  return value
}
export const isSgwcFormat = (qr: string) => /^SGWCMAID\d{12}[0-9A-F]{64}$/.test(qr)
export const QR_INPUT_HINT = t("qr.inputHint")

export function errorText(f: MigrateFailure): string {
  // The service's free-text error is not echoed to Discord; the status, stage and fixed hints below are enough to act on.
  const stage = f.stage === "connect" || f.stage === "pull" ? f.stage : undefined
  const trace = f.diagnostic ? undefined : new Trace("import", "cn")
  trace?.step("import")
  const diagnostic = f.diagnostic ?? trace!.fail(new UserError(t("migrate.serviceError")), { status: f.status })
  const title = f.status === 0 ? t("migrate.failTransportTitle") : t("migrate.failTitle", { status: f.status, stage: stage ? t("migrate.failStage", { stage }) : "" })
  const lines = [title, failureText(diagnostic)]
  if (f.status === 400) lines.push(t("migrate.hint400"))
  if (f.status === 401) lines.push(t("migrate.hint401"))
  if (f.status === 502) lines.push(t("migrate.hint502"))
  if (f.status === 504) lines.push(t("migrate.hint504"))
  return lines.join("\n").slice(0, 1900)
}
