import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js"
import { classifyError, debugLogPath, failureText, safeFields, safeReason, safeRoute, Trace, DiagnosticFailure } from "../src/diagnostics.js"
import { t } from "../src/messages.js"
import { errorText } from "../src/util.js"
import { syncRemote } from "../src/multiserver/sync.js"
import { HttpStatusError, UserError, type ScoreRecord, type Snapshot } from "../src/multiserver/registry.js"
import { closeServerStore, serverStore } from "../src/multiserver/store.js"
import { regionCatalog } from "../src/multiserver/catalog.js"
import { handleRemoteB50, handleServerButton, handleServerCommand, handleServerModal, handleServerSelect } from "../src/multiserver/interactions.js"
import type { BotConfig } from "../src/config.js"
import { pullAccount } from "../src/migrate-client.js"
import { handleB50 } from "../src/handlers.js"
import { createQueue } from "../src/queue.js"
import { createLxnsBindingStore } from "../src/lxns/bindings.js"
import { fileURLToPath } from "node:url"

const cfg = { allowedUserIds: new Set<string>(), maxPendingReads: 9, pullConcurrency: 3 } as BotConfig
const record: ScoreRecord = { title: "Fixture", type: "DX", level: 3, achievement: 1005000, dxScore: 2900, fc: "app", fs: "fsdp", playCount: 17, ds: 14.8, version: 25, isNew: true }
const SECRET_PASSWORD = "synthetic-password-XYZ"
const SECRET_SID = "SECRETSIDVALUE123"
const SECRET_TOKEN = "SECRETTOKENVALUE456"

function fetchFailed(cause: unknown) {
  return Object.assign(new TypeError("fetch failed"), { cause })
}

function quietConsole(t: { mock: { method: (object: object, key: string, impl: () => void) => unknown } }) {
  for (const key of ["info", "warn", "error", "log"]) t.mock.method(console, key, () => {})
}

