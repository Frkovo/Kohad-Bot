import { serverStore } from "./store.js"
import { NetClient } from "./net.js"
import { fetchPrivateSnapshot } from "./private.js"
import { fetchMumurSnapshot } from "../mumur/client.js"
import { UserError, NetMaintenanceError, requireEnabledServer, type Credentials, type RemoteServer, type Snapshot } from "./registry.js"
import { t } from "../messages.js"
import { Trace } from "../diagnostics.js"

const jobs = new Map<string, { controller: AbortController; promise: Promise<Snapshot> }>()
const jobKey = (user: string, server: RemoteServer) => JSON.stringify([user, server])
export function cancelSync(user: string, server: RemoteServer) { jobs.get(jobKey(user, server))?.controller.abort(); jobs.delete(jobKey(user, server)) }
export async function syncRemote(user: string, server: RemoteServer, progress?: (text: string) => Promise<unknown>, trace = new Trace("sync", server)): Promise<Snapshot> {
  requireEnabledServer(server)
  trace.server = server
  trace.step("binding.read")
  const store = serverStore(), binding = await store.binding(user, server)
  if (!binding?.bound) throw new UserError(t("sync.unbound"))
  const key = jobKey(user, server), existing = jobs.get(key)
  if (existing) return existing.promise
  if (Date.now() - binding.lastAttempt < 60000) throw new UserError(t("sync.tooSoon"))
  const controller = new AbortController()
  // Reserve the slot before the first await: two callers that arrive together must share one login and one failure id.
  let settle!: { resolve: (value: Snapshot) => void; reject: (error: unknown) => void }
  const promise = new Promise<Snapshot>((resolve, reject) => { settle = { resolve, reject } })
  promise.catch(() => undefined) // a cancelled job must not surface as an unhandled rejection
  jobs.set(key, { controller, promise })
  void (async () => {
    try {
      trace.step("credentials.read")
      let auth: Credentials
      try {
        const stored = await store.credentials(user, server)
        if (!stored) throw new UserError(t("sync.unbound"))
        auth = stored
      } catch (error) { throw trace.fail(error) }
      await store.attempt(user, server, binding.revision)
      let snapshot: Snapshot
      if (server === "jp" || server === "intl") {
        const client = new NetClient(server, auth.cookies, controller.signal, trace)
        snapshot = await client.fetchSnapshot(auth, progress)
        auth.cookies = client.cookies()
      } else if (server === "mumur") snapshot = await fetchMumurSnapshot(auth, controller.signal)
      else snapshot = await fetchPrivateSnapshot(server, auth, controller.signal)
      trace.step("snapshot.save")
      await store.save(user, server, binding.revision, snapshot)
      trace.step("credentials.save")
      await store.updateCredentials(user, server, binding.revision, auth)
      trace.note("complete", { records: snapshot.records.length })
      settle.resolve(snapshot)
    } catch (error) {
      // The failure is logged either way; maintenance stays typed so B50 can answer from the local snapshot.
      const failure = trace.fail(error)
      settle.reject(error instanceof NetMaintenanceError ? error : failure)
    } finally {
      if (jobs.get(key)?.promise === promise) jobs.delete(key)
    }
  })()
  return promise
}
