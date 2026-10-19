import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js"
import { normalizeSgwc, isSgwcFormat } from "../src/util.js"
import { normalizeSgwc as serverNormalize, buildMigrationPayload } from "../../server/src/migrate-core.js"
import { extractPlayerProfile, lxPlayerProfile } from "../src/local/profile.js"
import type { MigrateSuccess } from "../src/migrate-client.js"
import { handleB50, handleHelp } from "../src/handlers.js"
import { createQueue } from "../src/queue.js"
import { scoreDatabase } from "../src/local/database.js"
import { closeServerStore } from "../src/multiserver/store.js"
import type { BotConfig } from "../src/config.js"
import { COMMANDS_JSON } from "../src/commands.js"

const canonical = `SGWCMAID261008043342${"A1".repeat(32)}`
const short = canonical.slice(4)
const link = `https://wq.wahlap.net/qrcode/req/${short}.html?l=123&t=ignored&d=ignored`

test("all QR input forms normalize identically in bot and migration API without fetching the URL", t => {
  t.mock.method(globalThis,"fetch",()=>{throw new Error("QR URL must not be fetched")})
  for (const raw of [canonical,short,canonical.slice(8),short.toLowerCase(),`  ${link}  `,`<${link}>`,`[扫码链接](${link.replaceAll("&","\\&")})`]) {
    assert.equal(normalizeSgwc(raw),canonical)
    assert.equal(serverNormalize(raw),canonical)
    assert.equal(isSgwcFormat(normalizeSgwc(raw)),true)
  }
})
test("QR parsing rejects unrelated hosts, malformed payloads and query-only code",()=>{
  for (const raw of [link.replace("wq.wahlap.net","example.test"),link.replace("wq.wahlap.net","wq.wahlap.net.example.test"),link.replace(short,short.slice(0,-1)),`https://wq.wahlap.net/?code=${short}`,link.replace("A1A1","ZZZZ"),"MAID261008043342"]){
    assert.equal(isSgwcFormat(normalizeSgwc(raw)),false)
    assert.equal(isSgwcFormat(serverNormalize(raw)),false)
  }
})
test("active UserDetail plateId wins, invalid aliases don't hide valid plate and source preview is a fallback",()=>{
  const input={source:{userName:"Tester",iconId:550201,nameplateId:550201},data:{pull:{userData:{userData:[{plateId:200201,nameplateId:550201}]}}}} as unknown as MigrateSuccess
  assert.equal(extractPlayerProfile(input).nameplateId,200201)
  input.data.pull.userData={userData:[{plateId:0,nameplateId:200201}]}
  assert.equal(extractPlayerProfile(input).nameplateId,200201)
  input.data.pull.userData=null
  assert.equal(extractPlayerProfile(input).nameplateId,550201)
  assert.equal(extractPlayerProfile(input).iconId,550201)
})
test("LX player name_plate fills missing local art without overriding imported choices",()=>{
  const player={name:"LX",rating:15000,friend_code:"123456789012345",icon:{id:200201},name_plate:{id:200201}}
  assert.equal(lxPlayerProfile(player).nameplateId,200201)
  assert.equal(lxPlayerProfile(player,{name:"Game",nameplateId:550201}).nameplateId,550201)
  assert.equal(lxPlayerProfile(player,{name:"Game"}).iconId,200201)
})
test("migration preserves preview collection IDs when detail data is unavailable",()=>{
  const pull={userId:1,loginId:"must-strip",userData:null,itemKinds:{},itemFlat:[],music:{userMusicList:[]}} as Parameters<typeof buildMigrationPayload>[0]["pull"]
  const result=buildMigrationPayload({pull,session:{base:"https://fixture.test",preview:{userName:"Tester",nameplateId:550201,iconId:550201,playerRating:15000,token:"must-not-save"}}})
  assert.equal(result.source.nameplateId,550201)
  assert.equal(result.source.iconId,550201)
  assert.equal(JSON.stringify(result.source).includes("must-not-save"),false)
})
test("same user can query three public images concurrently during scan cooldown; upload is private and accepts linked QR",async t=>{
  const folder=mkdtempSync(path.join(tmpdir(),"kohad-public-"))
  process.env.LOCAL_SCORE_DB=path.join(folder,"scores.sqlite")
  const cfg={allowedUserIds:new Set(),cooldownMs:0,ephemeral:true,migrateUrl:"https://migrate.fixture",migrateApiKey:"fixture",callTimeoutMs:5000,b50NewVersion:25500,lxApiBase:"https://lx.fixture"} as BotConfig
  let posted=""
  t.mock.method(globalThis,"fetch",async(url:unknown, options?:RequestInit)=>{
    if(String(url).includes("migrate.fixture")) {
      posted=JSON.parse(String(options?.body)).sgwcmaid
      return Response.json({ok:true,source:{userId:1,userName:"Tester"},data:{pull:{music:{userMusicDetailList:[{musicId:11842,level:3,achievement:1005000,deluxscoreMax:123,playCount:25}]}},derived:{userMusicDetailList:[],userItemList:[]}}})
    }
    throw new Error("offline catalog fixture")
  })
  const messages: Record<string,unknown>[]=[]
  const acknowledgements: unknown[]=[]
  let command="upload"
  const interaction={get commandName(){return command},user:{id:"fixture-user"},options:{getString:(name:string)=>name==="sgwcmaid"?(command==="upload"?link:null):name==="source"?"local":null},
    deferReply:async(options:unknown)=>{acknowledgements.push(options)},editReply:async(message:Record<string,unknown>)=>{messages.push(message)}} as unknown as ChatInputCommandInteraction
  try {
    await handleB50(interaction,cfg,createQueue(1),new Map())
    assert.equal(posted,canonical)
    assert.deepEqual(acknowledgements.pop(),{flags:MessageFlags.Ephemeral})
    // A user's scan cooldown must not block querying saved images simultaneously.
    cfg.cooldownMs=30000
    const images=["b50","nb50","pc50"].map(name=>handleB50({ ...interaction, commandName:name,
      options:{getString:(option:string)=>option==="source"?"local":null,getBoolean:(option:string)=>option==="public"?true:null},
    } as unknown as ChatInputCommandInteraction,cfg,createQueue(1),new Map()))
    await new Promise<void>(resolve=>setImmediate(resolve))
    assert.deepEqual(acknowledgements.splice(0),[{},{},{}])
    await Promise.all(images)
    assert.equal(messages.filter(message=>Array.isArray(message.files)).length,3)
    command="help"
    await handleHelp(interaction)
    assert.equal(acknowledgements.pop(),undefined)
    assert.equal(Array.isArray(messages.at(-1)?.files),true)
    assert.equal(COMMANDS_JSON.some(c=>c.name==="help"),true)
    assert.equal(COMMANDS_JSON.some(c=>c.name==="nb50"),true)
    assert.equal(COMMANDS_JSON.some(c=>["import","fitb50"].includes(c.name)),false)
    for(const c of COMMANDS_JSON)for(const o of c.options??[])if(o.name==="sgwcmaid")assert.ok("max_length" in o&&Number(o.max_length)>=link.length)
  } finally {closeServerStore();scoreDatabase().close();delete process.env.LOCAL_SCORE_DB;rmSync(folder,{recursive:true,force:true})}
})
