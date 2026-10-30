// Bot 配置：优先加载 discord-bot/.env（源码与 dist 同深度，../.env 均为项目根），缺关键项拒绝启动。
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dataDir } from "./store/paths.js"

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
  /** /opt：下载目录（容器内路径；宿主机为 compose 的 ./data 映射） */
  optUpdateDir: string
  /** /opt：文案里展示的宿主机目录（默认空 = 显示 optUpdateDir） */
  optDisplayDir: string
  /** /opt：直连 CDN / 走迁移服务代理 / 自动回退 */
  optTransport: "auto" | "direct" | "proxy"
  /** /opt：片间隔毫秒（0 = 全速；CLI 默认 1000 对应官机 8KB/s） */
  optPaceMs: number
  /** /opt：分片字节默认值（0 = 整文件单请求；8192 = 官机分片） */
  optPartSize: number
  /** /opt：同一片连续失败上限 */
  optMaxRetries: number
  /** /opt：单次任务已探测总量上限（0 = 不限） */
  optMaxBytes: number
  /** /opt：允许直连/代理的 CDN 主机后缀 */
  optHostAllowlist: string[]
  /** /opt：对外分享下载链接的站点根（默认 OAUTH_PUBLIC_BASE） */
  optPublicBase: string
  /** /opt：链接有效期（0 = 不过期） */
  optLinkTtlMs: number
  /** /opt：链接签名密钥（空 = 用 B50_AUTH_KEY，或自动生成 .data/opt-link.key） */
  optLinkSecret: string
  /** /opt：自动探测新 OPT 的间隔（0 = 关闭） */
  optPollMs: number
  /** /opt：自动探测使用的 title_ver */
  optTitleVer: string
  /** /opt：新包私信通知的 Discord 用户 ID；空则用应用 owner */
  optNotifyUserIds: string[]
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
  // /opt：下载目录与传输参数。默认全速；官机节奏（1000ms/8KB）可按次在下载弹窗里填写。
  const optTransportRaw = (process.env.SDGB_OPT_TRANSPORT ?? "auto").trim().toLowerCase()
  const optTransport = optTransportRaw === "direct" || optTransportRaw === "proxy" ? optTransportRaw : "auto"
  const optPaceRaw = Number(process.env.SDGB_OPT_PACE_MS ?? 0)
  const optPartRaw = (process.env.SDGB_OPT_PART_SIZE ?? "").trim()
  const optRetriesRaw = Number(process.env.SDGB_OPT_MAX_RETRIES ?? 200)
  const optMaxBytesRaw = Number(process.env.SDGB_OPT_MAX_BYTES ?? 0)
  const optPollRaw = Number(process.env.SDGB_OPT_POLL_MINUTES ?? 10)
  const optLinkTtlRaw = Number(process.env.SDGB_OPT_LINK_TTL_SECONDS ?? 7 * 24 * 3600)
  const optTitle = (process.env.SDGB_OPT_TITLE_VER ?? "1.56").trim()
  const optPublicBase = (process.env.SDGB_OPT_PUBLIC_BASE ?? publicBase).trim().replace(/\/+$/, "")
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
    optUpdateDir: path.resolve((process.env.SDGB_UPDATE_DIR ?? "").trim() || path.join(dataDir(), "sdgb-update")),
    optDisplayDir: (process.env.SDGB_UPDATE_DISPLAY_DIR ?? "").trim(),
    optTransport,
    optPaceMs: Number.isFinite(optPaceRaw) && optPaceRaw >= 0 ? Math.floor(optPaceRaw) : 0,
    optPartSize: /^\d+$/.test(optPartRaw) ? Number(optPartRaw) : 0,
    optMaxRetries: Number.isFinite(optRetriesRaw) && optRetriesRaw >= 0 ? Math.floor(optRetriesRaw) : 200,
    optMaxBytes: Number.isFinite(optMaxBytesRaw) && optMaxBytesRaw > 0 ? Math.floor(optMaxBytesRaw) : 0,
    optHostAllowlist: (process.env.SDGB_OPT_HOST_ALLOWLIST ?? "wahlap.com,sys-allnet.cn").split(",").map(value => value.trim()).filter(Boolean),
    optPublicBase: optPublicBase || publicBase,
    optLinkTtlMs: Number.isFinite(optLinkTtlRaw) && optLinkTtlRaw >= 0 ? Math.floor(optLinkTtlRaw) * 1000 : 7 * 24 * 3600 * 1000,
    optLinkSecret: (process.env.SDGB_OPT_LINK_SECRET ?? process.env.B50_AUTH_KEY ?? "").trim(),
    optPollMs: Number.isFinite(optPollRaw) && optPollRaw > 0 ? Math.floor(optPollRaw) * 60_000 : 0,
    optTitleVer: /^\d+\.\d+(\.\d+)?$/.test(optTitle) ? optTitle : "1.56",
    optNotifyUserIds: (process.env.SDGB_OPT_NOTIFY_USER_IDS ?? "").split(/[\s,，]+/).map(value => value.trim()).filter(Boolean),
  }
}
