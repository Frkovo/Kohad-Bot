// 输出组装（纯函数，可单测）：按命令抽取 → compact JSON → 超限 gzip → tomunet 数组拆分。
import { gzipSync } from "node:zlib"
import type { MigrateSuccess } from "./migrate-client.js"

export type OutputKind = "getuserall" | "tomunet"
export type OutFile = { name: string; data: Buffer }
export type BuiltPayload = {
  files: OutFile[]
  /** 因体积过大被裁掉的顶层字段（仅 getuserall 极端情况） */
  reduced: string[]
  /** 是否发生数组拆分（各分片为原数组连续片段） */
  split: boolean
  /** 附件是否为 gzip */
  gz: boolean
  rawBytes: number
}

export class PayloadTooLargeError extends Error {
  constructor(public bytes: number, public maxBytes: number) {
    super(`payload too large: ${bytes} bytes (max ${maxBytes})`)
    this.name = "PayloadTooLargeError"
  }
}

const byteLen = (s: string) => Buffer.byteLength(s, "utf8")

/** 中国时区时间戳 yyyymmddHHMMSS（用于附件命名） */
function tsSuffix(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().replace(/[-:T]/g, "").slice(0, 14)
}

export function baseFilename(kind: OutputKind, userId: number, now = new Date()): string {
  const base = kind === "getuserall" ? "getUserAll" : "UserMusicDetailList"
  return `${base}-${userId}-${tsSuffix(now)}`
}

/** /getuserall = 整份迁移响应；/tomunet = 官方 userMusicDetailList 数组原样 */
export function extractForCommand(kind: OutputKind, s: MigrateSuccess): unknown {
  if (kind === "tomunet") return s.data?.derived?.userMusicDetailList ?? []
  return s
}

/** 将数组按体积切分为 ≤10 个 gz 分片；分片内容为原数组的连续片段 */
function splitArrayFiles(base: string, arr: unknown[], maxBytes: number): OutFile[] {
  if (arr.length === 0) return [{ name: `${base}.json.gz`, data: gzipSync(Buffer.from("[]", "utf8")) }]
  const totalRaw = byteLen(JSON.stringify(arr))
  // gzip 压缩比经验估计 ~50% 起步；从估计份数开始逐步增加，最多 10 份
  const startParts = Math.min(10, Math.max(2, Math.ceil((totalRaw / 2) / maxBytes)))
  for (let parts = startParts; parts <= 10; parts++) {
    const per = Math.ceil(arr.length / parts)
    const chunks: unknown[][] = []
    for (let i = 0; i < arr.length; i += per) chunks.push(arr.slice(i, i + per))
    const files = chunks.map((c, i) => ({
      name: `${base}-part${i + 1}of${chunks.length}.json.gz`,
      data: gzipSync(Buffer.from(JSON.stringify(c), "utf8")),
    }))
    if (files.every(f => f.data.length <= maxBytes)) return files
  }
  throw new PayloadTooLargeError(totalRaw, maxBytes)
}

export function buildPayload(args: {
  kind: OutputKind
  result: MigrateSuccess
  userId: number
  maxBytes: number
  now?: Date
}): BuiltPayload {
  const { kind, result, userId } = args
  const maxBytes = Math.max(256, Math.floor(args.maxBytes))
  const base = baseFilename(kind, userId, args.now)
  const value = extractForCommand(kind, result)

  const raw = JSON.stringify(value)
  const rawBytes = byteLen(raw)
  if (rawBytes <= maxBytes) {
    return { files: [{ name: `${base}.json`, data: Buffer.from(raw, "utf8") }], reduced: [], split: false, gz: false, rawBytes }
  }

  const gz = gzipSync(Buffer.from(raw, "utf8"))
  if (gz.length <= maxBytes) {
    return { files: [{ name: `${base}.json.gz`, data: gz }], reduced: [], split: false, gz: true, rawBytes }
  }

  if (kind === "tomunet") {
    return { files: splitArrayFiles(base, value as unknown[], maxBytes), reduced: [], split: true, gz: true, rawBytes }
  }

  // getuserall 极端兜底：渐进瘦身（derived 与 pull 内容重复；extraRaw 与正表重复），正常大账号不会走到这里
  const reduced: string[] = ["data.derived"]
  const noDerived = { ...result, data: { pull: result.data.pull } }
  let g2 = gzipSync(Buffer.from(JSON.stringify(noDerived), "utf8"))
  if (g2.length <= maxBytes) {
    return { files: [{ name: `${base}-reduced.json.gz`, data: g2 }], reduced, split: false, gz: true, rawBytes }
  }
  reduced.push("data.pull.extraRaw")
  const noExtra = { ...result, data: { pull: { ...(result.data.pull as Record<string, unknown>), extraRaw: undefined } } }
  g2 = gzipSync(Buffer.from(JSON.stringify(noExtra), "utf8"))
  if (g2.length <= maxBytes) {
    return { files: [{ name: `${base}-reduced.json.gz`, data: g2 }], reduced, split: false, gz: true, rawBytes }
  }
  throw new PayloadTooLargeError(g2.length, maxBytes)
}
