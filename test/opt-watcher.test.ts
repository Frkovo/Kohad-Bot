import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import type { BotConfig } from "../src/config.js"
import type { OptPackage } from "../src/opt/client.js"
import { resetSeenForTests } from "../src/opt/seen.js"
import { findNewPackages, pollOnce } from "../src/opt/watcher.js"

function pkg(name: string, kind: OptPackage["kind"] = "opt"): OptPackage {
  return {
    index: 1, kind, role: "option", section: "COMMON", key: "INSTALL1", name,
    url: `https://maimai-haisin.wahlap.com/${name}`, size: null, note: "",
    transfer: { partSizes: [8192, 8192, 8192], intervals: { isdn: [1], dsl: [1], bb: [1] } },
  }
}

function cfg(dir: string): BotConfig {
  return {
    optUpdateDir: dir, optTitleVer: "1.56", migrateUrl: "https://migrate.test", migrateApiKey: "k", callTimeoutMs: 5000,
  } as BotConfig
}

function tempData(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-data-"))
  process.env.B50_DATA_DIR = dir
  resetSeenForTests()
  return dir
}

test("findNewPackages 只挑磁盘上没有的 .opt", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-watch-"))
  try {
    writeFileSync(path.join(dir, "exists.opt"), "x")
    const found = findNewPackages(cfg(dir), [pkg("exists.opt"), pkg("new.opt"), pkg("app.app", "app")])
    assert.deepEqual(found.map(item => item.name), ["new.opt"])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("轮询只通知新包、不下载；通知成功后不重复打扰", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-watch-"))
  const data = tempData()
  writeFileSync(path.join(dir, "exists.opt"), "x")
  t.mock.method(globalThis, "fetch", async () => Response.json({
    ok: true, format: "sdgb-opt-v1", queriedAt: new Date().toISOString(), titleVer: "1.56", clientIdMasked: "A63E*******",
    dli: { host: "http://at.sys-allnet.cn", result: "1" }, instructions: [],
    packages: [pkg("exists.opt"), pkg("new.opt"), pkg("app.app", "app")],
  }))
  const messages: string[] = []
  const notify = async (text: string) => { messages.push(text); return true }
  try {
    const first = await pollOnce(cfg(dir), notify)
    assert.deepEqual(first, { packages: 3, added: 1 })
    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /new\.opt/)
    assert.equal(existsSync(path.join(dir, "new.opt")), false)
    const second = await pollOnce(cfg(dir), notify)
    assert.deepEqual(second, { packages: 3, added: 0 })
    assert.equal(messages.length, 1)
  } finally {
    delete process.env.B50_DATA_DIR
    resetSeenForTests()
    rmSync(dir, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
})

test("私信失败不记为已通知，下一轮会重试", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-watch-"))
  const data = tempData()
  t.mock.method(globalThis, "fetch", async () => Response.json({
    ok: true, format: "sdgb-opt-v1", queriedAt: new Date().toISOString(), titleVer: "1.56", clientIdMasked: "A63E*******",
    dli: { host: "http://at.sys-allnet.cn", result: "1" }, instructions: [], packages: [pkg("new.opt")],
  }))
  let calls = 0
  const notify = async () => { calls++; return false }
  try {
    assert.deepEqual(await pollOnce(cfg(dir), notify), { packages: 1, added: 0 })
    assert.deepEqual(await pollOnce(cfg(dir), notify), { packages: 1, added: 0 })
    assert.equal(calls, 2)
  } finally {
    delete process.env.B50_DATA_DIR
    resetSeenForTests()
    rmSync(dir, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
})
