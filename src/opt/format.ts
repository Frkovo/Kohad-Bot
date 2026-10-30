// /opt 的纯输入/格式化工具：与迁移服务的解析语义保持一致，但文案由 keys.json 提供。
export type SelectionResult = { picked: number[] } | { error: "bad"; bad: string[] } | null

/** "1,3-4" -> 0 基序号；与 CLI / 服务端 parseSelection 相同（范围越界整单报错）。 */
export function parseSelection(text: string, count: number): SelectionResult {
  const tokens = String(text ?? "").trim().split(/[,，、\s]+/).filter(Boolean)
  if (!tokens.length) return null
  const picked: number[] = []
  const bad: string[] = []
  for (const token of tokens) {
    const span = /^(\d+)\s*-\s*(\d+)$/.exec(token)
    if (span) {
      const [a, b] = [Number(span[1]), Number(span[2])].sort((x, y) => x - y)
      for (let i = a; i <= b; i++) {
        if (i >= 1 && i <= count) picked.push(i - 1)
        else bad.push(String(i))
      }
      continue
    }
    if (/^\d+$/.test(token)) {
      const i = Number(token)
      if (i >= 1 && i <= count) picked.push(i - 1)
      else bad.push(token)
    } else {
      bad.push(token)
    }
  }
  if (bad.length) return { error: "bad", bad }
  return { picked: [...new Set(picked)].sort((x, y) => x - y) }
}

export type NumberField = { ok: true; value: number | undefined } | { ok: false }

/** 空串 = undefined（用默认值）；否则必须是 >= min 的整数。 */
export function numberField(raw: string | null | undefined, min = 0): NumberField {
  const text = String(raw ?? "").trim()
  if (!text) return { ok: true, value: undefined }
  if (!/^\d+$/.test(text)) return { ok: false }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < min) return { ok: false }
  return { ok: true, value }
}

export function validTitleVer(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim()
  return /^\d+\.\d+(\.\d+)?$/.test(text) ? text : null
}

export function humanSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "?"
  let v = bytes
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (v < 1024 || unit === "TB") return unit === "B" ? `${Math.trunc(v)} B` : `${v.toFixed(2)} ${unit}`
    v /= 1024
  }
  return "?"
}

/** 包名只保留安全字符，杜绝路径穿越；上传/下载共用。 */
export function safeFileName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? ""
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 180)
  return clean || "package.bin"
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${humanSize(bytesPerSecond)}/s`
}
