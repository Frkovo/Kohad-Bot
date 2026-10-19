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
  const store = serverStore(), binding = store.binding(user, server)
  if (!binding?.bound) throw new UserError(t("sync.unbound"))
  const key = jobKey(user, server), existing = jobs.get(key)
  if (existing) return existing.promise
  if (Date.now() - binding.lastAttempt < 60000) throw new UserError(t("sync.tooSoon"))
  trace.step("credentials.read")
  let auth: Credentials
  try {
    const stored = store.credentials(user, server)
    if (!stored) throw new UserError(t("sync.unbound"))
    auth = stored
  } catch (error) { throw trace.fail(error) }
  const controller = new AbortController()
  store.attempt(user, server, binding.revision)
  // One job, one log: the failure is converted (and logged at the stage where it happened) here, so every caller sharing
  // this job receives the same DiagnosticFailure id/stage instead of its own binding.read context.
  const promise = (async () => {
    try {
      let snapshot: Snapshot
      if (server === "jp" || server === "intl") {
        const client = new NetClient(server, auth.cookies, controller.signal, trace)
        snapshot = await client.fetchSnapshot(auth, progress)
        auth.cookies = client.cookies()
      } else if (server === "mumur") snapshot = await fetchMumurSnapshot(auth, controller.signal)
      else snapshot = await fetchPrivateSnapshot(server, auth, controller.signal)
      trace.step("snapshot.save")
      store.save(user, server, binding.revision, snapshot)
      trace.step("credentials.save")
      store.updateCredentials(user, server, binding.revision, auth)
      trace.note("complete", { records: snapshot.records.length })
      return snapshot
    } catch (error) {
      // The failure is logged either way; maintenance stays typed so B50 can answer from the local snapshot.
      const failure = trace.fail(error)
      throw error instanceof NetMaintenanceError ? error : failure
    }
  })().finally(() => { if (jobs.get(key)?.promise === promise) jobs.delete(key) })
  jobs.set(key, { controller, promise })
  return promise
}
