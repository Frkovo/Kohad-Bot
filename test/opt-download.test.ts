import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import type { OptPackage } from "../src/opt/client.js"
import { assertFetchable, downloadPackage, probeSize, resolvePart, DownloadCancelled } from "../src/opt/download.js"

type ServeOptions = { data: Buffer; ignoreRange?: boolean; delayMs?: number; failFirst?: number }

async function serve(options: ServeOptions) {
  const ranges: string[] = []
  let failures = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    ranges.push(String(req.headers.range ?? ""))
    if (options.failFirst && failures < options.failFirst) {
      failures++
      res.writeHead(503, { "content-length": 0 })
      res.end()
      return
    }
    const data = options.data
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""))
    const respond = () => {
      if (!match || options.ignoreRange) {
        res.writeHead(200, { "content-length": data.length })
        res.end(data)
        return
      }
      const start = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1
      if (start >= data.length) {
        res.writeHead(416, { "content-range": `bytes */${data.length}`, "content-length": 0 })
        res.end()
        return
      }
      const chunk = data.subarray(start, end + 1)
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": chunk.length,
        "content-range": `bytes ${start}-${end}/${data.length}`,
      })
      res.end(chunk)
    }
    if (options.delayMs) setTimeout(respond, options.delayMs)
    else respond()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/SDGB_test.opt`,
    ranges,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function pkg(url: string, name = "SDGB_test.opt", transfer = { partSizes: [4, 4, 4], intervals: { isdn: [1], dsl: [1], bb: [1] } }): OptPackage {
  return { index: 1, kind: "opt", role: "option", section: "COMMON", key: "INSTALL1", name, url, size: null, note: "", transfer }
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "sdgb-opt-"))
}

const DATA = Buffer.from("0123456789")

test("分片下载写出完整文件并逐片请求 Range", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA })
  try {
    const result = await downloadPackage(pkg(server.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 4, paceMs: 0, maxRetries: 2,
      signal: new AbortController().signal,
    })
    assert.equal(result.skipped, false)
    assert.equal(result.size, DATA.length)
    assert.equal(readFileSync(path.join(dir, "SDGB_test.opt")).toString(), DATA.toString())
    assert.deepEqual(server.ranges, ["bytes=0-3", "bytes=4-7", "bytes=8-11"])
    assert.equal(existsSync(path.join(dir, "SDGB_test.opt.part")), false)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("已有 .part 从断点续传", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA })
  try {
    writeFileSync(path.join(dir, "SDGB_test.opt.part"), DATA.subarray(0, 4))
    const result = await downloadPackage(pkg(server.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 4, paceMs: 0, maxRetries: 2,
      signal: new AbortController().signal,
    })
    assert.equal(result.size, DATA.length)
    assert.deepEqual(server.ranges, ["bytes=4-7", "bytes=8-11"])
    assert.equal(readFileSync(path.join(dir, "SDGB_test.opt")).toString(), DATA.toString())
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("完成文件已存在时跳过且不发请求", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA })
  try {
    writeFileSync(path.join(dir, "SDGB_test.opt"), DATA)
    const result = await downloadPackage(pkg(server.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 4, paceMs: 0, maxRetries: 2,
      signal: new AbortController().signal,
    })
    assert.equal(result.skipped, true)
    assert.equal(server.ranges.length, 0)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("取消时保留 .part 且不重命名", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA, delayMs: 1500 })
  const controller = new AbortController()
  try {
    const pending = downloadPackage(pkg(server.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 4, paceMs: 0, maxRetries: 2,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 150)
    await assert.rejects(pending, (error: unknown) => error instanceof DownloadCancelled)
    assert.equal(existsSync(path.join(dir, "SDGB_test.opt")), false)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("416 且 .part 与服务器不一致时截断重下", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA })
  try {
    writeFileSync(path.join(dir, "SDGB_test.opt.part"), Buffer.alloc(20, 0x41))
    const result = await downloadPackage(pkg(server.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 4, paceMs: 0, maxRetries: 2,
      signal: new AbortController().signal,
    })
    assert.equal(result.size, DATA.length)
    assert.equal(readFileSync(path.join(dir, "SDGB_test.opt")).toString(), DATA.toString())
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("服务器忽略 Range 时直连失败并回退代理", async () => {
  const dir = tempDir()
  const direct = await serve({ data: DATA, ignoreRange: true })
  const proxy = await serve({ data: DATA })
  try {
    const result = await downloadPackage(pkg(direct.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "auto",
      proxy: { build: () => proxy.url, apiKey: "" },
      link: "bb", partSize: 4, paceMs: 0, maxRetries: 1,
      signal: new AbortController().signal,
    })
    assert.equal(result.via, "proxy")
    assert.equal(readFileSync(path.join(dir, "SDGB_test.opt")).toString(), DATA.toString())
  } finally { await direct.close(); await proxy.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("整文件模式在 5xx 后按阶梯重试", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA, failFirst: 1 })
  try {
    const result = await downloadPackage(pkg(server.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 0, paceMs: 0, maxRetries: 3,
      signal: new AbortController().signal,
    })
    assert.equal(result.size, DATA.length)
    assert.equal(server.ranges.length, 2)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("分片失败按阶梯重试后成功", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA, failFirst: 2 })
  try {
    const result = await downloadPackage(pkg(server.url), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 4, paceMs: 0, maxRetries: 3,
      signal: new AbortController().signal,
    })
    assert.equal(result.size, DATA.length)
    assert.equal(server.ranges.length, 5)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("文件名清洗阻止路径穿越", async () => {
  const dir = tempDir()
  const server = await serve({ data: DATA })
  try {
    const result = await downloadPackage(pkg(server.url, "../../evil.opt"), {
      dir, hostAllowlist: ["127.0.0.1"], transport: "direct", link: "bb", partSize: 4, paceMs: 0, maxRetries: 1,
      signal: new AbortController().signal,
    })
    assert.equal(result.name, "evil.opt")
    assert.equal(existsSync(path.join(dir, "evil.opt")), true)
    assert.equal(existsSync(path.join(path.dirname(dir), "evil.opt")), false)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("probeSize 读取 Content-Range 总大小", async () => {
  const server = await serve({ data: DATA })
  try {
    const hit = await probeSize(server.url, { allowHostlist: ["127.0.0.1"], signal: new AbortController().signal })
    assert.deepEqual(hit, { size: DATA.length, note: "" })
  } finally { await server.close() }
})

test("resolvePart 按链路选择 PART_SIZE 并在缺项时回落", () => {
  const transfer = { partSizes: [8, 16, 32], intervals: { isdn: [1], dsl: [2], bb: [3, 4] } }
  assert.deepEqual(resolvePart(pkg("https://x/y.opt", "y.opt", transfer), "bb"), { partSize: 32, intervals: [3, 4] })
  assert.deepEqual(resolvePart(pkg("https://x/y.opt", "y.opt", transfer), "isdn"), { partSize: 8, intervals: [1] })
  assert.deepEqual(resolvePart(pkg("https://x/y.opt", "y.opt", { partSizes: null, intervals: { isdn: null, dsl: null, bb: null } }), "bb"), { partSize: 8192, intervals: [1000, 2000, 3000, 4000] })
  assert.deepEqual(resolvePart(pkg("https://x/y.opt"), "bb", 0), { partSize: 0, intervals: [1] })
})

test("URL 校验：https/回环 http/主机后缀", () => {
  assert.equal(assertFetchable("https://maimai-haisin.wahlap.com/a.opt", ["wahlap.com"]).hostname, "maimai-haisin.wahlap.com")
  assert.throws(() => assertFetchable("http://maimai-haisin.wahlap.com/a.opt", ["wahlap.com"]), /明文 http/)
  assert.throws(() => assertFetchable("https://evil.test/a.opt", ["wahlap.com"]), /非允许主机/)
  assert.throws(() => assertFetchable("https://user:pw@wahlap.com/a.opt", ["wahlap.com"]), /用户信息/)
  assert.equal(assertFetchable("http://127.0.0.1:8080/a.opt", []).port, "8080")
  // 迁移服务在 Tailscale/内网时允许显式 http 主机；不在白名单仍拒绝。
  assert.throws(() => assertFetchable("http://100.115.107.74:8788/api/opt/range?url=x", [], []), /明文 http/)
  assert.equal(assertFetchable("http://100.115.107.74:8788/api/opt/range?url=x", [], ["100.115.107.74"]).hostname, "100.115.107.74")
})
