"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const {
  resolveProtectApiExport,
  isLikelyProtectApiConstructor,
} = require("../helpers/resolve-protect-api-export")

test("resolveProtectApiExport prefers named ProtectApi", () => {
  function ProtectApi() {}
  ProtectApi.prototype.login = async () => {}
  ProtectApi.prototype.retrieve = async () => {}
  const mod = { ProtectApi, noise: 1 }
  assert.strictEqual(resolveProtectApiExport(mod), ProtectApi)
})

test("resolveProtectApiExport reads default.ProtectApi", () => {
  function ProtectApi() {}
  ProtectApi.prototype.login = async () => {}
  ProtectApi.prototype._retrieve = async () => {}
  const mod = { default: { ProtectApi } }
  assert.strictEqual(resolveProtectApiExport(mod), ProtectApi)
})

test("resolveProtectApiExport accepts default export when it looks like ProtectApi", () => {
  function ProtectApi() {}
  ProtectApi.prototype.login = async () => {}
  ProtectApi.prototype.retrieve = async () => {}
  const mod = { default: ProtectApi }
  assert.strictEqual(resolveProtectApiExport(mod), ProtectApi)
})

test("resolveProtectApiExport returns null for empty module", () => {
  assert.equal(resolveProtectApiExport(null), null)
  assert.equal(resolveProtectApiExport(undefined), null)
  assert.equal(resolveProtectApiExport({}), null)
  assert.equal(resolveProtectApiExport("not-an-object"), null)
})

test("resolveProtectApiExport uses default export when prototype matches but name is not ProtectApi", () => {
  function Foo() {}
  Foo.prototype.login = async () => {}
  Foo.prototype.retrieve = async () => {}
  assert.strictEqual(resolveProtectApiExport({ default: Foo }), Foo)
})

test("isLikelyProtectApiConstructor requires login and retrieve or _retrieve", () => {
  function A() {}
  A.prototype.login = async () => {}
  assert.equal(isLikelyProtectApiConstructor(A), false)
  function B() {}
  B.prototype.login = async () => {}
  B.prototype.retrieve = async () => {}
  assert.equal(isLikelyProtectApiConstructor(B), true)
})
