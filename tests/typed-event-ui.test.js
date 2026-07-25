"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { typedEventsToUi } = require("../helpers/typed-event-ui")

const all = { motion: true, ring: true, smart: true }

test("typedEventsToUi returns empty for bad input", () => {
  assert.deepEqual(typedEventsToUi(null, all), [])
  assert.deepEqual(typedEventsToUi({}, all), [])
  assert.deepEqual(typedEventsToUi({ kind: "devicePatched" }, all), [])
})

test("motionDetected maps to motion", () => {
  const ev = typedEventsToUi({
    kind: "motionDetected",
    cameraId: "cam1",
    at: 1000,
    eventId: "e1",
  }, all)
  assert.deepEqual(ev, [{ type: "motion", cameraId: "cam1", ts: 1000, eventId: "e1" }])
})

test("motionDetected respects flags.motion", () => {
  assert.deepEqual(
    typedEventsToUi({ kind: "motionDetected", cameraId: "c", at: 1, eventId: "" }, { motion: false, ring: true, smart: true }),
    [],
  )
})

test("doorbellRing maps to ring", () => {
  const ev = typedEventsToUi({
    kind: "doorbellRing",
    cameraId: "door",
    at: 2000,
    eventId: "r1",
  }, all)
  assert.deepEqual(ev, [{ type: "ring", cameraId: "door", ts: 2000, eventId: "r1" }])
})

test("smartDetect emits one event per object type", () => {
  const ev = typedEventsToUi({
    kind: "smartDetect",
    cameraId: "cam",
    at: 3000,
    eventId: "s1",
    objectTypes: ["person", "vehicle", 42, ""],
  }, all)
  assert.deepEqual(ev, [
    { type: "smart", cameraId: "cam", object: "person", ts: 3000, eventId: "s1" },
    { type: "smart", cameraId: "cam", object: "vehicle", ts: 3000, eventId: "s1" },
  ])
})

test("smartDetect skips empty types", () => {
  assert.deepEqual(
    typedEventsToUi({ kind: "smartDetect", cameraId: "c", at: 1, eventId: "", objectTypes: [] }, all),
    [],
  )
})

test("missing cameraId becomes empty string", () => {
  const ev = typedEventsToUi({ kind: "motionDetected", at: 1, eventId: "x" }, all)
  assert.equal(ev[0].cameraId, "")
})
