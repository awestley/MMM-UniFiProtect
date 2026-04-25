"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { shouldEmit } = require("../helpers/debounce")

test("shouldEmit always true when debounce zero", () => {
  const m = new Map()
  assert.equal(shouldEmit("a", 100, 0, m), true)
  assert.equal(shouldEmit("a", 200, 0, m), true)
})

test("shouldEmit false within debounce window", () => {
  const m = new Map()
  assert.equal(shouldEmit("k", 1000, 500, m), true)
  assert.equal(shouldEmit("k", 1100, 500, m), false)
})

test("shouldEmit true after debounce window", () => {
  const m = new Map()
  assert.equal(shouldEmit("k", 1000, 500, m), true)
  assert.equal(shouldEmit("k", 1600, 500, m), true)
})

test("independent keys", () => {
  const m = new Map()
  assert.equal(shouldEmit("a", 100, 300, m), true)
  assert.equal(shouldEmit("b", 150, 300, m), true)
})
