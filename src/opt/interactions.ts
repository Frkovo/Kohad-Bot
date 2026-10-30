// /opt v2：一次一个包。概览（单选）→ 详情 → 下载 → 完成卡（URL 按钮）。
// 轮询只负责通知；下载必须由用户明确选择。
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, statfsSync, statSync } from "node:fs"
import path from "node:path"
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type StringSelectMenuInteraction,
} from "discord.js"
import type { BotConfig } from "../config.js"
import { t } from "../messages.js"
import { Trace, failureText } from "../diagnostics.js"
import { checkAccess, UserError } from "../multiserver/registry.js"
import {
  isOptFailure, probeOpt, queryOpt, rangeUrl,
  type OptFailure, type OptPackage, type OptQuerySuccess,
} from "./client.js"
import { DownloadCancelled, downloadPackage, type DownloadProgress } from "./download.js"
import { formatDuration, formatSpeed, humanSize, safeFileName } from "./format.js"
import { linkFor } from "./links.js"
import { isSeen } from "./seen.js"
import { watcherState } from "./status.js"

type ReplyInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction

type Panel = {
  id: string
  user: string
  query: OptQuerySuccess
  titleVer: string
  trace: Trace
  selected?: OptPackage
  sizes: Map<string, number | null>
  notes: Map<string, string>
  probing?: boolean
  expires: number
  timer: NodeJS.Timeout
}

type Job = {
  id: string
  panelId: string
  user: string
  pkg: OptPackage
  name: string
  state: "running" | "done" | "failed" | "cancelled"
  controller: AbortController
  written: number
  total: number | null
  speed: number
  startedAt: number
  finishedAt?: number
  error?: string
  interaction: ReplyInteraction
  trace: Trace
  lastEdit: number
  stale: boolean
}

const PANEL_MS = 30 * 60 * 1000
const EDIT_MS = 2000
const SELECT_LIMIT = 25

const panels = new Map<string, Panel>()
let active: Job | null = null

class OptServiceError extends UserError {
  constructor(readonly failure: OptFailure) {
    super(failure.detail ?? `HTTP ${failure.status}`)
  }
}

function clearPanel(id: string) {
  const panel = panels.get(id)
  if (panel) clearTimeout(panel.timer)
  panels.delete(id)
}

function addPanel(user: string, query: OptQuerySuccess, trace: Trace): Panel {
  for (const [id, panel] of panels) if (panel.user === user) clearPanel(id)
  const id = randomUUID().replace(/-/g, "").slice(0, 10)
  const timer = setTimeout(() => clearPanel(id), PANEL_MS)
  timer.unref()
  const panel: Panel = {
    id, user, query, titleVer: query.titleVer ?? "1.56", trace,
    sizes: new Map(), notes: new Map(),
    expires: Date.now() + PANEL_MS, timer,
  }
  panels.set(id, panel)
  return panel
}

function getPanel(id: string, user: string): Panel {
  const panel = panels.get(id)
  if (!panel || panel.expires < Date.now() || panel.user !== user) throw new UserError(t("opt.error.expired"))
  return panel
}

function ensureDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new UserError(t("opt.error.dir", { detail: (error as Error).message }))
  }
}

function freeBytes(dir: string): number | null {
  try {
    const stat = statfsSync(dir)
    return stat.bavail * stat.bsize
  } catch {
    return null
  }
}

function displayDir(cfg: BotConfig): string {
  return cfg.optDisplayDir || cfg.optUpdateDir
}

function optPackages(query: OptQuerySuccess): OptPackage[] {
  return query.packages.filter(pkg => pkg.kind === "opt")
}

/** A 后面的三位编号升序（A005/A011/.../A041），否则按名称。 */
function sortPackages(packages: OptPackage[]): OptPackage[] {
  const number = (pkg: OptPackage) => {
    const match = /_A(\d+)_/.exec(pkg.name)
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
  }
  return [...packages].sort((a, b) => number(a) - number(b) || a.name.localeCompare(b.name))
}

