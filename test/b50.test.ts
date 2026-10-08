import assert from "node:assert/strict"
import test from "node:test"

import { calculateDxRating, dxRatingMultiplier } from "../src/b50/rating.js"
import { buildChartIndex, computeB50, type B50Input } from "../src/b50/compute.js"
import type { LxnsSong } from "../src/b50/songs.js"

test("dx rating multipliers follow the achievement table", () => {
  assert.equal(dxRatingMultiplier(1_010_000), 0.224)
  assert.equal(dxRatingMultiplier(1_000_000), 0.216)
  assert.equal(dxRatingMultiplier(999_999), 0.211)
  assert.equal(dxRatingMultiplier(50_000), 0.070)
  assert.equal(dxRatingMultiplier(1_005_000), 0.224)
})

test("calculateDxRating matches formula anchors", () => {
  assert.equal(calculateDxRating(13.0, 1_010_000), 292) // cap at 100.5%, then floor
  assert.equal(calculateDxRating(13.0, 1_005_000), 292)
  assert.equal(calculateDxRating(13.0, 1_000_000), 280)
  assert.equal(calculateDxRating(13.0, 999_999), 274)
  assert.equal(calculateDxRating(13.0, 0), 0)
  assert.equal(calculateDxRating(null, 1_000_000), 0)
})

/** 40 张旧曲（v20000）+ 20 张新曲（v25500）的合成曲库 */
function makeSongs(): LxnsSong[] {
  const songs: LxnsSong[] = []
  for (let i = 1; i <= 60; i++) {
    const isNew = i > 40
    songs.push({
      id: i,
      title: `Song ${i}`,
      version: isNew ? 25500 : 20000,
      difficulties: {
        standard: [{ difficulty: 3, level: "13", level_value: 10 + i / 10, version: isNew ? 25500 : 20000 }],
        dx: [],
      },
    })
  }
  return songs
}

test("computeB50 splits B35/B15 and sums top ratings", () => {
  const index = buildChartIndex(makeSongs())
  const inputs: B50Input[] = []
  for (let i = 1; i <= 60; i++) {
    inputs.push({ musicId: i, level: 3, type: "SD", achievement: 1_010_000, dxScore: 1000, fc: "ap", fs: "sync", ra: 300 + i })
  }
  const r = computeB50(inputs, index, { newVersionFrom: 25500 })
  assert.equal(r.b35.length, 35)
  assert.equal(r.b15.length, 15)
  assert.equal(r.b35[0].musicId, 40)
  assert.equal(r.b35[34].musicId, 6)
  assert.equal(r.b15[0].musicId, 60)
  assert.equal(r.b15[14].musicId, 46)
  const oldSum = [...Array(35)].map((_, k) => Math.floor((10 + (40-k)/10) * 22.512 + 1e-9)).reduce((a, b) => a + b, 0)
  const newSum = [...Array(15)].map((_, k) => Math.floor((10 + (60-k)/10) * 22.512 + 1e-9)).reduce((a, b) => a + b, 0)
  assert.equal(r.total, oldSum + newSum)
})

test("new-version charts below B15 cutoff are excluded from B35", () => {
  const index = buildChartIndex(makeSongs())
  const inputs: B50Input[] = [
    { musicId: 41, level: 3, type: "SD", achievement: 1_000_000, dxScore: 0, fc: "", fs: "", ra: 500 },
    ...Array.from({ length: 15 }, (_, k) => ({
      musicId: 42 + k, level: 3, type: "SD" as const, achievement: 1_000_000, dxScore: 0, fc: "", fs: "", ra: 600 + k,
    })),
    { musicId: 1, level: 3, type: "SD", achievement: 1_000_000, dxScore: 0, fc: "", fs: "", ra: 400 },
  ]
  const r = computeB50(inputs, index, { newVersionFrom: 25500 })
  assert.equal(r.b15.length, 15)
  assert.equal(r.b35.length, 1)
  assert.equal(r.b35[0].musicId, 1)
  assert.ok(![...r.b35, ...r.b15].some(e => e.musicId === 41))
})

test("computeB50 computes ra from ds when absent and counts missing charts", () => {
  const index = buildChartIndex(makeSongs())
  const inputs: B50Input[] = [
    { musicId: 1, level: 3, type: "SD", achievement: 1_000_000, dxScore: 0, fc: "", fs: "" },
    { musicId: 999, level: 3, achievement: 1_000_000, dxScore: 0, fc: "", fs: "" },
  ]
  const r = computeB50(inputs, index, { newVersionFrom: 25500 })
  assert.equal(r.missing, 1)
  assert.equal(r.b35.length, 1)
  assert.equal(r.b35[0].ra, calculateDxRating(10.1, 1_000_000))
})
