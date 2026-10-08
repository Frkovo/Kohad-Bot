// 绑定、双目标上传与 B50 / 拟合 B50 / PC50；扫码成功后保存本地成绩与玩家资料。
// 扫码直接保存并同步；成绩图公开，绑定与导入私密。
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction,
} from "discord.js"
import type { BotConfig } from "./config.js"
import { t } from "./messages.js"
import { Trace, failureText, safeReason, type DiagnosticFailure, type Operation } from "./diagnostics.js"
import { createQueue } from "./queue.js"
import { normalizeSgwc, isSgwcFormat, errorText, QR_INPUT_HINT } from "./util.js"
import { getDfAccessToken, clearDfTokenCache, NotBoundError, startDfAuthorization } from "./df/oauth.js"
import { startLxAuthorization, completeLxAuthorization, type LxOAuthConfig } from "./lxns/oauth.js"
import { fetchPlayerRecords, DfUnauthorizedError } from "./df/client.js"
import { fetchPlayer, fetchOwnPlayer, fetchBests, fetchScores, LxnsApiError } from "./lxns/client.js"
import { lxnsBindings } from "./lxns/bindings.js"
import { lxnsBestsToB50 } from "./lxns/bests.js"
import { loadChartCatalog } from "./b50/catalog.js"
import { scoreDatabase } from "./local/database.js"
import { computeB50, type B50Input, type B50Result } from "./b50/compute.js"
import { renderB50 } from "./b50/render.js"
import { renderHelp } from "./b50/help.js"
import { lxPlayerProfile, type PlayerProfile } from "./local/profile.js"
import { dfCfg, lxCfg, lxOAuthCfg, lxUserCfg } from "./provider-config.js"
import { importAccount, ImportBusyError, ImportQueueFullError } from "./import-account.js"
import { syncFields, type SyncResult } from "./sync.js"
import { resolveServer, UserError } from "./multiserver/registry.js"
import { serverStore } from "./multiserver/store.js"
import { bindRow, handleRemoteB50, handleServerButton, handleServerModal } from "./multiserver/interactions.js"

type BotQueue = ReturnType<typeof createQueue>

export async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply()
    await interaction.editReply({ files: [new AttachmentBuilder(await renderHelp(), { name: "kohad-help.png" })] })
  } catch (e) { await safeError(interaction, e, "command", true) }
}

async function gate(interaction: ChatInputCommandInteraction, cfg: BotConfig, lastUsed: Map<string, number>): Promise<boolean> {
  const userId = interaction.user.id
  if (cfg.allowedUserIds.size > 0 && !cfg.allowedUserIds.has(userId)) {
    await interaction.reply({ content: t("access.denied"), flags: MessageFlags.Ephemeral })
    return false
  }
  // Scan cooldown/busy/dedup belongs to the shared coordinator. Cached score
  // queries must not be blocked by another command from this same user.
  return true
}

// 失败统一经 Trace 归类：私密回复排查详情；公开延迟（publicAck）时公开仅显示排查编号。
export async function replyFailure(interaction: ChatInputCommandInteraction, failure: DiagnosticFailure, publicAck = false, details = failureText(failure)): Promise<void> {
  if (interaction.deferred && publicAck) {
    await interaction.editReply({ content: t("diagnostic.public", { id: failure.id }) })
    await interaction.followUp({ content: details, flags: MessageFlags.Ephemeral })
    return
  }
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content: details })
  else await interaction.reply({ content: details, flags: MessageFlags.Ephemeral })
}

async function safeError(interaction: ChatInputCommandInteraction, e: unknown, operation: Operation, publicAck = false, trace = new Trace(operation)): Promise<void> {
  const failure = trace.fail(e)
  if (failure.code === "10062") return
  try {
    await replyFailure(interaction, failure, publicAck)
  } catch {
    /* 交互已失效则忽略 */
  }
}

// ---------- /binddf（水鱼：网页授权，回调 /oauth-callback/diving-fish 自动完成绑定） ----------

export async function handleBindDf(interaction: ChatInputCommandInteraction, cfg: BotConfig): Promise<void> {
  if (!(await gate(interaction, cfg, new Map()))) return
  const df = dfCfg(cfg)
  if (!df) { await interaction.reply({ content: t("err.dfUnconfigured"), flags: MessageFlags.Ephemeral }); return }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const trace = new Trace("bind")
  try {
    // The callback edits this same reply when the user returns from the browser.
    const auth = startDfAuthorization(df, cfg.dfRedirectUri, cfg.dfScope, interaction.user.id, content => interaction.editReply({ content, components: [] }))
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setURL(auth.url).setLabel(t("df.button.authorize")).setStyle(ButtonStyle.Link),
    )
    await interaction.editReply({ content: t("oauth.start", { provider: t("provider.df") }), components: [row] })
    trace.note("complete")
  } catch (e) { await replyFailure(interaction, trace.fail(e)) }
}