function scopedEnv(values: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  return () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

async function withStore(run: (logPath: string) => Promise<void>) {
  const folder = mkdtempSync(path.join(tmpdir(), "kohad-diag-"))
  const logPath = path.join(folder, "logs", "bot-debug.jsonl")
  const restore = scopedEnv({ LOCAL_SCORE_DB: path.join(folder, "scores.sqlite"), B50_AUTH_KEY: randomBytes(32).toString("base64"), B50_AUTH_KEY_FILE: undefined, B50_DEBUG_LOG: logPath })
  try { await run(logPath) } finally { closeServerStore(); restore(); rmSync(folder, { recursive: true, force: true }) }
}

function interaction(name: string, options: Record<string, string | boolean | null> = {}, user = "user-a") {
  const messages: any[] = []
  const value = {
    commandName: name, user: { id: user }, deferred: false, replied: false, ephemeral: null as boolean | null,
    options: { getString: (key: string) => typeof options[key] === "string" ? options[key] : null, getBoolean: (key: string) => typeof options[key] === "boolean" ? options[key] : null },
    reply: async (message: any) => { value.replied = true; value.ephemeral = message.flags === MessageFlags.Ephemeral; messages.push(message) },
    deferReply: async (message?: any) => { value.deferred = true; value.ephemeral = message?.flags === MessageFlags.Ephemeral },
    editReply: async (message: any) => { messages.push(message) },
    followUp: async (message: any) => { messages.push({ ...message, followUp: true }) },
    showModal: async () => {},
  }
  return { value, messages, command: value as unknown as ChatInputCommandInteraction }
}

function readLog(logPath: string): Record<string, unknown>[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

// Seed a bound JP account with one cached record so B50 can run a refresh path against fake network failures.
function seedBinding(fetchedAt = new Date().toISOString()) {
  const store = serverStore()
  const revision = store.bind("user-a", "jp", "account-a", "Fixture", { username: "fixture", password: SECRET_PASSWORD, cardIndex: 2 })
  const chart = [...regionCatalog("jp").index.values()].find(c => c.level === 3)!
  const cached: Snapshot = { accountKey: "account-a", profile: { name: "Fixture" }, records: [{ ...record, title: chart.title, type: chart.type, level: chart.level }], fetchedAt, source: "private_api", countsComplete: true }
  store.save("user-a", "jp", revision, cached)
}

const idIn = (text: string) => {
  const match = text.match(/B50-[0-9A-F]{8}/)
  assert.ok(match, `no correlation id in: ${text.slice(0, 200)}`)
  return match[0]
}

test("error.cause classification uses fixed allowlisted codes only", () => {
  const cases: [unknown, string, string | undefined][] = [
    [fetchFailed({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND maimaidx.jp" }), "dns", "ENOTFOUND"],
    [fetchFailed({ code: "EAI_AGAIN" }), "dns", "EAI_AGAIN"],
    [fetchFailed({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "tls", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    [fetchFailed({ code: "CERT_HAS_EXPIRED" }), "tls", "CERT_HAS_EXPIRED"],
    [Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }), "timeout", "TimeoutError"],
    [fetchFailed({ code: "UND_ERR_CONNECT_TIMEOUT" }), "timeout", "UND_ERR_CONNECT_TIMEOUT"],
    [fetchFailed({ code: "ECONNRESET" }), "connection", "ECONNRESET"],
    [fetchFailed({ code: "ECONNREFUSED" }), "connection", "ECONNREFUSED"],
    [{ code: "EACCES" }, "storage", "EACCES"],
    [{ code: 10062 }, "discord", "10062"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "cancelled", "AbortError"],
    [fetchFailed(undefined), "network", undefined],
    [new TypeError("fetch failed"), "network", undefined],
    [new UserError(t("net.credentialsMissing")), "validation", undefined],
    [new Error("token=SECRET-DO-NOT-LEAK"), "internal", undefined],
  ]
  for (const [error, category, code] of cases) {
    const classified = classifyError(error)
    assert.equal(classified.category, category)
    assert.equal(classified.code, code)
  }
  assert.equal(classifyError(fetchFailed({ code: "SOME_UNLISTED_CODE" })).code, undefined)
})

test("classification walks a bounded cause chain and never returns unlisted messages", () => {
  const nested = fetchFailed({ cause: { cause: { code: "EPIPE" } } })
  assert.deepEqual(classifyError(nested), { category: "connection", code: "EPIPE" })
  const cyclic: { cause?: unknown } = {}
  cyclic.cause = cyclic
  assert.equal(classifyError(cyclic).category, "internal")
})

test("user-facing reasons are first-party and never echo raw error text", () => {
  const raw = new Error(`https://maimaidx.jp/x?sid=${SECRET_SID}&token=${SECRET_TOKEN}`)
  assert.equal(safeReason(raw), t("diagnostic.reason.internal"))
  const failure = new Trace("b50", "jp").fail(raw)
  assert.equal(failure.reason, t("diagnostic.reason.internal"))
  const text = failureText(failure)
  assert.equal(text.includes(SECRET_SID), false)
  assert.equal(text.includes(SECRET_TOKEN), false)
  assert.equal(safeReason(new UserError(t("net.credentialsMissing"))), t("net.credentialsMissing"))
})

test("HTTP status drives the http category and a validation UserError keeps its first-party text", () => {
  const httpFailure = new Trace("b50", "jp").fail(new Error("raw body"), { status: 503 })
  assert.equal(httpFailure.category, "http")
  assert.equal(httpFailure.status, 503)
  const userFailure = new Trace("b50", "jp").fail(new UserError(t("net.redirectBlocked")))
  assert.equal(userFailure.category, "validation")
  assert.equal(userFailure.reason, t("net.redirectBlocked"))
})

test("safe route logging exposes only fixed route names and allowlisted hosts", () => {
  assert.deepEqual(safeRoute(new URL(`https://maimaidx.jp/maimai-mobile/submit/?sid=${SECRET_SID}&token=${SECRET_TOKEN}`)), { host: "maimaidx.jp", route: "login-submit" })
  assert.deepEqual(safeRoute(new URL(`https://evil.example/path?sid=${SECRET_SID}`)), { host: "blocked", route: "blocked" })
  assert.deepEqual(safeRoute(new URL("https://maimaidx.jp/unknown/path?x=1")), { host: "maimaidx.jp", route: "net-other" })
})

test("debug log path honours off, explicit override and default test isolation", () => {
  const restore = scopedEnv({ B50_DEBUG_LOG: "off", NODE_TEST_CONTEXT: undefined, LOCAL_SCORE_DB: undefined })
  try {
    assert.equal(debugLogPath(), undefined)
    process.env.B50_DEBUG_LOG = path.join(tmpdir(), "override-bot-debug.jsonl")
    assert.equal(debugLogPath(), path.resolve(process.env.B50_DEBUG_LOG))
    delete process.env.B50_DEBUG_LOG
    assert.equal(debugLogPath(), fileURLToPath(new URL("../.data/logs/bot-debug.jsonl", import.meta.url)))
    process.env.LOCAL_SCORE_DB = path.join("data-root", "scores.sqlite")
    assert.equal(debugLogPath(), path.resolve("data-root", "logs", "bot-debug.jsonl"))
    process.env.NODE_TEST_CONTEXT = "child"
    assert.equal(debugLogPath(), undefined)
  } finally { restore() }
})

test("shared correlation id appears in console output, bounded log and private reply", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    const trace = new Trace("b50", "jp")
    trace.step("records.fetch", { level: 2 })
    trace.note("http-response", { host: "maimaidx.jp", route: "music-records", status: 200, bytes: 12, cookiesReceived: 1, cookiesSent: 0 })
    const failure = trace.fail(fetchFailed({ code: "ECONNRESET" }), { host: "maimaidx.jp", route: "music-records" })
    const text = failureText(failure)
    assert.ok(text.includes(`\`${trace.id}\``))
    const lines = readLog(logPath)
    assert.ok(lines.length >= 4)
    assert.ok(lines.every(line => line.id === trace.id))
    const failed = lines.find(line => line.event === "failed")!
    assert.equal(failed.category, "connection")
    assert.equal(failed.code, "ECONNRESET")
    assert.equal(failed.stage, "records.fetch")
    assert.equal(lines.find(line => line.event === "http-response")?.cookiesReceived, 1)
    assert.match(text, /连接失败或被中断/)
    assert.match(text, /ECONNRESET/)
  })
})

test("bounded log rotates to one backup once the 5 MB limit is reached", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    const limit = 5 * 1024 * 1024
    mkdirSync(path.dirname(logPath), { recursive: true })
    writeFileSync(logPath, Buffer.alloc(limit, "a"))
    new Trace("runtime").note("start")
    assert.equal(statSync(`${logPath}.1`).size, limit)
    assert.ok(statSync(logPath).size < 2048)
  })
})

