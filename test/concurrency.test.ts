import test from "node:test"
import assert from "node:assert/strict"
import { createQueue } from "../src/queue.js"
import { createImportCoordinator, ImportBusyError, ImportQueueFullError } from "../src/import-account.js"
import { syncScores } from "../src/sync.js"
import { lxnsBindings } from "../src/lxns/bindings.js"
import { clearDfTokenCache } from "../src/df/oauth.js"
import type { MigrateSuccess } from "../src/migrate-client.js"
import type { BotConfig } from "../src/config.js"
import { renderB50 } from "../src/b50/render.js"
import { handleHelp } from "../src/handlers.js"
import type { ChatInputCommandInteraction } from "discord.js"
import { performance } from "node:perf_hooks"

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const cfg = { cooldownMs:0, migrateUrl:"https://fixture", b50NewVersion:25500, lxApiBase:"https://lx.fixture" } as BotConfig
const result = { ok:true, source:{userId:1,userName:"Fixture"}, data:{pull:{music:{userMusicDetailList:[{musicId:1,level:3,achievement:1000000,deluxscoreMax:99,playCount:10}]}},derived:{userMusicDetailList:[],userItemList:[]}},logout:{ok:true},warnings:[] } as unknown as MigrateSuccess
const skipped = {df:{status:"skipped" as const,detail:"fixture"},lxns:{status:"skipped" as const,detail:"fixture"}}

test("multiple users read concurrently, duplicate QR shares one read/sync, same-user second QR replies busy",async()=>{
  const first = deferred<MigrateSuccess>(), second = deferred<MigrateSuccess>()
  const calls:string[] = [], saved:string[] = [], synced:string[] = []
  const read=createImportCoordinator({pull:async(qr)=>{calls.push(qr);return qr==="first"?first.promise:second.promise},save:id=>saved.push(id),sync:async(_cfg,id)=>{synced.push(id);return skipped}})
  const queue=createQueue(3,2)
  const a=read("user-a","first",cfg,queue), duplicate=read("user-a","first",cfg,queue)
  const b=read("user-b","second",cfg,queue)
  await assert.rejects(read("user-a","different",cfg,queue),ImportBusyError)
  await assert.rejects(read("user-c","first",cfg,queue),ImportBusyError)
  await tick()
  assert.deepEqual(calls,["first","second"])
  second.resolve(result)
  await b
  assert.deepEqual(saved,["user-b"])
  assert.deepEqual(synced,["user-b"])
  first.resolve(result)
  const [one,two]=await Promise.all([a,duplicate])
  assert.equal(one.result,two.result)
  assert.equal(two.reused,true)
  assert.equal(saved.filter(id=>id==="user-a").length,1)
  assert.equal(synced.filter(id=>id==="user-a").length,1)
  await read("user-a","first",cfg,queue)
  assert.equal(calls.length,2)
})
test("sync never occupies the machine-read slot and local commit precedes sync",async()=>{
  const syncGate=deferred<typeof skipped>(), saved:string[]=[]
  const read=createImportCoordinator({pull:async()=>result,save:id=>saved.push(id),sync:async(_cfg,id)=>{assert.ok(saved.includes(id));return id==="a"?syncGate.promise:skipped}})
  const queue=createQueue(2,1)
  const a=read("a","qr-a",cfg,queue)
  await tick()
  const b=await read("b","qr-b",cfg,queue)
  assert.equal(b.result.ok,true)
  assert.deepEqual(saved,["a","b"])
  syncGate.resolve(skipped)
  await a
})
test("import resolves before prober sync; the user lock holds until sync settles",async()=>{
  const syncGate=deferred<typeof skipped>(), saved:string[]=[]
  const read=createImportCoordinator({pull:async()=>result,save:id=>saved.push(id),sync:async()=>syncGate.promise})
  const queue=createQueue(2,1)
  const account=await read("a","qr-a",cfg,queue)
  assert.equal(account.result.ok,true)
  assert.deepEqual(saved,["a"])
  // The caller can render B50 now; the sync promise is still pending.
  let settled=false
  account.sync!.then(()=>{settled=true})
  await tick()
  assert.equal(settled,false)
  await assert.rejects(read("a","qr-a-2",cfg,queue),ImportBusyError)
  syncGate.resolve(skipped)
  assert.deepEqual(await account.sync,skipped)
  await tick()
  assert.equal((await read("a","qr-a-3",cfg,queue)).result.ok,true)
})
test("queue failure/overflow releases capacity and user locks",async()=>{
  const failed=deferred<MigrateSuccess>()
  let calls=0
  const read=createImportCoordinator({pull:async()=>++calls===1?failed.promise:result,save:()=>{},sync:async()=>skipped})
  const queue=createQueue(1,1)
  const a=read("a","first",cfg,queue)
  await assert.rejects(read("b","full",cfg,queue),ImportQueueFullError)
  failed.reject(new Error("fixture failure"))
  await assert.rejects(a,/fixture failure/)
  await tick()
  assert.equal((await read("a","new",cfg,queue)).result.ok,true)
  assert.equal((await read("b","retry",cfg,queue)).result.ok,true)
})

