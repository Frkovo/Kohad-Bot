// Storage contract: the same assertions run against the in-memory doubles and, when MYSQL_URL is set,
// against a real MySQL database. Flow tests use the doubles; this file is what keeps the SQL honest.
import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes } from "node:crypto"
import type { MigrateSuccess } from "../src/migrate-client.js"
import type { Snapshot } from "../src/multiserver/registry.js"
import { connectMysql, mysqlConfig } from "../src/store/mysql.js"
import { createMysqlProviderStores, createMysqlScoreStore, createMysqlServerStore } from "../src/store/mysql-stores.js"
import { createMemoryProviderStores, createMemoryScoreStore, createMemoryServerStore } from "../src/store/memory.js"
import type { ProviderStores, ScoreStore, ServerStore } from "../src/store/types.js"

type Backend = { scores: ScoreStore; servers: ServerStore; providers: ProviderStores; close: () => Promise<void> }

const packageFor = (gameId: number, count: number, achievement = 1000000, extra: Record<string, unknown> = {}) => ({
  source: { userId: gameId, userName: "Tester" },
  data: { pull: { userData: { userData: [{ userName: "Tester", iconId: 550201, plateId: 550201, playerRating: 15300, accessCode: "must-not-save" }] },
    music: { userMusicDetailList: [{ musicId: 11842, level: 3, achievement, playCount: count, deluxscoreMax: 123, token: "must-not-save", ...extra }] } } },
} as unknown as MigrateSuccess)
const snapshot = (key: string, playCount = 17): Snapshot => ({
  accountKey: key, profile: { name: "Tester" }, fetchedAt: new Date().toISOString(),
  records: [{ title: "Fixture", type: "DX", level: 3, achievement: 1005000, dxScore: 2900, fc: "app", fs: "fsdp", playCount }],
  source: "private_api", countsComplete: true,
})

async function runContract(backend: Backend, prefix: string) {
  const user = `${prefix}-user`, other = `${prefix}-other`, auth = { username: "fixture", password: "synthetic-password", cardIndex: 2 }

  // Scores: merge by max, never add; a different game account replaces the old scores; no credential fields.
  await backend.scores.save(user, packageFor(1, 20))
  await backend.scores.save(user, packageFor(1, 20, 970000))
  let account = await backend.scores.get(user)
  assert.equal(account!.inputs[0].playCount, 20)
  assert.equal(account!.inputs[0].achievement, 1000000)
  assert.deepEqual(account!.profile, { name: "Tester", iconId: 550201, nameplateId: 550201, rating: 15300 })
  assert.equal(JSON.stringify(account).includes("must-not-save"), false)
  assert.equal(await backend.scores.get(other), null)
  assert.equal(await backend.scores.has(user), true)
  await backend.scores.save(user, packageFor(2, 1, 800000))
  assert.equal((await backend.scores.get(user))!.inputs[0].playCount, 1)

  // Server bindings: encrypted credentials round-trip; a rebind bumps the revision and drops the old snapshot.
  assert.equal(await backend.servers.savedPreferred(user), null)
  assert.equal(await backend.servers.preferred(user), "cn")
  await backend.servers.setPreferred(user, "intl")
  assert.equal(await backend.servers.savedPreferred(user), "intl")
  const revision = await backend.servers.bind(user, "jp", "jp-account", "JP Player", auth)
  assert.deepEqual(await backend.servers.credentials(user, "jp"), auth)
  assert.deepEqual(await backend.servers.boundServers(user), ["jp"])
  await backend.servers.save(user, "jp", revision, snapshot("jp-account"))
  assert.equal((await backend.servers.snapshot(user, "jp"))!.records.length, 1)
  const next = await backend.servers.bind(user, "jp", "jp-account-2", "JP Player 2", auth, revision)
  assert.equal(await backend.servers.snapshot(user, "jp"), null)
  await assert.rejects(backend.servers.save(user, "jp", revision, snapshot("jp-account")), /作废/)
  await backend.servers.save(user, "jp", next, snapshot("jp-account-2"))
  await backend.servers.unbind(user, "jp")
  assert.equal(await backend.servers.credentials(user, "jp"), null)
  assert.equal((await backend.servers.snapshot(user, "jp"))!.accountKey, "jp-account-2")
  assert.deepEqual(await backend.servers.boundServers(user), [])

  // Provider credentials and tokens.
  await backend.providers.df.set(user, { nickname: "DF", boundAt: "2026-01-01", refreshToken: "refresh", scope: "prober.records.read" })
  assert.equal((await backend.providers.df.get(user))!.refreshToken, "refresh")
  assert.equal(await backend.providers.df.remove(user), true)
  assert.equal(await backend.providers.df.remove(user), false)
  assert.equal(await backend.providers.df.get(user), null)
  await backend.providers.dfImportTokens.set(user, "import-token")
  assert.equal((await backend.providers.dfImportTokens.get(user))!.token, "import-token")
  assert.equal(await backend.providers.dfImportTokens.remove(user), true)
  await backend.providers.lxns.set(user, { friendCode: "123456789012345", name: "LX", boundAt: "2026-01-01", method: "friend_code" })
  await backend.providers.lxns.set(other, { friendCode: "012345678901234", name: "LX2", boundAt: "2026-01-01", method: "oauth", accessToken: "a", refreshToken: "r", expiresAt: 1, scope: "read" })
  assert.equal((await backend.providers.lxns.get(user))!.method, "friend_code")
  assert.equal((await backend.providers.lxns.get(other))!.refreshToken, "r")
  assert.ok(await backend.providers.lxns.size() >= 2)
  assert.equal(await backend.providers.lxns.remove(user), true)
}

test("in-memory store contract", async () => {
  const backend: Backend = {
    scores: createMemoryScoreStore(), servers: createMemoryServerStore(), providers: createMemoryProviderStores(), close: async () => undefined,
  }
  await runContract(backend, `mem-${randomBytes(4).toString("hex")}`)
})

const mysqlUrl = process.env.MYSQL_URL?.trim()
test("mysql store contract", { skip: mysqlUrl ? false : "set MYSQL_URL (and a disposable database) to run the MySQL integration test" }, async () => {
  const sql = await connectMysql(mysqlConfig(), { attempts: 1, delayMs: 0 })
  try {
    const backend: Backend = {
      scores: createMysqlScoreStore(sql), servers: createMysqlServerStore(sql), providers: createMysqlProviderStores(sql), close: async () => undefined,
    }
    await runContract(backend, `my-${randomBytes(4).toString("hex")}`)
  } finally { await sql.close() }
})
