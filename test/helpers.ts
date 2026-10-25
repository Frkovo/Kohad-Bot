// Test helpers: every test file runs in its own process (node --test), so one in-memory store per file is enough.
// The MySQL implementations are exercised by test/mysql.integration.test.ts when MYSQL_URL and REDIS_URL are set.
import { closeAppStore, openAppStore } from "../src/store/index.js"

export { closeAppStore }

export async function openTestStore(options: { serverPreferences?: Array<[string, string]> } = {}) {
  await closeAppStore()
  return openAppStore({ driver: "memory", seed: { serverPreferences: options.serverPreferences } })
}