/** 优先探测值，其次查询返回值，最后直接读已下载文件的磁盘大小。 */
function sizeOf(panel: Panel, pkg: OptPackage, cfg: BotConfig): number | null {
  const name = safeFileName(pkg.name)
  const known = panel.sizes.get(name)
  if (known !== undefined) return known
  if (pkg.size != null) return pkg.size
  try {
    const stat = statSync(path.join(cfg.optUpdateDir, name))
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

function downloaded(cfg: BotConfig, pkg: OptPackage): boolean {
  return existsSync(path.join(cfg.optUpdateDir, safeFileName(pkg.name)))
}

function isDownloading(panel: Panel, pkg: OptPackage): boolean {
  return !!active && active.state === "running" && active.panelId === panel.id && active.name === safeFileName(pkg.name)
}

function stateText(panel: Panel, pkg: OptPackage, cfg: BotConfig): string {
  if (isDownloading(panel, pkg)) {
    const percent = active && active.total ? `${((active.written / active.total) * 100).toFixed(0)}%` : "--"
    return t("opt.option.downloading", { percent })
  }
  return downloaded(cfg, pkg) ? t("opt.option.downloaded") : t("opt.option.missing")
}

function stateLine(pkg: OptPackage, cfg: BotConfig): string {
  return downloaded(cfg, pkg) ? t("opt.option.downloaded") : t("opt.option.missing")
}

function sizeText(panel: Panel, pkg: OptPackage, cfg: BotConfig): string {
  const size = sizeOf(panel, pkg, cfg)
  return size == null ? t("opt.option.sizeUnknown") : humanSize(size)
}

function serviceErrorText(failure: OptFailure): string {
  if (failure.status === 0) return t("opt.error.transport", { detail: failure.detail ?? "network" })
  if (failure.status === 404) return t("opt.error.serviceMissing")
  return t("opt.error.service", { status: failure.status, detail: failure.detail ?? failure.stage ?? "-" })
}

function unwrap<T>(result: T | OptFailure): T {
  if (!isOptFailure(result)) return result
  throw new OptServiceError(result)
}

async function report(interaction: ReplyInteraction, trace: Trace, error: unknown) {
  const failure = trace.fail(error, error instanceof OptServiceError ? { status: error.failure.status } : {})
  const text = error instanceof OptServiceError ? `${serviceErrorText(error.failure)}\n${failureText(failure)}` : failureText(failure)
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.reply({ content: text, flags: MessageFlags.Ephemeral })
    else await interaction.editReply({ content: text, components: [], embeds: [] })
  } catch {
    trace.note("reply-failed")
  }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

function overviewEmbed(panel: Panel, cfg: BotConfig): EmbedBuilder {
  const watcher = watcherState()
  const opt = optPackages(panel.query)
  const done = opt.filter(pkg => downloaded(cfg, pkg)).length
  const fresh = opt.filter(pkg => !downloaded(cfg, pkg) && isSeen(pkg.name)).length
  const status = watcher.intervalMs <= 0
    ? t("opt.status.off")
    : watcher.lastPollAt
      ? t("opt.status.line", {
          minutes: Math.round(watcher.intervalMs / 60_000),
          time: new Date(watcher.lastPollAt + 8 * 3600_000).toISOString().slice(11, 16),
          added: watcher.added ?? 0,
        })
      : t("opt.status.never")
  const description = [
    status,
    watcher.lastError ? t("opt.status.error", { error: watcher.lastError.slice(0, 100) }) : "",
    t("opt.overview.counts", { total: opt.length, downloaded: done, new: fresh }),
  ].filter(Boolean).join("\n")
  const free = freeBytes(cfg.optUpdateDir)
  return new EmbedBuilder()
    .setTitle(t("opt.title"))
    .setColor(0x45adc6)
    .setDescription(description.slice(0, 4000))
    .addFields(
      { name: t("opt.field.version"), value: `${panel.titleVer} · ${panel.query.clientIdMasked ?? "-"}`, inline: true },
      { name: t("opt.field.disk"), value: `${free == null ? "?" : humanSize(free)} · ${displayDir(cfg)}`.slice(0, 200), inline: true },
    )
}

function overviewComponents(panel: Panel, cfg: BotConfig) {
  const opt = sortPackages(optPackages(panel.query)).slice(0, SELECT_LIMIT)
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`opt:s:${panel.id}`)
    .setPlaceholder(t("opt.select.placeholder"))
    .addOptions(opt.map(pkg => ({
      label: `${!downloaded(cfg, pkg) && isSeen(pkg.name) ? "🆕 " : ""}${pkg.name}`.slice(0, 100),
      value: String(pkg.index),
      description: t("opt.option.desc", { size: sizeText(panel, pkg, cfg), state: stateText(panel, pkg, cfg) }).slice(0, 100),
    })))
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`opt:b:${panel.id}:refresh`).setLabel(t("opt.button.refresh")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`opt:b:${panel.id}:close`).setLabel(t("opt.button.close")).setStyle(ButtonStyle.Danger),
  )
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), buttons]
}

