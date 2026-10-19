import { createHash } from "node:crypto"
import type { BotConfig } from "./config.js"
import { t } from "./messages.js"
import { pullAccount, type MigrateResult } from "./migrate-client.js"
import { scoreDatabase } from "./local/database.js"
import { syncScores, type SyncResult } from "./sync.js"
import { createQueue } from "./queue.js"

type Queue = ReturnType<typeof createQueue>
// sync resolves after the local commit; callers decide whether to wait for it (B50 renders without waiting).
export type ImportedAccount = { result: MigrateResult; sync?: Promise<SyncResult>; reused?: boolean }
export class ImportBusyError extends Error {}
export class ImportQueueFullError extends Error {}
type Dependencies = { pull: typeof pullAccount; save: (userId: string, result: Extract<MigrateResult, {ok:true}>) => unknown; sync: typeof syncScores }

export function createImportCoordinator(dependencies: Dependencies) {
  const users = new Map<string, string>()
  const lastScan = new Map<string, number>()
  const scans = new Map<string, { owner: string; at: number; task: Promise<ImportedAccount>; done: boolean }>()
  const ttl = 15 * 60 * 1000
  return async function read(userId: string, qr: string, cfg: BotConfig, queue: Queue, progress?: (text: string) => Promise<unknown>): Promise<ImportedAccount> {
    const key = createHash("sha256").update(`${cfg.migrateUrl}:${qr}`).digest("hex")
    for (const [hash, scan] of scans) if (scan.done && Date.now() - scan.at > ttl) scans.delete(hash)
    const hit = scans.get(key)
    if (hit) {
      if (hit.owner !== userId) throw new ImportBusyError(t("import.ownedByOther"))
      await progress?.(hit.done ? t("import.alreadyDone") : t("import.inProgress"))?.catch(() => undefined)
      return { ...await hit.task, reused: true }
    }
    if (users.has(userId)) throw new ImportBusyError(t("import.userBusy"))
    const cooldownLeft = (cfg.cooldownMs || 0) - (Date.now() - (lastScan.get(userId) || 0))
    if (cooldownLeft > 0) throw new ImportBusyError(t("import.cooldown", { seconds: Math.ceil(cooldownLeft / 1000) }))
    users.set(userId, key)
    const ahead = queue.pending
    const pull = queue.enqueue(() => dependencies.pull(qr, cfg))
    if (!pull) { users.delete(userId); throw new ImportQueueFullError(t("import.queueFull")) }
    lastScan.set(userId, Date.now())
    const entry = { owner: userId, at: Date.now(), done: false, task: null as unknown as Promise<ImportedAccount> }
    entry.task = (async () => {
      let syncing = false
      try {
        const result = await pull
        if (!result.ok) return { result }
        dependencies.save(userId, result)
        // QR failures or a failed prober must never roll back the saved scores.
        await progress?.(t("import.saved"))?.catch(() => undefined)
        // Prober sync is detached: the user lock stays held until it settles, so two syncs never overlap for one user.
        const sync = dependencies.sync(cfg, userId, result)
        sync.finally(() => users.delete(userId)).catch(() => undefined)
        syncing = true
        return { result, sync }
      } finally {
        if (!syncing) users.delete(userId)
        entry.done = true; entry.at = Date.now()
      }
    })()
    scans.set(key, entry)
    if (scans.size > 100) for (const [hash, scan] of scans) { if (scan.done) scans.delete(hash); if (scans.size <= 100) break }
    await progress?.(ahead >= queue.concurrency ? t("import.queued", { count: ahead - queue.concurrency + 1 }) : t("import.reading"))?.catch(() => undefined)
    return entry.task
  }
}
export const importAccount = createImportCoordinator({ pull: pullAccount, save: (userId, result) => scoreDatabase().save(userId, result), sync: syncScores })
