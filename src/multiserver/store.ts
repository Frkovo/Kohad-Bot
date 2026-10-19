import { DatabaseSync } from "node:sqlite"
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isEnabledServer, requireEnabledServer, type ServerId, type RemoteServer, type Credentials, type Snapshot, UserError } from "./registry.js"
import { t } from "../messages.js"

const DEFAULT = fileURLToPath(new URL("../../.data/scores.sqlite", import.meta.url))
export function seal(value: Credentials, key: Buffer, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), body: body.toString("base64") })
}
export function unseal(value: string, key: Buffer, context: string): Credentials {
  try {
    const envelope = JSON.parse(value)
    if (envelope.v !== 1) throw new Error()
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
    cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.body, "base64")), cipher.final()]).toString("utf8"))
  } catch { throw new UserError(t("store.decryptFailed")) }
}
export function createServerStore(file = DEFAULT, suppliedKey?: Buffer) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS server_preferences(discord_id TEXT PRIMARY KEY, server TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS server_bindings(discord_id TEXT NOT NULL, server TEXT NOT NULL, revision INTEGER NOT NULL,
      account_key TEXT NOT NULL, name TEXT NOT NULL, encrypted_auth TEXT, last_attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(discord_id,server));
    CREATE TABLE IF NOT EXISTS server_snapshots(discord_id TEXT NOT NULL, server TEXT NOT NULL,
      account_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(discord_id,server));`)
  let key = suppliedKey
  function encryptionKey(): Buffer {
    if (key) {
      if (key.length !== 32) throw new UserError(t("store.keyLength"))
      return key
    }
    const configured = process.env.B50_AUTH_KEY?.trim()
    if (configured) key = Buffer.from(configured, "base64")
    else {
      if (file === ":memory:") key = randomBytes(32)
      else {
        const keyFile = process.env.B50_AUTH_KEY_FILE || path.join(path.dirname(file), "binding-master.key")
        if (!existsSync(keyFile)) {
          const existing = db.prepare("SELECT COUNT(*) AS n FROM server_bindings WHERE encrypted_auth IS NOT NULL").get()
          if (Number(existing?.n)) throw new UserError(t("store.keyMissing"))
          mkdirSync(path.dirname(keyFile), { recursive: true })
          try { writeFileSync(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 }) }
          catch (error) { if (!existsSync(keyFile)) throw error }
        }
        key = readFileSync(keyFile)
      }
    }
    if (key.length !== 32) { key = undefined; throw new UserError(t("store.authKeyInvalid")) }
    return key
  }
  const context = (user: string, server: RemoteServer, revision: number) => JSON.stringify([user, server, revision])
  return {
    preferred(user: string): ServerId {
      const value = db.prepare("SELECT server FROM server_preferences WHERE discord_id=?").get(user)?.server
      return isEnabledServer(value) ? value : "cn"
    },
    savedPreferred(user: string): ServerId | null {
      const value = db.prepare("SELECT server FROM server_preferences WHERE discord_id=?").get(user)?.server
      return isEnabledServer(value) ? value : null
    },
    // Only live credentials count; an unbound server keeps its snapshot but is not "in use".
    boundServers(user: string): RemoteServer[] {
      return db.prepare("SELECT server FROM server_bindings WHERE discord_id=? AND encrypted_auth IS NOT NULL").all(user)
        .map(row => String(row.server))
        .filter((server): server is RemoteServer => isEnabledServer(server) && server !== "cn")
    },
    setPreferred(user: string, server: ServerId) {
      requireEnabledServer(server)
      db.prepare("INSERT INTO server_preferences VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET server=excluded.server").run(user, server)
    },
    binding(user: string, server: RemoteServer) {
      const row = db.prepare("SELECT * FROM server_bindings WHERE discord_id=? AND server=?").get(user, server)
      return row ? { revision: Number(row.revision), accountKey: String(row.account_key), name: String(row.name), bound: !!row.encrypted_auth, lastAttempt: Number(row.last_attempt) } : null
    },
    credentials(user: string, server: RemoteServer): Credentials | null {
      const row = db.prepare("SELECT revision,encrypted_auth FROM server_bindings WHERE discord_id=? AND server=?").get(user, server)
      return row?.encrypted_auth ? unseal(String(row.encrypted_auth), encryptionKey(), context(user, server, Number(row.revision))) : null
    },
    bind(user: string, server: RemoteServer, accountKey: string, name: string, auth: Credentials, expectedRevision?: number) {
      const previous = this.binding(user, server)
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new UserError(t("store.revisionChanged"))
      const revision = (previous?.revision ?? 0) + 1
      const encrypted = seal(auth, encryptionKey(), context(user, server, revision))
      db.exec("BEGIN IMMEDIATE")
      try {
        db.prepare(`INSERT INTO server_bindings VALUES(?,?,?,?,?,?,0) ON CONFLICT(discord_id,server) DO UPDATE SET
          revision=excluded.revision,account_key=excluded.account_key,name=excluded.name,encrypted_auth=excluded.encrypted_auth,last_attempt=0`)
          .run(user, server, revision, accountKey, name, encrypted)
        if (previous?.accountKey !== accountKey) db.prepare("DELETE FROM server_snapshots WHERE discord_id=? AND server=?").run(user, server)
        db.exec("COMMIT")
      } catch (e) { db.exec("ROLLBACK"); throw e }
      return revision
    },
    updateCredentials(user: string, server: RemoteServer, revision: number, auth: Credentials) {
      const encrypted = seal(auth, encryptionKey(), context(user, server, revision))
      db.prepare("UPDATE server_bindings SET encrypted_auth=? WHERE discord_id=? AND server=? AND revision=? AND encrypted_auth IS NOT NULL").run(encrypted, user, server, revision)
    },
    unbind(user: string, server: RemoteServer) {
      db.prepare(`INSERT INTO server_bindings VALUES(?,?,1,'','',NULL,0)
        ON CONFLICT(discord_id,server) DO UPDATE SET encrypted_auth=NULL,revision=server_bindings.revision+1`).run(user, server)
    },
    attempt(user: string, server: RemoteServer, revision: number) {
      db.prepare("UPDATE server_bindings SET last_attempt=? WHERE discord_id=? AND server=? AND revision=?").run(Date.now(), user, server, revision)
    },
    save(user: string, server: RemoteServer, revision: number, snapshot: Snapshot) {
      const binding = this.binding(user, server)
      if (!binding?.bound || binding.revision !== revision || binding.accountKey !== snapshot.accountKey) throw new UserError(t("store.staleSync"))
      db.prepare("INSERT INTO server_snapshots VALUES(?,?,?,?) ON CONFLICT(discord_id,server) DO UPDATE SET account_key=excluded.account_key,data=excluded.data")
        .run(user, server, snapshot.accountKey, JSON.stringify(snapshot))
    },
    snapshot(user: string, server: RemoteServer): Snapshot | null {
      const row = db.prepare("SELECT data FROM server_snapshots WHERE discord_id=? AND server=?").get(user, server)
      return row ? JSON.parse(String(row.data)) : null
    },
    close() { db.close(); key = undefined },
  }
}
let singleton: ReturnType<typeof createServerStore> | undefined
export function serverStore() { return singleton ??= createServerStore(process.env.LOCAL_SCORE_DB || DEFAULT) }
export function closeServerStore() { singleton?.close(); singleton = undefined }
