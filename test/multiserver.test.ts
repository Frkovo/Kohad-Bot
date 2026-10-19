import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { MessageFlags, type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction, type ButtonInteraction } from "discord.js"
import { COMMANDS_JSON } from "../src/commands.js"
import { SERVER_CHOICES, resolveServer, UserError, type Snapshot, type ScoreRecord } from "../src/multiserver/registry.js"
import { createServerStore, serverStore, closeServerStore, seal, unseal } from "../src/multiserver/store.js"
import { regionCatalog, calculateRemote, type DxData } from "../src/multiserver/catalog.js"
import { netRating } from "../src/multiserver/rating.js"
import { computeB50 } from "../src/b50/compute.js"
import { NetClient, accountKey, parseMusicPage, parseCards } from "../src/multiserver/net.js"
import { fetchPrivateSnapshot, privateEndpoint } from "../src/multiserver/private.js"
import { syncRemote, cancelSync } from "../src/multiserver/sync.js"
import { handleServerCommand, handleServerModal, handleServerSelect, handleServerButton, handleRemoteB50 } from "../src/multiserver/interactions.js"
import { handleB50, handleBindLx, handleBindDf } from "../src/handlers.js"
import { createQueue } from "../src/queue.js"
import type { BotConfig } from "../src/config.js"

