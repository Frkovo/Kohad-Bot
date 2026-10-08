// AimeDB lookup for MuNET: turns a 20-digit Aime card number into the server's user id. Lookup only. AquaDX also
// registers unknown cards on lookup; this bot never does, so a card that is not registered yet fails with a message.
import { connect } from "node:net"
import { createCipheriv, createDecipheriv } from "node:crypto"
import { UserError } from "../multiserver/registry.js"
import { t } from "../messages.js"

const PORT = 22345
const AIMEDB_KEY = Buffer.from("Copyright(C)SEGA", "utf8")
const HEADER_LEN = 0x20
// International AiMeDB "Get AiMe Account" (bsnk docs 6.2): request command 4, reply command 6. Client version 1.00.0.
const LOOKUP_COMMAND = 4
const LOOKUP_REPLY = 6
const CLIENT_VERSION = 0x1000
const SEGA_COMPANY = 1
const STORE_ID = 299
const NOT_FOUND = 0xffffffff

function aes(encrypt: boolean, data: Buffer): Buffer {
  const cipher = encrypt ? createCipheriv("aes-128-ecb", AIMEDB_KEY, null) : createDecipheriv("aes-128-ecb", AIMEDB_KEY, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

// Header: magic, client version, command, length, result, game id, store id, keychip (bsnk "Common API Specification" 3.1).
// Payload: access code (10 bytes, hex literal), company code, firmware version, serial number (bsnk 6.2).
export function buildLookupPacket(game: string, keychipShortId: string, card: string): Buffer {
  const payload = Buffer.concat([Buffer.from(card.padStart(20, "0"), "hex"), Buffer.from([SEGA_COMPANY, 0]), Buffer.alloc(4)])
  const head = Buffer.alloc(HEADER_LEN)
  head.writeUInt16LE(0xa13e, 0)
  head.writeUInt16LE(CLIENT_VERSION, 2)
  head.writeUInt16LE(LOOKUP_COMMAND, 4)
  head.writeUInt16LE(HEADER_LEN + payload.length, 6)
  head.writeUInt16LE(0, 8)
  head.write(game, 0x0a, 6, "ascii")
  head.writeUInt32LE(STORE_ID, 0x10)
  head.write(keychipShortId, 0x14, 12, "ascii")
  return aes(true, Buffer.concat([head, payload]))
}

// Reply: header with command 6, then the AiMe ID at 0x20. A header-only reply (length 0x20) or FFFFFFFF means the
// card is not registered. MuNET answers unknown cards with a header-only reply and result 0, which is the case we
// observed. A reply that is not a command-6 header at all is a protocol failure, not a missing card.
export function parseLookupResponse(response: Buffer): number | undefined {
  const usable = response.subarray(0, response.length - (response.length % 16))
  if (usable.length < HEADER_LEN) throw new UserError(t("mumur.aimeDbFailed"))
  const plain = aes(false, usable)
  if (plain.readUInt16LE(0) !== 0xa13e || plain.readUInt16LE(4) !== LOOKUP_REPLY) throw new UserError(t("mumur.aimeDbFailed"))
  if (plain.readUInt16LE(6) < HEADER_LEN + 4 || plain.length < HEADER_LEN + 4) return undefined
  const userId = plain.readUInt32LE(HEADER_LEN)
  return userId === NOT_FOUND ? undefined : userId
}

export type LookupOptions = { host: string; game: string; keychipShortId: string; card: string; port?: number; timeoutMs?: number }

// Reads until the reply is complete (header plus one block), the server closes, or the timeout hits.
export function lookupUserId(options: LookupOptions): Promise<number | undefined> {
  const packet = buildLookupPacket(options.game, options.keychipShortId, options.card)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host, port: options.port ?? PORT })
    const chunks: Buffer[] = []
    let received = 0
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) return reject(error instanceof UserError ? error : new UserError(t("mumur.aimeDbFailed")))
      try { resolve(parseLookupResponse(Buffer.concat(chunks))) } catch (parseError) { reject(parseError) }
    }
    socket.setTimeout(options.timeoutMs ?? 5000)
    socket.on("connect", () => socket.write(packet))
    socket.on("data", chunk => {
      chunks.push(chunk)
      received += chunk.length
      if (received >= HEADER_LEN + 16) finish()
    })
    socket.on("end", () => finish())
    socket.on("timeout", () => finish())
    socket.on("error", error => finish(error))
  })
}
