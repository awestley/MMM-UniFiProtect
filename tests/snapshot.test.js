"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { jpegToDataUrl } = require("../helpers/snapshot")

test("jpegToDataUrl empty buffer", () => {
  assert.equal(jpegToDataUrl(Buffer.alloc(0)), "")
})

test("jpegToDataUrl encodes bytes", () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff])
  const url = jpegToDataUrl(buf)
  assert.ok(url.startsWith("data:image/jpeg;base64,"))
  assert.ok(url.length > 20)
})
