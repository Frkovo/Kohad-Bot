import { test } from "node:test"
import assert from "node:assert/strict"
import { deflateSync, inflateSync } from "node:zlib"
import { encodeAllNet, decodeAllNet, keychipShort } from "../src/mumur/allnet.js"
import { buildLookupPacket, parseLookupResponse } from "../src/mumur/aimedb.js"

const AIMEDB_KEY = Buffer.from("Copyright(C)SEGA", "utf8")
import { mumurChartIndex, toScoreRecord, callMumurApi, mumurConfig } from "../src/mumur/client.js"
import { UserError, type Snapshot } from "../src/multiserver/registry.js"
import { calculateRemote } from "../src/multiserver/catalog.js"

// AES-128-ECB with the AimeDB key, as the server side would produce it. Used only to build fixtures.
import { createCipheriv, createDecipheriv } from "node:crypto"
const encryptFixture = (plain: Buffer) => {
  const cipher = createCipheriv("aes-128-ecb", AIMEDB_KEY, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}
// Command-6 reply carrying an AiMe ID at 0x20 (48 bytes).
const serverReply = (userId: number) => {
  const plain = Buffer.alloc(48)
  plain.writeUInt16LE(0xa13e, 0)
  plain.writeUInt16LE(6, 4)
  plain.writeUInt16LE(48, 6)
  plain.writeUInt32LE(userId, 0x20)
  return encryptFixture(plain)
}
// Header-only reply (32 bytes, result 0): what MuNET returns for a card it does not know.
const headerOnlyReply = () => {
  const plain = Buffer.alloc(32)
  plain.writeUInt16LE(0xa13e, 0)
  plain.writeUInt16LE(6, 4)
  plain.writeUInt16LE(32, 6)
  return encryptFixture(plain)
}

test("AllNet body round-trips through deflate and base64", () => {
  const fields = { game_id: "SDEZ", ver: "1.70", serial: "A63E01E6852", token: "2864179931" }
  assert.deepEqual(decodeAllNet(encodeAllNet(fields)), fields)
})

test("AllNet response with a uri field is decoded", () => {
  const encoded = deflateSync(Buffer.from("stat=1&uri=http://110.40.128.13:84/abc~def/&uri2=x=y", "utf8")).toString("base64")
  const fields = decodeAllNet(encoded)
  assert.equal(fields.uri, "http://110.40.128.13:84/abc~def/")
  assert.equal(fields.uri2, "x=y")
})

test("keychip is reduced to the 11-character AllNet serial", () => {
  assert.equal(keychipShort("A63E01E6852"), "A63E01E6852")
  assert.equal(keychipShort("A63E-01E68520000"), "A63E01E6852")
  assert.throws(() => keychipShort("bad keychip"), UserError)
})

test("AimeDB lookup packet is 48 encrypted bytes with the lookup header", () => {
  const packet = buildLookupPacket("SDEZ", "A63E01E6852", "00000000000000000001")
  assert.equal(packet.length, 48)
  const decipher = createDecipheriv("aes-128-ecb", AIMEDB_KEY, null)
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(packet), decipher.final()])
  assert.equal(plain.readUInt16LE(0), 0xa13e)
  assert.equal(plain.readUInt16LE(4), 4)
  assert.equal(plain.readUInt16LE(6), 48)
  assert.equal(plain.subarray(0x0a, 0x10).toString("ascii"), "SDEZ\0\0")
  assert.equal(plain.subarray(0x14, 0x20).toString("ascii").replace(/\0/g, ""), "A63E01E6852")
  // 20-digit card -> 10 bytes, hex-decoded the same way AquaDX does it.
  assert.equal(plain.subarray(0x20, 0x2a).toString("hex"), "00000000000000000001")
  assert.equal(plain[0x2a], 1)
})

test("AimeDB reply yields the user id; header-only and 0xffffffff both mean not registered", () => {
  assert.equal(parseLookupResponse(serverReply(4653057)), 4653057)
  assert.equal(parseLookupResponse(serverReply(0xffffffff)), undefined)
  assert.equal(parseLookupResponse(headerOnlyReply()), undefined)
  assert.throws(() => parseLookupResponse(Buffer.alloc(8)), UserError)
})

test("AimeDB reply with the wrong command is a protocol failure, not a missing card", () => {
  const plain = Buffer.alloc(48)
  plain.writeUInt16LE(0xa13e, 0)
  plain.writeUInt16LE(0x10, 4)
  plain.writeUInt16LE(48, 6)
  assert.throws(() => parseLookupResponse(encryptFixture(plain)), UserError)
})

test("chart index resolves musicId and level to a titled chart with ds", () => {
  const { version, index } = mumurChartIndex()
  assert.ok(version.length > 0)
  const dx = [...index.values()].find(chart => chart.type === "DX")
  assert.ok(dx && dx.title && dx.ds > 0)
  assert.ok(index.size > 1000)
})

