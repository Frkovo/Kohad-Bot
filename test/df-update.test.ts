import assert from "node:assert/strict"
import test from "node:test"

import { updateRecords, UPDATE_CHUNK } from "../src/df/client.js"

// 拦截 fetch：记录每次 update_records 的批大小与鉴权头，按 respond(batchIndex) 决定返回码
async function withMockFetch(respond: (batch: number) => number, run: () => Promise<void>) {
  const original = globalThis.fetch
  const calls: Array<{ count: number; authorization?: string; importToken?: string }> = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[]
    const headers = init?.headers as Record<string, string>
    calls.push({ count: body.length, authorization: headers.authorization, importToken: headers["Import-Token"] })
    const status = respond(calls.length)
    return new Response("{}", { status })
  }) as typeof fetch
  try { await run() } finally { globalThis.fetch = original }
  return calls
}

const records = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `song${i}`, type: "SD", level_index: 0 }))

test("updateRecords splits the upload into UPDATE_CHUNK-sized batches in order", async () => {
  assert.equal(UPDATE_CHUNK, 100)
  let result: Awaited<ReturnType<typeof updateRecords>> | undefined
  const calls = await withMockFetch(() => 200, async () => {
    result = await updateRecords(records(250), { token: "tok" })
  })
  assert.deepEqual(calls.map(c => c.count), [100, 100, 50])
  assert.ok(calls.every(c => c.authorization === "Bearer tok"))
  assert.equal(result?.ok, true)
  assert.equal(result?.status, 200)
})

test("updateRecords stops at the first rejected batch and reports how many were already written", async () => {
  let result: Awaited<ReturnType<typeof updateRecords>> | undefined
  const calls = await withMockFetch(batch => (batch === 2 ? 500 : 200), async () => {
    result = await updateRecords(records(250), { token: "tok" })
  })
  // 第 2 批被拒后不应再发第 3 批
  assert.deepEqual(calls.map(c => c.count), [100, 100])
  assert.equal(result?.ok, false)
  assert.equal(result?.status, 500)
  assert.match(result?.message ?? "", /第 2\/3 批/)
  assert.match(result?.message ?? "", /前 100 条已写入/)
})

test("updateRecords sends Import-Token (not Bearer) when only an import token is given", async () => {
  const calls = await withMockFetch(() => 200, async () => {
    await updateRecords(records(1), { importToken: "imp-123" })
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].importToken, "imp-123")
  assert.equal(calls[0].authorization, undefined)
})

test("updateRecords adds the auth hint on 401/403 for the failing batch", async () => {
  let result: Awaited<ReturnType<typeof updateRecords>> | undefined
  await withMockFetch(() => 403, async () => {
    result = await updateRecords(records(3), { importToken: "imp" })
  })
  assert.equal(result?.ok, false)
  assert.match(result?.message ?? "", /第 1\/1 批/)
  assert.match(result?.message ?? "", /请检查绑定、写权限或 Import-Token/)
})
