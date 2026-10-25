// 水鱼旧版 Import-Token（每位 Discord 用户自行提供）：discordUserId → { token, savedAt }，存于 MySQL。
// 令牌不写入日志，只展示末 4 位。
import { appStore } from "../store/index.js"
import type { DfImportToken } from "../store/types.js"

export type { DfImportToken }

export const dfImportTokens = {
  get: (userId: string) => appStore().providers.dfImportTokens.get(userId),
  set: (userId: string, token: string) => appStore().providers.dfImportTokens.set(userId, token),
  remove: (userId: string) => appStore().providers.dfImportTokens.remove(userId),
}
