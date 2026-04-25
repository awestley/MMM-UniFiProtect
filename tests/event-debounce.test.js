"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { debounceMsForEvent } = require("../helpers/event-debounce")

test("ring uses doorbellRingDebounceMs when set", () => {
  assert.equal(debounceMsForEvent("ring", 1500, 4000), 4000)
})

test("ring falls back to event debounce when doorbell ms unset", () => {
  assert.equal(debounceMsForEvent("ring", 1500, undefined), 1500)
})

test("non-ring ignores doorbellRingDebounceMs", () => {
  assert.equal(debounceMsForEvent("motion", 1500, 4000), 1500)
  assert.equal(debounceMsForEvent("smart", 2000, 8000), 2000)
})

test("defaults to 1500 when eventDebounceMs not finite", () => {
  assert.equal(debounceMsForEvent("motion", NaN, undefined), 1500)
  assert.equal(debounceMsForEvent("motion", Infinity, undefined), 1500)
})

test("ring ignores non-finite doorbellRingDebounceMs", () => {
  assert.equal(debounceMsForEvent("ring", 1000, NaN), 1000)
})

test("ring uses base 1500 when eventDebounceMs invalid and no doorbell override", () => {
  assert.equal(debounceMsForEvent("ring", undefined, undefined), 1500)
})
