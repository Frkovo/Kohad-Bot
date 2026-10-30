// SDGB Tools Discord Bot 入口：/getuserall、/tomunet → 调用 :8788 迁移服务。
// 关键约束：3 秒内 ack（先 deferReply）；命令名全小写；差量注册避免消耗命令配额。
import {
  AttachmentBuilder, Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js"
import { loadConfig } from "./config.js"
import { COMMANDS_JSON, COMMAND_NAMES } from "./commands.js"
import { type MigrateSuccess } from "./migrate-client.js"
import { buildPayload, PayloadTooLargeError, type BuiltPayload, type OutputKind } from "./payload.js"
import { createQueue } from "./queue.js"
import { handleB50, handleB50Pick, handleBindDf, handleBindLx, handleButton, handleModal, handleUpload, handleHelp, replyFailure } from "./handlers.js"
import { startOAuthServer } from "./oauth-callback.js"
import { errorText, isSgwcFormat, normalizeSgwc, QR_INPUT_HINT } from "./util.js"
import { importAccount, ImportBusyError, ImportQueueFullError } from "./import-account.js"
import { syncFields, type SyncResult } from "./sync.js"
import { handleServerCommand, handleServerSelect } from "./multiserver/interactions.js"
import { handleOptButton, handleOptCommand, handleOptSelect } from "./opt/interactions.js"
import { startOptWatcher } from "./opt/watcher.js"
import { t } from "./messages.js"
import { Trace } from "./diagnostics.js"
import { closeAppStore, openAppStore } from "./store/index.js"

const cfg = loadConfig()
// MySQL and Redis start alongside the bot in Compose; wait for them before registering commands.
await openAppStore({ log: message => console.warn(message) })
const queue = createQueue(cfg.maxPendingReads, cfg.pullConcurrency)
const lastUsed = new Map<string, number>()

function summaryEmbed(kind: OutputKind, r: MigrateSuccess, built: BuiltPayload, note: string, sync?: SyncResult): EmbedBuilder {
  const title = kind === "getuserall" ? t("migrate.title.getuserall") : t("migrate.title.tomunet")
  const warnings = [...(r.warnings ?? [])]
  if (note) warnings.unshift(note)
  const logoutText = r.logout?.ok ? t("summary.logoutOk") : t("summary.logoutUnconfirmed", { error: r.logout?.error ?? t("summary.noReturn") }).slice(0, 100)
  const embed = new EmbedBuilder()
    .setTitle(t("summary.title", { title }))
    .setColor(0x22c55e)
    .addFields(
      { name: t("summary.field.account"), value: `${r.source.userName ?? t("summary.unknownAccount")}\n\`${r.source.userId}\``, inline: true },
      { name: t("summary.field.version"), value: `${r.source.romVersion ?? "-"} / ${r.source.dataVersion ?? "-"}`, inline: true },
      { name: t("summary.field.data"), value: t("summary.dataCounts", { musicDetails: r.counts.musicDetails, items: r.counts.items }), inline: true },
      { name: t("summary.field.logout"), value: logoutText, inline: true },
      { name: t("summary.field.timing"), value: t("summary.timingFiles", { ms: r.elapsedMs ?? 0, count: built.files.length, gzip: built.gz ? t("summary.gzip") : "" }), inline: true },
    )
    .setFooter({ text: warnings.length ? t("summary.warnings", { warnings: warnings.slice(0, 3).join(t("list.separator")) }).slice(0, 300) : t("summary.noWarnings") })
  if (sync) embed.addFields(syncFields(sync))
  return embed
}

/** 差量注册：现有命令签名一致则跳过，避免重启消耗 Discord 命令配额 */
async function registerCommands(client: Client): Promise<void> {
  const app = client.application
  if (!app) return
  const guildId = cfg.guildId ?? undefined
  const existing = await app.commands.fetch(guildId ? { guildId } : {})
  // A prior global registration can outlive switching to guild commands.
  // Remove only the obsolete names, so users see one scan entry point.
  if (guildId) {
    const globalCommands = await app.commands.fetch()
    for (const command of globalCommands.values()) if (["import", "fitb50"].includes(command.name)) await command.delete()
  }
  const sig = (c: { name: string; description: string; options?: readonly unknown[] }) =>
    `${c.name}|${c.description}|${(c.options ?? []).map((o) => {
      const x = o as { name?: string; type?: number; required?: boolean; description?: string; min_length?: number; max_length?: number; minLength?: number; maxLength?: number; choices?: unknown }
      // discord.js 的 Command 对象可能把 min/max 归一成 camelCase，两种都读，避免每次重启都误判。
      return `${x.name}:${x.type}:${x.required ?? false}:${x.description ?? ""}:${x.min_length ?? x.minLength ?? ""}:${x.max_length ?? x.maxLength ?? ""}:${JSON.stringify(x.choices ?? [])}`
    }).join(",")}`
  const before = [...existing.values()].map(sig).sort().join(";")
  const after = [...COMMANDS_JSON].map(sig).sort().join(";")
  if (before === after) {
    console.log("[bot] commands unchanged, skip registration")
    return
  }
  const live = new Map([...existing.values()].map(c => [c.name, sig(c)]))
  for (const command of COMMANDS_JSON) {
    const current = live.get(command.name)
    if (current !== sig(command)) console.log(`[bot] command diff ${command.name}\n  live:  ${String(current).slice(0, 240)}\n  local: ${sig(command).slice(0, 240)}`)
  }
  if (guildId) {
    await app.commands.set(COMMANDS_JSON, guildId)
  } else {
    await app.commands.set(COMMANDS_JSON)
  }
  console.log(`[bot] registered ${COMMANDS_JSON.length} commands ${guildId ? `to guild ${guildId}` : "globally"}`)
}

async function handleCommand(interaction: ChatInputCommandInteraction, kind: OutputKind): Promise<void> {
  const userId = interaction.user.id
  const trace = new Trace("command")
  try {
    if (cfg.allowedUserIds.size > 0 && !cfg.allowedUserIds.has(userId)) {
      await interaction.reply({ content: t("access.denied"), flags: MessageFlags.Ephemeral })
      return
    }
    const qr = normalizeSgwc(interaction.options.getString("sgwcmaid", true))
    if (!isSgwcFormat(qr)) {
      await interaction.reply({
        content: t("qr.invalid", { hint: QR_INPUT_HINT }),
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    // 3 秒内 ack；延迟令牌 15 分钟内可编辑（8788 默认预算 180s）
    const ackStart = Date.now()
    await interaction.deferReply(cfg.ephemeral ? { flags: MessageFlags.Ephemeral } : {})
    const ackMs = Date.now() - ackStart
    if (ackMs > 1500) {
      console.warn(`[bot] deferReply 耗时 ${ackMs}ms：到 Discord 网络偏慢，超过 3000ms 会报 Unknown interaction(10062)`)
    }

    trace.step("import")
    let imported
    try { imported = await importAccount(userId, qr, cfg, queue, text => interaction.editReply({ content: text })) }
    catch (e) {
      if (!(e instanceof ImportBusyError || e instanceof ImportQueueFullError)) throw e
      await interaction.editReply({ content: t("import.busy", { reason: e.message }) }); return
    }
    const result = imported.result
    if (!result.ok) {
      const details = errorText(result)
      if (result.diagnostic) await replyFailure(interaction, result.diagnostic, !cfg.ephemeral, details)
      else await interaction.editReply({ content: details })
      return
    }
    trace.step("runtime")
    let built: BuiltPayload
    try {
      built = buildPayload({ kind, result, userId: result.source.userId, maxBytes: cfg.maxAttachmentBytes })
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        await interaction.editReply({ content: t("payload.tooLarge", { mb: Math.round(e.maxBytes / 1048576) }) })
        return
      }
      throw e
    }
    const notes: string[] = []
    if (built.split) notes.push(t("payload.split", { count: built.files.length }))
    if (built.reduced.length > 0) notes.push(t("payload.reduced", { fields: built.reduced.join(t("list.itemSeparator")) }))
    const note = notes.join(t("list.separator"))
    // The migration summary reports sync results, so this reply waits for them (unlike /b50).
    const sync = imported.sync ? await imported.sync : undefined
    await interaction.editReply({
      content: "",
      embeds: [summaryEmbed(kind, result, built, note, sync)],
      files: built.files.map(f => new AttachmentBuilder(f.data, { name: f.name })),
    })
  } catch (e) {
    const failure = trace.fail(e)
    if (failure.code === "10062") return
    try {
      await replyFailure(interaction, failure, !cfg.ephemeral)
    } catch {
      trace.note("reply-failed")
    }
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

// 交互异常（如 Unknown interaction 10062）不应当让进程退出
process.on("unhandledRejection", (reason) => {
  new Trace("runtime").fail(reason)
})

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag} (${c.user.id})`)
  if (cfg.allowedUserIds.size === 0) {
    console.warn("[bot] ALLOWED_USER_IDS 为空：命令对所有人开放（可在 .env 配置用户白名单）")
  }
  try {
    await registerCommands(client)
  } catch (e) {
    const failure = new Trace("runtime").fail(e)
    if (failure.code === "50001") {
      const invite = `https://discord.com/oauth2/authorize?client_id=${cfg.appId}&scope=bot%20applications.commands&permissions=51200`
      console.error(`[bot] 机器人尚未加入 Guild ${cfg.guildId ?? "(未配置)"}，请先用以下链接邀请（必须含 applications.commands scope）：`)
      console.error(`[bot] ${invite}`)
      // 每 60s 重试，邀请后无需重启即可自动完成注册
      const timer = setInterval(async () => {
        try {
          await registerCommands(client)
          clearInterval(timer)
        } catch { /* 等待被邀请，静默重试 */ }
      }, 60_000)
      timer.unref()
    }
  }
})

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName
    if (!(COMMAND_NAMES as readonly string[]).includes(name) && !["import", "fitb50"].includes(name)) {
      void interaction.reply({ content: t("command.outdated"), flags: MessageFlags.Ephemeral }).catch(() => undefined)
      return
    }
    if (name === "help") { void handleHelp(interaction); return }
    if (name === "opt") { void handleOptCommand(interaction, cfg); return }
    if (["server", "bind", "sync", "unbind"].includes(name)) { void handleServerCommand(interaction, cfg); return }
    if (name === "getuserall" || name === "tomunet") { void handleCommand(interaction, name as OutputKind); return }
    if (name === "binddf") { void handleBindDf(interaction, cfg); return }
    if (name === "bindlx") { void handleBindLx(interaction, cfg); return }
    if (name === "upload" || name === "import") { void handleUpload(interaction, cfg, queue, lastUsed); return }
    if (["b50", "nb50", "fitb50", "pc50"].includes(name)) { void handleB50(interaction, cfg, queue, lastUsed); return }
    return
  }
  if (interaction.isButton()) {
    if (interaction.customId.startsWith("opt:")) { void handleOptButton(interaction, cfg).catch(e => new Trace("opt").fail(e)); return }
    void handleButton(interaction, cfg).catch(e => new Trace("runtime").fail(e))
    return
  }
  if (interaction.isModalSubmit()) {
    void handleModal(interaction, cfg, queue).catch(e => new Trace("runtime").fail(e))
    return
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("opt:")) {
    void handleOptSelect(interaction, cfg).catch(e => new Trace("opt").fail(e))
    return
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ms:pick:")) {
    void handleB50Pick(interaction, cfg, queue).catch(e => new Trace("runtime").fail(e))
    return
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ms:")) {
    void handleServerSelect(interaction, cfg).catch(e => new Trace("runtime").fail(e))
  }
})