test("redirected query strings and credentials never reach logs or private replies", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    seedBinding()
    ctx.mock.method(globalThis, "fetch", async () => new Response("", {
      status: 302,
      headers: { location: `https://evil.example/cb?sid=${SECRET_SID}&token=${SECRET_TOKEN}` },
    }))
    const query = interaction("b50", { server: "jp", refresh: true, public: true })
    await handleRemoteB50(query.command, cfg, "jp")
    const replies = JSON.stringify(query.messages)
    const logs = readFileSync(logPath, "utf8")
    for (const secret of [SECRET_SID, SECRET_TOKEN, SECRET_PASSWORD, "evil.example"]) {
      assert.equal(replies.includes(secret), false, `reply leaked ${secret}`)
      assert.equal(logs.includes(secret), false, `log leaked ${secret}`)
    }
    assert.match(query.messages[1].content, /跳转地址/)
  })
})

test("DNS, TLS and timeout failures after a public B50 ACK are private, classified and logged with one id", async ctx => {
  quietConsole(ctx)
  const scenarios: [string, unknown, RegExp, string][] = [
    ["dns", fetchFailed({ code: "ENOTFOUND" }), /无法解析目标服务器域名/, "ENOTFOUND"],
    ["tls", fetchFailed({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), /TLS 证书验证失败/, "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" }), /请求超时/, "TimeoutError"],
  ]
  for (const [category, error, reason, code] of scenarios) {
    await withStore(async logPath => {
      seedBinding()
      ctx.mock.method(globalThis, "fetch", async () => { throw error })
      const query = interaction("b50", { server: "jp", refresh: true, public: true })
      await handleRemoteB50(query.command, cfg, "jp")
      assert.equal(query.value.ephemeral, false)
      assert.match(query.messages[0].content, /具体原因已私密发送/)
      const id = idIn(query.messages[0].content)
      assert.equal(query.messages[1].followUp, true)
      assert.equal(query.messages[1].flags, MessageFlags.Ephemeral)
      assert.equal(idIn(query.messages[1].content), id)
      assert.match(query.messages[1].content, reason)
      assert.match(query.messages[1].content, new RegExp(`错误类别：\`${category}\``))
      assert.match(query.messages[1].content, new RegExp(code))
      const failed = readLog(logPath).find(line => line.event === "failed")!
      assert.equal(failed.id, id)
      assert.equal(failed.category, category)
      assert.equal(failed.code, code)
      assert.ok(["card.select", "auth.form", "auth.submit"].includes(String(failed.stage)), `unexpected pre-records stage ${String(failed.stage)}`)
      assert.equal(readLog(logPath).some(line => line.event === "relogin"), false, "network/TLS errors must not trigger a relogin")
    })
    ctx.mock.restoreAll()
    quietConsole(ctx)
  }
})