function detailEmbed(panel: Panel, cfg: BotConfig): EmbedBuilder {
  const pkg = panel.selected!
  const name = safeFileName(pkg.name)
  const note = panel.notes.get(name)
  const size = sizeOf(panel, pkg, cfg)
  const done = downloaded(cfg, pkg)
  const fields = [
    { name: t("opt.detail.size"), value: size == null ? t("opt.option.sizeUnknown") : humanSize(size), inline: true },
    { name: t("opt.detail.state"), value: stateLine(pkg, cfg), inline: true },
  ]
  if (done) fields.push({ name: t("opt.detail.saved"), value: displayDir(cfg), inline: false })
  return new EmbedBuilder()
    .setTitle(pkg.name)
    .setColor(done ? 0x22c55e : 0x7c81ff)
    .setDescription([t("opt.detail.source", { section: pkg.section, key: pkg.key }), note ? t("opt.detail.note", { note }) : ""].filter(Boolean).join("\n").slice(0, 4000))
    .addFields(...fields)
}

function linkButton(cfg: BotConfig, name: string): ButtonBuilder {
  return new ButtonBuilder().setURL(linkFor(cfg, name)).setLabel(t("opt.button.link")).setStyle(ButtonStyle.Link)
}

function detailComponents(panel: Panel, cfg: BotConfig) {
  const pkg = panel.selected!
  const done = downloaded(cfg, pkg)
  const row = new ActionRowBuilder<ButtonBuilder>()
  if (done) row.addComponents(linkButton(cfg, pkg.name))
  else row.addComponents(new ButtonBuilder()
    .setCustomId(`opt:b:${panel.id}:download`)
    .setLabel(t("opt.button.download"))
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!!active && active.state === "running"))
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`opt:b:${panel.id}:probe`)
      .setLabel(panel.probing ? t("opt.button.probing") : t("opt.button.probe"))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!!panel.probing || done),
    new ButtonBuilder().setCustomId(`opt:b:${panel.id}:back`).setLabel(t("opt.button.back")).setStyle(ButtonStyle.Secondary),
  )
  return [row]
}

function panelView(panel: Panel, cfg: BotConfig) {
  if (active && active.state === "running" && active.panelId === panel.id) return jobView(active, cfg)
  if (!panel.selected) return { embeds: [overviewEmbed(panel, cfg)], components: overviewComponents(panel, cfg) }
  return { embeds: [detailEmbed(panel, cfg)], components: detailComponents(panel, cfg) }
}

function progressEmbed(job: Job, cfg: BotConfig): EmbedBuilder {
  const percent = job.total ? `${((job.written / job.total) * 100).toFixed(1)}%` : "--"
  const eta = job.total && job.speed > 0 ? formatDuration(((job.total - job.written) / job.speed) * 1000) : "-"
  return new EmbedBuilder()
    .setTitle(t("opt.progress.title", { name: job.pkg.name }))
    .setColor(0x7c81ff)
    .addFields(
      { name: t("opt.progress.bytes"), value: `${humanSize(job.written)} / ${job.total == null ? "?" : humanSize(job.total)}（${percent}）`, inline: true },
      { name: t("opt.progress.speed"), value: formatSpeed(job.speed), inline: true },
      { name: t("opt.progress.eta"), value: eta, inline: true },
    )
    .setFooter({ text: displayDir(cfg) })
}

function doneEmbed(job: Job, cfg: BotConfig): EmbedBuilder {
  const title = job.state === "cancelled" ? t("opt.done.cancelledTitle") : job.state === "failed" ? t("opt.done.failedTitle") : t("opt.done.title")
  const color = job.state === "done" ? 0x22c55e : job.state === "cancelled" ? 0xe0a54a : 0xef4444
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(job.state === "failed" ? (job.error ?? "-").slice(0, 4000) : t("opt.done.saved", { dir: cfg.optUpdateDir }))
    .addFields({ name: t("opt.done.size"), value: humanSize(job.written || job.total || 0), inline: true })
  if (job.finishedAt) embed.setFooter({ text: formatDuration(job.finishedAt - job.startedAt) })
  return embed
}

