import { test } from "node:test"
import assert from "node:assert/strict"
import { regionCatalog, REGION_CURRENT_VERSION, VERSIONS } from "../src/multiserver/catalog.js"

test("each region uses its released version and B15 covers that version and the one before", () => {
  for (const region of ["jp", "intl"] as const) {
    const catalog = regionCatalog(region)
    assert.equal(catalog.version, REGION_CURRENT_VERSION[region])
    const newVersions = new Set([...catalog.index.values()].filter(c => c.isNew).map(c => c.version))
    const current = VERSIONS.indexOf(catalog.version)
    assert.deepEqual([...newVersions].sort(), [current - 1, current])
  }
})

test("intl does not pull in charts from versions it has not released", () => {
  const catalog = regionCatalog("intl")
  assert.ok([...catalog.index.values()].every(c => c.version <= VERSIONS.indexOf("CiRCLE PLUS")))
})
