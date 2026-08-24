"use strict"

const fs = require("fs")
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

test("getUnifiProtectRuntimeMeta returns error when read fails", () => {
  const orig = fs.readFileSync
  fs.readFileSync = () => {
    throw new Error("mock read fail")
  }
  try {
    const m = getUnifiProtectRuntimeMeta()
    assert.equal(m.version, null)
    assert.equal(m.packageJsonPath, null)
    assert.ok(m.error && m.error.includes("mock read fail"))
  } finally {
    fs.readFileSync = orig
  }
})

test("getUnifiProtectRuntimeMeta stringifies non-Error throws", () => {
  const orig = fs.readFileSync
  fs.readFileSync = () => {
    throw "plain-fail"
  }
  try {
    const m = getUnifiProtectRuntimeMeta()
    assert.equal(m.error, "plain-fail")
  } finally {
    fs.readFileSync = orig
  }
})

test("getUnifiProtectRuntimeMeta nulls non-string version field", () => {
  const orig = fs.readFileSync
  fs.readFileSync = () => JSON.stringify({ version: 12 })
  try {
    const m = getUnifiProtectRuntimeMeta()
    assert.equal(m.version, null)
    assert.ok(m.packageJsonPath)
  } finally {
    fs.readFileSync = orig
  }
})

test("semverMajor parses v-prefixed and plain semver", () => {
  assert.equal(semverMajor("3.0.4"), 3)
  assert.equal(semverMajor("v4.28.0"), 4)
  assert.equal(semverMajor("10.0.1-rc.1"), 10)
  assert.equal(semverMajor(""), null)
  assert.equal(semverMajor(null), null)
  assert.equal(semverMajor("not-a-version"), null)
  assert.equal(semverMajor("  v7.1.0  "), 7)
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

test("incompatibleUnifiProtectMessage returns null for bad or missing meta", () => {
  assert.equal(incompatibleUnifiProtectMessage(null), null)
  assert.equal(incompatibleUnifiProtectMessage({ version: null, packageJsonPath: null }), null)
  assert.equal(
    incompatibleUnifiProtectMessage({
      version: "5.0.0",
      packageJsonPath: "/x",
      error: "stale",
    }),
    null,
  )
  assert.equal(
    incompatibleUnifiProtectMessage({
      version: "not-semver",
      packageJsonPath: "/x",
    }),
    null,
  )
})

test("incompatibleUnifiProtectMessage uses ? when package path missing", () => {
  const msg = incompatibleUnifiProtectMessage({
    version: "4.1.0",
    packageJsonPath: null,
  })
  assert.ok(msg && msg.includes(" at ?."))
})
