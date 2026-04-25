"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { Headers, Response } = require("undici")
const {
  undiciHeadersToPlain,
  wrapResponseHeadersForUniFiLibrary,
} = require("../helpers/undici-response-headers")

test("undici Headers become bracket-readable plain object", () => {
  const h = new Headers()
  h.set("X-Updated-CSRF-Token", "csrf1")
  h.append("Set-Cookie", "TOKEN=abc; Path=/")
  const plain = undiciHeadersToPlain(h)
  assert.equal(plain["x-updated-csrf-token"], "csrf1")
  assert.ok(plain["set-cookie"])
  assert.match(String(plain["set-cookie"]), /TOKEN=abc/)
})

test("multiple Set-Cookie values become array when getSetCookie returns many", () => {
  const h = new Headers()
  h.append("Set-Cookie", "a=1; Path=/")
  h.append("Set-Cookie", "b=2; Path=/")
  const plain = undiciHeadersToPlain(h)
  assert.ok(Array.isArray(plain["set-cookie"]) || String(plain["set-cookie"]).length > 0)
})

test("wrapResponseHeadersForUniFiLibrary leaves null and non-Headers alone", () => {
  assert.equal(wrapResponseHeadersForUniFiLibrary(null), null)
  const bare = { statusCode: 200, headers: { "content-type": "text/plain" } }
  assert.strictEqual(wrapResponseHeadersForUniFiLibrary(bare), bare)
})

test("wrapResponseHeadersForUniFiLibrary Proxy exposes bracket headers", () => {
  const h = new Headers()
  h.set("X-Updated-CSRF-Token", "tok")
  h.append("Set-Cookie", "SID=x; Path=/")
  const res = new Response(null, { headers: h, status: 200 })
  const w = wrapResponseHeadersForUniFiLibrary(res)
  assert.equal(w.status, 200)
  assert.equal(w.headers["x-updated-csrf-token"], "tok")
  assert.ok(w.headers["set-cookie"])
})
