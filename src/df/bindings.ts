// 水鱼网页授权绑定：discordUserId → { nickname, boundAt, refreshToken, scope }，存于 MySQL。
// 令牌不写入日志，与落雪绑定存储一致。
import { appStore } from "../store/index.js"
import type { DfBinding } from "../store/types.js"

export type { DfBinding }

export const dfBindings = {
  get: (userId: string) => appStore().providers.df.get(userId),
  set: (userId: string, binding: DfBinding) => appStore().providers.df.set(userId, binding),
  remove: (userId: string) => appStore().providers.df.remove(userId),
}
