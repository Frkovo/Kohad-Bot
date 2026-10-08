import { readFileSync } from "node:fs"
import tls from "node:tls"
import { Agent, fetch as undiciFetch } from "undici"

// Public intermediate CAs for maimai NET (provenance: assets/certs/PROVENANCE.md). Only used by the NET dispatcher below.
const PEM_FILE = new URL("../../assets/certs/maimai-net-intermediates.pem", import.meta.url)
export const NET_INTERMEDIATE_PEMS: readonly string[] = readFileSync(PEM_FILE, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
if (NET_INTERMEDIATE_PEMS.length !== 2) throw new Error("assets/certs/maimai-net-intermediates.pem must contain the two pinned intermediates")

// Node's default root store plus the pinned intermediates. Certificate verification stays on.
export function netCaBundle(): string[] {
  return [...tls.rootCertificates, ...NET_INTERMEDIATE_PEMS]
}

// Only the CA list is customised; certificate verification keeps undici's default (on).
export function netAgentOptions() {
  return { connect: { ca: netCaBundle() } }
}

let dispatcher: Agent | undefined
// Scoped to NET requests only: no global dispatcher or process-wide TLS setting is changed.
export function netDispatcher(): Agent {
  dispatcher ??= new Agent(netAgentOptions())
  return dispatcher
}

export type NetRequestInit = RequestInit & { dispatcher?: unknown }

const nativeFetch = globalThis.fetch
// Node's global fetch rejects dispatchers from the separately installed undici package ("invalid onError method"),
// so production NET requests use undici's own fetch with the matching Agent. A replaced globalThis.fetch (test mocks)
// is honoured as-is, still receiving the same dispatcher extension for assertions.
export function netFetch(url: URL, init: NetRequestInit): Promise<Response> {
  const withDispatcher = { ...init, dispatcher: netDispatcher() }
  if (globalThis.fetch !== nativeFetch) return globalThis.fetch(url, withDispatcher as RequestInit)
  return undiciFetch(url, withDispatcher as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
}
