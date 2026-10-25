import { createHash } from "node:crypto"
import type { BotConfig } from "./config.js"
import { t } from "./messages.js"
import { pullAccount, type MigrateResult } from "./migrate-client.js"
import { scoreDatabase } from "./local/database.js"
import { syncScores, type SyncResult } from "./sync.js"
import { createQueue } from "./queue.js"
import { appStore } from "./store/index.js"
import { kvKeys } from "./store/redis.js"

type Queue = ReturnType<typeof createQueue>
// sync resolves after the local commit; callers decide whether to wait for it (B50 renders without waiting).
export type ImportedAccount = { result: MigrateResult; sync?: Promise<SyncResult>; reused?: boolean }
export class ImportBusyError extends Error {}
export class ImportQueueFullError extends Error {}
type Dependencies = { pull: typeof pullAccount; save: (userId: string, result: Extract<MigrateResult, { ok: true }>) => Promise<unknown>; sync: typeof syncScores }

const DEDUPE_MS = 15 * 60 * 1000
const LOCK_MS = 30 * 60 * 1000

/**
 * One scan per user, one pull per QR.
 * The local maps answer same-process repeats without a round trip; Redis holds the same facts so a second
 * replica (or a restarted one) cannot pull the same one-time QR again.
 */
export function createImportCoordinator(dependencies: Dependencies) {
  const users = new Map<string, string>()
  const lastScan = new Map<string, number>()
  const scans = new Map<string, { owner: string; at: number; task: Promise<ImportedAccount>; done: boolean }>()

  function prune() {
    for (const [hash, scan] of scans) if (scan.done && Date.now() - scan.at > DEDUPE_MS) scans.delete(hash)
  }

  async function remoteEntry(digest: string): Promise<{ owner: string; status: string } | null> {
    const raw = await appStore().kv.get(kvKeys.scanDigest(digest))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { owner?: unknown; status?: unknown }
      return typeof parsed.owner === "string" ? { owner: parsed.owner, status: String(parsed.status ?? "running") } : null
    } catch { return null }
  }

  return async function read(userId: string, qr: string, cfg: BotConfig, queue: Queue, progress?: (text: string) => Promise<unknown>): Promise<ImportedAccount> {
    const digest = createHash("sha256").update(`${cfg.migrateUrl}:${qr}`).digest("hex")
    prune()
    // Same-process fast path: a repeat of the same QR shares the running (or finished) task.
    const local = scans.get(digest)
    if (local) {
      if (local.owner !== userId) throw new ImportBusyError(t("import.ownedByOther"))
      await progress?.(local.done ? t("import.alreadyDone") : t("import.inProgress"))?.catch(() => undefined)
      return { ...await local.task, reused: true }
    }
    if (users.has(userId)) throw new ImportBusyError(t("import.userBusy"))
    const cooldownLeft = (cfg.cooldownMs || 0) - (Date.now() - (lastScan.get(userId) || 0))
    if (cooldownLeft > 0) throw new ImportBusyError(t("import.cooldown", { seconds: Math.ceil(cooldownLeft / 1000) }))
    // Reserve the user and the QR synchronously: two interactions cannot both start before the first await.
    users.set(userId, digest)
    const kv = appStore().kv
    const releaseUser = async () => { users.delete(userId); await kv.del(kvKeys.scanUser(userId)).catch(() => undefined) }
    const entry = { owner: userId, at: Date.now(), done: false, task: null as unknown as Promise<ImportedAccount> }
    entry.task = (async () => {
      let syncing = false
      try {
        const remote = await remoteEntry(digest)
        if (remote) {
          if (remote.owner !== userId) throw new ImportBusyError(t("import.ownedByOther"))
          throw new ImportBusyError(remote.status === "done" ? t("import.remoteDone") : t("import.remoteInProgress"))
        }
        if (!(await kv.setIfAbsent(kvKeys.scanUser(userId), digest, LOCK_MS))) throw new ImportBusyError(t("import.userBusy"))
        const cooling = await kv.pttl(kvKeys.cooldown(userId))
        if (cooling > 0) throw new ImportBusyError(t("import.cooldown", { seconds: Math.ceil(cooling / 1000) }))
        const ahead = queue.pending
        const pull = queue.enqueue(() => dependencies.pull(qr, cfg))
        if (!pull) throw new ImportQueueFullError(t("import.queueFull"))
        lastScan.set(userId, Date.now())
        if (cfg.cooldownMs > 0) await kv.set(kvKeys.cooldown(userId), "1", cfg.cooldownMs)
        await kv.set(kvKeys.scanDigest(digest), JSON.stringify({ owner: userId, status: "running" }), DEDUPE_MS)
        await progress?.(ahead >= queue.concurrency ? t("import.queued", { count: ahead - queue.concurrency + 1 }) : t("import.reading"))?.catch(() => undefined)
        const result = await pull
        if (!result.ok) return { result }
        await dependencies.save(userId, result)
        // QR failures or a failed prober must never roll back the saved scores.
        await progress?.(t("import.saved"))?.catch(() => undefined)
        // Prober sync is detached: the user lock stays held until it settles, so two syncs never overlap for one user.
        const sync = dependencies.sync(cfg, userId, result)
        sync.finally(() => { void releaseUser() }).catch(() => undefined)
        syncing = true
        return { result, sync }
      } finally {
        if (!syncing) await releaseUser()
        entry.done = true; entry.at = Date.now()
        await kv.set(kvKeys.scanDigest(digest), JSON.stringify({ owner: userId, status: "done" }), DEDUPE_MS).catch(() => undefined)
      }
    })()
    scans.set(digest, entry)
    if (scans.size > 100) for (const [hash, scan] of scans) { if (scan.done) scans.delete(hash); if (scans.size <= 100) break }
    return entry.task
  }
}
export const importAccount = createImportCoordinator({ pull: pullAccount, save: (userId, result) => scoreDatabase().save(userId, result), sync: syncScores })
