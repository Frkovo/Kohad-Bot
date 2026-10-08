import { randomUUID } from "node:crypto"
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js"
import type { BotConfig } from "../config.js"
import { createQueue } from "../queue.js"
import { importAccount } from "../import-account.js"
import { normalizeSgwc, isSgwcFormat } from "../util.js"
import { renderB50 } from "../b50/render.js"
import { t } from "../messages.js"
import { classifyError, failureText, Trace, type DiagnosticFailure } from "../diagnostics.js"
import { SERVER_NAMES, SERVER_BADGE, resolveServer, requireEnabledServer, checkAccess, isServer, UserError, type ServerId, type RemoteServer, type Credentials, type Snapshot } from "./registry.js"
import { serverStore } from "./store.js"
import { NetClient, accountKey, type Card } from "./net.js"
import { fetchPrivateSnapshot, privateEndpoint } from "./private.js"
import { fetchMumurSnapshot } from "../mumur/client.js"
import { calculateRemote } from "./catalog.js"
import { CACHE_MS, cancelSync, syncRemote } from "./sync.js"

type ReplyInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction
type Pending = { user: string; server: RemoteServer; auth: Credentials; client?: NetClient; cards?: Card[]; snapshot?: Snapshot; selected?: number; busy?: boolean; revision: number; expires: number; timer: NodeJS.Timeout; trace: Trace }
const pending = new Map<string, Pending>()
const PENDING_MS = 10 * 60 * 1000
function clearPending(id: string) { const entry = pending.get(id); if (entry) clearTimeout(entry.timer); pending.delete(id) }
function addPending(value: Omit<Pending, "timer" | "expires">) {
  for (const [id, entry] of pending) if (entry.user === value.user && entry.server === value.server) clearPending(id)
  const id = randomUUID(), timer = setTimeout(() => clearPending(id), PENDING_MS); timer.unref()
  pending.set(id, { ...value, expires: Date.now() + PENDING_MS, timer }); return id
}
function getPending(id: string, user: string) {
  const entry = pending.get(id)
  if (!entry || entry.expires < Date.now() || entry.user !== user) throw new UserError(t("interaction.expired"))
  requireEnabledServer(entry.server)
  return entry
}
const button = (id: string, label: string, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style)
export function bindRow(server: ServerId) { return new ActionRowBuilder<ButtonBuilder>().addComponents(button(`ms:bind:${server}`, t("bind.button", { server: SERVER_NAMES[server] }))) }

