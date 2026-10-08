// AllNet PowerOn for MuNET. Same wire format as AquaDX's AllNetClient: a zlib-deflated "k=v&k=v" body, base64 encoded,
// answered with the same encoding. The response's `uri` is the game-server root used for every later call.
import { deflateSync, inflateSync } from "node:zlib"
import { UserError } from "../multiserver/registry.js"
import { t } from "../messages.js"

const KEYCHIP_RE = /^([A-Z\d]{4}-[A-Z\d]{11}|[A-Z\d]{15}|[A-Z\d]{11})$/

// AllNet keys the chip by its 11-character short form (A63E-01E6852xxxx -> A63E01E6852).
export function keychipShort(keychip: string): string {
  if (!KEYCHIP_RE.test(keychip)) throw new UserError(t("mumur.keychipInvalid"))
  return keychip.length === 11 ? keychip : keychip.slice(0, 4) + keychip.slice(5, 12)
}

export function encodeAllNet(fields: Record<string, string>): string {
  const plain = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("&")
  return deflateSync(Buffer.from(plain, "utf8")).toString("base64")
}

export function decodeAllNet(encoded: string): Record<string, string> {
  return parsePlain(inflateSync(Buffer.from(encoded.trim(), "base64")).toString("utf8"))
}

export function parsePlain(plain: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const pair of plain.trim().split("&")) {
    const cut = pair.indexOf("=")
    if (cut > 0) fields[pair.slice(0, cut)] = pair.slice(cut + 1)
  }
  return fields
}

export type PowerOnOptions = { url: string; keychip: string; game: string; version: string; signal?: AbortSignal }

// Returns the game-server root. Only the `uri` field is used; the rest of the response is ignored.
export async function powerOn(options: PowerOnOptions): Promise<string> {
  const body = encodeAllNet({
    game_id: options.game, ver: options.version, serial: keychipShort(options.keychip),
    ip: "127.0.0.1", firm_ver: "60001", boot_ver: "0000", encode: "UTF-8", format_ver: "3", hops: "1", token: "2864179931",
  })
  const response = await fetch(options.url, {
    method: "POST", redirect: "error", body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Pragma: "DFI", "User-Agent": "sdgb-tools-discord-bot/0.1" },
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(options.signal ? [options.signal] : [])]),
  })
  if (!response.ok) throw new UserError(t("mumur.powerOnFailed"))
  // Like AquaDX's decodeAllNetResp: only a DFI-tagged reply is base64+zlib; otherwise the body is plain "k=v&k=v".
  const text = await response.text()
  let fields: Record<string, string>
  try {
    fields = response.headers.get("pragma") === "DFI" ? decodeAllNet(text) : parsePlain(text)
  } catch { throw new UserError(t("mumur.powerOnFailed")) }
  const uri = fields.uri
  if (!uri || !/^https?:\/\/[^\s]+$/.test(uri)) throw new UserError(t("mumur.powerOnFailed"))
  return uri.endsWith("/") ? uri : `${uri}/`
}
