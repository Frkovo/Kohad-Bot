// /api/opt/* 客户端：只查询直链/大小，下载由本机完成。鉴权沿用 MIGRATE_API_KEY。
import type { BotConfig } from "../config.js"

export type OptLink = "isdn" | "dsl" | "bb"
export type OptTransfer = { partSizes: number[] | null; intervals: Record<OptLink, number[] | null> }
export type OptPackage = {
  index: number
  kind: "opt" | "app" | "pack" | "other"
  role: "app" | "option" | "local"
  section: string
  key: string
  name: string
  url: string
  size: number | null
  note: string
  transfer: OptTransfer
}
export type OptInstruction = { role: "app" | "option" | "local"; url: string; status: number; name?: string; common?: Record<string, string>; error?: string }
export type OptQuerySuccess = {
  ok: true
  format: "sdgb-opt-v1"
  queriedAt: string
  titleVer: string | null
  clientIdMasked: string | null
  dli: { host: string; result: string } | null
  instructions: OptInstruction[]
  packages: OptPackage[]
}
export type SweepRow = {
  version: string
  result?: string
  appUrl?: string
  optionUrl?: string
  packages?: OptPackage[]
  opt?: string[]
  error?: string
  note?: string
  stopped?: boolean
}
export type OptSweepSuccess = { ok: true; format: "sdgb-opt-v1"; spec: string; clientIdMasked: string; versions: SweepRow[] }
export type ProbeHit = { url: string; size: number | null; note: string }
export type OptProbeSuccess = { ok: true; results: ProbeHit[] }
export type OptFailure = { ok: false; status: number; stage?: string; detail?: string }
export type OptResult<T> = T | OptFailure

const MAX_DETAIL = 300

function failure(status: number, body: unknown): OptFailure {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const detail = typeof record.error === "string" ? record.error.slice(0, MAX_DETAIL) : undefined
  const stage = typeof record.stage === "string" ? record.stage : undefined
  return { ok: false, status, stage, detail }
}

function transport(error: unknown): OptFailure {
  const code = (error as { code?: unknown } | null)?.code
  const name = (error as { name?: unknown } | null)?.name
  const detail = typeof code === "string" ? code : typeof name === "string" && name !== "Error" ? name : "network"
  return { ok: false, status: 0, detail }
}

async function request<T>(cfg: BotConfig, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<OptResult<T>> {
  try {
    const res = await fetch(`${cfg.migrateUrl}${path}`, {
      method: init.method,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(cfg.migrateApiKey ? { "x-api-key": cfg.migrateApiKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(cfg.callTimeoutMs),
    })
    const text = await res.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (res.ok && (body as { ok?: unknown } | null)?.ok === true) return body as T
    return failure(res.status, body)
  } catch (error) {
    return transport(error)
  }
}

export function queryOpt(cfg: BotConfig, args: { titleVer?: string; link?: OptLink } = {}): Promise<OptResult<OptQuerySuccess>> {
  return request<OptQuerySuccess>(cfg, "/api/opt/query", { method: "POST", body: args })
}

export function parseOpt(cfg: BotConfig, text: string): Promise<OptResult<OptQuerySuccess>> {
  return request<OptQuerySuccess>(cfg, "/api/opt/parse", { method: "POST", body: { text } })
}

export function probeOpt(cfg: BotConfig, urls: string[]): Promise<OptResult<OptProbeSuccess>> {
  return request<OptProbeSuccess>(cfg, "/api/opt/probe", { method: "POST", body: { urls } })
}

export function sweepOpt(cfg: BotConfig, spec: string): Promise<OptResult<OptSweepSuccess>> {
  return request<OptSweepSuccess>(cfg, "/api/opt/sweep", { method: "POST", body: { spec } })
}

/** Range 回源代理地址：UK 直连 CDN 失败时使用。 */
export function rangeUrl(cfg: BotConfig, url: string): string {
  return `${cfg.migrateUrl}/api/opt/range?url=${encodeURIComponent(url)}`
}

export const isOptFailure = <T>(value: OptResult<T>): value is OptFailure => (value as OptFailure).ok === false
