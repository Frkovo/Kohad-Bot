import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { type ButtonInteraction, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from "discord.js"

import type { BotConfig } from "../src/config.js"
import { t as msg } from "../src/messages.js"
import { handleOptButton, handleOptCommand, handleOptSelect } from "../src/opt/interactions.js"
import type { OptPackage, OptQuerySuccess } from "../src/opt/client.js"
import { setWatcherInterval } from "../src/opt/status.js"

type Payload = Record<string, unknown>

const DATA = Buffer.from("0123456789abcdef")

async function fileServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""))
    if (!range) {
      res.writeHead(200, { "content-length": DATA.length })
      res.end(DATA)
      return
    }
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), DATA.length - 1) : DATA.length - 1
    const chunk = DATA.subarray(start, end + 1)
    res.writeHead(206, { "content-length": chunk.length, "content-range": `bytes ${start}-${end}/${DATA.length}` })
    res.end(chunk)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/SDGB_new.opt`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function cfg(dir: string): BotConfig {
  return {
    migrateUrl: "https://migrate.test", migrateApiKey: "k", callTimeoutMs: 5000, allowedUserIds: new Set<string>(),
    optUpdateDir: dir, optDisplayDir: "", optTransport: "direct", optPaceMs: 0, optPartSize: 0,
    optMaxRetries: 2, optMaxBytes: 0, optHostAllowlist: ["wahlap.com", "127.0.0.1"],
    optPublicBase: "https://kohad-bot.frkovo.uk", optLinkTtlMs: 60_000, optLinkSecret: "ui-secret",
    optPollMs: 0, optTitleVer: "1.56", optNotifyUserIds: [],
  } as BotConfig
}

function pkg(index: number, name: string, url: string, size: number | null): OptPackage {
  return {
    index, kind: "opt", role: "option", section: "COMMON", key: `INSTALL${index}`, name, url, size, note: "",
    transfer: { partSizes: [8192, 8192, 8192], intervals: { isdn: [1], dsl: [1], bb: [1] } },
  }
}

function query(packages: OptPackage[]): OptQuerySuccess {
  return {
    ok: true, format: "sdgb-opt-v1", queriedAt: new Date().toISOString(), titleVer: "1.56", clientIdMasked: "A63E*******",
    dli: { host: "http://at.sys-allnet.cn", result: "1" }, instructions: [], packages,
  }
}

function mockFetch(t: { mock: { method: Function } }, payload: OptQuerySuccess) {
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/api/opt/probe")) {
      const body = JSON.parse(String(init?.body)) as { urls: string[] }
      return Response.json({ ok: true, results: [{ url: body.urls[0], size: 555, note: "" }] })
    }
    return Response.json(payload)
  })
}

function commandFake() {
  const state = { replies: [] as Payload[], deferred: false }
  const interaction = {
    user: { id: "u1" }, commandName: "opt", deferred: false, replied: false,
    options: { getString: () => null, getAttachment: () => null },
    deferReply: async () => { state.deferred = true; interaction.deferred = true },
    editReply: async (payload: Payload) => { state.replies.push(payload) },
    reply: async (payload: Payload) => { state.replies.push(payload) },
  }
  return { interaction: interaction as unknown as ChatInputCommandInteraction, state }
}

function componentFake(customId: string, values: string[] = []) {
  const state = { replies: [] as Payload[], deferred: false }
  const interaction = {
    user: { id: "u1" }, customId, values, deferred: false, replied: false, message: {},
    client: { users: { fetch: async () => ({ send: async () => undefined }) } },
    update: async (payload: Payload) => { state.replies.push(payload); interaction.replied = true },
    deferUpdate: async () => { state.deferred = true; interaction.deferred = true },
    editReply: async (payload: Payload) => { state.replies.push(payload) },
    reply: async (payload: Payload) => { state.replies.push(payload); interaction.replied = true },
  }
  return { interaction, state }
}

function panelId(payload: Payload): string {
  const match = /opt:s:([a-z0-9]+)/.exec(JSON.stringify(payload))
  assert.ok(match, "panel id present")
  return match[1]!
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test("/opt 概览：单选菜单 + 刷新/关闭，不直接给下载", async t => {
  setWatcherInterval(600_000)
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-ui2-"))
  mockFetch(t, query([pkg(1, "SDGB_A041_20261020134418_0.opt", "https://maimai-haisin.wahlap.com/a.opt", 1024), pkg(2, "SDGB_A005_20260610180958_0.opt", "https://maimai-haisin.wahlap.com/b.opt", 2048)]))
  try {
    const { interaction, state } = commandFake()
    await handleOptCommand(interaction, cfg(dir))
    const payload = state.replies[0]!
    const text = JSON.stringify(payload)
    assert.ok(text.indexOf("SDGB_A005") < text.indexOf("SDGB_A041"), "A005 sorted before A041")
    assert.match(text, /opt:s:/)
    assert.match(text, new RegExp(msg("opt.button.refresh")))
    assert.match(text, new RegExp(msg("opt.button.close")))
    assert.doesNotMatch(text, /opt.button.download/)
    assert.equal(text.includes("/opt-files/"), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("选择一个已下载的包：详情给下载文件 URL 按钮", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-ui2-"))
  writeFileSync(path.join(dir, "SDGB_a.opt"), DATA)
  mockFetch(t, query([pkg(1, "SDGB_a.opt", "https://maimai-haisin.wahlap.com/a.opt", 1024), pkg(2, "SDGB_b.opt", "https://maimai-haisin.wahlap.com/b.opt", 2048)]))
  try {
    const { interaction, state } = commandFake()
    await handleOptCommand(interaction, cfg(dir))
    const id = panelId(state.replies[0]!)
    const select = componentFake(`opt:s:${id}`, ["1"])
    await handleOptSelect(select.interaction as unknown as StringSelectMenuInteraction, cfg(dir))
    const detail = JSON.stringify(select.state.replies[0])
    assert.match(detail, new RegExp(msg("opt.option.downloaded")))
    assert.match(detail, /"url":"https:\/\/kohad-bot\.frkovo\.uk\/opt-files\/SDGB_a\.opt\?exp=/)
    assert.match(detail, new RegExp(msg("opt.button.link")))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("选择未下载的包 → 下载 → 完成卡带下载按钮", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-ui2-"))
  const file = await fileServer()
  mockFetch(t, query([pkg(1, "SDGB_new.opt", file.url, DATA.length)]))
  try {
    const { interaction, state } = commandFake()
    await handleOptCommand(interaction, cfg(dir))
    const id = panelId(state.replies[0]!)
    const select = componentFake(`opt:s:${id}`, ["1"])
    await handleOptSelect(select.interaction as unknown as StringSelectMenuInteraction, cfg(dir))
    assert.match(JSON.stringify(select.state.replies[0]), new RegExp(msg("opt.button.download")))

    const download = componentFake(`opt:b:${id}:download`)
    await handleOptButton(download.interaction as unknown as ButtonInteraction, cfg(dir))
    for (let i = 0; i < 120 && !existsSync(path.join(dir, "SDGB_new.opt")); i++) await sleep(25)
    await sleep(150)
    assert.equal(statSync(path.join(dir, "SDGB_new.opt")).size, DATA.length)
    assert.equal(readFileSync(path.join(dir, "SDGB_new.opt")).toString(), DATA.toString())
    const last = JSON.stringify(download.state.replies.at(-1))
    assert.match(last, new RegExp(msg("opt.done.title")))
    assert.match(last, /"url":"https:\/\/kohad-bot\.frkovo\.uk\/opt-files\/SDGB_new\.opt\?exp=/)
  } finally { await file.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("大小未知时自动探测再展示详情", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-ui2-"))
  mockFetch(t, query([pkg(1, "SDGB_a.opt", "https://maimai-haisin.wahlap.com/a.opt", null)]))
  try {
    const { interaction, state } = commandFake()
    await handleOptCommand(interaction, cfg(dir))
    const id = panelId(state.replies[0]!)
    const select = componentFake(`opt:s:${id}`, ["1"])
    await handleOptSelect(select.interaction as unknown as StringSelectMenuInteraction, cfg(dir))
    assert.match(JSON.stringify(select.state.replies[0]), /555 B/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("过期 panel 给出重新执行提示", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-ui2-"))
  try {
    const fake = componentFake("opt:b:nope:download")
    await handleOptButton(fake.interaction as unknown as ButtonInteraction, cfg(dir))
    assert.match(String(fake.state.replies[0]!.content), /\/opt/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