function jobView(job: Job, cfg: BotConfig) {
  if (job.state === "running") {
    return {
      embeds: [progressEmbed(job, cfg)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`opt:b:${job.panelId}:cancel`).setLabel(t("opt.button.cancel")).setStyle(ButtonStyle.Danger),
      )],
    }
  }
  const row = new ActionRowBuilder<ButtonBuilder>()
  if (job.state === "done") row.addComponents(linkButton(cfg, job.pkg.name))
  else row.addComponents(new ButtonBuilder().setCustomId(`opt:b:${job.panelId}:download`).setLabel(t("opt.button.retry")).setStyle(ButtonStyle.Primary))
  row.addComponents(new ButtonBuilder().setCustomId(`opt:b:${job.panelId}:back`).setLabel(t("opt.button.back")).setStyle(ButtonStyle.Secondary))
  return { embeds: [doneEmbed(job, cfg)], components: [row] }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

async function editJob(job: Job, cfg: BotConfig, force = false) {
  if (job.stale) return
  const now = Date.now()
  if (!force && now - job.lastEdit < EDIT_MS) return
  job.lastEdit = now
  try {
    await job.interaction.editReply(jobView(job, cfg))
  } catch {
    job.stale = true
  }
}

async function runDownload(job: Job, cfg: BotConfig) {
  try {
    const result = await downloadPackage(job.pkg, {
      dir: cfg.optUpdateDir,
      hostAllowlist: cfg.optHostAllowlist,
      allowHttpHosts: [new URL(cfg.migrateUrl).hostname],
      transport: cfg.optTransport,
      proxy: { build: url => rangeUrl(cfg, url), apiKey: cfg.migrateApiKey },
      partSize: cfg.optPartSize,
      link: "bb",
      paceMs: cfg.optPaceMs,
      maxRetries: cfg.optMaxRetries,
      signal: job.controller.signal,
      onProgress: (progress: DownloadProgress) => {
        job.written = progress.written
        job.total = progress.total ?? job.total
        job.speed = progress.speed
        void editJob(job, cfg)
      },
    })
    job.state = "done"
    job.written = result.size ?? job.written
    job.total = job.written
    job.trace.step("opt.store")
  } catch (error) {
    if (error instanceof DownloadCancelled || job.controller.signal.aborted) {
      job.state = "cancelled"
    } else {
      job.state = "failed"
      job.error = (error as Error).message
      console.warn(`[opt] ${job.name} failed: ${job.error}`)
    }
  } finally {
    job.finishedAt = Date.now()
    job.trace.note("complete")
    if (active === job) active = null
    await editJob(job, cfg, true)
    if (job.stale) {
      try {
        const user = await job.interaction.client.users.fetch(job.user)
        await user.send({ embeds: [doneEmbed(job, cfg)] })
      } catch { /* DM 关闭时忽略 */ }
    }
  }
}

function startDownload(panel: Panel, pkg: OptPackage, interaction: ReplyInteraction, cfg: BotConfig): Job {
  if (active && active.state === "running") throw new UserError(t("opt.error.busy"))
  ensureDir(cfg.optUpdateDir)
  const known = sizeOf(panel, pkg, cfg) ?? 0
  const free = freeBytes(cfg.optUpdateDir)
  if (free != null && known > 0 && free < known + 512 * 1024 * 1024) {
    throw new UserError(t("opt.error.disk", { need: humanSize(known), free: humanSize(free) }))
  }
  if (cfg.optMaxBytes > 0 && known > cfg.optMaxBytes) {
    throw new UserError(t("opt.error.quota", { need: humanSize(known), limit: humanSize(cfg.optMaxBytes) }))
  }
  const job: Job = {
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    panelId: panel.id,
    user: panel.user,
    pkg,
    name: safeFileName(pkg.name),
    state: "running",
    controller: new AbortController(),
    written: 0,
    total: sizeOf(panel, pkg, cfg),
    speed: 0,
    startedAt: Date.now(),
    interaction,
    trace: panel.trace,
    lastEdit: 0,
    stale: false,
  }
  active = job
  void runDownload(job, cfg)
  return job
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

async function probeSelected(panel: Panel, cfg: BotConfig) {
  const pkg = panel.selected
  if (!pkg) return
  const name = safeFileName(pkg.name)
  panel.probing = true
  try {
    const result = unwrap(await probeOpt(cfg, [pkg.url]))
    const hit = result.results[0]
    panel.sizes.set(name, hit?.size ?? null)
    panel.notes.set(name, hit?.note ?? "")
  } catch (error) {
    if (error instanceof OptServiceError) throw error
    panel.notes.set(name, t("opt.error.probe", { detail: (error as Error).message }))
  } finally {
    panel.probing = false
  }
}

export async function handleOptCommand(interaction: ChatInputCommandInteraction, cfg: BotConfig): Promise<void> {
  const trace = new Trace("opt", "cn")
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    trace.step("opt.query")
    const query = unwrap(await queryOpt(cfg, { titleVer: cfg.optTitleVer }))
    if (!optPackages(query).length) throw new UserError(t("opt.error.noPackages"))
    const panel = addPanel(interaction.user.id, query, trace)
    trace.step("reply")
    await interaction.editReply(panelView(panel, cfg))
    trace.note("complete")
  } catch (error) {
    await report(interaction, trace, error)
  }
}

