import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import tls from "node:tls"
import { X509Certificate } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Agent } from "undici"
import { NET_INTERMEDIATE_PEMS, netAgentOptions, netCaBundle, netDispatcher, netFetch } from "../src/multiserver/transport.js"

// Pins copied from the parent's independent verification of the pinned upstream source (see assets/certs/PROVENANCE.md).
const PINNED = [
  { subject: "GlobalSign RSA OV SSL CA 2018", sha256: "B6:76:FF:A3:17:9E:88:12:09:3A:1B:5E:AF:EE:87:6A:E7:A6:AA:F2:31:07:8D:AD:1B:FB:21:CD:28:93:76:4A", validTo: "Nov 21 00:00:00 2028 GMT" },
  { subject: "GlobalSign GCC R46 OV TLS CA 2025", sha256: "D1:60:E2:DE:4E:56:CB:10:B6:6C:1C:B0:AD:CB:79:CF:93:C7:8D:CD:9D:B3:0C:20:18:22:02:62:C0:40:63:F9", validTo: "Jun 23 00:00:00 2029 GMT" },
]
const root = fileURLToPath(new URL("../", import.meta.url))

test("the bundled NET intermediates are exactly the two pinned, CA-flagged certificates chaining to built-in roots", () => {
  assert.equal(NET_INTERMEDIATE_PEMS.length, 2)
  const builtIn = tls.rootCertificates.map(pem => new X509Certificate(pem))
  const parsed = NET_INTERMEDIATE_PEMS.map(pem => new X509Certificate(pem))
  for (const [index, cert] of parsed.entries()) {
    assert.equal(cert.fingerprint256, PINNED[index]!.sha256)
    assert.match(cert.subject, new RegExp(PINNED[index]!.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.equal(cert.ca, true)
    assert.equal(cert.validTo, PINNED[index]!.validTo)
    assert.ok(new Date(cert.validFrom) <= new Date() && new Date() <= new Date(cert.validTo))
    const issuer = builtIn.find(candidate => candidate.subject === cert.issuer && cert.verify(candidate.publicKey))
    assert.ok(issuer, `${PINNED[index]!.subject} must chain to a built-in root`)
  }
})

test("the NET CA bundle is Node's default roots plus the pinned intermediates, with verification left on", () => {
  const bundle = netCaBundle()
  for (const pem of tls.rootCertificates) assert.ok(bundle.includes(pem))
  for (const pem of NET_INTERMEDIATE_PEMS) assert.ok(bundle.includes(pem))
  const options = netAgentOptions()
  assert.deepEqual(options.connect.ca, bundle)
  assert.equal("rejectUnauthorized" in options.connect, false)
  assert.ok(netDispatcher() instanceof Agent)
  assert.equal(netDispatcher(), netDispatcher(), "one NET dispatcher is reused")
})

test("the NET dispatcher is scoped to NET requests: no global dispatcher or TLS switch is introduced", () => {
  const sources = readdirSync(path.join(root, "src"), { recursive: true }) as string[]
  const violations: string[] = []
  for (const name of sources) {
    const file = path.join(root, "src", name)
    if (!name.endsWith(".ts") || statSync(file).isDirectory()) continue
    const source = readFileSync(file, "utf8")
    for (const banned of ["setGlobalDispatcher", "rejectUnauthorized", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "--use-system-ca"]) {
      if (source.includes(banned)) violations.push(`${name}: ${banned}`)
    }
  }
  assert.deepEqual(violations, [])
})

test("the NET fetch path works with its matched undici fetch+Agent pair and keeps redirects manual", async t => {
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/landing", "set-cookie": "session=fixture; Path=/" })
      return response.end()
    }
    response.end(`ok:${request.url}`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const redirect = await netFetch(new URL(`http://127.0.0.1:${port}/redirect`), { redirect: "manual" })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get("location"), "/landing")
  assert.deepEqual(redirect.headers.getSetCookie(), ["session=fixture; Path=/"])
  await redirect.text()
  const landing = await netFetch(new URL(`http://127.0.0.1:${port}/landing`), { redirect: "manual" })
  assert.equal(await landing.text(), "ok:/landing")
})

test("a mocked globalThis.fetch still receives NET requests, now carrying the NET dispatcher", async t => {
  const seen: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: { dispatcher?: unknown }) => {
    seen.push(init?.dispatcher)
    return new Response("mocked")
  })
  const response = await netFetch(new URL("https://maimaidx.jp/maimai-mobile/"), { redirect: "manual" })
  assert.equal(await response.text(), "mocked")
  assert.equal(seen[0], netDispatcher())
})

test("unrelated requests keep the process-wide fetch: the NET path never replaces globalThis.fetch", () => {
  const before = globalThis.fetch
  netDispatcher()
  assert.equal(globalThis.fetch, before)
})
