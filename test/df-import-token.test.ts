import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { createDfImportTokenStore } from "../src/df/import-token.js"

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "df-import-token-"))
  return { file: path.join(dir, "tokens.json"), dir }
}

test("import token store saves, reads back, and removes per user", () => {
  const { file, dir } = tempFile()
  try {
    const store = createDfImportTokenStore(file)
    assert.equal(store.get("u1"), null)
    store.set("u1", "tok-aaaa-1111")
    assert.equal(store.get("u1")?.token, "tok-aaaa-1111")
    assert.equal(store.get("u2"), null)
    assert.equal(store.remove("u1"), true)
    assert.equal(store.remove("u1"), false)
    assert.equal(store.get("u1"), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("import token store persists across instances", () => {
  const { file, dir } = tempFile()
  try {
    createDfImportTokenStore(file).set("u1", "persisted-token")
    assert.equal(createDfImportTokenStore(file).get("u1")?.token, "persisted-token")
    assert.match(readFileSync(file, "utf8"), /persisted-token/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a corrupt token file is treated as empty instead of throwing", () => {
  const { file, dir } = tempFile()
  try {
    createDfImportTokenStore(file).set("u1", "x")
    // 覆盖为非法 JSON
    writeFileSync(file, "{not json")
    assert.equal(createDfImportTokenStore(file).get("u1"), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
