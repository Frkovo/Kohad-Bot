// AES-256-GCM master key for the encrypted remote-server credentials.
// B50_AUTH_KEY wins; otherwise a 0600 key file is created once and must be kept with the database.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { UserError } from "../multiserver/registry.js"
import { t } from "../messages.js"

export type MasterKeyOptions = {
  /** Base64 of 32 bytes from B50_AUTH_KEY. */
  configured?: string
  keyFile: string
  /** Whether any binding already stores encrypted credentials; a missing key must not be replaced. */
  hasEncryptedBindings: boolean
}

/** Resolve the credentials key without ever silently replacing a lost one. */
export function loadMasterKey(options: MasterKeyOptions): Buffer {
  const configured = options.configured?.trim()
  if (configured) {
    const key = Buffer.from(configured, "base64")
    if (key.length !== 32) throw new UserError(t("store.authKeyInvalid"))
    return key
  }
  if (!existsSync(options.keyFile)) {
    if (options.hasEncryptedBindings) throw new UserError(t("store.keyMissing"))
    mkdirSync(path.dirname(options.keyFile), { recursive: true })
    try { writeFileSync(options.keyFile, randomBytes(32), { flag: "wx", mode: 0o600 }) }
    catch (error) { if (!existsSync(options.keyFile)) throw error }
  }
  const key = readFileSync(options.keyFile)
  if (key.length !== 32) throw new UserError(t("store.keyLength"))
  return key
}
