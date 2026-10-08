import { test } from "node:test"
import assert from "node:assert/strict"
import { parseMusicPage } from "../src/multiserver/net.js"

// Shape taken from the live JP master page: achievements above 100.5% are valid (e.g. 100.5466%).
const card = (rate: string) => '<form><input name="genre"></form><div class="w_450 m_15 p_r f_0"><div class="music_name_block">Song</div><div class="music_score_block w_112">' + rate + '</div><div class="music_score_block w_190"><img src="/img/deluxscore.png">2,295 / 2,568</div><img class="music_kind_icon" src="/img/music_dx.png"><img class="h_20 f_l" src="/img/diff_master.png"></div>'

test("achievements between 100.5% and 101% parse", () => {
  const [record] = parseMusicPage(card("100.5466%"), 3)
  assert.equal(record!.achievement, 1005466)
})

test("101.0000% (AP+ all-perfect) parses", () => {
  const [record] = parseMusicPage(card("101.0000%"), 3)
  assert.equal(record!.achievement, 1010000)
})

test("achievement above 101% is rejected", () => {
  assert.throws(() => parseMusicPage(card("101.0001%"), 3))
})