test("a stale local snapshot is served without contacting NET; only an explicit refresh reaches NET and hides its error body", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    seedBinding("2000-01-01T00:00:00.000Z")
    const hosts: string[] = []
    ctx.mock.method(globalThis, "fetch", async (input: unknown) => {
      const host = new URL(String(input)).hostname
      hosts.push(host)
      if (host === "maimaidx.jp") return new Response("synthetic-sensitive-response", { status: 503 })
      throw new Error("artwork offline fixture")
    })
    const cached = interaction("b50", { server: "jp" })
    await handleRemoteB50(cached.command, cfg, "jp")
    assert.equal(hosts.includes("maimaidx.jp"), false)
    assert.equal(cached.messages[0].embeds[0].toJSON().description?.includes("使用上次成功缓存"), false)

    const refreshed = interaction("b50", { server: "jp", refresh: true })
    await handleRemoteB50(refreshed.command, cfg, "jp")
    assert.equal(hosts.includes("maimaidx.jp"), true)
    assert.equal(JSON.stringify(refreshed.messages).includes("synthetic-sensitive-response"), false)
    assert.equal(readFileSync(logPath, "utf8").includes("synthetic-sensitive-response"), false)
  })
})

test("first sync after a successful bind keeps credentials, replies privately with the failure id and logs the stage", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    const pages = jpPages()
    ctx.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.includes("musicGenre")) return new Response("synthetic-sensitive-response", { status: 503 })
      return pages(url, init)
    })
    const bind = interaction("bind", { server: "jp" })
    await handleServerCommand(bind.command, cfg)
    const form = interaction("")
    Object.assign(form.value, { customId: "ms:credentials:jp", fields: { getTextInputValue: (key: string) => ({ username: "fixture", password: SECRET_PASSWORD } as Record<string, string>)[key] } })
    await handleServerModal(form.value as unknown as ModalSubmitInteraction, cfg)
    const selectId = form.messages[0].components[0].toJSON().components[0].custom_id
    const select = interaction("")
    Object.assign(select.value, { customId: selectId, values: ["2"] })
    await handleServerSelect(select.value as unknown as StringSelectMenuInteraction, cfg)
    const confirmId = select.messages[0].components[0].toJSON().components[0].custom_id
    const confirm = interaction("")
    Object.assign(confirm.value, { customId: confirmId })
    await handleServerButton(confirm.value as unknown as ButtonInteraction, cfg)
    assert.ok(serverStore().credentials("user-a", "jp"), "credentials must be saved before the first sync")
    const last = confirm.messages.at(-1).content as string
    assert.match(last, /首次同步失败/)
    const id = idIn(last)
    assert.match(last, /NET 暂时无法访问（HTTP 503）/)
    const failed = readLog(logPath).find(line => line.event === "failed" && line.id === id)!
    assert.equal(failed.stage, "records.fetch")
    assert.equal(JSON.stringify(confirm.messages).includes("synthetic-sensitive-response"), false)
    assert.equal(readFileSync(logPath, "utf8").includes(SECRET_PASSWORD), false)
  })
})