startOAuthServer(cfg)

// Close MySQL and Redis on the orchestrator's stop signal so restarts never leave sessions behind.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`[bot] ${signal} received, shutting down`)
    void (async () => {
      try { client.destroy() } catch { /* already logged out */ }
      await closeAppStore().catch(error => console.warn(`[bot] store close failed: ${(error as Error).message}`))
      process.exit(0)
    })()
  })
}
await client.login(cfg.token)

/** 新包只私信管理员；管理员列表优先 SDGB_OPT_NOTIFY_USER_IDS，否则用应用 owner。 */
async function notifyAdmins(text: string): Promise<boolean> {
  const ids = new Set(cfg.optNotifyUserIds)
  const owner = client.application?.owner
  if (owner) {
    if ("members" in owner) for (const member of owner.members.values()) ids.add(member.user.id)
    else ids.add(owner.id)
  }
  if (!ids.size) {
    console.warn("[opt] new package found but no SDGB_OPT_NOTIFY_USER_IDS and no application owner")
    return false
  }
  let delivered = false
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id)
      await user.send(text)
      delivered = true
    } catch (error) {
      console.warn(`[opt] DM ${id} failed: ${(error as Error).message}`)
    }
  }
  return delivered
}

startOptWatcher(cfg, notifyAdmins)
