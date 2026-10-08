// :8788 迁移服务客户端：POST /api/migrate/pull（唯一参数 sgwcmaid），
// 负责 API Key、总超时与错误归一；不自动重试（二维码一次性，重试无意义）。
import type { BotConfig } from "./config.js"
import { t } from "./messages.js"
import { classifyError, Trace, type DiagnosticFailure } from "./diagnostics.js"
import { UserError } from "./multiserver/registry.js"

export type MigrationClientConfig = Pick<BotConfig, "migrateUrl" | "migrateApiKey" | "callTimeoutMs">

export type MigrateCounts = {
  musicDetails: number
  items: number
  itemKinds?: Record<string, number>
  rivals?: number
  sections?: Record<string, boolean>
}

export type MigrateSuccess = {
  ok: true
  format: string
  pulledAt?: string
  elapsedMs?: number
  source: {
    base?: string
    userId: number
    userName: string | null
    romVersion: string | null
    dataVersion: string | null
    iconId?: number
    nameplateId?: number
    playerRating?: number
  }
  counts: MigrateCounts
  data: {
    pull: Record<string, unknown>
    derived: { userMusicDetailList: unknown[]; userItemList: unknown[] }
  }
  logout: { ok: boolean; type?: number; error?: string } | null
  warnings: string[]
}

export type MigrateFailure = {
  ok: false
  status: number
  stage?: string
  error: string
  logout?: unknown
  warnings?: string[]
  diagnostic?: DiagnosticFailure
}

export type MigrateResult = MigrateSuccess | MigrateFailure

export async function pullAccount(qr: string, cfg: MigrationClientConfig): Promise<MigrateResult> {
  const trace = new Trace("import", "cn")
  trace.step("import")
  const started = Date.now()
  let res: Response
  let text: string
  try {
    res = await fetch(`${cfg.migrateUrl}/api/migrate/pull`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.migrateApiKey ? { "x-api-key": cfg.migrateApiKey } : {}),
      },
      body: JSON.stringify({ sgwcmaid: qr }),
      signal: AbortSignal.timeout(cfg.callTimeoutMs),
    })
    text = await res.text()
  } catch (e) {
    const { code, category } = classifyError(e)
    const timedOut = category === "timeout" || category === "cancelled"
    const hint = timedOut
      ? t("migrate.timeout", { ms: cfg.callTimeoutMs })
      : code ? t("migrate.connectCode", { code }) : t("migrate.connectUnknown")
    return { ok: false, status: 0, error: t("migrate.connectFailed", { hint }), diagnostic: trace.fail(e, { elapsedMs: Date.now() - started }) }
  }

  trace.note("http-response", { status: res.status, bytes: Buffer.byteLength(text), elapsedMs: Date.now() - started })
  let body: Record<string, unknown> | null = null
  try { body = text ? JSON.parse(text) as Record<string, unknown> : null } catch { body = null }

  if (res.ok && body?.ok === true) { trace.note("complete"); return body as unknown as MigrateSuccess }
  const error = typeof body?.error === "string" ? body.error : t("migrate.httpStatus", { status: res.status })
  const stage = body?.stage === "connect" || body?.stage === "pull" ? body.stage : undefined
  return {
    ok: false,
    status: res.status,
    stage,
    error,
    diagnostic: trace.fail(new UserError(t("migrate.serviceError")), { status: res.status }),
    logout: body?.logout,
    warnings: Array.isArray(body?.warnings) ? body.warnings as string[] : undefined,
  }
}