test("failure ids are unique per trace and reasons reference only fixed stage names", () => {
  const first = new Trace("sync", "cn")
  const second = new Trace("sync", "cn")
  assert.notEqual(first.id, second.id)
  assert.match(first.id, /^B50-[0-9A-F]{8}$/)
  const failure = first.fail(new UserError(t("sync.unbound")))
  assert.ok(failure instanceof DiagnosticFailure)
  assert.equal(failure.stage, "interaction")
})

test("malicious codes, names and causes are never echoed: only allowlisted codes or fixed TimeoutError leave classification", () => {
  assert.deepEqual(classifyError({ name: "TimeoutError", code: `sid=${SECRET_SID}` }), { category: "timeout", code: "TimeoutError" })
  assert.deepEqual(classifyError({ code: "ETIMEDOUT", name: `Secret ${SECRET_TOKEN}` }), { category: "timeout", code: "ETIMEDOUT" })
  assert.deepEqual(classifyError(fetchFailed({ code: `ECONNRESET ${SECRET_TOKEN}` })), { category: "network" })
  assert.deepEqual(classifyError(Object.assign(new Error("x"), { name: `Error ${SECRET_SID}` })), { category: "internal" })
  assert.deepEqual(classifyError(Object.assign(new Error("x"), { name: "AbortError", code: `token=${SECRET_TOKEN}` })), { category: "cancelled", code: "AbortError" })
  assert.deepEqual(classifyError(fetchFailed({ code: "UNKNOWN_SECRET_CODE" })), { category: "network" })
})

test("HTTP status failures keep the numeric status and category, never the response body, and are not session errors", () => {
  const failure = new Trace("b50", "jp").fail(new HttpStatusError(503))
  assert.equal(failure.category, "http")
  assert.equal(failure.status, 503)
  assert.equal(failure.reason, t("net.httpStatus", { status: 503 }))
  assert.equal(classifyError(new HttpStatusError(429)).category, "http")
  assert.ok(new HttpStatusError(500) instanceof UserError)
})

test("log fields are allowlisted: injected strings, non-finite numbers and unknown keys never reach the log", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    const trace = new Trace("b50", "jp")
    trace.note("records", { difficulty: "basic\nSECRET-INJECT", level: Number.NaN, records: 3, unknownField: SECRET_SID } as never)
    const line = readLog(logPath).find(entry => entry.event === "records")!
    assert.equal("difficulty" in line, false)
    assert.equal("level" in line, false)
    assert.equal(line.records, 3)
    assert.equal("unknownField" in line, false)
    assert.deepEqual(safeFields({ difficulty: "expert", code: "ECONNRESET", status: 204 }), { difficulty: "expert", code: "ECONNRESET", status: 204 })
    // Identifier-shaped secrets pass a token regexp, but must not pass an enum allowlist.
    trace.note("http-error", { host: SECRET_SID, route: SECRET_TOKEN, method: SECRET_PASSWORD, code: SECRET_SID,
      category: SECRET_TOKEN, difficulty: SECRET_SID, status: "503", elapsedMs: -1, level: true, records: 1.5, maintenance: "true" } as never)
    const rejected = readLog(logPath).find(entry => entry.event === "http-error")!
    for (const key of ["host", "route", "method", "code", "category", "difficulty", "status", "elapsedMs", "level", "records", "maintenance"]) assert.equal(key in rejected, false, key)
    assert.deepEqual(safeFields({ host: "maimaidx.jp", route: "login-page", method: "GET", category: "tls", code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", maintenance: false, level: 3 }),
      { host: "maimaidx.jp", route: "login-page", method: "GET", level: 3, maintenance: false, code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", category: "tls" })
    assert.equal(readFileSync(logPath, "utf8").includes(SECRET_SID), false)
  })
})

test("migration service failure text is never echoed; the status and stage still explain the failure", () => {
  const text = errorText({ ok: false, status: 500, stage: "pull", error: `upstream said sid=${SECRET_SID}` })
  assert.equal(text.includes(SECRET_SID), false)
  assert.match(text, /HTTP 500/)
  assert.match(text, /stage=pull/)
})

test("CN migration transport and malformed HTTP failures share a private reply id with safe logs", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    const config = { migrateUrl: `https://fixture.invalid/private/${SECRET_SID}?token=${SECRET_TOKEN}`, migrateApiKey: SECRET_PASSWORD, callTimeoutMs: 1000 }
    ctx.mock.method(globalThis, "fetch", async () => { throw fetchFailed({ code: "ENOTFOUND", message: SECRET_PASSWORD }) })
    const result = await pullAccount(SECRET_TOKEN, config)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error("expected migration failure")
    const text = errorText(result)
    assert.ok(result.diagnostic)
    assert.equal(result.diagnostic.stage, "import")
    assert.equal(result.diagnostic.category, "dns")
    assert.equal(idIn(text), result.diagnostic.id)
    assert.ok(readLog(logPath).some(line => line.id === result.diagnostic!.id && line.event === "failed" && line.code === "ENOTFOUND"))
    ctx.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error: SECRET_PASSWORD, stage: SECRET_SID }, { status: 503 }))
    const bad = await pullAccount(SECRET_TOKEN, config)
    assert.equal(bad.ok, false)
    if (bad.ok) throw new Error("expected migration failure")
    assert.equal(bad.stage, undefined)
    assert.equal(bad.diagnostic?.category, "http")
    assert.match(errorText(bad), /HTTP.*503/)
    for (const secret of [SECRET_SID, SECRET_TOKEN, SECRET_PASSWORD]) {
      assert.equal((text + result.error + errorText(bad) + readFileSync(logPath, "utf8")).includes(secret), false)
    }
  })
})