test("record mapping: combo and sync values, unresolved charts stay without ds", () => {
  const index = new Map([["17:4", { title: "Known", type: "SD" as const, ds: 12.5, version: 25, isNew: true, maxDxScore: 900 }]])
  const known = toScoreRecord({ musicId: 17, level: 4, achievement: 1009325, deluxscoreMax: 1414, playCount: 1, comboStatus: 3, syncStatus: 4 }, index)
  assert.equal(known.title, "Known")
  assert.equal(known.fc, "ap")
  assert.equal(known.fs, "fsd")
  assert.equal(known.ds, 12.5)
  assert.equal(known.maxDxScore, 900)
  const unknown = toScoreRecord({ musicId: 99999, level: 0, achievement: 500000, deluxscoreMax: 0, playCount: 0, comboStatus: 0, syncStatus: 0 }, index)
  assert.equal(unknown.title, "#99999")
  assert.equal(unknown.ds, undefined)
  assert.equal(unknown.fc, "")
})

test("record mapping keeps scores up to 101.0000% and rejects anything above", () => {
  // 101.0000% (1010000) is a real stored value for AP+ all-perfect plays in the MuNET export.
  const top = toScoreRecord({ musicId: 809, level: 4, achievement: 1010000, deluxscoreMax: 1930, playCount: 1, comboStatus: 4, syncStatus: 5 }, new Map())
  assert.equal(top.achievement, 1010000)
  assert.equal(top.fs, "fsdp")
  assert.throws(() => toScoreRecord({ musicId: 17, level: 4, achievement: 1010001, deluxscoreMax: 0, playCount: 0, comboStatus: 0, syncStatus: 0 }, new Map()), UserError)
})

test("plain API call deflates the request and accepts plain or deflated JSON", async () => {
  const original = globalThis.fetch
  const seen: { body?: Uint8Array; headers?: Record<string, string>; url?: string }[] = []
  let reply: Buffer = Buffer.from(JSON.stringify({ userData: { userName: "A" } }))
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: init.body as Uint8Array, headers: init.headers as Record<string, string> })
    return new Response(reply, { status: 200 })
  }) as typeof fetch
  try {
    const plain = await callMumurApi("http://example.test/base/", "GetUserDataApi", { userId: 7 })
    assert.equal(plain.userData.userName, "A")
    assert.equal(seen[0].url, "http://example.test/base/Maimai2Servlet/GetUserDataApi")
    assert.equal(seen[0].headers?.["Content-Encoding"], "deflate")
    assert.deepEqual(JSON.parse(inflateSync(Buffer.from(seen[0].body!)).toString("utf8")), { userId: 7 })
    reply = deflateSync(Buffer.from(JSON.stringify({ userMusicList: [] })))
    const deflated = await callMumurApi("http://example.test/base/", "GetUserMusicApi", { userId: 7 })
    assert.deepEqual(deflated.userMusicList, [])
    reply = Buffer.alloc(0)
    await assert.rejects(callMumurApi("http://example.test/base/", "GetUserMusicApi", { userId: 7 }), UserError)
  } finally { globalThis.fetch = original }
})

test("unknown MuNET charts fill empty B15 slots as 未知歌曲 with rating 0", () => {
  const { index } = mumurChartIndex()
  const [key, chart] = [...index.entries()].find(([, c]) => c.isNew && c.type === "DX")!
  const [musicId, level] = key.split(":").map(Number)
  const snapshot: Snapshot = {
    accountKey: "fixture", profile: { name: "Fixture" }, fetchedAt: new Date().toISOString(), countsComplete: true, source: "private_api", version: "MAGiCAL",
    records: [
      { title: chart.title, type: chart.type, level, achievement: 1005000, dxScore: 1000, fc: "", fs: "", musicId, ds: chart.ds, version: chart.version, isNew: true, playCount: 1 },
      { title: "#999999", type: "DX", level: 3, achievement: 990000, dxScore: 500, fc: "", fs: "", musicId: 999999, playCount: 2 },
    ],
  }
  const { result } = calculateRemote("mumur", snapshot, "b50")
  assert.equal(result.b15.filter(entry => !entry.unknown).length, 1)
  const unknown = result.b15.find(entry => entry.unknown)!
  assert.equal(unknown.title, "未知歌曲")
  assert.equal(unknown.ra, 0)
  assert.equal(result.total, result.b35.reduce((n, e) => n + e.ra, 0) + result.b15.reduce((n, e) => n + e.ra, 0))
})

test("MuNET defaults point at the observed PowerOn and AimeDB hosts", () => {
  const cfg = mumurConfig({})
  assert.equal(cfg.powerOnUrl, "http://play.mumur.net/sys/servlet/PowerOn")
  assert.equal(cfg.aimeHost, "aime.mumur.net")
  assert.equal(cfg.game, "SDEZ")
})
