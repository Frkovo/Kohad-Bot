import assert from "node:assert/strict"
import test from "node:test"
import { gunzipSync } from "node:zlib"

import { buildPayload } from "../src/payload.js"
import type { MigrateSuccess } from "../src/migrate-client.js"

function fakeSuccess(detailCount: number): MigrateSuccess {
  const userMusicDetailList = Array.from({ length: detailCount }, (_, i) => ({
    musicId: 100 + i, level: 3, playCount: 1, achievement: 1_000_000 + i, deluxscoreMax: 2000 + i, comboStatus: 3, syncStatus: 5,
  }))
  return {
    ok: true,
    format: "sdgb-migration-v1",
    elapsedMs: 1234,
    source: { userId: 42, userName: "tester", romVersion: "1.56.00", dataVersion: "1.55.03" },
    counts: { musicDetails: detailCount, items: 1 },
    data: {
      pull: {
        userId: 42,
        itemFlat: [{ itemKind: 1, itemId: 1, stock: 1, isValid: true }],
        music: { userMusicList: [{ userMusicDetailList }] },
      },
      derived: { userMusicDetailList, userItemList: [{ itemKind: 1, itemId: 1, stock: 1, isValid: true }] },
    },
    logout: { ok: true, type: 2 },
    warnings: [],
  }
}

test("tomunet 只导出 derived.userMusicDetailList 原样数组（小体积明文）", () => {
  const built = buildPayload({ kind: "tomunet", result: fakeSuccess(3), userId: 42, maxBytes: 1024 * 1024, now: new Date("2026-10-05T12:00:00Z") })
  assert.equal(built.files.length, 1)
  assert.match(built.files[0].name, /^UserMusicDetailList-42-\d{14}\.json$/)
  assert.equal(built.gz, false)
  const parsed = JSON.parse(built.files[0].data.toString("utf8")) as { musicId: number }[]
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0].musicId, 100)
})

test("getuserall 全量包超过阈值时自动 gzip，内容可解回", () => {
  const built = buildPayload({ kind: "getuserall", result: fakeSuccess(200), userId: 42, maxBytes: 4096, now: new Date("2026-10-05T12:00:00Z") })
  assert.equal(built.files.length, 1)
  assert.equal(built.gz, true)
  assert.match(built.files[0].name, /^getUserAll-42-\d{14}\.json\.gz$/)
  const parsed = JSON.parse(gunzipSync(built.files[0].data).toString("utf8")) as { source: { userId: number }; data: { derived: { userMusicDetailList: unknown[] } } }
  assert.equal(parsed.source.userId, 42)
  assert.equal(parsed.data.derived.userMusicDetailList.length, 200)
})

test("tomunet 超过阈值时拆分为多个 gz 分片，合并后顺序完整", () => {
  const count = 400
  const built = buildPayload({ kind: "tomunet", result: fakeSuccess(count), userId: 42, maxBytes: 600, now: new Date("2026-10-05T12:00:00Z") })
  assert.equal(built.split, true)
  assert.ok(built.files.length >= 2 && built.files.length <= 10, `parts=${built.files.length}`)
  const all = built.files.flatMap(f => JSON.parse(gunzipSync(f.data).toString("utf8")) as { musicId: number }[])
  assert.equal(all.length, count)
  assert.deepEqual(all.map(x => x.musicId), Array.from({ length: count }, (_, i) => 100 + i))
})
