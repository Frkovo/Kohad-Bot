import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import type { BotConfig } from "../src/config.js"
import { linkFor, linkLines, listDownloaded, resetLinkSecretForTests, signName, verifyLink } from "../src/opt/links.js"

function cfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    optUpdateDir: mkdtempSync(path.join(tmpdir(), "sdgb-links-")),
    optPublicBase: "https://kohad-bot.frkovo.uk",
    optLinkTtlMs: 60_000,
    optLinkSecret: "test-secret",
    ...overrides,
  } as BotConfig
}

test("签名链接：可验证、改名/改期/改签名都失效、过期失效", () => {
  resetLinkSecretForTests()
  const config = cfg()
  try {
    const link = new URL(linkFor(config, "SDGB_A005_0.opt"))
    const name = decodeURIComponent(link.pathname.split("/").pop()!)
    assert.equal(link.origin + link.pathname, "https://kohad-bot.frkovo.uk/opt-files/SDGB_A005_0.opt")
    const exp = link.searchParams.get("exp")!
    const sig = link.searchParams.get("sig")!
    assert.equal(verifyLink(name, exp, sig, Buffer.from("test-secret")), true)
    assert.equal(verifyLink("SDGB_A006_0.opt", exp, sig, Buffer.from("test-secret")), false)
    assert.equal(verifyLink(name, String(Number(exp) + 1), sig, Buffer.from("test-secret")), false)
    assert.equal(verifyLink(name, exp, sig.slice(0, -1) + "A", Buffer.from("test-secret")), false)
    assert.equal(verifyLink(name, exp, sig, Buffer.from("test-secret"), Number(exp) * 1000 + 1), false)
    assert.equal(verifyLink(name, "0", signName(name, 0, Buffer.from("test-secret")), Buffer.from("test-secret")), true)
    assert.equal(verifyLink(name, "abc", sig, Buffer.from("test-secret")), false)
    assert.equal(verifyLink(name, exp, null, Buffer.from("test-secret")), false)
  } finally { rmSync(config.optUpdateDir, { recursive: true, force: true }) }
})

test("过期时间为 0 时生成永久链接；文件清单排除 .part 与不安全名称", () => {
  resetLinkSecretForTests()
  const config = cfg({ optLinkTtlMs: 0 })
  try {
    writeFileSync(path.join(config.optUpdateDir, "a.opt"), "a")
    writeFileSync(path.join(config.optUpdateDir, "b.opt.part"), "b")
    writeFileSync(path.join(config.optUpdateDir, "bad name.opt"), "c")
    const link = new URL(linkFor(config, "a.opt"))
    assert.equal(link.searchParams.get("exp"), "0")
    assert.deepEqual(listDownloaded(config).map(file => file.name), ["a.opt"])
    const lines = linkLines(config, listDownloaded(config))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /\/opt-files\/a\.opt\?exp=0&sig=/)
  } finally { rmSync(config.optUpdateDir, { recursive: true, force: true }) }
})
