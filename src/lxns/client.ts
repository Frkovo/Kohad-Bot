// 落雪（LXNS）开发者 API 客户端（https://maimai.lxns.net）
// 鉴权：Authorization: <开发者密钥>（无 Bearer）；响应统一 {success, code, message, data}
// 接口：player（读玩家）、bests（官方 B50）、scores（分批上传成绩）
import { t } from "../messages.js"
import { safeReason } from "../diagnostics.js"
export type LxnsConfig = { devToken: string; apiBase: string; accessToken?: string }

export class LxnsApiError extends Error {
  status: number
  code?: number
  constructor(status: number, message: string, code?: number) {
    super(message)
    this.name = "LxnsApiError"
    this.status = status
    this.code = code
  }
}

export type LxnsPlayer = {
  name: string
  rating: number
  friend_code: string | number
  course_rank?: number
  class_rank?: number
  star?: number
  upload_time?: string
  icon?: { id: number } | null
  name_plate?: { id: number } | null
}

export type LxnsScore = {
  id: number
  song_name?: string
  level?: string
  level_index: number
  achievements: number
  fc?: string | null
  fs?: string | null
  dx_score: number
  dx_star?: number
  dx_rating?: number
  rate?: string
  type: string
  play_time?: string | null
  upload_time?: string
  last_played_time?: string
}

export type LxnsBests = {
  standard_total: number
  dx_total: number
  standard: LxnsScore[]
  dx: LxnsScore[]
  standard_selections?: LxnsScore[]
  dx_selections?: LxnsScore[]
}

export type LxnsUploadScore = {
  id: number
  type: "standard" | "dx" | "utage"
  level_index: number
  achievements: number
  fc: string | null
  fs: string | null
  dx_score: number
}

async function request<T>(cfg: LxnsConfig, method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: {
      authorization: cfg.accessToken ? `Bearer ${cfg.accessToken}` : cfg.devToken,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text().catch(() => "")
  let json: { success?: boolean; code?: number; message?: string; data?: unknown } | null = null
  // Keep friend codes as identifiers, including leading zeroes in string responses.
  try { json = text ? JSON.parse(text.replace(/("friend_code"\s*:\s*)(\d{15,20})(?=\s*[,}])/g, '$1"$2"')) : null } catch { json = null }
  if (!res.ok || (json && json.success === false)) {
    const reason = typeof json?.message === "string" ? json.message : `HTTP ${res.status}`
    const credential = cfg.accessToken || cfg.devToken
    throw new LxnsApiError(res.status, credential ? reason.split(credential).join("[凭据已隐藏]") : reason, json?.code)
  }
  if (!json || json.success !== true || typeof json.code !== "number") throw new LxnsApiError(res.status, "落雪返回无效 JSON 或不完整的响应")
  return json.data as T
}

// OAuth user: the player behind the access token (GET /api/v0/user/maimai/player, scope read_player).
export async function fetchOwnPlayer(cfg: LxnsConfig): Promise<LxnsPlayer> {
  return request<LxnsPlayer>(cfg, "GET", "/api/v0/user/maimai/player")
}
export async function fetchPlayer(cfg: LxnsConfig, friendCode: string | number): Promise<LxnsPlayer> {
  if (!cfg.accessToken && !/^\d{15}$/.test(String(friendCode))) throw new LxnsApiError(400, "好友码必须为 15 位数字")
  const player = await request<LxnsPlayer>(cfg, "GET", cfg.accessToken ? "/api/v0/user/maimai/player" : `/api/v0/maimai/player/${friendCode}`)
  if (!player || !/^\d{15}$/.test(String(player.friend_code)) || typeof player.name !== "string") throw new LxnsApiError(502, "落雪玩家资料不完整（好友码应为 15 位）")
  return player
}

export async function fetchBest(cfg: LxnsConfig, friendCode: string | number, score: Pick<LxnsScore, "id" | "type" | "level_index">): Promise<LxnsScore> {
  const params = new URLSearchParams({ song_id: String(score.id), song_type: score.type, level_index: String(score.level_index) })
  const prefix = cfg.accessToken ? "/api/v0/user/maimai/player" : `/api/v0/maimai/player/${friendCode}`
  return request<LxnsScore>(cfg, "GET", `${prefix}/best?${params}`)
}

export async function fetchBests(cfg: LxnsConfig, friendCode: string | number): Promise<LxnsBests> {
  return await request<LxnsBests>(cfg, "GET", cfg.accessToken ? "/api/v0/user/maimai/player/bests" : `/api/v0/maimai/player/${friendCode}/bests`)
}

export async function fetchScores(cfg: LxnsConfig): Promise<LxnsScore[]> {
  if (!cfg.accessToken) throw new Error("完整成绩读取需要落雪 OAuth 授权")
  const rows = await request<LxnsScore[]>(cfg, "GET", "/api/v0/user/maimai/player/scores")
  if (!Array.isArray(rows)) throw new LxnsApiError(502, "落雪成绩响应无效")
  return rows
}

export type UploadBatchResult = { count: number; ok: boolean; message?: string }
export type UploadScoresResult = { ok: boolean; uploaded: number; batches: UploadBatchResult[] }

const CHUNK_SIZE = 500

/** 分批上传（500/批）；429/5xx 退避重试一次，鉴权类错误立即终止 */
export async function uploadScores(cfg: LxnsConfig, friendCode: string | number, scores: LxnsUploadScore[]): Promise<UploadScoresResult> {
  const batches: UploadBatchResult[] = []
  let uploaded = 0
  for (let i = 0; i < scores.length; i += CHUNK_SIZE) {
    const chunk = scores.slice(i, i + CHUNK_SIZE)
    let attempt = 0
    for (;;) {
      try {
        await request(cfg, "POST", cfg.accessToken ? "/api/v0/user/maimai/player/scores" : `/api/v0/maimai/player/${friendCode}/scores`, { scores: chunk }, 60000)
        batches.push({ count: chunk.length, ok: true })
        uploaded += chunk.length
        break
      } catch (e) {
        const err = e as LxnsApiError
        const retriable = err.status === 429 || err.status >= 500
        if (retriable && attempt < 1) {
          attempt++
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        // Provider text is never echoed: only the HTTP status or a fixed reason category reaches the user.
        batches.push({ count: chunk.length, ok: false, message: Number.isInteger(err.status) && err.status > 0 ? t("lx.batchHttp", { status: err.status }) : safeReason(e) })
        return { ok: false, uploaded, batches }
      }
    }
  }
  return { ok: batches.every(b => b.ok), uploaded, batches }
}
