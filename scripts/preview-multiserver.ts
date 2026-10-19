// Public catalogue and synthetic scores only; no player database, login or Discord connection.
import { mkdirSync, writeFileSync } from "node:fs"
import { regionCatalog, calculateRemote } from "../src/multiserver/catalog.js"
import { SERVER_BADGE, type Snapshot } from "../src/multiserver/registry.js"
import { renderB50 } from "../src/b50/render.js"
import { renderHelp } from "../src/b50/help.js"

const catalog = regionCatalog("intl",process.env.NET_INTL_VERSION)
const selected = [...catalog.index.values()].filter(c=>c.level===3||c.level===4)
const charts = [...selected.filter(c=>!c.isNew).slice(0,35),...selected.filter(c=>c.isNew).slice(0,15)]
const snapshot: Snapshot = {accountKey:"synthetic-preview",profile:{name:"演示玩家・非真实成绩"},fetchedAt:new Date().toISOString(),countsComplete:false,source:"net",
  records:charts.map((chart,i)=>({title:chart.title,type:chart.type,level:chart.level,achievement:[1005000,1004999,1001000,1000000,999999,995000][i%6],
    dxScore:Math.floor((chart.maxDxScore??3000)*0.97),fc:i%2?"fc":"app",fs:"fsdp"}))}
const calculated = calculateRemote("intl",snapshot,"b50")
mkdirSync(".data/previews",{recursive:true})
writeFileSync(".data/previews/intl-b50-preview.webp",await renderB50({title:snapshot.profile.name,profile:snapshot.profile,result:calculated.result,
  useCnArtwork:false,serverLabel:SERVER_BADGE.intl,footerNote:calculated.version+" · 演示数据 · "+calculated.note}))
writeFileSync(".data/previews/help-preview.webp",await renderHelp())
console.log(JSON.stringify({version:calculated.version,charts:calculated.result.b35.length+calculated.result.b15.length,missing:calculated.result.missing,synthetic:true}))
