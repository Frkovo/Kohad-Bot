import assert from "node:assert/strict"
import test from "node:test"

import { buildUploadPlan, extractMusicDetails } from "../src/df/upload.js"
import type { DfMusic } from "../src/df/client.js"

const catalog = new Map<number, DfMusic>([
  [8, { id: 8, title: "True Love Song", type: "SD" }],
  [10030, { id: 10030, title: "True Love Song", type: "DX" }],
  [834, { id: 834, title: "PANDORA PARADOXXX", type: "SD" }],
  [100508, { id: 100508, title: "[協]恋愛裁判", type: "DX" }],
])

function pullWith(details: unknown[]) {
  return { music: { userMusicList: [{ userMusicDetailList: details }] } }
}

test("extractMusicDetails merges wrapper and direct forms", () => {
  const pull = {
    music: {
      userMusicList: [{ userMusicDetailList: [{ musicId: 1, level: 0 }] }],
      userMusicDetailList: [{ musicId: 2, level: 1 }],
    },
  }
  const out = extractMusicDetails(pull)
  assert.equal(out.length, 2)
})

test("buildUploadPlan maps valid details per pu.pu rules", () => {
  const plan = buildUploadPlan(pullWith([
    { musicId: 834, level: 3, achievement: 1_010_000, deluxscoreMax: 2847, comboStatus: 4, syncStatus: 5 },
    { musicId: 10030, level: 3, achievement: 995_000, deluxscoreMax: 1500, comboStatus: 2, syncStatus: 1 },
  ]), catalog)
  assert.equal(plan.mapped, 2)
  assert.equal(plan.total, 2)
  assert.deepEqual(plan.records[0], {
    achievements: 101, dxScore: 2847, fc: "app", fs: "sync", level_index: 3, title: "PANDORA PARADOXXX", type: "SD",
  })
  assert.deepEqual(plan.records[1], {
    achievements: 99.5, dxScore: 1500, fc: "fcp", fs: "fs", level_index: 3, title: "True Love Song", type: "DX",
  })
  assert.equal(plan.skipped.length, 0)
})

test("buildUploadPlan maps utage (id>=100000) as catalog type + level_index 0", () => {
  const plan = buildUploadPlan(pullWith([
    { musicId: 100508, level: 0, achievement: 1_962_659, deluxscoreMax: 2138, comboStatus: 0, syncStatus: 5 },
  ]), catalog)
  assert.equal(plan.mapped, 1)
  assert.deepEqual(plan.records[0], {
    achievements: 196.2659, dxScore: 2138, fc: "", fs: "sync", level_index: 0, title: "[協]恋愛裁判", type: "DX",
  })
})

test("buildUploadPlan skips invalid entries but keeps songs missing from the 水鱼 catalog via the local snapshot", () => {
  const local = new Map([
    [9999, { title: "本地新曲", type: "DX" }],
    [100001, { title: "[協]本地宴谱", type: "DX" }],
  ])
  const plan = buildUploadPlan(pullWith([
    { musicId: 0, level: 3, achievement: 1_000_000 },      // 无效 id
    { musicId: 834, level: 9, achievement: 1_000_000 },    // level 越界
    { musicId: 834, level: 3, achievement: 0 },            // 0 分
    { musicId: 9999, level: 3, achievement: 1_000_000 },   // 水鱼曲库没有，本地快照有
    { musicId: 100001, level: 0, achievement: 1_000_000 }, // 宴谱 + 本地快照
    { musicId: 834, level: 3, achievement: 1_010_000, deluxscoreMax: 1, comboStatus: 0, syncStatus: 0 }, // 有效
  ]), catalog, local)
  assert.equal(plan.mapped, 3)
  assert.equal(plan.total, 6)
  assert.equal(plan.skipped.find(s => s.reason === "无效记录")?.count, 3)
  assert.equal(plan.skipped.find(s => s.reason === "缺少歌曲名称"), undefined)
  assert.deepEqual(plan.records.map(r => [r.title, r.type, r.level_index]), [
    ["本地新曲", "DX", 3],
    ["[協]本地宴谱", "DX", 0],
    ["PANDORA PARADOXXX", "SD", 3],
  ])
  assert.equal(plan.records[2].fc, "")
  assert.equal(plan.records[2].fs, "")
})

test("buildUploadPlan reports the only real skip: no title anywhere", () => {
  const plan = buildUploadPlan(pullWith([{ musicId: 424242, level: 0, achievement: 1_000_000 }]), catalog, new Map())
  assert.equal(plan.mapped, 0)
  assert.equal(plan.skipped.find(s => s.reason === "缺少歌曲名称")?.count, 1)
})
