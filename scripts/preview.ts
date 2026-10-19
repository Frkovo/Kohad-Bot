// Public song data and synthetic scores only. Never imports into the player database.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { loadChartCatalog } from "../src/b50/catalog.js"
import { computeB50, type B50Input } from "../src/b50/compute.js"
import { renderB50 } from "../src/b50/render.js"
import { renderHelp } from "../src/b50/help.js"
import { extractPlayerProfile } from "../src/local/profile.js"
import type { MigrateSuccess } from "../src/migrate-client.js"
import { scoreDatabase } from "../src/local/database.js"

const charts = await loadChartCatalog(25500, "https://maimai.lxns.net", true)
const inputs: B50Input[] = [...charts.values()].filter(c => c.level >= 3 && c.musicId < 10000 && !c.disabled && c.version < 26000 && existsSync(`assets/maimaiDX/cover/${c.musicId}.png`))
  .map((c,i) => ({ musicId: c.musicId + (c.type === "DX" ? 10000 : 0), level: c.level, type: c.type,
    achievement: [1005000,1004800,1001000,1000000,999500,995000][i%6], dxScore: Math.floor((c.maxDxScore ?? 2000) * (0.93 + (i%7)*0.01)),
    fc: ["app","ap","fcp","fc",""][i%5], fs: ["fsdp","fsd","fsp","fs",""][i%5], playCount: (i*47)%150 + 1 }))
mkdirSync(".data/previews",{recursive:true})
// Exercise the actual GetUserData plateId shape, rather than passing a hard-coded renderer profile.
const profile = extractPlayerProfile({ source: { userName: "玩家昵称・预览" }, data: { pull: {
  userData: { userData: [{ userName: "玩家昵称・预览", iconId:550201, plateId:550201 }] },
} } } as unknown as MigrateSuccess)
for (const mode of ["b50","fitb50","pc50"] as const) {
  const result=computeB50(inputs,charts,{newVersionFrom:25500,versionTo:26000,mode})
  const png=await renderB50({title:"玩家昵称・预览",profile,
    subtitle:"公开曲库 · 演示成绩，非真实玩家",result,footerNote:mode==="fitb50"?"水鱼 fit_diff 原始精度 · 演示数据":mode==="pc50"?"playCount 降序 · 演示数据":"国服 1.56.00 · 演示数据"})
  writeFileSync(`.data/previews/${mode === "fitb50" ? "nb50" : mode}-preview.webp`,png)
  console.log(JSON.stringify({mode,bytes:png.length,charts:result.b35.length+result.b15.length,total:result.total,missing:result.missing,fitMissing:result.fitMissing}))
}
writeFileSync(".data/previews/help-preview.webp",await renderHelp())
// Provision the empty persistent schema without saving any synthetic user.
scoreDatabase().close()