test("B50 without public:true defers ephemerally, so a failure is never posted to the channel", async ctx => {
  quietConsole(ctx)
  await withStore(async () => {
    seedBinding()
    ctx.mock.method(globalThis, "fetch", async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }) })
    const query = interaction("b50", { server: "jp", refresh: true })
    await handleRemoteB50(query.command, cfg, "jp")
    assert.equal(query.value.ephemeral, true)
    assert.equal(query.messages.length, 1)
    assert.match(query.messages[0].content, /请求超时/)
  })
})

test("a CN B50 QR failure after a public ACK sends diagnostics privately and logs the same id", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    ctx.mock.method(globalThis, "fetch", async () => { throw fetchFailed({ code: "ECONNREFUSED", message: SECRET_PASSWORD }) })
    const query = interaction("b50", { server: "cn", public: true, sgwcmaid: "SGWCMAID" + "123456789012" + "A".repeat(64) })
    await handleB50(query.command, { ...cfg, migrateUrl: "https://migrate.fixture", migrateApiKey: SECRET_PASSWORD, callTimeoutMs: 1000 } as BotConfig, createQueue(3), new Map())
    const privateReply = query.messages.find(message => message.followUp && message.flags === MessageFlags.Ephemeral)
    assert.ok(privateReply)
    assert.match(privateReply.content, /ECONNREFUSED/)
    const id = idIn(privateReply.content)
    assert.ok(query.messages.some(message => !message.followUp && message.content === t("diagnostic.public", { id })))
    assert.ok(readLog(logPath).some(line => line.id === id && line.event === "failed" && line.stage === "import" && line.code === "ECONNREFUSED"))
    assert.equal(JSON.stringify(query.messages).includes(SECRET_PASSWORD), false)
  })
})

test("a malformed legacy binding file logs its stage without echoing the JSON parser's credential snippet", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    const bindingFile = path.join(path.dirname(logPath), "malformed-fixture.json")
    mkdirSync(path.dirname(bindingFile), { recursive: true })
    writeFileSync(bindingFile, `{ "refreshToken": "${SECRET_TOKEN}", bad-json`)
    assert.equal(createLxnsBindingStore(bindingFile).get("fixture-user"), null)
    const failed = readLog(logPath).find(line => line.event === "failed")!
    assert.equal(failed.stage, "binding.read")
    assert.equal(failed.category, "internal")
    assert.equal(readFileSync(logPath, "utf8").includes(SECRET_TOKEN), false)
  })
})

