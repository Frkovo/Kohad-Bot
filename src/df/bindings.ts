// 水鱼网页授权绑定存储：discordUserId → { nickname, boundAt, refreshToken, scope }
// 文件：discord-bot/.data/df-bindings.json（0600，原子写 tmp+rename）。令牌不写入日志，与落雪绑定存储一致。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type DfBinding = { nickname: string; boundAt: string; refreshToken: string; scope: string }
export type DfBindingStore = {
  get(userId: string): DfBinding | null
  set(userId: string, binding: DfBinding): void
  remove(userId: string): boolean
}

const HERE = path.dirname(fileURLToPath(import.meta.url)) // src/df 或 dist/df
const DEFAULT_FILE = path.resolve(HERE, "..", "..", ".data", "df-bindings.json")

export function createDfBindingStore(filePath: string = process.env.DF_BINDINGS_FILE?.trim() || DEFAULT_FILE): DfBindingStore {
  let cache: Record<string, DfBinding> | null = null

  const load = (): Record<string, DfBinding> => {
    if (cache) return cache
    const data: Record<string, DfBinding> = {}
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [userId, value] of Object.entries(raw as Record<string, unknown>)) {
            const b = value as Partial<DfBinding> | null
            if (b && typeof b.refreshToken === "string" && b.refreshToken) {
              data[userId] = { nickname: String(b.nickname ?? ""), boundAt: String(b.boundAt ?? ""), refreshToken: b.refreshToken, scope: String(b.scope ?? "") }
            }
          }
        }
      }
    } catch {
      // A corrupt file is treated as empty; the affected users see "not bound" and can rebind.
    }
    cache = data
    return cache
  }

  const save = (data: Record<string, DfBinding>) => {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, filePath)
  }

  return {
    get: (userId) => load()[userId] ?? null,
    set: (userId, binding) => {
      const next = { ...load(), [userId]: binding }
      save(next)
      cache = next
    },
    remove: (userId) => {
      const current = load()
      if (!(userId in current)) return false
      const next = { ...current }
      delete next[userId]
      save(next)
      cache = next
      return true
    },
  }
}

export const dfBindings = createDfBindingStore()