// ---------- /bindlx（落雪：网页 OAuth 授权，回调 /oauth-callback/lxns；粘贴授权码作为备用） ----------

async function replyLxOAuth(interaction: ChatInputCommandInteraction | ButtonInteraction, oauth: LxOAuthConfig): Promise<void> {
  // The callback edits this same reply when the user returns from the browser.
  const auth = startLxAuthorization(oauth, interaction.user.id, content => interaction.editReply({ content, components: [] }))
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setURL(auth.url).setLabel(t("lx.button.authorize")).setStyle(ButtonStyle.Link),
    new ButtonBuilder().setCustomId(`lx:oauth:${auth.id}`).setLabel(t("lx.button.paste")).setStyle(ButtonStyle.Primary),
  )
  await interaction.reply({ content: `${t("oauth.start", { provider: t("provider.lx") })}\n${t("lx.oauthPasteHint")}`, components: [row], flags: MessageFlags.Ephemeral })
}

async function showLxOAuthModal(interaction: ButtonInteraction, id: string): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`lx:oauth:${id}`)
    .setTitle(t("lx.oauthModal.title"))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("callback").setLabel(t("lx.oauthField")).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000),
    ))
  await interaction.showModal(modal)
}

async function showLxBindModal(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("lx:bind")
    .setTitle(t("lx.modal.title"))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("friend_code")
        .setLabel(t("lx.modal.friendCode"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(15)
        .setMaxLength(32),
    ))
  await interaction.showModal(modal)
}

