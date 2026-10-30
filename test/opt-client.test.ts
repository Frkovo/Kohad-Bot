import assert from "node:assert/strict"
import test from "node:test"

import type { BotConfig } from "../src/config.js"
import { isOptFailure, parseOpt, probeOpt, queryOpt, rangeUrl, sweepOpt } from "../src/opt/client.js"

const cfg = { migrateUrl: "https://migrate.test", migrateApiKey: "secret-key", callTimeoutMs: 5000 } as BotConfig

type Seen = { url: string; init?: RequestInit }

test("queryOpt 发送 x-api-key 与 titleVer，并解析包清单", async t => {
  const seen: Seen[] = []
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return Response.json({
      ok: true, format: "sdgb-opt-v1", queriedAt: "2026-10-29T00:00:00.000Z", titleVer: "1.56", clientIdMasked: "A63E*******",
      dli: { host: "http://at.sys-allnet.cn", result: "1" },
      instructions: [{ role: "option", url: "https://x/opt.ini", status: 200, name: "opt.ini", common: { PART_SIZE: "8192" } }],
      packages: [{ index: 1, kind: "opt", role: "option", section: "COMMON", key: "INSTALL1", name: "a.opt", url: "https://x/a.opt", size: 10, note: "", transfer: { partSizes: [1, 2, 3], intervals: { isdn: null, dsl: null, bb: null } } }],
    })
  })
  const result = await queryOpt(cfg, { titleVer: "1.56" })
  assert.equal(isOptFailure(result), false)
  if (isOptFailure(result)) return
  assert.equal(result.packages[0]!.name, "a.opt")
  assert.equal(seen[0]!.url, "https://migrate.test/api/opt/query")
  assert.equal((seen[0]!.init?.headers as Record<string, string>)["x-api-key"], "secret-key")
  assert.equal((seen[0]!.init?.headers as Record<string, string>)["content-type"], "application/json")
  assert.equal(seen[0]!.init?.method, "POST")
  assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), { titleVer: "1.56" })
})

test("失败归一：鉴权、非 JSON、传输错误", async t => {
  let mode: "auth" | "non-json" | "offline" = "auth"
  t.mock.method(globalThis, "fetch", async () => {
    if (mode === "auth") return Response.json({ ok: false, stage: "auth", error: "x-api-key 校验失败" }, { status: 401 })
    if (mode === "non-json") return new Response("oops", { status: 502 })
    throw Object.assign(new Error("connect"), { code: "ECONNREFUSED" })
  })

  const unauthorized = await queryOpt(cfg)
  assert.equal(isOptFailure(unauthorized), true)
  if (isOptFailure(unauthorized)) {
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.stage, "auth")
    assert.match(unauthorized.detail!, /x-api-key/)
  }

  mode = "non-json"
  const nonJson = await queryOpt(cfg)
  assert.equal(isOptFailure(nonJson), true)
  if (isOptFailure(nonJson)) { assert.equal(nonJson.status, 502); assert.equal(nonJson.detail, undefined) }

  mode = "offline"
  const offline = await queryOpt(cfg)
  assert.equal(isOptFailure(offline), true)
  if (isOptFailure(offline)) { assert.equal(offline.status, 0); assert.equal(offline.detail, "ECONNREFUSED") }
})

test("parse/probe/sweep 转发对应 body", async t => {
  const bodies: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ ok: true })
  })
  await parseOpt(cfg, "[COMMON]\nINSTALL1=https://x/a.opt\n")
  await probeOpt(cfg, ["https://x/a.opt"])
  await sweepOpt(cfg, "1.56.00-1.56.02")
  assert.deepEqual(bodies[0], { text: "[COMMON]\nINSTALL1=https://x/a.opt\n" })
  assert.deepEqual(bodies[1], { urls: ["https://x/a.opt"] })
  assert.deepEqual(bodies[2], { spec: "1.56.00-1.56.02" })
})

test("rangeUrl 对直链编码，避免查询串拆分", () => {
  const url = "https://maimai-haisin.wahlap.com/download/chn/155/option/a.opt?x=1&y=2"
  const proxied = rangeUrl(cfg, url)
  assert.ok(proxied.startsWith("https://migrate.test/api/opt/range?url="))
  assert.equal(new URL(proxied).searchParams.get("url"), url)
})
