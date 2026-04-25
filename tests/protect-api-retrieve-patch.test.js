"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { Headers } = require("undici")
const {
  patchProtectApiRetrieve,
  bindMethodFromPrototypeChain,
} = require("../helpers/protect-api-retrieve-patch")

test("bindMethodFromPrototypeChain finds class method on prototype", () => {
  class C {
    async _retrieve(u) {
      return { u, tag: "orig" }
    }
  }
  const c = new C()
  const fn = bindMethodFromPrototypeChain(c, "_retrieve")
  assert.equal(typeof fn, "function")
  return fn("x").then((r) => {
    assert.deepStrictEqual(r, { u: "x", tag: "orig" })
  })
})

test("bindMethodFromPrototypeChain returns null when method missing", () => {
  class C {}
  assert.equal(bindMethodFromPrototypeChain(new C(), "_retrieve"), null)
})

test("patchProtectApiRetrieve installs wrapper on real ProtectApi from dist", async () => {
  const { ProtectApi } = await import("unifi-protect/dist/protect-api.js")
  const log = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} }
  const api = new ProtectApi(log)
  const moduleLog = { debug: () => {} }
  const meta = patchProtectApiRetrieve(api, moduleLog, false)
  assert.equal(typeof api._retrieve, "function")
  assert.equal(meta.patchLayer, "_retrieve")
})

test("patchProtectApiRetrieve trace logs [retrieve#n] for non-snapshot URLs", async () => {
  const lines = []
  const moduleLog = {
    debug: (label, detail) => {
      lines.push({ label, detail })
    },
  }
  class X {
    async _retrieve() {
      return {
        statusCode: 200,
        headers: new Headers([["content-type", "application/json"]]),
      }
    }
  }
  const api = new X()
  patchProtectApiRetrieve(api, moduleLog, true)
  await api._retrieve("https://192.168.1.1/proxy/protect/api/bootstrap")
  const hit = lines.find(l => l.label.startsWith("[retrieve#"))
  assert.ok(hit, "expected trace line")
  assert.equal(hit.detail.patchLayer, "_retrieve")
  assert.equal(hit.detail.hasSetCookie, false)
})

test("patchProtectApiRetrieve skips noisy trace for snapshot URLs", async () => {
  const lines = []
  const moduleLog = {
    debug: (label) => {
      lines.push(label)
    },
  }
  class X {
    async _retrieve() {
      return { statusCode: 200, headers: {} }
    }
  }
  const api = new X()
  patchProtectApiRetrieve(api, moduleLog, true)
  await api._retrieve("https://h/cameras/x/snapshot")
  assert.equal(lines.length, 0)
})

test("patchProtectApiRetrieve wraps retrieve when _retrieve absent", async () => {
  class OnlyRetrieve {
    async retrieve() {
      return { statusCode: 204, headers: {} }
    }
  }
  const api = new OnlyRetrieve()
  const moduleLog = { debug: () => {} }
  const meta = patchProtectApiRetrieve(api, moduleLog, false)
  assert.equal(typeof api.retrieve, "function")
  assert.equal(meta.patchLayer, "retrieve")
  const res = await api.retrieve("https://x/")
  assert.equal(res.statusCode, 204)
})

test("patchProtectApiRetrieve throws when no retrieve layer exists", () => {
  class Empty {}
  assert.throws(
    () => patchProtectApiRetrieve(new Empty(), { debug: () => {} }, false),
    /no retrieve\/_retrieve/,
  )
})