// Every failure gets one correlation ID shared with console/file logs. Private details are ephemeral;
// public B50 replies only receive the ID and a private follow-up with the actionable details.
async function report(interaction: ReplyInteraction, trace: Trace, error: unknown) {
  const failure = trace.fail(error), text = failureText(failure)
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.reply({ content: text, flags: MessageFlags.Ephemeral })
    else if (interaction.ephemeral !== false) await interaction.editReply({ content: text, components: [], embeds: [] })
    else {
      await interaction.editReply({ content: t("diagnostic.public", { id: failure.id }), components: [], embeds: [] })
      await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral })
    }
  } catch (replyError) { trace.note("reply-failed", classifyError(replyError)) }
}
function selectedServer(interaction: ChatInputCommandInteraction) { return resolveServer(interaction.options.getString("server"), serverStore().preferred(interaction.user.id)) }
function modal(server: ServerId) {
  requireEnabledServer(server)
  const form = new ModalBuilder().setCustomId(`ms:credentials:${server}`).setTitle(t("bind.modalTitle", { server: SERVER_NAMES[server] }))
  const field = (id: string, label: string, limit: number, style = TextInputStyle.Short) => new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true).setMaxLength(limit))
  if (server === "cn") form.addComponents(field("qr", t("bind.field.qr"), 4000, TextInputStyle.Paragraph))
  else if (server === "jp" || server === "intl") form.addComponents(field("username", t("bind.field.username"), 100), field("password", t("bind.field.password"), 200))
  else if (server === "mumur") form.addComponents(field("accessCode", t("bind.field.aimeCard"), 40))
  else { privateEndpoint(server); form.addComponents(field("accessCode", t("bind.field.accessCode"), 300)) }
  return form
}
export async function handleServerCommand(interaction: ChatInputCommandInteraction, cfg: BotConfig) {
  const trace = new Trace("command")
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    trace.step("binding.read")
    const store = serverStore(), server = selectedServer(interaction), name = interaction.commandName
    trace.server = server
    if (name === "server") {
      if (interaction.options.getString("server")) store.setPreferred(interaction.user.id, server)
      await interaction.reply({ content: t("bind.defaultServer", { server: SERVER_NAMES[server] }), flags: MessageFlags.Ephemeral }); return
    }
    if (name === "bind" || (name === "sync" && server === "cn")) { await interaction.showModal(modal(server)); return }
    if (name === "unbind") {
      if (server === "cn") { await interaction.reply({ content: t("bind.cnUnbindHint"), flags: MessageFlags.Ephemeral }); return }
      await interaction.reply({ content: t("bind.unbindConfirm", { server: SERVER_NAMES[server] }), flags: MessageFlags.Ephemeral,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button(`ms:unbind:${server}:${store.binding(interaction.user.id, server)?.revision ?? 0}`, t("bind.unbindButton"), ButtonStyle.Danger))] }); return
    }
    if (name === "sync") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      const snapshot = await syncRemote(interaction.user.id, server as RemoteServer, text => interaction.editReply({ content: text }), trace)
      trace.step("reply")
      await interaction.editReply({ content: t("sync.done", { server: SERVER_NAMES[server], count: snapshot.records.length }) })
      trace.note("complete"); return
    }
  } catch (error) { await report(interaction, trace, error) }
}
export async function handleRemoteB50(interaction: ChatInputCommandInteraction, cfg: BotConfig, server: RemoteServer) {
  const trace = new Trace("b50", server)
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    requireEnabledServer(server)
    if (interaction.options.getString("sgwcmaid")) throw new UserError(t("b50.sgwcOtherServer"))
    const source = interaction.options.getString("source") ?? "auto", refreshOption = interaction.options.getBoolean?.("refresh"), refresh = refreshOption === true
    if (!["auto", "local", "net"].includes(source) || (source === "net" && server !== "jp" && server !== "intl")) throw new UserError(t("b50.unsupportedSource"))
    if (source === "local" && refresh) throw new UserError(t("b50.localRefresh"))
    if (source === "net" && refreshOption === false) throw new UserError(t("b50.netNoRefresh"))
    const mode = ["nb50", "fitb50"].includes(interaction.commandName) ? "fitb50" : interaction.commandName === "pc50" ? "pc50" : "b50"
    if (mode === "fitb50") throw new UserError(t("b50.fitUnsupported"))
    if (mode === "pc50" && ["jp", "intl"].includes(server)) throw new UserError(t("b50.pc50Unsupported"))
    trace.step("binding.read")
    const store = serverStore(), binding = store.binding(interaction.user.id, server)
    let snapshot = store.snapshot(interaction.user.id, server)
    if (!snapshot && !binding?.bound) {
      await interaction.reply({ content: t("b50.unbound", { server: SERVER_NAMES[server] }), flags: MessageFlags.Ephemeral, components: [bindRow(server)] }); return
    }
    await interaction.deferReply()
    let privateFailure: DiagnosticFailure | undefined
    const stale = !snapshot || Date.now() - Date.parse(snapshot.fetchedAt) >= CACHE_MS
    if ((refresh || source === "net") && !binding?.bound) throw new UserError(t("b50.unboundCache"))
    if (source !== "local" && refreshOption !== false && (refresh || stale || source === "net") && binding?.bound) {
      try { snapshot = await syncRemote(interaction.user.id, server, undefined, trace) }
      catch (error) {
        if (!snapshot || refresh || source === "net") throw error
        if (store.binding(interaction.user.id, server)?.accountKey !== snapshot.accountKey) throw new UserError(t("b50.accountChangedSync"))
        privateFailure = trace.fail(error)
        trace.note("cache-fallback")
      }
    }
    if (!snapshot) throw new UserError(t("b50.noSnapshot"))
    trace.step("rating.calculate")
    const calculated = calculateRemote(server, snapshot, mode)
    const subtitle = t("b50.subtitle", { server: SERVER_NAMES[server], version: calculated.version, fetchedAt: snapshot.fetchedAt.slice(0, 16).replace("T", " ") })
    trace.step("image.render")
    const png = await renderB50({ title: snapshot.profile.name, profile: snapshot.profile, accountRating: snapshot.profile.rating, result: calculated.result,
      subtitle, serverLabel: SERVER_BADGE[server], useCnArtwork: false, footerNote: t("b50.footer", { version: calculated.version, note: calculated.note }) })
    if (store.binding(interaction.user.id, server)?.accountKey !== snapshot.accountKey) throw new UserError(t("b50.accountChangedRender"))
    trace.step("reply")
    const pc = mode === "pc50", modeLabel = pc ? t("label.pc50") : t("label.b50")
    const embed = new EmbedBuilder().setTitle(t("b50.embedTitle", { server: SERVER_NAMES[server], mode: modeLabel, name: snapshot.profile.name })).setColor(0x7c81ff)
      .setDescription([subtitle, calculated.note,
        privateFailure ? t("diagnostic.cacheFailed", { id: privateFailure.id }) : "",
        calculated.result.missing ? t("b50.missingCharts", { count: calculated.result.missing }) : ""].filter(Boolean).join("\n"))
      .addFields({ name: pc ? t("b50.field.pc50Total") : t("b50.field.calcRating"), value: String(pc ? [...calculated.result.b35, ...calculated.result.b15].reduce((n, r) => n + (r.playCount ?? 0), 0) : calculated.result.total), inline: true },
        { name: t("b50.field.accountRating"), value: snapshot.profile.rating === undefined ? t("value.notProvided") : String(snapshot.profile.rating), inline: true })
    await interaction.editReply({ content: "", embeds: [embed], files: [new AttachmentBuilder(png, { name: `${server}-${mode}.png` })] })
    if (privateFailure) await interaction.followUp({ content: failureText(privateFailure), flags: MessageFlags.Ephemeral })
      .catch(followError => trace.note("reply-failed", classifyError(followError)))
    trace.note("complete")
  } catch (error) { await report(interaction, trace, error) }
}
export async function handleServerModal(interaction: ModalSubmitInteraction, cfg: BotConfig, queue = createQueue(cfg.maxPendingReads ?? 9, cfg.pullConcurrency ?? 3)) {
  const trace = new Trace("bind")
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    const [, action, value] = interaction.customId.split(":")
    if (action !== "credentials" || !isServer(value)) throw new UserError(t("bind.invalidModal"))
    requireEnabledServer(value)
    const server = value
    trace.server = server
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (server === "cn") {
      trace.step("import")
      const qr = normalizeSgwc(interaction.fields.getTextInputValue("qr"))
      if (!isSgwcFormat(qr)) throw new UserError(t("bind.cnInvalidQr"))
      const result = await importAccount(interaction.user.id, qr, cfg, queue, text => interaction.editReply({ content: text }))
      if (!result.result.ok) throw result.result.diagnostic ?? new UserError(t("bind.cnReadFailed"))
      await interaction.editReply({ content: t("bind.cnDone") }); trace.note("complete"); return
    }
    trace.step("binding.read")
    const revision = serverStore().binding(interaction.user.id, server)?.revision ?? 0
    if (server === "jp" || server === "intl") {
      const auth = { username: interaction.fields.getTextInputValue("username").trim(), password: interaction.fields.getTextInputValue("password") }
      const client = new NetClient(server, undefined, undefined, trace), cards = await client.start(auth)
      const id = addPending({ user: interaction.user.id, server, auth, client, cards, revision, trace })
      // Discord limits selects to 25 options. Fail explicitly instead of silently choosing card 0.
      if (cards.length > 25) { clearPending(id); throw new UserError(t("bind.cardLimit")) }
      const menu = new StringSelectMenuBuilder().setCustomId(`ms:card:${id}`).setPlaceholder(t("bind.cardPlaceholder")).addOptions(cards.map(card => ({ label: card.label, value: String(card.index) })))
      trace.step("reply")
      await interaction.editReply({ content: t("bind.loggedIn", { server: SERVER_NAMES[server] }), components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] })
      trace.note("complete")
    } else {
      trace.step("provider")
      const auth = { accessCode: interaction.fields.getTextInputValue("accessCode").trim() }
      const snapshot = server === "mumur" ? await fetchMumurSnapshot(auth) : await fetchPrivateSnapshot(server, auth)
      trace.step("rating.calculate")
      calculateRemote(server, snapshot, "b50") // Validate independent rules before committing credentials.
      const id = addPending({ user: interaction.user.id, server, auth, snapshot, revision, trace })
      trace.step("reply")
      await interaction.editReply({ content: t("bind.verified", { server: SERVER_NAMES[server], name: snapshot.profile.name }), components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button(`ms:confirm:${id}`, t("bind.confirmButton")))] })
      trace.note("complete")
    }
  } catch (error) { await report(interaction, trace, error) }
}
export async function handleServerSelect(interaction: StringSelectMenuInteraction, cfg: BotConfig) {
  let trace = new Trace("select")
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    const [, action, id] = interaction.customId.split(":")
    if (action !== "card") throw new UserError(t("interaction.invalidCard"))
    const entry = getPending(id, interaction.user.id), selected = Number(interaction.values[0])
    trace = entry.trace
    if (!entry.cards?.some(card => card.index === selected) || !entry.client) throw new UserError(t("interaction.cardInvalid"))
    if (entry.busy) throw new UserError(t("interaction.busySelect"))
    entry.busy = true
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      const profile = await entry.client.select(selected)
      getPending(id, interaction.user.id)
      entry.selected = selected
      trace.step("reply")
      await interaction.editReply({ content: t("bind.cardSelected", { server: SERVER_NAMES[entry.server], name: profile.name }), components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button(`ms:confirm:${id}:${selected}`, t("bind.confirmButton")))] })
    } finally { entry.busy = false }
  } catch (error) { await report(interaction, trace, error) }
}
export async function handleServerButton(interaction: ButtonInteraction, cfg: BotConfig) {
  let trace = new Trace("confirm")
  try {
    checkAccess(interaction.user.id, cfg.allowedUserIds)
    const [, action, id, revision] = interaction.customId.split(":")
    if (action === "bind") {
      if (!isServer(id)) throw new UserError(t("server.invalidOption"))
      await interaction.showModal(modal(id)); return
    }
    if (action === "unbind") {
      if (!isServer(id) || id === "cn") throw new UserError(t("interaction.invalidUnbind"))
      requireEnabledServer(id)
      trace.server = id
      trace.step("binding.read")
      const store = serverStore()
      if ((store.binding(interaction.user.id, id)?.revision ?? 0) !== Number(revision)) throw new UserError(t("interaction.unbindChanged"))
      // Confirmation messages are ephemeral; also bind future shared-message buttons to their owner.
      if (interaction.message.interactionMetadata?.user.id && interaction.message.interactionMetadata.user.id !== interaction.user.id) throw new UserError(t("interaction.notOwner"))
      cancelSync(interaction.user.id, id); store.unbind(interaction.user.id, id)
      for (const [nonce, entry] of pending) if (entry.user === interaction.user.id && entry.server === id) clearPending(nonce)
      await interaction.reply({ content: t("bind.unbindDone", { server: SERVER_NAMES[id] }), flags: MessageFlags.Ephemeral })
      trace.note("complete"); return
    }
    if (action !== "confirm") throw new UserError(t("interaction.invalidBind"))
    const entry = getPending(id, interaction.user.id)
    trace = entry.trace
    if (entry.client && entry.selected === undefined) throw new UserError(t("interaction.cardRequired"))
    if (entry.busy) throw new UserError(t("interaction.busyConfirm"))
    if (entry.client && String(entry.selected) !== revision) throw new UserError(t("interaction.cardChanged"))
    entry.busy = true
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      let snapshot = entry.snapshot
      let key: string, name: string
      if (entry.client) {
        const profile = await entry.client.select(entry.selected!)
        entry.auth.cardIndex = entry.selected; entry.auth.playerName = profile.name; entry.auth.cookies = entry.client.cookies()
        key = accountKey(entry.server, JSON.stringify([entry.auth.username, entry.selected])); name = profile.name
      } else { key = snapshot!.accountKey; name = snapshot!.profile.name }
      getPending(id, interaction.user.id)
      cancelSync(entry.user, entry.server)
      trace.step("credentials.save")
      const store = serverStore(), newRevision = store.bind(entry.user, entry.server, key, name, entry.auth, entry.revision)
      clearPending(id)
      if (snapshot) {
        trace.step("snapshot.save")
        store.save(entry.user, entry.server, newRevision, snapshot)
        await interaction.editReply({ content: t("bind.done", { server: SERVER_NAMES[entry.server], count: snapshot.records.length }) })
        trace.note("complete"); return
      }
      try {
        snapshot = await syncRemote(entry.user, entry.server, text => interaction.editReply({ content: text }), trace)
        trace.step("reply")
        await interaction.editReply({ content: t("bind.done", { server: SERVER_NAMES[entry.server], count: snapshot.records.length }) })
        trace.note("complete")
      } catch (error) {
        // The credentials are already saved; report the first-sync failure with actionable private details.
        const failure = trace.fail(error)
        await interaction.editReply({ content: t("diagnostic.boundSyncFailed", { server: SERVER_NAMES[entry.server], failure: failureText(failure) }) })
      }
    } finally { entry.busy = false }
  } catch (error) { await report(interaction, trace, error) }
}
