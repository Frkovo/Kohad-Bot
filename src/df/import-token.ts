// 水鱼旧版 Import-Token（每位 Discord 用户自行提供）存储：discordUserId → { token, savedAt }
// 文件：discord-bot/.data/df-import-tokens.json（0600，原子写 tmp+rename）。令牌不写入日志，只展示末 4 位。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type DfImportToken = { token: string; savedAt: string }
export type DfImportTokenStore = {
  get(userId: string): DfImportToken | null
  set(userId: string, token: string): void
  remove(userId: string): boolean
}

const HERE = path.dirname(fileURLToPath(import.meta.url)) // src/df 或 dist/df
const DEFAULT_FILE = path.resolve(HERE, "..", "..", ".data", "df-import-tokens.json")

export function createDfImportTokenStore(filePath: string = process.env.DF_IMPORT_TOKENS_FILE?.trim() || DEFAULT_FILE): DfImportTokenStore {
  let cache: Record<string, DfImportToken> | null = null

  const load = (): Record<string, DfImportToken> => {
    if (cache) return cache
    const data: Record<string, DfImportToken> = {}
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [userId, value] of Object.entries(raw as Record<string, unknown>)) {
            const b = value as Partial<DfImportToken> | null
            if (b && typeof b.token === "string" && b.token) data[userId] = { token: b.token, savedAt: String(b.savedAt ?? "") }
          }
        }
      }
    } catch {
      // A corrupt file is treated as empty; the affected users fall back to OAuth or re-enter the token.
    }
    cache = data
    return cache
  }

  const save = (data: Record<string, DfImportToken>) => {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, filePath)
  }

  return {
    get: (userId) => load()[userId] ?? null,
    set: (userId, token) => {
      const next = { ...load(), [userId]: { token, savedAt: new Date().toISOString() } }
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

export const dfImportTokens = createDfImportTokenStore()
