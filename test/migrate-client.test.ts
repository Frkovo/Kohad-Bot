import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { pullAccount, type MigrationClientConfig } from "../src/migrate-client.js"

test("pullAccount 携带 x-api-key、转发 sgwcmaid，并归一化 401", async () => {
  let seenKey = ""
  let seenBody = ""
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", c => chunks.push(c as Buffer))
    req.on("end", () => {
      seenKey = String(req.headers["x-api-key"] ?? "")
      seenBody = Buffer.concat(chunks).toString("utf8")
      res.setHeader("content-type", "application/json")
      if (seenKey !== "test-key") {
        res.writeHead(401)
        res.end(JSON.stringify({ ok: false, error: "x-api-key 校验失败" }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify({
        ok: true,
        format: "sdgb-migration-v1",
        source: { userId: 7, userName: "tester", romVersion: "1.56.00", dataVersion: "1.55.03" },
        counts: { musicDetails: 0, items: 0 },
        data: { pull: {}, derived: { userMusicDetailList: [], userItemList: [] } },
        logout: { ok: true, type: 2 },
        warnings: [],
      }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const cfg: MigrationClientConfig = { migrateUrl: `http://127.0.0.1:${port}`, migrateApiKey: "test-key", callTimeoutMs: 5000 }
  try {
    const ok = await pullAccount("SGWCMAIDTEST", cfg)
    assert.equal(ok.ok, true)
    assert.equal(seenBody, JSON.stringify({ sgwcmaid: "SGWCMAIDTEST" }))
    assert.equal(seenKey, "test-key")

    const bad = await pullAccount("SGWCMAIDTEST", { ...cfg, migrateApiKey: "wrong" })
    assert.equal(bad.ok, false)
    if (!bad.ok) {
      assert.equal(bad.status, 401)
      assert.match(bad.error, /x-api-key/)
    }
  } finally {
    server.close()
  }
})
