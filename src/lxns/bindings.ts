// 落雪绑定存储：discordUserId → { friendCode, name, boundAt, method }
// 文件：discord-bot/.data/lxns-bindings.json（原子写 tmp+rename；内容不进入日志）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Trace } from "../diagnostics.js"
import { fileURLToPath } from "node:url"

export type LxnsBinding = {
  friendCode: string | number
  name: string
  boundAt: string
  method: "friend_code" | "oauth"
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

export type LxnsBindingStore = {
  get(userId: string): LxnsBinding | null
  set(userId: string, binding: LxnsBinding): void
  remove(userId: string): boolean
  size(): number
}

const HERE = path.dirname(fileURLToPath(import.meta.url)) // src/lxns 或 dist/lxns
const DEFAULT_FILE = path.resolve(HERE, "..", "..", ".data", "lxns-bindings.json")

export function createLxnsBindingStore(filePath: string = DEFAULT_FILE): LxnsBindingStore {
  let cache: Record<string, LxnsBinding> | null = null

  const load = (): Record<string, LxnsBinding> => {
    if (cache) return cache
    const data: Record<string, LxnsBinding> = {}
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const b = v as Partial<LxnsBinding> | null
            if (b && /^\d{15}$/.test(String(b.friendCode)) && typeof b.name === "string") {
              data[k] = { friendCode: b.friendCode!, name: b.name, boundAt: String(b.boundAt ?? ""), method: b.method === "oauth" ? "oauth" : "friend_code",
                ...(b.method === "oauth" ? { accessToken: b.accessToken, refreshToken: b.refreshToken, expiresAt: b.expiresAt, scope: b.scope } : {}) }
            }
          }
        }
      }
    } catch (e) {
      const trace = new Trace("runtime")
      trace.step("binding.read")
      trace.fail(e)
    }
    cache = data
    return cache
  }

  const save = (data: Record<string, LxnsBinding>) => {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, filePath)
  }

  return {
    get(userId) { return load()[userId] ?? null },
    set(userId, binding) { const data = load(); data[userId] = binding; save(data) },
    remove(userId) { const data = load(); if (!(userId in data)) return false; delete data[userId]; save(data); return true },
    size() { return Object.keys(load()).length },
  }
}

export const lxnsBindings = createLxnsBindingStore()