async function handlePanelButton(interaction: ButtonInteraction, cfg: BotConfig, panel: Panel, action: string) {
  switch (action) {
    case "refresh":
      if (active && active.state === "running") throw new UserError(t("opt.error.busy"))
      await interaction.deferUpdate()
      panel.trace.step("opt.query")
      panel.query = unwrap(await queryOpt(cfg, { titleVer: cfg.optTitleVer }))
      panel.selected = undefined
      panel.sizes.clear()
      panel.notes.clear()
      await interaction.editReply(panelView(panel, cfg))
      return
    case "close":
      clearPanel(panel.id)
      await interaction.update({ content: t("opt.closed"), embeds: [], components: [] })
      return
    case "back":
      panel.selected = undefined
      await interaction.update(panelView(panel, cfg))
      return
    case "cancel": {
      if (active && active.state === "running" && active.panelId === panel.id) active.controller.abort()
      await interaction.deferUpdate()
      return
    }
    case "download": {
      if (!panel.selected) throw new UserError(t("opt.error.noPackages"))
      if (downloaded(cfg, panel.selected)) throw new UserError(t("opt.error.alreadyDownloaded"))
      await interaction.deferUpdate()
      const job = startDownload(panel, panel.selected, interaction, cfg)
      await editJob(job, cfg, true)
      return
    }
    case "probe": {
      if (panel.probing) throw new UserError(t("opt.error.busy"))
      await interaction.deferUpdate()
      await probeSelected(panel, cfg)
      await interaction.editReply(panelView(panel, cfg))
      return
    }
    default:
      throw new UserError(t("opt.error.unknown"))
  }
}

export async function handleOptButton(interaction: ButtonInteraction, cfg: BotConfig): Promise<void> {
  const trace = new Trace("opt", "cn")
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    const [, kind, id, action] = interaction.customId.split(":")
    if (kind !== "b" || !id || !action) throw new UserError(t("opt.error.unknown"))
    const panel = getPanel(id, interaction.user.id)
    await handlePanelButton(interaction, cfg, panel, action)
  } catch (error) {
    await report(interaction, trace, error)
  }
}

export async function handleOptSelect(interaction: StringSelectMenuInteraction, cfg: BotConfig): Promise<void> {
  const trace = new Trace("opt", "cn")
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    const [, kind, id] = interaction.customId.split(":")
    if (kind !== "s" || !id) throw new UserError(t("opt.error.unknown"))
    const panel = getPanel(id, interaction.user.id)
    const index = Number(interaction.values[0])
    const pkg = panel.query.packages.find(item => item.index === index && item.kind === "opt")
    if (!pkg) throw new UserError(t("opt.error.unknown"))
    panel.selected = pkg
    panel.notes.delete(safeFileName(pkg.name))
    await interaction.deferUpdate()
    if (sizeOf(panel, pkg, cfg) == null && !downloaded(cfg, pkg)) {
      await probeSelected(panel, cfg)
    }
    await interaction.editReply(panelView(panel, cfg))
    trace.note("complete")
  } catch (error) {
    await report(interaction, trace, error)
  }
}
