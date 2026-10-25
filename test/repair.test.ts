import assert from "node:assert/strict"
import test from "node:test"
import { buildChartIndex, computeB50, type B50Input } from "../src/b50/compute.js"
import { createMemoryProviderStores, createMemoryScoreStore } from "../src/store/memory.js"
import { startDfAuthorization, subjectRef, getDfAccessToken, clearDfTokenCache } from "../src/df/oauth.js"
import { fetchPlayer } from "../src/lxns/client.js"
import { startLxAuthorization, completeLxAuthorization, authorizedLxConfig } from "../src/lxns/oauth.js"
import type { MigrateSuccess } from "../src/migrate-client.js"
import { extractPlayerProfile } from "../src/local/profile.js"
import { verifyDfRecords, verifyLxRecords } from "../src/verification.js"
import { lxnsBestsToB50 } from "../src/lxns/bests.js"
import { closeAppStore, openTestStore } from "./helpers.js"

await openTestStore()
test.after(() => closeAppStore())

const input = (musicId: number, more: Partial<B50Input> = {}): B50Input => ({ musicId, level: 3, achievement: 1005000, dxScore: 1000, fc: "", fs: "", ...more })
const catalog = () => buildChartIndex([
  { id: 30, title: "旧曲双谱面", version: 10000, difficulties: {
    standard: [{difficulty:3,level:"13",level_value:13,version:10000}], dx:[{difficulty:3,level:"14",level_value:14,version:25500}] } },
  { id: 1842, title: "Synthesis.", version:25500, difficulties: { dx:[{difficulty:3,level:"14+",level_value:14.6,version:25500}] } },
])
test("DX +10000 mapping, explicit type, dedupe and 1.56 new chart split", () => {
  const result = computeB50([input(11842,{type:"DX"}), input(10030,{type:"DX"}), input(30,{type:"SD"}), input(11842,{type:"DX",achievement:970000})], catalog(), {newVersionFrom:25500})
  assert.equal(result.missing,0)
  assert.equal(result.b15.length,2)
  assert.equal(result.b35.length,1)
  assert.equal(result.b15[0].musicId,1842)
  assert.equal(result.b15[0].ra,328)
  assert.equal(computeB50([input(1842,{type:"SD"})],catalog(),{newVersionFrom:25500}).missing,1)
})
test("fit B50 uses unrounded DF fit_diff, recalculates rating, excludes absent fits", () => {
  const charts=catalog()
  charts.get("1842:3:DX")!.fitDs=14.123456
  const result=computeB50([input(11842,{ra:999}),input(30,{type:"SD"})],charts,{newVersionFrom:25500,mode:"fitb50"})
  assert.equal(result.b15[0].ds,14.123456)
  assert.equal(result.b15[0].ra,317)
  assert.equal(result.b15[0].officialDs,14.6)
  assert.equal(result.fitMissing,1)
  assert.equal(result.b35.length,0)
})
test("PC50 sorts the full library by playCount rather than rating or version", () => {
  const r=computeB50([input(11842,{playCount:3}),input(30,{type:"SD",playCount:100}),input(10030,{playCount:15})],catalog(),{newVersionFrom:25500,mode:"pc50"})
  assert.deepEqual(r.b35.map(e=>e.playCount),[100,15,3])
  assert.equal(r.b35[0].type,"SD")
})
test("PC50 includes played zero-score and retired utage charts", () => {
  const charts=catalog()
  charts.set("100508:0:DX",{musicId:100508,level:0,type:"DX",title:"宴",ds:0,version:26000,disabled:true,levelLabel:"13?"})
  const r=computeB50([input(100508,{level:0,achievement:0,playCount:300}),input(11842,{playCount:3})],charts,{newVersionFrom:25500,versionTo:26000,mode:"pc50"})
  assert.deepEqual(r.b35.map(e=>e.playCount),[300,3])
})
test("cached LX B50 candidates are repartitioned using current chart versions",()=>{
  const r=lxnsBestsToB50({standard:[{id:1842,type:"dx",level_index:3,achievements:100.5,dx_score:100}],dx:[{id:30,type:"standard",level_index:3,achievements:100,dx_score:100}]},catalog(),{newVersionFrom:25500})
  assert.equal(r.b15[0].musicId,1842)
  assert.equal(r.b35[0].musicId,30)
})
test("score store keeps whitelisted scores, persists PC, does not add cumulative counts, isolates users/account switches", async () => {
  const store=createMemoryScoreStore()
  const packageFor=(id:number,count:number,ach=1000000)=>({source:{userId:id,userName:"Tester"},data:{pull:{music:{userMusicDetailList:[{musicId:11842,level:3,achievement:ach,playCount:count,deluxscoreMax:123,token:"must-not-save"}]}}}} as unknown as MigrateSuccess)
  await store.save("a",packageFor(1,20))
  await store.save("a",packageFor(1,20,970000))
  assert.equal((await store.get("a"))!.inputs[0].playCount,20)
  assert.equal((await store.get("a"))!.inputs[0].achievement,1000000)
  assert.equal(JSON.stringify(await store.get("a")).includes("must-not-save"),false)
  assert.equal(await store.get("b"),null)
  await store.save("a",packageFor(2,1,800000))
  assert.equal((await store.get("a"))!.inputs[0].playCount,1)
})
test("game nickname/icon/nameplate are stored per Discord user and no credential field is kept", async () => {
  const store=createMemoryScoreStore()
  const data={source:{userId:1,userName:"旧昵称"},data:{pull:{userData:{userData:[{userName:"玩家新昵称",iconId:550201,nameplateId:550201,playerRating:15300,accessCode:"must-not-save"}]},music:{userMusicDetailList:[]}}}} as unknown as MigrateSuccess
  await store.save("u",data)
  assert.deepEqual((await store.get("u"))!.profile,{name:"玩家新昵称",iconId:550201,nameplateId:550201,rating:15300})
  assert.equal(JSON.stringify(await store.get("u")).includes("must-not-save"),false)
  assert.deepEqual(extractPlayerProfile({...data,data:{...data.data,pull:{userData:{userName:"对象形态",iconId:"200201",plateId:200201}}}}),{name:"对象形态",iconId:200201,nameplateId:200201,rating:undefined})
})
test("readback accepts better remote bests but reports missing or weaker achievements/DX/combo",()=>{
  const e={title:"Synthesis.",type:"DX",level_index:3,achievements:100,dxScore:123,fc:"fcp",fs:"fs"}
  assert.deepEqual(verifyDfRecords([e],{records:[{...e,achievements:100.5,dxScore:124,fc:"app",fs:"fsdp"}]}),{verified:1,total:1})
  assert.equal(verifyDfRecords([e],{records:[{...e,dxScore:122}]}).verified,0)
  assert.equal(verifyLxRecords([{id:1842,type:"dx",level_index:3,achievements:100,dx_score:123,fc:"fcp",fs:null}],[]).verified,0)
})
test("DF web authorization sends PKCE and only prober scopes, without device-flow fallbacks", () => {
  const cfg={clientId:"app",clientSecret:"fixture",authUrl:"https://auth.test"}
  const { url, id } = startDfAuthorization(cfg,"https://kohad-bot.example/oauth-callback/diving-fish","openid profile prober.records.read prober.records.write","discord-user")
  const u=new URL(url)
  assert.equal(u.origin+u.pathname,"https://auth.test/oauth/authorize")
  assert.equal(u.searchParams.get("response_type"),"code")
  assert.equal(u.searchParams.get("scope"),"prober.records.read prober.records.write")
  assert.equal(u.searchParams.get("code_challenge_method"),"S256")
  assert.match(u.searchParams.get("state")??"",/^[a-f0-9]{48}$/)
  assert.match(id,/^[a-f0-9]{24}$/)
})
test("DF concurrent token exchange is single flight and caches per application", async t=>{
  await clearDfTokenCache();let calls=0
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({access_token:"fixture",scope:"prober.records.read",expires_in:300})})
  const cfg={clientId:"app",clientSecret:"fixture",authUrl:"https://auth.test"}
  await Promise.all(Array.from({length:8},()=>getDfAccessToken(cfg,"u","prober.records.read")))
  assert.equal(calls,1)
  await getDfAccessToken({...cfg,clientId:"another-app"},"u","prober.records.read")
  assert.equal(calls,2)
  await clearDfTokenCache()
  // The cache lives in the shared Kv, so clearing it forces a new exchange.
  await getDfAccessToken(cfg,"u","prober.records.read")
  assert.equal(calls,3)
})
test("LXNS keeps friend code digits and matches credential type to endpoint/header", async t=>{
  let url="",auth=""
  t.mock.method(globalThis,"fetch",async(u:unknown,opts:RequestInit)=>{url=String(u);auth=(opts.headers as Record<string,string>).authorization;return new Response('{"success":true,"code":200,"data":{"name":"Tester","friend_code":123456789012345,"rating":15000}}')})
  const player=await fetchPlayer({devToken:"dev-fixture",apiBase:"https://lx.test"},"123456789012345")
  assert.equal(player.friend_code,"123456789012345")
  assert.equal(url,"https://lx.test/api/v0/maimai/player/123456789012345")
  assert.equal(auth,"dev-fixture")
  await fetchPlayer({devToken:"",apiBase:"https://lx.test",accessToken:"user-fixture"},0)
  assert.equal(url,"https://lx.test/api/v0/user/maimai/player")
  assert.equal(auth,"Bearer user-fixture")
})
test("LXNS rejects HTTP 200 invalid JSON instead of binding an empty player",async t=>{
  t.mock.method(globalThis,"fetch",async()=>new Response("<html>bad gateway</html>"))
  await assert.rejects(fetchPlayer({devToken:"fixture",apiBase:"https://lx.test"},"123456789012345"),/无效 JSON/)
})
test("LXNS enforces exactly 15 digits before requesting and preserves leading zeroes",async t=>{
  let calls=0
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({success:true,code:200,data:{name:"Tester",friend_code:"012345678901234",rating:1}})})
  const cfg={devToken:"fixture",apiBase:"https://lx.test"}
  await assert.rejects(fetchPlayer(cfg,"123456789012"),/15 位/)
  await assert.rejects(fetchPlayer(cfg,"1234567890123456"),/15 位/)
  assert.equal(calls,0)
  assert.equal((await fetchPlayer(cfg,"012345678901234")).friend_code,"012345678901234")
})
test("LX OAuth verifies state and persists rotated refresh tokens with one concurrent refresh",async t=>{
  const store=createMemoryProviderStores().lxns
  const cfg={clientId:"app",clientSecret:"fixture",apiBase:"https://lx.test",redirectUri:"https://app.test/callback"}
  let calls=0
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({access_token:"new-access",refresh_token:"new-refresh",expires_in:900,scope:"read_player write_player"})})
  const session=startLxAuthorization(cfg,"u")
  await assert.rejects(completeLxAuthorization(cfg,"u",session.id,"https://app.test/callback?code=abcdefgh&state=wrong"),/state/)
  const state=new URL(session.url).searchParams.get("state")
  const token=await completeLxAuthorization(cfg,"u",session.id,`https://app.test/callback?code=abcdefgh&state=${state}`)
  assert.equal(token.refreshToken,"new-refresh")
  await store.set("u",{friendCode:"123456789012345",name:"Tester",boundAt:"",method:"oauth",accessToken:"old-access",refreshToken:"old-refresh",expiresAt:1})
  await Promise.all([authorizedLxConfig(cfg,"u",store),authorizedLxConfig(cfg,"u",store)])
  assert.equal(calls,2)
  assert.equal((await store.get("u"))!.refreshToken,"new-refresh")
})
