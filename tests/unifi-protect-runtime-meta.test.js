"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const {
  getUnifiProtectRuntimeMeta,
  semverMajor,
  incompatibleUnifiProtectMessage,
} = require("../helpers/unifi-protect-runtime-meta")

test("getUnifiProtectRuntimeMeta reads installed unifi-protect version", () => {
  const m = getUnifiProtectRuntimeMeta()
  assert.ok(m.packageJsonPath && m.packageJsonPath.includes("unifi-protect"), "expected path to package")
  assert.ok(m.version && /^\d+\.\d+/.test(m.version), "expected semver-like version")
  assert.equal(m.error, undefined)
})

test("semverMajor parses v-prefixed and plain semver", () => {
  assert.equal(semverMajor("3.0.4"), 3)
  assert.equal(semverMajor("v4.28.0"), 4)
  assert.equal(semverMajor("10.0.1-rc.1"), 10)
  assert.equal(semverMajor(""), null)
  assert.equal(semverMajor(null), null)
})

test("incompatibleUnifiProtectMessage blocks v3 and v4", () => {
  const msg3 = incompatibleUnifiProtectMessage({
    version: "3.0.4",
    packageJsonPath: "/tmp/node_modules/unifi-protect/package.json",
  })
  assert.ok(msg3 && msg3.includes("v5"), "expected v5 requirement")
  assert.ok(msg3 && msg3.includes("3.0.4"), "expected installed version")

  const msg4 = incompatibleUnifiProtectMessage({
    version: "4.29.0",
    packageJsonPath: "/tmp/node_modules/unifi-protect/package.json",
  })
  assert.ok(msg4 && msg4.includes("v5"), "expected v5 requirement for v4")
})

test("incompatibleUnifiProtectMessage allows v5", () => {
  assert.equal(
    incompatibleUnifiProtectMessage({
      version: "5.2.0",
      packageJsonPath: "/x/package.json",
    }),
    null,
  )
})
