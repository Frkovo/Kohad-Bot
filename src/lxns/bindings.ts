// 落雪绑定：discordUserId → { friendCode, name, boundAt, method }（OAuth 时含令牌），存于 MySQL。
import { appStore } from "../store/index.js"
import type { LxnsBinding, LxnsBindingStore } from "../store/types.js"

export type { LxnsBinding, LxnsBindingStore }

export const lxnsBindings = {
  get: (userId: string) => appStore().providers.lxns.get(userId),
  set: (userId: string, binding: LxnsBinding) => appStore().providers.lxns.set(userId, binding),
  remove: (userId: string) => appStore().providers.lxns.remove(userId),
  size: () => appStore().providers.lxns.size(),
}
