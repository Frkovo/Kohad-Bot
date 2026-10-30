import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import type { BotConfig } from "../src/config.js"
import { createOAuthServer } from "../src/oauth-callback.js"
import { linkFor, resetLinkSecretForTests, signName } from "../src/opt/links.js"

const DATA = Buffer.alloc(2048, 7)

async function start(cfg: BotConfig) {
  const server = createOAuthServer(cfg)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function cfg(dir: string): BotConfig {
  return {
    optUpdateDir: dir, optPublicBase: "https://kohad-bot.frkovo.uk", optLinkTtlMs: 60_000, optLinkSecret: "file-secret",
    oauthHost: "127.0.0.1", oauthPort: 0,
  } as BotConfig
}

test("/opt-files：签名下载、HEAD、Range 与错误码", async () => {
  resetLinkSecretForTests()
  const dir = mkdtempSync(path.join(tmpdir(), "sdgb-files-"))
  writeFileSync(path.join(dir, "SDGB_test.opt"), DATA)
  writeFileSync(path.join(dir, "SDGB_test.opt.part"), DATA.subarray(0, 10))
  const config = cfg(dir)
  const { base, close } = await start(config)
  try {
    const link = new URL(linkFor(config, "SDGB_test.opt"))
    const pathAndQuery = link.pathname + link.search

    const full = await fetch(base + pathAndQuery)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get("content-length"), String(DATA.length))
    assert.equal(full.headers.get("accept-ranges"), "bytes")
    assert.equal(Buffer.from(await full.arrayBuffer()).length, DATA.length)

    const head = await fetch(base + pathAndQuery, { method: "HEAD" })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get("content-length"), String(DATA.length))

    const range = await fetch(base + pathAndQuery, { headers: { range: "bytes=10-19" } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get("content-range"), `bytes 10-19/${DATA.length}`)
    assert.equal((await range.arrayBuffer()).byteLength, 10)

    const suffix = await fetch(base + pathAndQuery, { headers: { range: "bytes=-8" } })
    assert.equal(suffix.status, 206)
    assert.equal((await suffix.arrayBuffer()).byteLength, 8)

    const invalidRange = await fetch(base + pathAndQuery, { headers: { range: "bytes=99999-" } })
    assert.equal(invalidRange.status, 416)

    const unsigned = await fetch(base + `/opt-files/SDGB_test.opt`)
    assert.equal(unsigned.status, 403)
    const tampered = await fetch(base + pathAndQuery.replace("sig=", "sig=x"))
    assert.equal(tampered.status, 403)

    const expired = Math.floor(Date.now() / 1000) - 5
    const expiredSig = signName("SDGB_test.opt", expired, Buffer.from("file-secret"))
    const expiredRes = await fetch(base + `/opt-files/SDGB_test.opt?exp=${expired}&sig=${expiredSig}`)
    assert.equal(expiredRes.status, 403)

    const missingLink = new URL(linkFor(config, "SDGB_missing.opt"))
    const missing = await fetch(base + missingLink.pathname + missingLink.search)
    assert.equal(missing.status, 404)

    const partLink = new URL(linkFor(config, "SDGB_test.opt.part"))
    const part = await fetch(base + partLink.pathname + partLink.search)
    assert.equal(part.status, 404)

    const traversal = await fetch(base + `/opt-files/..%2Fetc%2Fpasswd?exp=0&sig=${"A".repeat(43)}`)
    assert.equal(traversal.status, 404)

    const health = await fetch(base + "/healthz")
    assert.equal(health.status, 200)
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})