test("a shared sync job reports ONE failure: every caller gets the job's id and stage, logged once", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    seedBinding("2000-01-01T00:00:00.000Z")
    const fixture = jpPages()
    ctx.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.includes("musicGenre")) return new Response("synthetic-sensitive-response", { status: 503 })
      return fixture(url, init)
    })
    const first = new Trace("sync", "jp")
    const second = new Trace("sync", "jp")
    const [a, b] = await Promise.allSettled([syncRemote("user-a", "jp", undefined, first), syncRemote("user-a", "jp", undefined, second)])
    assert.equal(a.status, "rejected")
    assert.equal(b.status, "rejected")
    const failureA = a.reason as DiagnosticFailure, failureB = b.reason as DiagnosticFailure
    assert.ok(failureA instanceof DiagnosticFailure && failureB instanceof DiagnosticFailure)
    assert.equal(failureB.id, failureA.id)
    assert.equal(failureB.stage, "records.fetch")
    assert.equal(failureB.status, 503)
    assert.equal(failureB.category, "http")
    assert.equal(readLog(logPath).filter(line => line.event === "failed" && line.id === failureA.id).length, 1)
    assert.equal(readLog(logPath).some(line => line.id === second.id && line.event === "failed"), false, "the second caller must not log its own failure")
    assert.equal(readFileSync(logPath, "utf8").includes("synthetic-sensitive-response"), false)
  })
})

test("an HTTP 503 on the card page is surfaced without a second login attempt", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    seedBinding()
    let calls = 0
    ctx.mock.method(globalThis, "fetch", async () => { calls++; return new Response("synthetic-sensitive-response", { status: 503 }) })
    await assert.rejects(syncRemote("user-a", "jp", undefined, new Trace("sync", "jp")), (error: unknown) => {
      assert.ok(error instanceof DiagnosticFailure)
      assert.equal(error.category, "http")
      assert.equal(error.status, 503)
      return true
    })
    assert.equal(calls, 1, "a 503 must not trigger a login retry")
    assert.equal(readLog(logPath).some(line => line.event === "relogin"), false)
  })
})

test("credential precheck failures are logged once at credentials.read", async ctx => {
  quietConsole(ctx)
  await withStore(async logPath => {
    const store = serverStore()
    store.bind("user-a", "jp", "account-a", "Fixture", { username: "fixture", password: SECRET_PASSWORD, cardIndex: 2 })
    const trace = new Trace("sync", "jp")
    ctx.mock.method(store, "credentials", () => { throw new UserError(t("store.decryptFailed")) })
    await assert.rejects(syncRemote("user-a", "jp", undefined, trace), (error: unknown) => error instanceof DiagnosticFailure && error.stage === "credentials.read")
    const failed = readLog(logPath).find(line => line.event === "failed" && line.id === trace.id)!
    assert.equal(failed.stage, "credentials.read")
    assert.equal(failed.category, "validation")
  })
})

function jpPages() {
  const diffNames = ["basic", "advanced", "expert", "master", "remaster"]
  const musicPage = (level: number) => '<form><input name="genre"></form><div class="w_450 m_15 p_r f_0"><div class="music_name_block">Fixture &amp; Song</div><div class="music_score_block w_112">100.5000%</div><div class="music_score_block w_190">2,900 / 3,000</div><img class="music_kind_icon" src="/img/music_dx.png"><img class="h_20 f_l" src="/img/diff_' + diffNames[level] + '.png"><img src="/img/applus.png"><img src="/img/fsdplus.png"></div>'
  const cardsPage = '<a href="/maimai-mobile/aimeList/submit/?idx=0">card</a><form action="/maimai-mobile/aimeList/submit/"><input name="idx" value="2"></form>'
  const homePage = '<div class="name_block">Player A</div><div class="rating_block">15,200</div>'
  let authenticated = false
  return async (url: URL, _init?: RequestInit) => {
    if (url.pathname.endsWith("/submit/") && !url.pathname.includes("aimeList")) {
      authenticated = true
      return new Response("", { status: 302, headers: { location: "/maimai-mobile/aimeList/", "Set-Cookie": "jpSession=fixture-session; Secure; HttpOnly; Path=/maimai-mobile/" } })
    }
    if (!authenticated) return new Response('<form><input name="token" value="fixture-csrf"><input name="password"></form>')
    if (url.pathname.endsWith("/aimeList/")) return new Response(cardsPage)
    if (url.pathname.includes("musicGenre/search")) return new Response(musicPage(Number(url.searchParams.get("diff"))))
    return new Response(homePage)
  }
}
