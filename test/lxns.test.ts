import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildLxnsUploadPlan, buildChartPresence } from "../src/lxns/map.js"
import { lxnsBestsToB50 } from "../src/lxns/bests.js"
import { createLxnsBindingStore } from "../src/lxns/bindings.js"
import { buildChartIndex } from "../src/b50/compute.js"
import type { LxnsSong } from "../src/b50/songs.js"

const songs: LxnsSong[] = [
  {
    id: 30, title: "Dual Song", version: 10000,
    difficulties: {
      standard: [{ difficulty: 3, level: "13", level_value: 13.0, version: 10000 }],
      dx: [{ difficulty: 3, level: "13", level_value: 13.0, version: 10000 }],
    },
  },
  {
    id: 1000, title: "DX Only", version: 20000,
    difficulties: { dx: [{ difficulty: 3, level: "12+", level_value: 12.5, version: 20000 }] },
  },
  {
    id: 8, title: "SD Only", version: 10000,
    difficulties: { standard: [{ difficulty: 3, level: "12", level_value: 12.4, version: 10000 }] },
  },
  {
    id: 100508, title: "[協]恋愛裁判", version: 25000,
    difficulties: { standard: [], dx: [], utage: [{ difficulty: 0, level: "13?", level_value: 0, version: 25000, kanji: "協" }] },
  },
]

function pullWith(details: unknown[]) {
  return { music: { userMusicList: [{ userMusicDetailList: details }] } }
}

test("buildLxnsUploadPlan maps ids/types per LXNS model (incl. utage)", () => {
  const plan = buildLxnsUploadPlan(pullWith([
    { musicId: 30, level: 3, achievement: 1_010_000, deluxscoreMax: 2000, comboStatus: 4, syncStatus: 5 },
    { musicId: 10030, level: 3, achievement: 1_000_000, deluxscoreMax: 1800, comboStatus: 2, syncStatus: 1 },
    { musicId: 1000, level: 3, achievement: 995_000, deluxscoreMax: 1500, comboStatus: 0, syncStatus: 0 },
    { musicId: 8, level: 3, achievement: 1_000_000, deluxscoreMax: 1600, comboStatus: 1, syncStatus: 0 },
    { musicId: 100508, level: 0, achievement: 1_962_659, deluxscoreMax: 2138, comboStatus: 0, syncStatus: 5 },
  ]), songs)
  assert.equal(plan.mapped, 5)
  assert.equal(plan.total, 5)
  assert.equal(plan.skipped.length, 0)
  const byId = new Map(plan.scores.map(s => [`${s.id}:${s.type}`, s]))
  assert.deepEqual(byId.get("30:standard"), { id: 30, type: "standard", level_index: 3, achievements: 101, fc: "app", fs: "sync", dx_score: 2000 })
  assert.deepEqual(byId.get("30:dx"), { id: 30, type: "dx", level_index: 3, achievements: 100, fc: "fcp", fs: "fs", dx_score: 1800 })
  assert.deepEqual(byId.get("1000:dx"), { id: 1000, type: "dx", level_index: 3, achievements: 99.5, fc: null, fs: null, dx_score: 1500 })
  assert.deepEqual(byId.get("8:standard"), { id: 8, type: "standard", level_index: 3, achievements: 100, fc: "fc", fs: null, dx_score: 1600 })
  assert.deepEqual(byId.get("100508:utage"), { id: 100508, type: "utage", level_index: 0, achievements: 196.2659, fc: null, fs: "sync", dx_score: 2138 })
})

test("buildLxnsUploadPlan skips invalid records and unknown charts", () => {
  const plan = buildLxnsUploadPlan(pullWith([
    { musicId: 0, level: 3, achievement: 1_000_000 },      // 无效 id
    { musicId: 30, level: 9, achievement: 1_000_000 },     // level 越界
    { musicId: 30, level: 3, achievement: 0 },             // 0 分
    { musicId: 10030, level: 4, achievement: 1_000_000 },  // base 30 无 level 4 dx
    { musicId: 99999, level: 3, achievement: 1_000_000 },  // base 89999 不存在
    { musicId: 100999, level: 0, achievement: 1_000_000 }, // 宴谱不在曲库
    { musicId: 8, level: 3, achievement: 1_000_000, deluxscoreMax: 1, comboStatus: 0, syncStatus: 0 }, // 有效
  ]), songs)
  assert.equal(plan.mapped, 1)
  assert.equal(plan.total, 7)
  assert.equal(plan.skipped.find(s => s.reason === "无效记录")?.count, 3)
  assert.equal(plan.skipped.find(s => s.reason === "落雪曲库缺失")?.count, 3)
})

test("buildChartPresence marks standard/dx/utage", () => {
  const p = buildChartPresence(songs)
  assert.deepEqual(p.get("30:3"), { standard: true, dx: true, utage: false })
  assert.deepEqual(p.get("1000:3"), { standard: false, dx: true, utage: false })
  assert.deepEqual(p.get("100508:0"), { standard: false, dx: false, utage: true })
})

test("lxnsBestsToB50 maps by Score.type (standard array can contain dx charts)", () => {
  const index = buildChartIndex(songs)
  index.get("30:3:SD")!.version = 25500
  const bests = {
    standard_total: 500,
    dx_total: 400,
    standard: [
      { id: 1000, level_index: 3, type: "dx", achievements: 101, dx_score: 1500, fc: "ap", fs: null, dx_rating: 300.9 },   // 旧曲列表里的 DX 谱面
      { id: 8, level_index: 3, type: "standard", achievements: 99.5, dx_score: 1200, fc: null, fs: "fs", dx_rating: 260.1 },
    ],
    dx: [
      { id: 100508, level_index: 0, type: "utage", achievements: 100, dx_score: 100, fc: null, fs: null, dx_rating: 0 },      // utage：查不到 SD/DX 谱面 → 计入 missing
      { id: 30, level_index: 3, type: "standard", achievements: 100, dx_score: 2000, fc: "fc", fs: null, dx_rating: 291.4 },
    ],
  }
  const r = lxnsBestsToB50(bests, index, { newVersionFrom: 25500 })
  assert.equal(r.b35.length, 2)
  assert.equal(r.b15.length, 1)
  assert.equal(r.missing, 0) // utage is intentionally excluded from rating
  assert.equal(r.total, 821) // current constants; the platform's cached ra/totals can be stale
  const dxEntry = r.b35.find(e => e.musicId === 1000)
  assert.equal(dxEntry?.type, "DX")
  assert.equal(dxEntry?.ra, 281)
  const stdEntry = r.b15.find(e => e.musicId === 30)
  assert.equal(stdEntry?.type, "SD")
  assert.equal(stdEntry?.ra, 280)
})

test("lxns binding store persists atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxns-bind-"))
  const file = path.join(dir, "bindings.json")
  const store = createLxnsBindingStore(file)
  assert.equal(store.get("u1"), null)
  const binding = { friendCode: 123456789012345, name: "Tester", boundAt: "2026-10-08T00:00:00.000Z", method: "friend_code" as const }
  store.set("u1", binding)
  assert.equal(store.size(), 1)
  const store2 = createLxnsBindingStore(file) // 重新加载（验证落盘）
  assert.deepEqual(store2.get("u1"), binding)
  assert.equal(store2.remove("u1"), true)
  assert.equal(store2.get("u1"), null)
  fs.rmSync(dir, { recursive: true, force: true })
})
