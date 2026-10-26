import assert from "node:assert/strict"
import test, { after } from "node:test"
import { MessageFlags, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from "discord.js"
import { resolveB50Server, UserError } from "../src/multiserver/registry.js"
import { serverStore } from "../src/multiserver/store.js"
import { dataServersFor, resolveB50Query, type B50Request, type DataSources } from "../src/multiserver/b50-query.js"
import { handleServerCommand } from "../src/multiserver/interactions.js"
import { handleB50, handleB50Pick } from "../src/handlers.js"
import { createQueue } from "../src/queue.js"
import { closeAppStore, openTestStore } from "./helpers.js"
import { dfImportTokens } from "../src/df/import-token.js"
import { t } from "../src/messages.js"
import type { BotConfig } from "../src/config.js"

// One in-memory store for the file: the store is a process-wide singleton, so it cannot change per test.
await openTestStore()
after(() => closeAppStore())

const cfg = { allowedUserIds: new Set<string>(), maxPendingReads: 9, pullConcurrency: 3 } as BotConfig

function interaction(name: string, options: Record<string, string | boolean | null> = {}, user = "b50-user") {
  const messages: any[] = []
  const value: any = {
    commandName: name, user: { id: user }, deferred: false, replied: false,
    options: {
      getString: (key: string) => typeof options[key] === "string" ? options[key] : null,
      getBoolean: (key: string) => typeof options[key] === "boolean" ? options[key] : null,
    },
    reply: async (message: any) => { value.replied = true; messages.push(message) },
    deferReply: async () => { value.deferred = true },
    editReply: async (message: any) => { messages.push(message) },
    followUp: async (message: any) => { messages.push({ ...message, followUp: true }) },
  }
  return { messages, command: value as unknown as ChatInputCommandInteraction }
}

function pickInteraction(customId: string, server: string, user: string) {
  const messages: any[] = []
  const value: any = {
    customId, values: [server], user: { id: user }, deferred: false, replied: false,
    reply: async (message: any) => { value.replied = true; messages.push(message) },
    deferReply: async () => { value.deferred = true },
    editReply: async (message: any) => { messages.push(message) },
    followUp: async (message: any) => { messages.push({ ...message, followUp: true }) },
  }
  return { messages, command: value as unknown as StringSelectMenuInteraction }
}

// The ephemeral prompt's select menu, as Discord would receive it.
function promptMenu(messages: any[]) {
  return messages[0].components[0].toJSON().components[0] as { custom_id: string; options: { value: string }[] }
}

test("resolveB50Server: explicit beats saved beats the single data server; otherwise the player chooses", () => {
  assert.equal(resolveB50Server("jp", "intl", ["cn"]), "jp")
  assert.equal(resolveB50Server(null, "intl", ["cn", "jp"]), "intl")
  assert.equal(resolveB50Server(null, null, ["jp"]), "jp")
  assert.equal(resolveB50Server(null, null, ["mumur"]), "mumur")
  assert.equal(resolveB50Server(null, null, ["cn", "jp"]), null)
  assert.equal(resolveB50Server(null, null, []), null)
  assert.equal(resolveB50Server(null, null, ["missless"]), null)
  assert.throws(() => resolveB50Server("https://invalid.test", null, []), UserError)
  assert.throws(() => resolveB50Server("missless", null, []), /旁路/)
})

test("store: saved default is null until chosen; only live bindings count as servers in use", async () => {
  const store = serverStore(), user = "b50-store-user", auth = { username: "fixture-user", password: "fixture-pass" }
  assert.equal(await store.savedPreferred(user), null)
  await store.setPreferred(user, "intl")
  assert.equal(await store.savedPreferred(user), "intl")
  await store.bind(user, "jp", "jp-account", "JP Player", auth)
  await store.bind(user, "intl", "intl-account", "Intl Player", auth)
  assert.deepEqual((await store.boundServers(user)).sort(), ["intl", "jp"])
  await store.unbind(user, "jp")
  assert.deepEqual(await store.boundServers(user), ["intl"])
})

test("dataServersFor: cn data from an import or a 水鱼/落雪 binding; bypassed servers never count", async () => {
  const sources: DataSources = { cnData: async id => id === "b50-cn", remoteBound: async id => id === "b50-cn" ? ["missless", "jp"] : [] }
  assert.deepEqual(await dataServersFor("b50-cn", sources), ["cn", "jp"])
  assert.deepEqual(await dataServersFor("b50-none", sources), [])
})

test("resolveB50Query: manual choice > cn-only inputs > saved default > single data server", async () => {
  const store = serverStore(), user = "b50-rule-user"
  const req = (over: Partial<B50Request> = {}): B50Request => ({ userId: user, commandName: "b50", explicit: null, sgwcmaid: null, source: null, refresh: null, public: false, hd: false, ...over })
  const oneRemote: DataSources = { cnData: async () => false, remoteBound: async () => ["intl"] }
  const cnAndJp: DataSources = { cnData: async () => true, remoteBound: async () => ["jp"] }

  assert.deepEqual(await resolveB50Query(req({ explicit: "jp" }), oneRemote), { server: "jp", fromData: false })
  assert.deepEqual(await resolveB50Query(req(), oneRemote), { server: "intl", fromData: true })
  assert.deepEqual(await resolveB50Query(req({ sgwcmaid: "fixture-qr" }), oneRemote), { server: "cn", fromData: false })
  assert.deepEqual(await resolveB50Query(req({ source: "lxns" }), oneRemote), { server: "cn", fromData: false })
  assert.equal(await resolveB50Query(req(), cnAndJp), null)

  await store.setPreferred(user, "jp")
  assert.deepEqual(await resolveB50Query(req(), cnAndJp), { server: "jp", fromData: false })
  assert.deepEqual(await resolveB50Query(req({ sgwcmaid: "fixture-qr" }), cnAndJp), { server: "cn", fromData: false })
})

test("/server reports an unset default instead of implying cn", async () => {
  const user = "b50-server-user"
  const first = interaction("server", {}, user)
  await handleServerCommand(first.command, cfg)
  assert.match(first.messages[0].content, /还没有设置默认成绩服务器/)

  const set = interaction("server", { server: "jp" }, user)
  await handleServerCommand(set.command, cfg)
  assert.match(set.messages[0].content, /日服/)
})

test("a saved /server default skips the prompt", async () => {
  const user = "b50-saved-user"
  await serverStore().setPreferred(user, "intl")
  const query = interaction("b50", {}, user)
  await handleB50(query.command, cfg, createQueue(1), new Map())
  assert.equal(query.messages.length, 1)
  assert.match(query.messages[0].content, /尚未绑定国际服/)
})

test("国服 with nothing imported offers the three import paths instead of failing", async () => {
  const user = "b50-empty-user"
  await serverStore().setPreferred(user, "cn")
  const query = interaction("b50", {}, user)
  await handleB50(query.command, cfg, createQueue(1), new Map())
  assert.equal(query.messages.length, 1)
  assert.equal(query.messages[0].content, t("b50.noData"))
  assert.equal(query.messages[0].flags, MessageFlags.Ephemeral)
  const buttons = query.messages[0].components[0].toJSON().components.map((component: { custom_id: string; label: string }) => [component.custom_id, component.label])
  assert.deepEqual(buttons, [["lx:rebind", t("b50.import.lx")], ["dfimport:open", t("b50.import.df")], ["ms:bind:cn", t("b50.import.maid")]])

  // An import token alone means the player already chose 水鱼, so the prompt must not repeat.
  await dfImportTokens.set(user, "fixture-import-token")
  const again = interaction("b50", {}, user)
  await handleB50(again.command, cfg, createQueue(1), new Map())
  assert.notEqual(again.messages[0].content, t("b50.noData"))
})

test("/b50 with no manual choice and no single server asks privately; the pick saves the default and resumes", async () => {
  const user = "b50-pick-user"
  const query = interaction("b50", {}, user)
  await handleB50(query.command, cfg, createQueue(1), new Map())
  const prompt = query.messages[0]
  assert.equal(prompt.flags, MessageFlags.Ephemeral)
  assert.match(prompt.content, /请选择一个服务器/)
  const menu = promptMenu(query.messages)
  assert.match(menu.custom_id, /^ms:pick:/)
  assert.deepEqual(menu.options.map(option => option.value), ["cn", "jp", "intl", "mumur"])

  const pick = pickInteraction(menu.custom_id, "intl", user)
  await handleB50Pick(pick.command, cfg, createQueue(1))
  assert.equal(await serverStore().savedPreferred(user), "intl")
  assert.match(pick.messages[0].content, /尚未绑定国际服/)

  // Single use: the same menu cannot be answered twice, and a second answer changes nothing.
  const again = pickInteraction(menu.custom_id, "jp", user)
  await handleB50Pick(again.command, cfg, createQueue(1))
  assert.match(again.messages[0].content, /已过期或不属于你/)
  assert.equal(await serverStore().savedPreferred(user), "intl")
})

test("a server pick belongs to the player who was asked", async () => {
  const owner = "b50-owner-user", stranger = "b50-stranger-user"
  const query = interaction("b50", {}, owner)
  await handleB50(query.command, cfg, createQueue(1), new Map())
  const menu = promptMenu(query.messages)

  const intruder = pickInteraction(menu.custom_id, "jp", stranger)
  await handleB50Pick(intruder.command, cfg, createQueue(1))
  assert.match(intruder.messages[0].content, /已过期或不属于你/)
  assert.equal(await serverStore().savedPreferred(stranger), null)

  // A rejected stranger does not consume the owner's pick.
  const ownerPick = pickInteraction(menu.custom_id, "jp", owner)
  await handleB50Pick(ownerPick.command, cfg, createQueue(1))
  assert.match(ownerPick.messages[0].content, /尚未绑定日服/)
  assert.equal(await serverStore().savedPreferred(owner), "jp")
})