test("DF upload failure cannot block LX upload/readback; requests use per-user binding and credentials",async t=>{
  clearDfTokenCache()
  const tokenGate=deferred<void>()
  let lxUploads=0, dfUploads=0
  const settings={...cfg,dfOAuthEnabled:true,dfClientId:"fixture-client",dfClientSecret:"fixture-secret",dfAuthUrl:"https://df-auth.fixture",lxDevToken:"fixture-dev-token"}
  t.mock.method(lxnsBindings,"get",id=>id==="sync-user"?{friendCode:"123456789012345",name:"Fixture",method:"friend_code",boundAt:"fixture"}:null)
  t.mock.method(globalThis,"fetch",async(input:unknown, options?:RequestInit)=>{
    const url=String(input)
    if(url.endsWith("/oauth/token"))return Response.json({access_token:"fixture-write",scope:"prober.records.write",expires_in:300})
    if(url.endsWith("/music_data"))return Response.json([{id:"1",title:"Fixture",type:"SD",ds:[1,2,3,14]}])
    if(url.includes("/song/list"))return Response.json({songs:[{id:1,title:"Fixture",version:25500,difficulties:{standard:[{difficulty:3,level:"14",level_value:14,version:25500}]}}]})
    if(url.endsWith("/update_records")) {dfUploads++;assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-write");await tokenGate.promise;return new Response("failure",{status:503})}
    if(url.endsWith("/123456789012345/scores")) {lxUploads++;assert.equal(new Headers(options?.headers).get("authorization"),"fixture-dev-token");return Response.json({success:true,code:200,data:null})}
    if(url.includes("/best?"))return Response.json({success:true,code:200,data:{id:1,type:"standard",level_index:3,achievements:100,dx_score:99,fc:null,fs:null}})
    throw new Error("unexpected fixture URL")
  })
  const work=syncScores(settings,"sync-user",result)
  for(let i=0;i<10&&lxUploads===0;i++)await tick()
  assert.equal(lxUploads,1)
  assert.equal(dfUploads,1)
  tokenGate.resolve()
  const sync=await work
  assert.equal(sync.df.status,"error")
  assert.equal(sync.lxns.status,"ok")
  assert.match(sync.lxns.detail,/回读 1\/1 通过/)
})
test("read-only DF grant is reported and never uploads",async t=>{
  clearDfTokenCache()
  let writes=0
  t.mock.method(lxnsBindings,"get",()=>null)
  t.mock.method(globalThis,"fetch",async(input:unknown)=>{
    if(String(input).endsWith("/oauth/token"))return Response.json({access_token:"fixture-read",scope:"prober.records.read"})
    writes++;throw new Error("must not upload with read-only grant")
  })
  const sync=await syncScores({...cfg,dfOAuthEnabled:true,dfClientId:"client",dfClientSecret:"secret",dfAuthUrl:"https://df-auth.fixture"},"read-only",result)
  assert.equal(sync.df.status,"skipped")
  assert.match(sync.df.detail,/写入授权/)
  assert.equal(writes,0)
})

test("heavy score rasterization does not block a second Discord ACK on the same user",async t=>{
  t.mock.method(globalThis,"fetch",async()=>{throw new Error("offline fixture")})
  const entry={musicId:1,type:"SD" as const,level:3,title:"Fixture",ds:14,achievement:1000000,dxScore:99,maxDxScore:100,fc:"",fs:"",ra:302,playCount:10}
  const result={b35:Array.from({length:35},()=>entry),b15:Array.from({length:15},()=>entry),total:15100,missing:0,fitMissing:0,mode:"b50" as const}
  const started=performance.now()
  const imageA=renderB50({title:"Fixture",result}), imageB=renderB50({title:"Fixture",result})
  await new Promise<void>(resolve=>setTimeout(resolve,80))
  let ackMs=Infinity
  const interaction={user:{id:"same-user"},deferReply:async()=>{ackMs=performance.now()-started},editReply:async()=>{}} as unknown as ChatInputCommandInteraction
  const help=handleHelp(interaction)
  await tick()
  assert.ok(ackMs<2500,`second command ACK took ${ackMs}ms (includes scheduled 80ms delay)`)
  const images=await Promise.all([imageA,imageB])
  assert.ok(images.every(image=>image.subarray(0,4).toString()==="RIFF"&&image.subarray(8,12).toString()==="WEBP"))
  await help
  t.diagnostic(`Second command ACK: ${Math.round(ackMs)} ms while two B50 images rendered`)
})
