import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { messageKeys, messagePlaceholders, parseMessages, t } from "../src/messages.js"
import { CATEGORIES, STAGES } from "../src/diagnostics.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const srcRoot = path.join(root, "src")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) return sourceFiles(file)
    return name.endsWith(".ts") ? [file] : []
  })
}

test("t() interpolates each placeholder in one pass and never reinterprets inserted values", () => {
  assert.equal(t("bind.button", { server: "{count}" }), "绑定{count}")
  assert.equal(t("bind.button", { server: "$& {server}" }), "绑定$& {server}")
  assert.equal(t("sync.done", { server: "国服", count: 3 }), "✅ 国服同步完成：3 条最佳成绩。现在可以 /b50。")
})

test("t() keeps newlines as real line breaks and never turns them into literal backslashes", () => {
  const text = t("bind.defaultServer", { server: "国服" })
  assert.ok(text.includes("\n"))
  assert.equal(text.includes("\\n"), false)
})

test("missing keys, missing parameters and non-scalar parameters are explicit errors", () => {
  assert.throws(() => t("no.such.key"), /Missing message key: no\.such\.key/)
  assert.throws(() => t("bind.button"), /Missing message parameter: bind\.button\.server/)
  assert.throws(() => t("bind.button", { server: {} as unknown as string }), /Invalid message parameter: bind\.button\.server/)
})

test("keys.json rejects duplicate, non-string and non-object entries", () => {
  assert.throws(() => parseMessages('{\n  "a": "x",\n  "a": "y"\n}'), /duplicate message key: a/)
  assert.throws(() => parseMessages('{"a": ["x"]}'), /must map to a non-empty string/)
  assert.throws(() => parseMessages('{"a": ""}'), /must map to a non-empty string/)
  assert.throws(() => parseMessages('["x"]'), /flat object/)
  assert.throws(() => parseMessages('{"a":"x","a":"y"}'), /duplicate message key: a/)
  assert.throws(() => parseMessages('{"a":"x","\\u0061":"y"}'), /duplicate message key: a/)
  assert.deepEqual(parseMessages(JSON.stringify({ a: 'quoted "a": value', b: 'a second "a": value' })), { a: 'quoted "a": value', b: 'a second "a": value' })
})

test("placeholder discovery reports exactly the named parameters", () => {
  assert.deepEqual(messagePlaceholders("bind.loggedIn"), ["server"])
  assert.deepEqual(messagePlaceholders("sync.ok").sort(), ["mapped", "skipped", "verification"])
})

test("every literal t() key used by src exists in keys.json", () => {
  const keys = new Set(messageKeys())
  const missing: string[] = []
  for (const file of sourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(/\bt\(\s*"([^"\\]+)"/g)) if (!keys.has(match[1]!)) missing.push(`${path.relative(root, file)}: ${match[1]}`)
    for (const match of source.matchAll(/\bt\(\s*`([^`]+)`/g)) {
      if (!match[1]!.includes("${")) if (!keys.has(match[1]!)) missing.push(`${path.relative(root, file)}: ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})

test("every keys.json entry is reachable from src (literal or documented dynamic family)", () => {
  const source = sourceFiles(srcRoot).map(file => readFileSync(file, "utf8")).join("\n")
  const dynamicFamilies = ["diagnostic.reason.", "diagnostic.stage.", "help.cmd.", "sync.leg.", "server.", "difficulty."]
  const unused = messageKeys().filter(key => !source.includes(`"${key}"`) && !dynamicFamilies.some(prefix => key.startsWith(prefix)))
  assert.deepEqual(unused, [])
})

test("every diagnostic stage and category has a reason or stage message", () => {
  for (const category of CATEGORIES) assert.doesNotThrow(() => t(`diagnostic.reason.${category}`))
  for (const stage of STAGES) assert.doesNotThrow(() => t(`diagnostic.stage.${stage}`))
})

test("compiled dist/messages.js reads the same root keys.json as src (when dist is built)", async ctx => {
  const dist = new URL("../dist/messages.js", import.meta.url)
  if (!existsSync(fileURLToPath(dist))) return ctx.skip("dist not built")
  const compiled = await import(dist.href) as typeof import("../src/messages.js")
  assert.deepEqual(compiled.messageKeys(), messageKeys())
  assert.equal(compiled.t("bind.button", { server: "测试" }), "绑定测试")
})

test("outgoing Discord send paths contain no raw Chinese or CJK-punctuation string literals", () => {
  const outgoing = [
    "index.ts", "handlers.ts", "commands.ts", "util.ts", "import-account.ts", "sync.ts", "migrate-client.ts",
    "b50/help.ts", "b50/render.ts", "b50/theme.ts", "local/profile.ts",
  ].map(name => path.join(srcRoot, name))
  // multiserver/catalog.ts holds game version proper nouns (e.g. Japanese release names) used as data identifiers, not UI copy.
  outgoing.push(...sourceFiles(path.join(srcRoot, "multiserver")).filter(file => !file.endsWith(path.join("multiserver", "catalog.ts"))))
  const cjk = /[\u00b7\u2013\u2014\u2026\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/
  const violations: string[] = []
  for (const file of outgoing) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const code = line.trim()
      if (!code || code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.includes("console.")) return
      const withoutComment = code.replace(/\s\/\/\s.*$/, "")
      for (const match of withoutComment.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
        if (cjk.test(match[0])) violations.push(`${path.relative(root, file)}:${index + 1}: ${match[0].slice(0, 60)}`)
      }
    })
  }
  assert.deepEqual(violations, [])
})
