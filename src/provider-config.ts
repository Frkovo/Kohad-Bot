import type { BotConfig } from "./config.js"
import type { DfOAuthConfig } from "./df/oauth.js"
import type { LxnsConfig } from "./lxns/client.js"
import { lxnsBindings } from "./lxns/bindings.js"
import { authorizedLxConfig, type LxOAuthConfig } from "./lxns/oauth.js"

export function dfCfg(cfg: BotConfig): DfOAuthConfig | null {
  return cfg.dfClientId && cfg.dfClientSecret ? { clientId: cfg.dfClientId, clientSecret: cfg.dfClientSecret, authUrl: cfg.dfAuthUrl } : null
}
export function lxCfg(cfg: BotConfig): LxnsConfig | null {
  return cfg.lxDevToken ? { devToken: cfg.lxDevToken, apiBase: cfg.lxApiBase } : null
}
export function lxOAuthCfg(cfg: BotConfig): LxOAuthConfig | null {
  return cfg.lxClientId && cfg.lxClientSecret ? { clientId: cfg.lxClientId, clientSecret: cfg.lxClientSecret, redirectUri: cfg.lxRedirectUri, apiBase: cfg.lxApiBase } : null
}
export async function lxUserCfg(cfg: BotConfig, userId: string): Promise<LxnsConfig | null> {
  if (lxnsBindings.get(userId)?.method === "oauth") {
    const oauth = lxOAuthCfg(cfg)
    if (!oauth) throw new Error("落雪 OAuth 应用配置缺失，请检查 LX_CLIENT_ID / LX_CLIENT_SECRET")
    return authorizedLxConfig(oauth, userId, lxnsBindings)
  }
  return lxCfg(cfg)
}