export async function handleBindLx(interaction: ChatInputCommandInteraction, cfg: BotConfig): Promise<void> {
  if (cfg.allowedUserIds.size && !cfg.allowedUserIds.has(interaction.user.id)) { await interaction.reply({ content: t("access.denied"), flags: MessageFlags.Ephemeral }); return }
  const oauth = lxOAuthCfg(cfg), lx = lxCfg(cfg)
  if (!oauth && !lx) {
    await interaction.reply({ content: t("lx.noDevToken"), flags: MessageFlags.Ephemeral })
    return
  }
  const method = interaction.options.getString("method")
  if (method && method !== "friend_code") { await interaction.reply({ content: t("lx.methodChanged"), flags: MessageFlags.Ephemeral }); return }
  const existing = lxnsBindings.get(interaction.user.id)
  if (existing && !method) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("lx:rebind").setLabel(t("lx.button.rebind")).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("lx:unbind").setLabel(t("lx.button.unbind")).setStyle(ButtonStyle.Danger),
    )
    await interaction.reply({
      content: t("lx.existing", { name: existing.name, friendCode: existing.friendCode, boundAt: existing.boundAt ? t("lx.boundAt", { date: existing.boundAt.slice(0, 10) }) : "" }),
      components: [row],
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  if (oauth) { await replyLxOAuth(interaction, oauth); return }
  await showLxBindModal(interaction)
}

export async function handleLxButton(interaction: ButtonInteraction, cfg: BotConfig): Promise<void> {
  if (cfg.allowedUserIds.size && !cfg.allowedUserIds.has(interaction.user.id)) { await interaction.reply({ content: t("access.denied"), flags: MessageFlags.Ephemeral }); return }
  const [ns, action, id] = interaction.customId.split(":")
  if (ns !== "lx") return
  if (action === "code") {
    await interaction.reply({ content: t("lx.legacyWeb"), flags: MessageFlags.Ephemeral }); return
  }
  if (action === "oauth" && id) {
    await showLxOAuthModal(interaction, id)
    return
  }
  if (action === "rebind") {
    const oauth = lxOAuthCfg(cfg)
    if (oauth) await replyLxOAuth(interaction, oauth)
    else await showLxBindModal(interaction)
    return
  }
  if (action === "unbind") {
    const removed = lxnsBindings.remove(interaction.user.id)
    await interaction.update({ content: removed ? t("lx.unbound") : t("lx.noRecord"), embeds: [], components: [] })
    return
  }
}

// Completes the OAuth code exchange, reads the player behind the token, and stores the binding.
async function handleLxOAuthSubmit(interaction: ModalSubmitInteraction, cfg: BotConfig): Promise<void> {
  const oauth = lxOAuthCfg(cfg)
  if (!oauth) { await interaction.reply({ content: t("lx.noDevToken"), flags: MessageFlags.Ephemeral }); return }
  const id = interaction.customId.split(":")[2] ?? ""
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  try {
    const tokens = await completeLxAuthorization(oauth, interaction.user.id, id, interaction.fields.getTextInputValue("callback"))
    const player = await fetchOwnPlayer({ devToken: "", apiBase: oauth.apiBase, accessToken: tokens.accessToken })
    lxnsBindings.set(interaction.user.id, { friendCode: player.friend_code, name: player.name, boundAt: new Date().toISOString(), method: "oauth",
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scope: tokens.scope })
    await interaction.editReply({ content: t("oauth.bound", { provider: t("provider.lx"), name: player.name, detail: t("oauth.detail.friendCode", { friendCode: String(player.friend_code) }) }) })
  } catch (e) {
    // OAuth errors carry only status and the provider error code, never tokens or the pasted URL.
    await interaction.editReply({ content: t("oauth.failed", { provider: t("provider.lx"), reason: e instanceof Error ? e.message : t("lx.oauthUnknown"), id: "" }) })
  }
}

export async function handleLxModal(interaction: ModalSubmitInteraction, cfg: BotConfig): Promise<void> {
  if (cfg.allowedUserIds.size && !cfg.allowedUserIds.has(interaction.user.id)) { await interaction.reply({ content: t("access.denied"), flags: MessageFlags.Ephemeral }); return }
  if (interaction.customId.startsWith("lx:oauth:")) { await handleLxOAuthSubmit(interaction, cfg); return }
  if (interaction.customId !== "lx:bind") return
  const lx = lxCfg(cfg)
  if (!lx) {
    await interaction.reply({ content: t("lx.noDevToken"), flags: MessageFlags.Ephemeral })
    return
  }
  const raw = interaction.fields.getTextInputValue("friend_code").normalize("NFKC").replace(/\s+/g, "")
  if (!/^\d{15}$/.test(raw)) {
    await interaction.reply({ content: t("lx.friendCodeRequired"), flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const trace = new Trace("bind", "cn")
  try {
    trace.step("provider")
    const player = await fetchPlayer(lx, raw)
    trace.step("credentials.save")
    lxnsBindings.set(interaction.user.id, { friendCode: player.friend_code, name: player.name, boundAt: new Date().toISOString(), method: "friend_code" })
    trace.step("reply")
    await interaction.editReply({ content: t("lx.bound", { name: player.name, rating: player.rating, friendCode: player.friend_code }) })
    trace.note("complete")
  } catch (e) {
    if (e instanceof LxnsApiError && (e.status === 404 || e.status === 400)) {
      await interaction.editReply({ content: failureText(trace.fail(new UserError(t("lx.friendCodeRejected")), { status: e.status })) })
      return
    }
    await interaction.editReply({ content: failureText(trace.fail(e)) })
  }
}

// /upload is the single scan/import/sync entry point.
export async function handleUpload(interaction: ChatInputCommandInteraction, cfg: BotConfig, queue: BotQueue, lastUsed: Map<string, number>): Promise<void> {
  return handleB50(interaction, cfg, queue, lastUsed)
}

// ---------- /b50 ----------

export async function handleB50(interaction: ChatInputCommandInteraction, cfg: BotConfig, queue: BotQueue, lastUsed: Map<string, number>): Promise<void> {
  const userId = interaction.user.id
  const importing = interaction.commandName === "upload" || interaction.commandName === "import"
  const mode = ["nb50", "fitb50"].includes(interaction.commandName) ? "fitb50" : interaction.commandName === "pc50" ? "pc50" : "b50"
  const trace = new Trace(importing ? "import" : "b50", "cn")
  const providerFailures: DiagnosticFailure[] = []
  try {
    if (!(await gate(interaction, cfg, lastUsed))) return
    if (!importing) {
      const server = resolveServer(interaction.options.getString("server"), serverStore().preferred(userId))
      if (server !== "cn") { await handleRemoteB50(interaction, cfg, server); return }
      if (interaction.options.getString("source") === "net") throw new UserError(t("b50.cnNoNet"))
      if (interaction.options.getBoolean?.("refresh") && !interaction.options.getString("sgwcmaid")) throw new UserError(t("b50.cnRefreshNeedQr"))
    }
    const raw = interaction.options.getString("sgwcmaid", importing)
    const qr = raw ? normalizeSgwc(raw) : null
    if (raw && !isSgwcFormat(qr ?? "")) {
      await interaction.reply({ content: t("qr.invalid", { hint: QR_INPUT_HINT }), flags: MessageFlags.Ephemeral }); return
    }
    await interaction.deferReply(importing ? { flags: MessageFlags.Ephemeral } : {})
    let imported = false
    let sync: SyncResult | undefined
    let reused = false
    if (qr) {
      trace.step("import")
      let account
      try { account = await importAccount(userId, qr, cfg, queue, text => interaction.editReply({ content: text })) }
      catch (e) {
        if (!(e instanceof ImportBusyError || e instanceof ImportQueueFullError)) throw e
        await interaction.editReply({ content: t("import.busy", { reason: e.message }) }); return
      }
      if (!account.result.ok) {
        const details = errorText(account.result)
        await replyFailure(interaction, account.result.diagnostic ?? trace.fail(new UserError(t("bind.cnReadFailed"))), !importing, details)
        return
      }
      sync = account.sync
      reused = !!account.reused
      imported = true
    }
    trace.step("binding.read")
    const local = scoreDatabase().get(userId)
    let profile: PlayerProfile | undefined = local?.profile
    if (importing) {
      const embed = new EmbedBuilder().setTitle(t("upload.embedTitle", { name: local?.name ?? t("value.unknownPlayer") })).setColor(0x7c81ff)
        .addFields({ name: t("upload.localField"), value: t("upload.localValue", { count: local?.inputs.length ?? 0 }), inline: false })
      if (sync) embed.addFields(syncFields(sync))
      await interaction.editReply({ content: t("upload.content", { status: reused ? t("upload.reused") : t("upload.done") }), embeds: [embed], components: [] }); return
    }
    const source = interaction.options.getString("source") ?? "auto"
    const errors: string[] = []
    let inputs: B50Input[] = []
    let title = t("value.unknownPlayer"), subtitle = "", accountRating: number | null = null
    let result: B50Result | null = null
    trace.step("rating.calculate")
    const index = await loadChartCatalog(cfg.b50NewVersion, cfg.lxApiBase, mode === "fitb50")
    const localOnly = imported || mode !== "b50" || source === "local"
    // Priority under auto: imported local data > 水鱼 > 落雪. Remote providers are only queried when there is no local copy.
    const remote = !localOnly && !(source === "auto" && local)
    if (remote && (source === "auto" || source === "df")) {
      const df = dfCfg(cfg)
      if (df) {
        try {
          trace.step("provider")
          let records
          try { records = await fetchPlayerRecords((await getDfAccessToken(df, userId, "prober.records.read")).token) }
          catch (e) {
            if (!(e instanceof DfUnauthorizedError)) throw e
            clearDfTokenCache(userId)
            records = await fetchPlayerRecords((await getDfAccessToken(df, userId, "prober.records.read")).token)
          }
          if (!Array.isArray(records.records)) throw new UserError(t("err.dfIncomplete"))
          inputs = records.records.map(r => ({ musicId: Number(r.song_id), level: Number(r.level_index), type: r.type === "DX" ? "DX" : "SD",
            achievement: Math.round(Number(r.achievements) * 10000), dxScore: Number(r.dxScore) || 0, fc: r.fc ?? "", fs: r.fs ?? "" }))
          title = records.nickname ?? records.username ?? t("value.dfPlayer")
          subtitle = t("source.dfFull")
          accountRating = records.rating ?? null
        } catch (e) {
          const failure = trace.fail(e)
          providerFailures.push(failure)
          errors.push(e instanceof NotBoundError ? t("err.dfNotBound") : t("err.dfFailed", { reason: safeReason(e) }))
        }
      } else errors.push(t("err.dfUnconfigured"))
    }
    if (remote && !inputs.length && (source === "auto" || source === "lxns")) {
      try {
        trace.step("provider")
        const lx = await lxUserCfg(cfg, userId), binding = lxnsBindings.get(userId)
        if (!lx || !binding) throw new UserError(t("err.lxNotBound"))
        const player = await fetchPlayer(lx, binding.friendCode)
        title = player.name; accountRating = player.rating
        profile = lxPlayerProfile(player, profile)
        if (lx.accessToken) {
          const rows = await fetchScores(lx)
          inputs = rows.filter(r => r.type !== "utage").map(r => ({ musicId: r.id, level: r.level_index, type: r.type === "dx" ? "DX" : "SD",
            achievement: Math.round(r.achievements * 10000), dxScore: r.dx_score, fc: r.fc ?? "", fs: r.fs ?? "" }))
          subtitle = t("source.lxOauth")
        } else {
          result = lxnsBestsToB50(await fetchBests(lx, binding.friendCode), index, { newVersionFrom: cfg.b50NewVersion })
          subtitle = t("source.lxCache")
        }
      } catch (e) {
        providerFailures.push(trace.fail(e))
        errors.push(t("err.lxFailed", { reason: safeReason(e) }))
      }
    }
    if (!inputs.length && !result && (localOnly || source === "auto") && local) {
      inputs = local.inputs; title = local.name
      subtitle = t("source.localImported", { time: local.importedAt.slice(0, 16).replace("T", " ") })
    }
    trace.step("rating.calculate")
    if (!result && inputs.length) result = computeB50(inputs, index, { newVersionFrom: cfg.b50NewVersion, versionTo: cfg.b50NewVersion + 500, mode })
    if (!result) {
      const failure = providerFailures[0] ?? trace.fail(new UserError(t("b50.noResult", { reason: mode === "b50" ? t("b50.cannotRead") : t("b50.noLocal"), errors: errors.join("\n") })))
      await replyFailure(interaction, failure, !importing)
      for (const extra of providerFailures.slice(1)) await interaction.followUp({ content: failureText(extra), flags: MessageFlags.Ephemeral })
      return
    }
    const pc = mode === "pc50"
    const label = pc ? t("label.pc50") : mode === "fitb50" ? t("label.fitb50") : t("label.b50")
    const totalPC = [...result.b35, ...result.b15].reduce((n, e) => n + (e.playCount ?? 0), 0)
    const footerNote = pc ? t("b50.note.pc50") : mode === "fitb50" ? t("b50.note.fit") : t("b50.note.default")
    // The latest imported game profile is the user's requested identity on score images.
    if (profile) title = profile.name
    trace.step("image.render")
    const png = await renderB50({ title, subtitle, accountRating, result, footerNote, profile })
    const footerParts = [footerNote, result.missing ? t("b50.missingCount", { count: result.missing }) : "", result.fitMissing ? t("b50.fitMissingCount", { count: result.fitMissing }) : ""]
    const embed = new EmbedBuilder().setTitle(t("b50.legacyTitle", { label, name: title })).setColor(0x7c81ff)
      .addFields({ name: pc ? t("b50.field.pc50Total") : t("b50.field.calcRating"), value: String(pc ? totalPC : result.total), inline: true },
        { name: t("b50.field.count"), value: String(result.b35.length + result.b15.length), inline: true },
        { name: t("b50.field.source"), value: subtitle, inline: false })
      .setFooter({ text: footerParts.filter(Boolean).join(t("b50.footerSeparator")) })
    if (sync) embed.addFields(syncFields(sync))
    trace.step("reply")
    await interaction.editReply({ content: "", embeds: [embed], files: [new AttachmentBuilder(png, { name: `${mode === "fitb50" ? "nb50" : mode}-${pc ? totalPC : result.total}.png` })] })
    for (const failure of providerFailures) await interaction.followUp({ content: failureText(failure), flags: MessageFlags.Ephemeral })
      .catch(() => trace.note("reply-failed"))
    trace.note("complete")
  } catch (e) { await safeError(interaction, e, "b50", !importing, trace) }
}
// ---------- 交互统一分发（index 调用） ----------

export async function handleButton(interaction: ButtonInteraction, cfg: BotConfig): Promise<void> {
  const ns = interaction.customId.split(":")[0]
  if (ns === "ms") return handleServerButton(interaction, cfg)
  if (ns === "dfbind") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    try {
      const df = dfCfg(cfg)
      if (!df) throw new UserError(t("err.dfUnconfigured"))
      clearDfTokenCache(interaction.user.id)
      await getDfAccessToken(df, interaction.user.id, "prober.records.read")
      await interaction.editReply({ content: t("df.bindOk") })
    } catch (e) { await interaction.editReply({ content: e instanceof NotBoundError ? t("df.notBound") : t("df.bindCheckFailed") }) }
    return
  }
  if (ns === "dfup") { await interaction.reply({ content: t("df.uploadChanged"), flags: MessageFlags.Ephemeral }); return }
  if (ns === "lx") return handleLxButton(interaction, cfg)
}

export async function handleModal(interaction: ModalSubmitInteraction, cfg: BotConfig, queue?: BotQueue): Promise<void> {
  const ns = interaction.customId.split(":")[0]
  if (ns === "ms") return handleServerModal(interaction, cfg, queue)
  if (ns === "dfup") { await interaction.reply({ content: t("df.uploadModalChanged"), flags: MessageFlags.Ephemeral }); return }
  if (ns === "lx") return handleLxModal(interaction, cfg)
}