const record: ScoreRecord = { title: "Fixture", type: "DX", level: 3, achievement: 1005000, dxScore: 2900, fc: "app", fs: "fsdp", playCount: 17, ds: 14.8, version: 25, isNew: true }
const snapshot = (key = "account-a"): Snapshot => ({ accountKey: key, profile: { name: "Fixture" }, records: [{ ...record }], fetchedAt: new Date().toISOString(), source: "private_api", countsComplete: true })
const cfg = { allowedUserIds: new Set<string>(), maxPendingReads: 9, pullConcurrency: 3 } as BotConfig
function scopedEnv(values: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key,value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  return () => { for (const [key,value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}
async function withStore(run: () => Promise<void>) {
  const folder = mkdtempSync(path.join(tmpdir(), "kohad-servers-"))
  const restore = scopedEnv({ LOCAL_SCORE_DB: path.join(folder, "scores.sqlite"), B50_AUTH_KEY: randomBytes(32).toString("base64"), B50_AUTH_KEY_FILE: undefined })
  try { await run() } finally { closeServerStore(); restore(); rmSync(folder, { recursive: true, force: true }) }
}
function interaction(name: string, options: Record<string, string | boolean | null> = {}, user = "user-a") {
  const messages: any[] = [], modals: any[] = []
  const value = {
    commandName: name, user: { id: user }, deferred: false, replied: false, ephemeral: null as boolean | null,
    options: { getString: (key: string) => typeof options[key] === "string" ? options[key] : null, getBoolean: (key: string) => typeof options[key] === "boolean" ? options[key] : null },
    reply: async (message: any) => { value.replied = true; value.ephemeral = message.flags === MessageFlags.Ephemeral; messages.push(message) },
    deferReply: async (message?: any) => { value.deferred = true; value.ephemeral = message?.flags === MessageFlags.Ephemeral },
    editReply: async (message: any) => { messages.push(message) },
    followUp: async (message: any) => { messages.push({ ...message, followUp: true }) },
    showModal: async (modal: any) => { modals.push(modal.toJSON()) },
  }
  return { value, messages, modals, command: value as unknown as ChatInputCommandInteraction }
}
const diffNames = ["basic","advanced","expert","master","remaster"]
const musicPage = (level: number) => '<form><input name="genre"></form><div class="w_450 m_15 p_r f_0"><div class="music_name_block">Fixture &amp; Song</div><div class="music_score_block w_112">100.5000%</div><div class="music_score_block w_190">2,900 / 3,000</div><img class="music_kind_icon" src="/img/music_dx.png"><img class="h_20 f_l" src="/img/diff_' + diffNames[level] + '.png"><img src="/img/applus.png"><img src="/img/fsdplus.png"></div>'
const cardsPage = '<a href="/maimai-mobile/aimeList/submit/?idx=0">card</a><form action="/maimai-mobile/aimeList/submit/"><input name="idx" value="2"></form>'
const homePage = '<div class="name_block">Player A</div><div class="rating_block">15,200</div>'
function jpFetch() {
  let authenticated = false
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetcher = async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname.endsWith("/submit/") && !url.pathname.includes("aimeList")) {
      authenticated = true
      return new Response("", { status: 302, headers: { location: "/maimai-mobile/aimeList/", "Set-Cookie": "jpSession=fixture-session; Secure; HttpOnly; Path=/maimai-mobile/" } })
    }
    if (!authenticated) return new Response('<form><input name="token" value="fixture-csrf"><input name="password"></form>')
    if (url.pathname.endsWith("/aimeList/")) return new Response(cardsPage)
    if (url.pathname.includes("musicGenre/search")) return new Response(musicPage(Number(url.searchParams.get("diff"))))
    return new Response(homePage)
  }
  return { fetcher, calls }
}
function privateResponse(overrides: Record<string, unknown> = {}) {
  return { authenticated: true, complete: true, countsComplete: true, version: "Private Fixture", account: { id: "private-a", name: "Private Player", accessCode: "must-not-store" }, records: [{ ...record, password: "must-not-store" }], ...overrides }
}

test("all B50 commands expose three enabled servers; explicit choices never change preferences", async () => {
  assert.deepEqual(SERVER_CHOICES.map(c => c.value), ["cn","jp","intl","mumur"])
  for (const name of ["server","bind","sync","unbind","b50","nb50","pc50"]) {
    const option = COMMANDS_JSON.find(c => c.name === name)!.options!.find(o => o.name === "server") as any
    assert.deepEqual(option.choices.map((c: any)=>({name:c.name,value:c.value})), SERVER_CHOICES)
  }
  await withStore(async () => {
    assert.equal(serverStore().preferred("user-a"), "cn")
    const set = interaction("server", { server: "intl" })
    await handleServerCommand(set.command, cfg)
    assert.equal(set.messages[0].flags, MessageFlags.Ephemeral)
    assert.equal(serverStore().preferred("user-a"), "intl")
    assert.equal(serverStore().preferred("user-b"), "cn")
    assert.equal(resolveServer("jp", serverStore().preferred("user-a")), "jp")
    assert.throws(() => resolveServer("https://invalid.test", "cn"), UserError)
    assert.equal(resolveServer("mumur", "cn"), "mumur")
    assert.throws(() => resolveServer("missless", "cn"), /旁路/)
    assert.equal(resolveServer(null, "missless"), "cn")
    const query = interaction("nb50", { server: "jp" })
    await handleB50(query.command, cfg, createQueue(1), new Map())
    assert.match(query.messages[0].content, /拟合定数/)
    assert.equal(serverStore().preferred("user-a"), "intl")
    const defaultQuery = interaction("b50")
    await handleB50(defaultQuery.command, cfg, createQueue(1), new Map())
    assert.match(defaultQuery.messages[0].content, /国际服/)
    assert.equal(defaultQuery.messages[0].flags, MessageFlags.Ephemeral)
  })
})
test("AES-GCM credentials cannot be swapped between users, servers or binding revisions", () => {
  const key = randomBytes(32), context = JSON.stringify(["user-a","intl",1])
  const auth = { username: "fixture-sega", password: "fixture-password", cookies: "fixture-cookie" }
  const encrypted = seal(auth, key, context)
  assert.equal(encrypted.includes(auth.password), false)
  assert.deepEqual(unseal(encrypted,key,context), auth)
  for (const other of [JSON.stringify(["user-b","intl",1]),JSON.stringify(["user-a","jp",1]),JSON.stringify(["user-a","intl",2])]) assert.throws(() => unseal(encrypted,key,other), UserError)
  assert.throws(() => unseal(encrypted,randomBytes(32),context), UserError)
  const envelope = JSON.parse(encrypted); envelope.body = Buffer.from("tampered").toString("base64")
  assert.throws(() => unseal(JSON.stringify(envelope),key,context), UserError)
  assert.notEqual(seal(auth,key,context), encrypted)
})
test("server bindings persist encrypted credentials and isolate caches; rebind/unbind reject stale writes", async () => {
  await withStore(async () => {
    const store = serverStore(), auth = { password: "synthetic-private-password" }
    const revision = store.bind("user-a","intl","account-a","Intl Player",auth)
    store.save("user-a","intl",revision,snapshot())
    store.bind("user-a","jp","account-b","JP Player",auth)
    const reader = new DatabaseSync(process.env.LOCAL_SCORE_DB!)
    try {
      const row = reader.prepare("SELECT encrypted_auth FROM server_bindings WHERE server='intl'").get()
      assert.equal(String(row!.encrypted_auth).includes(auth.password), false)
    } finally { reader.close() }
    assert.deepEqual(store.credentials("user-a","intl"),auth)
    assert.equal(store.snapshot("user-a","jp"),null)
    assert.equal(store.snapshot("user-b","intl"),null)
    const next = store.bind("user-a","intl","account-c","Other Player",auth,revision)
    assert.equal(store.snapshot("user-a","intl"),null)
    assert.throws(() => store.save("user-a","intl",revision,snapshot()),UserError)
    store.save("user-a","intl",next,snapshot("account-c"))
    store.unbind("user-a","intl")
    assert.equal(store.credentials("user-a","intl"),null)
    store.updateCredentials("user-a","intl",next,auth)
    assert.equal(store.credentials("user-a","intl"),null)
    assert.equal(store.snapshot("user-a","intl")!.accountKey,"account-c")
    assert.throws(() => store.save("user-a","intl",next,snapshot("account-c")),UserError)
    store.unbind("user-a","missless")
    assert.throws(() => store.bind("user-a","missless","x","x",auth,0),UserError)
    closeServerStore()
    assert.equal(serverStore().snapshot("user-a","intl")!.accountKey,"account-c")
    assert.equal(serverStore().credentials("user-a","intl"),null)
  })
})
test("missing persistent master key is not regenerated over existing bindings", () => {
  const folder = mkdtempSync(path.join(tmpdir(),"kohad-key-")), file = path.join(folder,"scores.sqlite"), keyFile = path.join(folder,"key")
  const restore = scopedEnv({ B50_AUTH_KEY: undefined, B50_AUTH_KEY_FILE: keyFile })
  let store = createServerStore(file)
  try {
    store.bind("u","intl","a","A",{ password:"fixture" })
    assert.equal(readFileSync(keyFile).length,32)
    store.close(); unlinkSync(keyFile); store = createServerStore(file)
    assert.throws(() => store.credentials("u","intl"),/密钥文件缺失/)
  } finally { store.close(); restore(); rmSync(folder,{recursive:true,force:true}) }
  const bad = createServerStore(":memory:",Buffer.alloc(5))
  try { assert.throws(() => bad.bind("u","jp","a","A",{password:"fixture"}),UserError) } finally { bad.close() }
})
test("NET catalogue applies regional availability, version constants and CiRCLE two-release B15", () => {
  const sheet = (version: string, intl = true, type = "dx") => ({ type, difficulty:"master", internalLevelValue:15, level:"15", version, regions:{jp:true,intl}, multiverInternalLevelValue:{"CiRCLE":14.8} })
  const data: DxData = { updateTime:"fixture",songs:[
    {songId:"old",title:"Shared",sheets:[sheet("PRiSM",true,"std"),sheet("PRiSM")]},
    {songId:"previous",title:"Previous",sheets:[sheet("PRiSM PLUS")]},
    {songId:"current",title:"Current",sheets:[sheet("CiRCLE")]},
    {songId:"future",title:"Future",sheets:[sheet("CiRCLE PLUS")]},
    {songId:"jp-only",title:"JP only",sheets:[sheet("CiRCLE",false)]},
  ] }
  const catalog = regionCatalog("intl","CiRCLE",data)
  assert.equal(catalog.index.size,4)
  assert.equal(regionCatalog("jp","CiRCLE",data).index.size,5)
  assert.equal([...catalog.index.values()].every(c=>c.ds===14.8),true)
  const inputs = [...catalog.index].map(([key,chart])=>({...record,musicId:1,chartKey:key,type:chart.type}))
  const result = computeB50(inputs,catalog.index,{newVersionFrom:25,useChartBuckets:true,ratingPolicy:"net"})
  assert.deepEqual(result.b15.map(r=>r.title).sort(),["Current","Previous"])
  assert.equal(result.b35.length,2) // Same numeric ID and title, SD and DX are still distinct.
  assert.equal(result.b35[0].ra,netRating(14.8,record.achievement,record.fc))
  assert.throws(()=>regionCatalog("intl","unknown",data),UserError)
})
test("ambiguous NET title matches are rejected instead of choosing another song", () => {
  const sheet = {type:"dx",difficulty:"master",internalLevelValue:14,level:"14",version:"PRiSM",regions:{intl:true,jp:true}}
  const catalog = regionCatalog("intl","CiRCLE",{ updateTime:"fixture",songs:[{songId:"a",title:"Same",sheets:[sheet]},{songId:"b",title:"Same",sheets:[sheet]}] })
  assert.equal(catalog.titles.get(JSON.stringify(["Same","DX",3])),null)
})
test("NET rating uses fine achievement boundaries and AP bonus independently of CN", () => {
  assert.equal(netRating(15,1005000,""),337)
  assert.equal(netRating(15,1005000,"app"),338)
  assert.equal(netRating(15,1004999,""),334)
  assert.equal(netRating(15,1006000,""),337)
  assert.equal(netRating(15,0,""),0)
  assert.ok(netRating(15,999999,"")<netRating(15,1000000,""))
})
test("NET HTML parser reads all fields and refuses broken/partial pages", () => {
  const rows = parseMusicPage(musicPage(3),3)
  assert.deepEqual(rows,[{title:"Fixture & Song",type:"DX",level:3,achievement:1005000,dxScore:2900,maxDxScore:3000,fc:"app",fs:"fsdp"}])
  assert.equal(parseMusicPage('<form><input name="genre"></form>',4).length,0)
  for (const html of ["<html>proxy error</html>",'<title>Maintenance</title>',musicPage(3).replace("w_450","changed"),musicPage(3).replace("music_dx.png","unknown.png"),musicPage(3).replace("100.5000%","error"),musicPage(3).replace("2,900 / 3,000","unknown"),musicPage(3).replace("100.5000%","101.0001%")]) assert.throws(()=>parseMusicPage(html,3),UserError)
  assert.throws(()=>parseMusicPage(musicPage(3),2),UserError)
  assert.deepEqual(parseCards(cardsPage+"<a href='https://outside.test/aimeList/submit/?idx=1'>bad</a>","https://maimaidx.jp/maimai-mobile/").map(c=>c.index),[0,2])
})
test("JP login submits CSRF/form credentials, retains cookies, selects card and fetches five difficulties", async t => {
  const fixture = jpFetch(); t.mock.method(globalThis,"fetch",fixture.fetcher)
  const client = new NetClient("jp"), auth = {username:"fixture-sega",password:"fixture-password",cardIndex:2,playerName:"Player A"}
  const cards = await client.start(auth)
  assert.deepEqual(cards.map(c=>c.index),[0,2])
  const scores = await client.fetchSnapshot(auth)
  const post = fixture.calls.find(c=>c.init?.method==="POST")!
  const form = new URLSearchParams(String(post.init!.body))
  assert.equal(form.get("segaId"),auth.username); assert.equal(form.get("password"),auth.password); assert.equal(form.get("token"),"fixture-csrf")
  assert.equal(fixture.calls.some(c=>c.url.href.includes(auth.password)),false)
  assert.ok(fixture.calls.some(c=>c.url.searchParams.get("idx")==="2"))
  assert.match(String((fixture.calls.at(-1)!.init!.headers as any).Cookie),/jpSession=/)
  assert.equal(scores.records.length,5)
  assert.equal(scores.countsComplete,false)
  assert.equal(scores.accountKey,accountKey("jp",JSON.stringify([auth.username,2])))
})
test("international gateway login preserves domain cookies without sending gateway cookie to NET", async t => {
  const calls: {url:URL;init?:RequestInit}[] = []
  t.mock.method(globalThis,"fetch",async(input:any,init?:RequestInit)=>{
    const url=new URL(String(input));calls.push({url,init})
    if(url.hostname==="lng-tgk-aime-gw.am-all.net") {
      if(init?.method==="POST")return new Response("",{status:302,headers:{location:"https://maimaidx-eng.com/maimai-mobile/callback/","Set-Cookie":"gw=fixture; Secure; Path=/"}})
      return new Response("<form></form>",{headers:{"Set-Cookie":"gwStart=fixture; Secure; Path=/"}})
    }
    if(url.pathname.endsWith("/callback/"))return new Response(cardsPage,{headers:{"Set-Cookie":"net=fixture; Secure; Path=/"}})
    if(url.pathname.includes("musicGenre/search"))return new Response(musicPage(Number(url.searchParams.get("diff"))))
    return new Response(homePage)
  })
  const client=new NetClient("intl"),auth={username:"fixture",password:"synthetic-password",cardIndex:0}
  assert.equal((await client.start(auth)).length,2)
  assert.equal((await client.fetchSnapshot(auth)).records.length,5)
  const post=calls.find(c=>c.init?.method==="POST")!,form=new URLSearchParams(String(post.init!.body))
  assert.equal(form.get("sid"),auth.username);assert.equal(form.get("retention"),"1")
  assert.match(String((post.init!.headers as any).Cookie),/gwStart=/)
  for(const c of calls.filter(c=>c.url.hostname==="maimaidx-eng.com"))assert.doesNotMatch(String((c.init!.headers as any).Cookie),/gw(?:Start)?=/)
  assert.match(String((calls.at(-1)!.init!.headers as any).Cookie),/net=/)
})
test("NET rejects unapproved redirects before another request and hides provider error bodies", async t => {
  let calls=0
  t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response("",{status:302,headers:{location:"https://outside.test/steal"}})})
  await assert.rejects(new NetClient("intl").request("https://maimaidx-eng.com/"),UserError)
  assert.equal(calls,1)
  t.mock.restoreAll()
  t.mock.method(globalThis,"fetch",async()=>new Response("synthetic-secret-token",{status:500}))
  await assert.rejects(new NetClient("jp").request("https://maimaidx.jp/"),error=>error instanceof UserError&&!error.message.includes("synthetic-secret-token"))
})
test("an expired NET session reauthenticates once; a changed card profile requires reconfirmation", async t => {
  const fixture=jpFetch();t.mock.method(globalThis,"fetch",fixture.fetcher)
  await new NetClient("jp").fetchSnapshot({username:"fixture",password:"fixture",cardIndex:2,playerName:"Player A"})
  assert.equal(fixture.calls.filter(c=>c.init?.method==="POST").length,1)
  fixture.calls.length=0
  await assert.rejects(new NetClient("jp").fetchSnapshot({username:"fixture",password:"fixture",cardIndex:2,playerName:"Different player"}),/资料与绑定时不一致/)
  assert.equal(fixture.calls.some(c=>c.url.pathname.includes("musicGenre/search")),false)
})
test("private adapter fails closed when unconfigured and validates independent score fields and counts", async t => {
  const restore=scopedEnv({MISSLESS_SCORE_ENDPOINT:undefined,MISSLESS_ADAPTER_TOKEN:"fixture-adapter-token"})
  try {
    assert.throws(()=>privateEndpoint("missless"),/只读接口尚未配置/)
    process.env.MISSLESS_SCORE_ENDPOINT="https://private.fixture/read"
    let response=privateResponse()
    t.mock.method(globalThis,"fetch",async(input:any,init?:RequestInit)=>{
      assert.equal(String(input),"https://private.fixture/read")
      assert.deepEqual(JSON.parse(String(init?.body)),{accessCode:"synthetic-access-code"})
      assert.equal((init?.headers as any).Authorization,"Bearer fixture-adapter-token")
      assert.equal(init?.redirect,"error")
      return Response.json(response)
    })
    const result=await fetchPrivateSnapshot("missless",{accessCode:"synthetic-access-code"})
    assert.equal(result.countsComplete,true)
    assert.equal(JSON.stringify(result).includes("must-not-store"),false)
    assert.equal(result.accountKey,accountKey("missless","private-a"))
    response=privateResponse({records:[{...record,playCount:undefined}]})
    assert.equal((await fetchPrivateSnapshot("missless",{accessCode:"synthetic-access-code"})).countsComplete,false)
    for(const bad of [{complete:false},{authenticated:false},{records:[{...record,ds:undefined}]},{records:[{...record,playCount:-1}]}]) {
      response=privateResponse(bad)
      await assert.rejects(fetchPrivateSnapshot("missless",{accessCode:"synthetic-access-code"}),UserError)
    }
  } finally {restore()}
})
test("private PC50 refuses incomplete counts and private Rating rules require explicit configuration", async t => {
  const restore=scopedEnv({MISSLESS_SCORE_ENDPOINT:"https://private.fixture/read",MISSLESS_RATING_POLICY:undefined})
  try {
    t.mock.method(globalThis,"fetch",async()=>Response.json(privateResponse({records:[{...record,playCount:undefined}]})))
    const result=await fetchPrivateSnapshot("missless",{accessCode:"fixture"})
    assert.equal(result.countsComplete,false)
    assert.throws(()=>calculateRemote("missless",result,"pc50"),/完整累计/)
    assert.throws(()=>calculateRemote("missless",result,"b50"),/RATING_POLICY/)
    process.env.MISSLESS_RATING_POLICY="net"
    assert.equal(calculateRemote("missless",result,"b50").result.b15.length,1)
    assert.throws(()=>calculateRemote("intl",snapshot(),"fitb50"),/拟合/)
  } finally {restore()}
})
test("single-flight NET sync retains old snapshot on incomplete data and discards in-flight rebind results", async t => {
    await withStore(async()=>{
      const fixture=jpFetch(),auth={username:"fixture",password:"fixture",cardIndex:2,playerName:"Player A"}
      const store=serverStore(),key=accountKey("jp",JSON.stringify(["fixture",2])),revision=store.bind("user-a","jp",key,"Player A",auth)
      store.save("user-a","jp",revision,snapshot(key))
      let release!:()=>void,calls=0
      const wait=new Promise<void>(resolve=>{release=resolve})
      t.mock.method(globalThis,"fetch",async(input:any,init?:RequestInit)=>{calls++;await wait;return fixture.fetcher(input,init)})
      const first=syncRemote("user-a","jp"),second=syncRemote("user-a","jp")
      assert.equal(calls,1)
      release();assert.deepEqual(await first,await second)
      assert.equal(fixture.calls.filter(c=>c.url.pathname.includes("musicGenre/search")).length,5)
      await assert.rejects(syncRemote("user-a","jp"),/不足 1 分钟/)
      store.bind("user-a","jp",key,"Player A",auth)
      t.mock.restoreAll()
      t.mock.method(globalThis,"fetch",async(input:any,init?:RequestInit)=>new URL(String(input)).searchParams.get("diff")==="4"?new Response("broken page"):fixture.fetcher(input,init))
      const old=store.snapshot("user-a","jp")
      await assert.rejects(syncRemote("user-a","jp"),/结构无法识别/)
      assert.deepEqual(store.snapshot("user-a","jp"),old)
      store.bind("user-a","jp",key,"Player A",auth)
      t.mock.restoreAll()
      let finish!:()=>void
      const pending=new Promise<void>(resolve=>{finish=resolve})
      t.mock.method(globalThis,"fetch",async(input:any,init?:RequestInit)=>{await pending;return fixture.fetcher(input,init)})
      const stale=syncRemote("user-a","jp")
      cancelSync("user-a","jp")
      store.bind("user-a","jp","new-account","New",{...auth,password:"new-fixture"})
      finish();await assert.rejects(stale,/换绑或解绑/)
      assert.equal(store.snapshot("user-a","jp"),null)
      assert.equal(store.credentials("user-a","jp")!.password,"new-fixture")
    })
})
test("Discord native binding uses modal/select/confirmation; buttons enforce owner and selected card", async t => {
  const fixture=jpFetch();t.mock.method(globalThis,"fetch",fixture.fetcher)
  await withStore(async()=>{
    const bind=interaction("bind",{server:"jp"})
    await handleServerCommand(bind.command,cfg)
    assert.equal(bind.modals[0].custom_id,"ms:credentials:jp")
    assert.equal(JSON.stringify(bind.modals).includes("http"),false)
    assert.match(JSON.stringify(bind.modals),/不遮罩/)
    const form=interaction(""), fields={username:"fixture",password:"synthetic-password"}
    Object.assign(form.value,{customId:"ms:credentials:jp",fields:{getTextInputValue:(key:string)=>fields[key as keyof typeof fields]}})
    await handleServerModal(form.value as unknown as ModalSubmitInteraction,cfg)
    const selectId=form.messages[0].components[0].toJSON().components[0].custom_id
    assert.equal(serverStore().credentials("user-a","jp"),null) // Credentials not persisted before explicit confirmation.
    const intruder=interaction("",{},"user-b")
    Object.assign(intruder.value,{customId:selectId,values:["2"]})
    await handleServerSelect(intruder.value as unknown as StringSelectMenuInteraction,cfg)
    assert.match(intruder.messages[0].content,/不属于你/)
    const select=interaction("")
    Object.assign(select.value,{customId:selectId,values:["2"]})
    await handleServerSelect(select.value as unknown as StringSelectMenuInteraction,cfg)
    const confirmId=select.messages[0].components[0].toJSON().components[0].custom_id
    const stale=interaction("")
    Object.assign(stale.value,{customId:confirmId.replace(/:2$/,":0")})
    await handleServerButton(stale.value as unknown as ButtonInteraction,cfg)
    assert.match(stale.messages[0].content,/选择已变化/)
    const confirm=interaction("")
    Object.assign(confirm.value,{customId:confirmId})
    await handleServerButton(confirm.value as unknown as ButtonInteraction,cfg)
    assert.equal(serverStore().credentials("user-a","jp")!.cardIndex,2)
    assert.equal(serverStore().credentials("user-a","jp")!.playerName,"Player A")
    assert.equal(serverStore().snapshot("user-a","jp")!.records.length,5)
    const again=interaction("")
    Object.assign(again.value,{customId:confirmId})
    await handleServerButton(again.value as unknown as ButtonInteraction,cfg)
    assert.match(again.messages[0].content,/已过期/)
  })
})
test("DC-only legacy binding entry points never generate a browser link", async () => {
  const df=interaction("binddf")
  await handleBindDf(df.command,cfg)
  assert.equal(JSON.stringify(df.messages).includes("https://"),false)
  const lx=interaction("bindlx")
  await handleBindLx(lx.command,{...cfg,lxDevToken:"fixture"} as BotConfig)
  assert.equal(lx.modals[0].custom_id,"lx:bind")
  assert.equal(JSON.stringify(lx.modals).includes("https://"),false)
})
test("NET errors after public B50 ACK are delivered ephemerally; incomplete capabilities fail before fetching", async t => {
    await withStore(async()=>{
      serverStore().bind("user-a","jp","fixture","Fixture",{username:"fixture",password:"synthetic-password",cardIndex:2})
      t.mock.method(globalThis,"fetch",async()=>new Response("synthetic-sensitive-response",{status:503}))
      const query=interaction("b50",{refresh:true,public:true})
      await handleRemoteB50(query.command,cfg,"jp")
      assert.equal(query.value.ephemeral,false)
      assert.match(query.messages[0].content,/具体原因已私密发送/)
      assert.equal(query.messages[1].followUp,true)
      assert.equal(query.messages[1].flags,MessageFlags.Ephemeral)
      assert.equal(JSON.stringify(query.messages).includes("synthetic-password"),false)
      assert.equal(JSON.stringify(query.messages).includes("synthetic-sensitive-response"),false)
      t.mock.method(globalThis,"fetch",()=>{throw new Error("must not fetch")})
      const pc=interaction("pc50")
      await handleRemoteB50(pc.command,cfg,"intl")
      assert.match(pc.messages[0].content,/不提供完整累计/)
      const denied=interaction("bind",{server:"jp"})
      await handleServerCommand(denied.command,{...cfg,allowedUserIds:new Set(["another-user"])})
      assert.equal(denied.modals.length,0)
      assert.match(denied.messages[0].content,/白名单/)
    })
})
test("NET rejects a partial five-page update without replacing the previous snapshot",async t=>{
  const fixture=jpFetch()
  await withStore(async()=>{
    const key=accountKey("jp",JSON.stringify(["fixture",2])),store=serverStore()
    const revision=store.bind("user-a","jp",key,"Player A",{username:"fixture",password:"fixture",cardIndex:2,playerName:"Player A"})
    store.save("user-a","jp",revision,snapshot(key))
    const before=store.snapshot("user-a","jp")
    t.mock.method(globalThis,"fetch",async(input:any,init?:RequestInit)=>{
      const url=new URL(String(input))
      return url.searchParams.get("diff")==="4"?new Response("broken last page"):fixture.fetcher(input,init)
    })
    await assert.rejects(syncRemote("user-a","jp"),/结构无法识别/)
    assert.deepEqual(store.snapshot("user-a","jp"),before)
  })
})
test("refresh:false renders stale remote cache without a network login and does not change the default server",async t=>{
    await withStore(async()=>{
      const store=serverStore(),revision=store.bind("user-a","jp","account-a","Fixture",{username:"fixture",password:"fixture"})
      const chart=[...regionCatalog("jp").index.values()].find(c=>c.level===3)!
      const cached=snapshot();cached.records=[{...record,title:chart.title,type:chart.type,level:chart.level}];cached.fetchedAt="2000-01-01T00:00:00.000Z";store.save("user-a","jp",revision,cached)
      store.setPreferred("user-a","intl")
      const calls:string[]=[]
      t.mock.method(globalThis,"fetch",(url:any)=>{calls.push(String(url));throw new Error("artwork offline fixture")})
      const query=interaction("b50",{server:"jp",refresh:false,public:true})
      await handleB50(query.command,cfg,createQueue(1),new Map())
      assert.equal(query.value.ephemeral,false)
      assert.equal(query.messages[0].files.length,1)
      assert.match(query.messages[0].embeds[0].toJSON().title,/日服/)
      assert.equal(calls.some(url=>new URL(url).hostname!=="shama.dxrating.net"),false)
      assert.equal(store.preferred("user-a"),"intl")
    })
})
test("NET maintenance during an explicit refresh renders the last local snapshot with a notice instead of failing",async t=>{
    await withStore(async()=>{
      const store=serverStore(),revision=store.bind("user-a","jp","account-a","Fixture",{username:"fixture",password:"fixture",cardIndex:2})
      const chart=[...regionCatalog("jp").index.values()].find(c=>c.level===3)!
      const cached=snapshot();cached.records=[{...record,title:chart.title,type:chart.type,level:chart.level}];store.save("user-a","jp",revision,cached)
      t.mock.method(globalThis,"fetch",async(url:any)=>{
        if(new URL(String(url)).hostname==="maimaidx.jp") return new Response("<html><head><title>メンテナンス中</title></head><body></body></html>",{status:200,headers:{"content-type":"text/html"}})
        throw new Error("artwork offline fixture")
      })
      const query=interaction("b50",{server:"jp",refresh:true,public:true})
      await handleB50(query.command,cfg,createQueue(1),new Map())
      assert.equal(query.messages.some(m=>m.followUp),false)
      assert.equal(query.messages[0].files.length,1)
      assert.match(query.messages[0].embeds[0].toJSON().description??"",/正在维护/)
    })
})
test("automatic sync cannot fall back to the old account cache after an in-flight rebind",async t=>{
    await withStore(async()=>{
      const store=serverStore(),revision=store.bind("user-a","jp","account-a","Fixture",{username:"fixture",password:"fixture",cardIndex:2})
      const cached=snapshot();cached.fetchedAt="2000-01-01T00:00:00.000Z";store.save("user-a","jp",revision,cached)
      let release!:()=>void
      const wait=new Promise<void>(resolve=>{release=resolve})
      t.mock.method(globalThis,"fetch",async()=>{await wait;return new Response("unavailable",{status:503})})
      const query=interaction("b50",{public:true,refresh:true})
      const running=handleRemoteB50(query.command,cfg,"jp")
      await new Promise<void>(resolve=>setImmediate(resolve))
      store.bind("user-a","jp","new-account","New Player",{username:"fixture",password:"new-fixture",cardIndex:2})
      release();await running
      assert.equal(query.messages.some(m=>m.files),false)
      assert.match(query.messages.find(m=>m.followUp).content,/已换绑/)
    })
})
test("bypassed private servers cannot be reached from old commands, buttons, modals or configured sync endpoints",async t=>{
  const restore=scopedEnv({MISSLESS_SCORE_ENDPOINT:"https://private.fixture/read"})
  try {
    await withStore(async()=>{
      let calls=0
      t.mock.method(globalThis,"fetch",()=>{calls++;throw new Error("bypassed server must not fetch")})
      for(const server of ["missless"] as const) {
        const store=serverStore(),revision=store.bind("user-a",server,"account-a","Private Fixture",{accessCode:"fixture"})
        store.save("user-a",server,revision,snapshot())
        const writer=new DatabaseSync(process.env.LOCAL_SCORE_DB!)
        try {writer.prepare("INSERT INTO server_preferences VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET server=excluded.server").run("user-a",server)} finally {writer.close()}
        assert.equal(store.preferred("user-a"),"cn")
        assert.throws(()=>store.setPreferred("user-a",server),/旁路/)
        for(const name of ["server","bind","sync","unbind"]) {
          const oldCommand=interaction(name,{server})
          await handleServerCommand(oldCommand.command,cfg)
          assert.equal(oldCommand.modals.length,0)
          assert.match(oldCommand.messages[0].content,/旁路/)
        }
        const oldQuery=interaction("b50",{server})
        await handleB50(oldQuery.command,cfg,createQueue(1),new Map())
        assert.match(oldQuery.messages[0].content,/旁路/)
        for(const action of ["bind","unbind"]) {
          const oldButton=interaction("")
          Object.assign(oldButton.value,{customId:"ms:"+action+":"+server+":"+revision})
          await handleServerButton(oldButton.value as unknown as ButtonInteraction,cfg)
          assert.match(oldButton.messages[0].content,/旁路/)
          assert.equal(oldButton.modals.length,0)
        }
        const oldModal=interaction("")
        Object.assign(oldModal.value,{customId:"ms:credentials:"+server,fields:{getTextInputValue:()=>"fixture"}})
        await handleServerModal(oldModal.value as unknown as ModalSubmitInteraction,cfg)
        assert.match(oldModal.messages[0].content,/旁路/)
        await assert.rejects(syncRemote("user-a",server),/旁路/)
        const directQuery=interaction("b50")
        await handleRemoteB50(directQuery.command,cfg,server)
        assert.match(directQuery.messages[0].content,/旁路/)
        assert.equal(store.snapshot("user-a",server)!.accountKey,"account-a")
        assert.equal(store.credentials("user-a",server)!.accessCode,"fixture")
      }
      assert.equal(calls,0)
    })
  } finally {restore()}
})
