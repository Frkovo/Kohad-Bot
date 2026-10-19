// Bot 配置：优先加载 discord-bot/.env（源码与 dist 同深度，../.env 均为项目根），缺关键项拒绝启动。
import { fileURLToPath } from "node:url"

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)))
} catch {
  /* 无 .env：允许完全由运行环境变量提供 */
}

function required(name: string): string {
  const v = (process.env[name] ?? "").trim()
  if (!v) throw new Error(`缺少环境变量 ${name}（参见 .env.example）`)
  return v
}

export type BotConfig = {
  token: string
  appId: string
  guildId: string | null
  migrateUrl: string
  migrateApiKey: string
  allowedUserIds: Set<string>
  ephemeral: boolean
  maxAttachmentBytes: number
  callTimeoutMs: number
  cooldownMs: number
  pullConcurrency: number
  maxPendingReads: number
  /** 水鱼 OAuth（未配置时 /binddf、/upload 的 OAuth 路径与 /b50 绑定源不可用） */
  dfOAuthEnabled: boolean
  dfClientId: string
  dfClientSecret: string
  dfAuthUrl: string
  /** 水鱼网页授权回调地址（需与应用登记的一致） */
  dfRedirectUri: string
  dfScope: string
  /** B50 新曲（B15）版本阈值：落雪版本号，默认 25500 = 舞萌DX 2026 */
  b50NewVersion: number
  /** 落雪开发者 API 密钥（Authorization: <密钥>，无 Bearer）；未配置则 /bindlx 不可用 */
  lxDevToken: string
  lxApiBase: string
  /** 落雪 OAuth 授权码 / PKCE，支持自动续期 */
  lxClientId: string
  lxClientSecret: string
  lxRedirectUri: string
  /** 本机回调监听（反向代理到 kohad-bot.frkovo.uk/oauth-callback/*），默认 127.0.0.1:3729 */
  oauthHost: string
  oauthPort: number
  /** 对外的公开地址，用于拼出回调地址；需与应用登记的回调地址一致 */
  oauthPublicBase: string
}

export function loadConfig(): BotConfig {
  const allowRaw = (process.env.ALLOWED_USER_IDS ?? "").trim()
  const mb = Number(process.env.MAX_ATTACHMENT_MB ?? 7)
  const timeout = Number(process.env.CALL_TIMEOUT_MS ?? 240_000)
  const cooldown = Number(process.env.COOLDOWN_SECONDS ?? 30)
  const b50v = Number(process.env.B50_NEW_VERSION ?? 25500)
  const concurrency = Number(process.env.PULL_CONCURRENCY ?? 3)
  const pending = Number(process.env.MAX_PENDING_READS ?? 9)
  const publicBase = (process.env.OAUTH_PUBLIC_BASE ?? "https://kohad-bot.frkovo.uk").trim().replace(/\/+$/, "")
  const oauthPortRaw = Number(process.env.OAUTH_PORT ?? 3729)
  const oauthPort = Number.isInteger(oauthPortRaw) && oauthPortRaw > 0 && oauthPortRaw < 65536 ? oauthPortRaw : 3729
  return {
    token: required("DISCORD_TOKEN"),
    appId: required("DISCORD_APP_ID"),
    guildId: (process.env.DISCORD_GUILD_ID ?? "").trim() || null,
    migrateUrl: required("MIGRATE_URL").replace(/\/+$/, ""),
    migrateApiKey: (process.env.MIGRATE_API_KEY ?? "").trim(),
    allowedUserIds: new Set(allowRaw ? allowRaw.split(/[\s,，]+/).filter(Boolean) : []),
    ephemeral: (process.env.EPHEMERAL ?? "true").toLowerCase() !== "false",
    maxAttachmentBytes: Math.max(1, Math.min(50, Number.isFinite(mb) ? mb : 7)) * 1024 * 1024,
    callTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 240_000,
    cooldownMs: (Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 30) * 1000,
    pullConcurrency: Math.max(1, Math.min(6, Number.isFinite(concurrency) ? Math.floor(concurrency) : 3)),
    maxPendingReads: Math.max(6, Math.min(30, Number.isFinite(pending) ? Math.floor(pending) : 9)),
    // 水鱼 OAuth 暂时旁路：默认关闭，一律走用户自备的 Import-Token；DF_OAUTH_ENABLED=1 恢复
    dfOAuthEnabled: process.env.DF_OAUTH_ENABLED?.trim() === "1",
    dfClientId: (process.env.DF_CLIENT_ID ?? "").trim(),
    dfClientSecret: (process.env.DF_CLIENT_SECRET ?? "").trim(),
    dfAuthUrl: (process.env.DF_AUTH_URL ?? "https://auth.diving-fish.com").trim().replace(/\/+$/, ""),
    dfRedirectUri: process.env.DF_REDIRECT_URI === undefined ? `${publicBase}/oauth-callback/diving-fish` : process.env.DF_REDIRECT_URI.trim(),
    // Read-only by default. Add prober.records.write once 水鱼 approves the write scope (manual review).
    dfScope: (process.env.DF_SCOPE ?? "prober.records.read").trim(),
    b50NewVersion: Number.isFinite(b50v) && b50v > 0 ? b50v : 25500,
    lxDevToken: (process.env.LX_DEV_TOKEN ?? "").trim(),
    lxApiBase: (process.env.LX_API_BASE ?? "https://maimai.lxns.net").trim().replace(/\/+$/, ""),
    lxClientId: (process.env.LX_CLIENT_ID ?? "").trim(),
    lxClientSecret: (process.env.LX_CLIENT_SECRET ?? "").trim(),
    oauthPublicBase: publicBase,
    // LX_REDIRECT_URI unset -> the public callback. Set it to an empty value to use the "无回调地址" mode instead.
    lxRedirectUri: process.env.LX_REDIRECT_URI === undefined ? `${publicBase}/oauth-callback/lxns` : process.env.LX_REDIRECT_URI.trim(),
    oauthHost: (process.env.OAUTH_HOST ?? "127.0.0.1").trim(),
    oauthPort,
  }
}
