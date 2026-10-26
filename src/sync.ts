// A successful scan is the user's authorization to sync both bound probers.
// Each leg catches its own failure; local data is committed before this runs.
import type { BotConfig } from "./config.js"
import type { MigrateSuccess } from "./migrate-client.js"
import { t } from "./messages.js"
import { safeReason } from "./diagnostics.js"
import { dfCfg, lxUserCfg } from "./provider-config.js"
import { getDfAccessToken, NotBoundError } from "./df/oauth.js"
import { fetchMusicCatalog, fetchPlayerRecords, updateRecords, type UpdateAuth } from "./df/client.js"
import { dfImportTokens } from "./df/import-token.js"
import { buildUploadPlan } from "./df/upload.js"
import { localCharts } from "./df/charts.js"
import { lxnsBindings } from "./lxns/bindings.js"
import { buildLxnsUploadPlan } from "./lxns/map.js"
import { fetchLxnsSongs } from "./b50/songs.js"
import { fetchBest, fetchScores, uploadScores } from "./lxns/client.js"
import { verifyDfRecords, verifyLxRecords } from "./verification.js"

export type SyncLeg = { status: "ok" | "error" | "skipped"; detail: string }
export type SyncResult = { df: SyncLeg; lxns: SyncLeg }

async function syncDf(cfg: BotConfig, userId: string, result: MigrateSuccess): Promise<SyncLeg> {
  const df = dfCfg(cfg) // OAuth 旁路时为 null，仅走 Import-Token
  // 用户自备的旧版 Import-Token 优先；没有且 OAuth 启用才走 OAuth 写入（需 prober.records.write 已审批）
  const importToken = (await dfImportTokens.get(userId))?.token
  if (!df && !importToken) return { status: "skipped", detail: cfg.dfOAuthEnabled ? t("sync.df.unconfigured") : t("sync.df.notBound") }
  try {
    let writeAuth: UpdateAuth
    if (importToken) {
      writeAuth = { importToken }
    } else {
      const auth = await getDfAccessToken(df!, userId, "prober.records.write")
      if (!auth.scope.split(/\s+/).includes("prober.records.write")) return { status: "skipped", detail: t("sync.df.noWrite") }
      writeAuth = { token: auth.token }
    }
    const plan = buildUploadPlan(result.data.pull, await fetchMusicCatalog(), localCharts())
    if (!plan.mapped) return { status: "skipped", detail: t("sync.noRecords", { skipped: plan.total }) }
    const uploaded = await updateRecords(plan.records, writeAuth)
    if (!uploaded.ok) return { status: "error", detail: uploaded.message }
    // The prober reports how many records it matched; a title it does not know yet is ignored on its side.
    const ignored = uploaded.accepted === undefined ? 0 : Math.max(0, plan.mapped - uploaded.accepted)
    let verification: string
    try {
      const records = await fetchPlayerRecords(importToken ? { importToken } : (await getDfAccessToken(df!, userId, "prober.records.read")).token)
      const check = verifyDfRecords(plan.records, records)
      verification = t("sync.verify", { mode: t("sync.mode.full"), verified: check.verified, total: check.total, tail: check.verified < check.total ? t("sync.verify.partial") : t("sync.verify.ok") })
    } catch { verification = t("sync.verifyUnavailable") }
    return { status: "ok", detail: t("sync.ok", { mapped: plan.mapped, skipped: plan.total - plan.mapped, verification }) + (ignored ? t("sync.dfIgnored", { count: ignored }) : "") }
  } catch (e) {
    return e instanceof NotBoundError ? { status: "skipped", detail: t("sync.df.notBound") }
      : { status: "error", detail: t("sync.df.error", { reason: safeReason(e) }) }
  }
}
async function syncLx(cfg: BotConfig, userId: string, result: MigrateSuccess): Promise<SyncLeg> {
  const binding = await lxnsBindings.get(userId)
  if (!binding) return { status: "skipped", detail: t("sync.lx.notBound") }
  try {
    const lx = await lxUserCfg(cfg, userId)
    if (!lx) return { status: "skipped", detail: t("sync.lx.unconfigured") }
    const plan = buildLxnsUploadPlan(result.data.pull, await fetchLxnsSongs(cfg.b50NewVersion, cfg.lxApiBase))
    if (!plan.mapped) return { status: "skipped", detail: t("sync.noRecords", { skipped: plan.total }) }
    if (String((await lxnsBindings.get(userId))?.friendCode) !== String(binding.friendCode)) return { status: "error", detail: t("sync.lx.changed") }
    const uploaded = await uploadScores(lx, binding.friendCode, plan.scores)
    if (!uploaded.ok) return { status: "error", detail: t("sync.lx.partial", { uploaded: uploaded.uploaded, reason: uploaded.batches.find(b => !b.ok)?.message ?? t("sync.uploadFailed") }) }
    let verification: string
    try {
      const sample = lx.accessToken ? plan.scores : [...plan.scores].sort((a,b) => b.achievements-a.achievements || b.dx_score-a.dx_score).slice(0,3)
      const actual = lx.accessToken ? await fetchScores(lx) : await Promise.all(sample.map(s => fetchBest(lx, binding.friendCode, s)))
      const check = verifyLxRecords(sample, actual)
      verification = t("sync.verify", { mode: lx.accessToken ? t("sync.mode.full") : t("sync.mode.sample"), verified: check.verified, total: check.total, tail: check.verified < check.total ? t("sync.verify.partial") : t("sync.verify.ok") })
    } catch { verification = t("sync.verifyUnavailable") }
    return { status: "ok", detail: t("sync.ok", { mapped: uploaded.uploaded, skipped: plan.total - plan.mapped, verification }) + (plan.unknown ? t("sync.lxUnknown", { count: plan.unknown }) : "") }
  } catch (e) { return { status: "error", detail: t("sync.lx.error", { reason: safeReason(e) }) } }
}
export async function syncScores(cfg: BotConfig, userId: string, result: MigrateSuccess): Promise<SyncResult> {
  const [df, lxns] = await Promise.all([syncDf(cfg, userId, result), syncLx(cfg, userId, result)])
  return { df, lxns }
}
export function syncFields(result: SyncResult) {
  return ([['df', result.df], ['lx', result.lxns]] as const).map(([name, leg]) => ({
    name: t("sync.field.name", { icon: leg.status === "ok" ? "✅" : leg.status === "skipped" ? "⚠️" : "❌", target: t(`sync.leg.${name}`) }), value: leg.detail, inline: false,
  }))
}
