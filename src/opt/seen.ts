// 已通知过的新包：持久化到 B50_DATA_DIR/opt-seen.json，避免每次轮询重复私信。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { dataDir } from "../store/paths.js"

type SeenFile = { seen: Record<string, number> }
let cache: Set<string> | null = null

function file(): string {
  return path.join(dataDir(), "opt-seen.json")
}

function load(): Set<string> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as SeenFile
    cache = new Set(Object.keys(parsed.seen ?? {}))
  } catch {
    cache = new Set()
  }
  return cache
}

export function isSeen(name: string): boolean {
  return load().has(name)
}

export function markSeen(names: string[]): void {
  const set = load()
  const now = Date.now()
  for (const name of names) set.add(name)
  const entries = [...set].slice(-200)
  const payload: SeenFile = { seen: Object.fromEntries(entries.map(name => [name, now])) }
  try {
    if (!existsSync(path.dirname(file()))) mkdirSync(path.dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(payload))
  } catch { /* 通知去重失败不阻断下载 */ }
}

export function resetSeenForTests(): void {
  cache = null
}
