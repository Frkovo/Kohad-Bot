import { readFileSync } from "node:fs"

// Every user-facing Discord string lives in the root keys.json. Resolving against this module keeps
// src/ (tsx) and dist/ (node) on the same editable file. Edits require a Bot restart.
export type MessageValue = string | number | boolean
export type MessageValues = Record<string, MessageValue>

const KEYS_URL = new URL("../keys.json", import.meta.url)
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g

export function parseMessages(source: string, origin = "keys.json"): Readonly<Record<string, string>> {
  const seen = new Set<string>()
  for (const match of source.matchAll(JSON_STRING)) {
    if (!/^\s*:/.test(source.slice(match.index! + match[0].length))) continue
    const key: string = JSON.parse(match[0])
    if (seen.has(key)) throw new Error(`${origin} contains duplicate message key: ${key}`)
    seen.add(key)
  }
  const dictionary: unknown = JSON.parse(source)
  if (!dictionary || typeof dictionary !== "object" || Array.isArray(dictionary)) throw new Error(`${origin} must contain a flat object of string messages`)
  for (const [key, value] of Object.entries(dictionary)) {
    if (!key.trim() || typeof value !== "string" || !value.trim()) throw new Error(`${origin} key "${key}" must map to a non-empty string message`)
  }
  return Object.freeze(Object.fromEntries(Object.entries(dictionary as Record<string, string>)))
}

const dictionary = parseMessages(readFileSync(KEYS_URL, "utf8"), KEYS_URL.pathname)

export function messageKeys(): string[] { return Object.keys(dictionary) }
export function messagePlaceholders(key: string): string[] {
  if (!Object.hasOwn(dictionary, key)) throw new Error(`Missing message key: ${key}`)
  return [...new Set([...dictionary[key]!.matchAll(PLACEHOLDER)].map(match => match[1]!))]
}

// One pass: inserted values are never scanned for placeholders, so user/player text cannot inject keys.
export function t(key: string, values: MessageValues = {}): string {
  if (!Object.hasOwn(dictionary, key)) throw new Error(`Missing message key: ${key}`)
  return dictionary[key]!.replace(PLACEHOLDER, (_placeholder, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing message parameter: ${key}.${name}`)
    const value = values[name]
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`Invalid message parameter: ${key}.${name}`)
    return String(value)
  })
}
