import assert from "node:assert/strict"
import test, { after } from "node:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MessageFlags, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from "discord.js"
import { resolveB50Server, UserError } from "../src/multiserver/registry.js"
import { closeServerStore, serverStore } from "../src/multiserver/store.js"
import { dataServersFor, resolveB50Query, type B50Request, type DataSources } from "../src/multiserver/b50-query.js"
import { handleServerCommand } from "../src/multiserver/interactions.js"
import { handleB50, handleB50Pick } from "../src/handlers.js"
import { closeScoreDatabase } from "../src/local/database.js"
import { createQueue } from "../src/queue.js"
import type { BotConfig } from "../src/config.js"

// One scratch database for the file: the score database is a process-wide singleton, so it cannot change per test.
const folder = mkdtempSync(path.join(tmpdir(), "kohad-b50-server-"))
process.env.LOCAL_SCORE_DB = path.join(folder, "scores.sqlite")
process.env.B50_AUTH_KEY = randomBytes(32).toString("base64")
delete process.env.B50_AUTH_KEY_FILE
after(() => { closeServerStore(); closeScoreDatabase(); rmSync(folder, { recursive: true, force: true }) })

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

test("store: saved default is null until chosen; only live bindings count as servers in use", () => {
  const store = serverStore(), user = "b50-store-user", auth = { username: "fixture-user", password: "fixture-pass" }
  assert.equal(store.savedPreferred(user), null)
  store.setPreferred(user, "intl")
  assert.equal(store.savedPreferred(user), "intl")
  store.bind(user, "jp", "jp-account", "JP Player", auth)
  store.bind(user, "intl", "intl-account", "Intl Player", auth)
  assert.deepEqual(store.boundServers(user).sort(), ["intl", "jp"])
  store.unbind(user, "jp")
  assert.deepEqual(store.boundServers(user), ["intl"])
})

test("dataServersFor: cn data from an import or a 水鱼/落雪 binding; bypassed servers never count", () => {
  const sources: DataSources = { cnData: id => id === "b50-cn", remoteBound: id => id === "b50-cn" ? ["missless", "jp"] : [] }
  assert.deepEqual(dataServersFor("b50-cn", sources), ["cn", "jp"])
  assert.deepEqual(dataServersFor("b50-none", sources), [])
})

test("resolveB50Query: manual choice > cn-only inputs > saved default > single data server", () => {
  const store = serverStore(), user = "b50-rule-user"
  const req = (over: Partial<B50Request> = {}): B50Request => ({ userId: user, commandName: "b50", explicit: null, sgwcmaid: null, source: null, refresh: null, public: false, hd: false, ...over })
  const oneRemote: DataSources = { cnData: () => false, remoteBound: () => ["intl"] }
  const cnAndJp: DataSources = { cnData: () => true, remoteBound: () => ["jp"] }

  assert.deepEqual(resolveB50Query(req({ explicit: "jp" }), oneRemote), { server: "jp", fromData: false })
  assert.deepEqual(resolveB50Query(req(), oneRemote), { server: "intl", fromData: true })
  assert.deepEqual(resolveB50Query(req({ sgwcmaid: "fixture-qr" }), oneRemote), { server: "cn", fromData: false })
  assert.deepEqual(resolveB50Query(req({ source: "lxns" }), oneRemote), { server: "cn", fromData: false })
  assert.equal(resolveB50Query(req(), cnAndJp), null)

  store.setPreferred(user, "jp")
  assert.deepEqual(resolveB50Query(req(), cnAndJp), { server: "jp", fromData: false })
  assert.deepEqual(resolveB50Query(req({ sgwcmaid: "fixture-qr" }), cnAndJp), { server: "cn", fromData: false })
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
  serverStore().setPreferred(user, "intl")
  const query = interaction("b50", {}, user)
  await handleB50(query.command, cfg, createQueue(1), new Map())
  assert.equal(query.messages.length, 1)
  assert.match(query.messages[0].content, /尚未绑定国际服/)
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
  assert.equal(serverStore().savedPreferred(user), "intl")
  assert.match(pick.messages[0].content, /尚未绑定国际服/)

  // Single use: the same menu cannot be answered twice, and a second answer changes nothing.
  const again = pickInteraction(menu.custom_id, "jp", user)
  await handleB50Pick(again.command, cfg, createQueue(1))
  assert.match(again.messages[0].content, /已过期或不属于你/)
  assert.equal(serverStore().savedPreferred(user), "intl")
})

test("a server pick belongs to the player who was asked", async () => {
  const owner = "b50-owner-user", stranger = "b50-stranger-user"
  const query = interaction("b50", {}, owner)
  await handleB50(query.command, cfg, createQueue(1), new Map())
  const menu = promptMenu(query.messages)

  const intruder = pickInteraction(menu.custom_id, "jp", stranger)
  await handleB50Pick(intruder.command, cfg, createQueue(1))
  assert.match(intruder.messages[0].content, /已过期或不属于你/)
  assert.equal(serverStore().savedPreferred(stranger), null)

  // A rejected stranger does not consume the owner's pick.
  const ownerPick = pickInteraction(menu.custom_id, "jp", owner)
  await handleB50Pick(ownerPick.command, cfg, createQueue(1))
  assert.match(ownerPick.messages[0].content, /尚未绑定日服/)
  assert.equal(serverStore().savedPreferred(owner), "jp")
})
