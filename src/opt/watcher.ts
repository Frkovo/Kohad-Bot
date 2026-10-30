// 每 10 分钟探测新的 .opt：只通知、不下载；下载必须由用户在 /opt 里选择。
import { existsSync } from "node:fs"
import path from "node:path"
import type { BotConfig } from "../config.js"
import { t } from "../messages.js"
import { queryOpt, type OptPackage } from "./client.js"
import { safeFileName } from "./format.js"
import { isSeen, markSeen } from "./seen.js"
import { beginPoll, endPoll, failPoll, setWatcherInterval } from "./status.js"

/** 返回 true 表示至少有一个管理员收到了私信；否则下一轮继续尝试。 */
export type Notify = (text: string) => Promise<boolean>

/** 只挑 .opt、磁盘上没有、且没有通知过的包。 */
export function findNewPackages(cfg: BotConfig, packages: OptPackage[]): OptPackage[] {
  return packages.filter(pkg => {
    if (pkg.kind !== "opt") return false
    const name = safeFileName(pkg.name)
    return !existsSync(path.join(cfg.optUpdateDir, name)) && !isSeen(name)
  })
}

export async function pollOnce(cfg: BotConfig, notify: Notify): Promise<{ packages: number; added: number }> {
  const result = await queryOpt(cfg, { titleVer: cfg.optTitleVer })
  if (result.ok !== true) throw new Error(`查询失败：HTTP ${result.status}${result.detail ? ` ${result.detail}` : ""}`)
  const fresh = findNewPackages(cfg, result.packages)
  if (!fresh.length) return { packages: result.packages.length, added: 0 }
  const delivered = await notify(t("opt.dm.new", { count: fresh.length, names: fresh.map(pkg => pkg.name).join("\n") }))
  if (delivered) markSeen(fresh.map(pkg => safeFileName(pkg.name)))
  return { packages: result.packages.length, added: delivered ? fresh.length : 0 }
}

export function startOptWatcher(cfg: BotConfig, notify: Notify): void {
  setWatcherInterval(cfg.optPollMs)
  if (cfg.optPollMs <= 0) {
    console.log("[opt] watcher disabled (SDGB_OPT_POLL_MINUTES=0)")
    return
  }
  let running = false
  const schedule = (ms: number) => {
    const timer = setTimeout(tick, ms)
    timer.unref()
  }
  const tick = async () => {
    if (running) return
    running = true
    beginPoll()
    try {
      const result = await pollOnce(cfg, notify)
      endPoll(result)
      if (result.added) console.log(`[opt] notified ${result.added} new package(s) of ${result.packages}`)
    } catch (error) {
      failPoll(error)
      console.warn(`[opt] watcher poll failed: ${(error as Error).message}`)
    } finally {
      running = false
      schedule(cfg.optPollMs)
    }
  }
  schedule(Math.min(30_000, cfg.optPollMs))
  console.log(`[opt] watcher every ${Math.round(cfg.optPollMs / 60_000)} min (notify only, title_ver ${cfg.optTitleVer})`)
}
