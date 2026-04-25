"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { normalizeUpdatePacket, toPositiveNumber } = require("../helpers/normalize-update")

test("toPositiveNumber handles finite numbers", () => {
  assert.equal(toPositiveNumber(42), 42)
  assert.equal(toPositiveNumber(0), 0)
})

test("toPositiveNumber handles numeric strings", () => {
  assert.equal(toPositiveNumber("99"), 99)
})

test("toPositiveNumber returns null for invalid", () => {
  assert.equal(toPositiveNumber("x"), null)
  assert.equal(toPositiveNumber(NaN), null)
  assert.equal(toPositiveNumber(null), null)
  assert.equal(toPositiveNumber(undefined), null)
})

test("normalizeUpdatePacket returns empty for bad input", () => {
  assert.deepEqual(normalizeUpdatePacket(null, { lastMotionByCamera: {}, lastRingByCamera: {} }, { motion: true, ring: true, smart: true }), [])
  assert.deepEqual(normalizeUpdatePacket({}, { lastMotionByCamera: {}, lastRingByCamera: {} }, { motion: true, ring: true, smart: true }), [])
})

test("uses empty camera id when action id is not a string", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: true, ring: false, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: 123 },
    payload: { lastMotion: 1000 },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].cameraId, "")
})

test("smart event uses empty camera id when camera field not a string", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: false, smart: true }
  const packet = {
    action: { action: "add", modelKey: "event", id: "evt1" },
    payload: {
      id: "evt1",
      camera: 99,
      start: 50,
      smartDetectTypes: ["person"],
    },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].cameraId, "")
})

test("emits motion when lastMotion changes to positive", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: true, ring: false, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: "cam1" },
    payload: { lastMotion: 1000 },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, "motion")
  assert.equal(ev[0].cameraId, "cam1")
  assert.equal(ev[0].ts, 1000)
  assert.equal(state.lastMotionByCamera.cam1, 1000)
})

test("does not emit motion when lastMotion unchanged", () => {
  const state = { lastMotionByCamera: { cam1: 1000 }, lastRingByCamera: {} }
  const flags = { motion: true, ring: false, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: "cam1" },
    payload: { lastMotion: 1000 },
  }
  assert.deepEqual(normalizeUpdatePacket(packet, state, flags), [])
})

test("emits motion again when lastMotion timestamp advances", () => {
  const state = { lastMotionByCamera: { cam1: 1000 }, lastRingByCamera: {} }
  const flags = { motion: true, ring: false, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: "cam1" },
    payload: { lastMotion: 2000 },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].ts, 2000)
})

test("motion flag off suppresses motion", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: false, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: "cam1" },
    payload: { lastMotion: 1000 },
  }
  assert.deepEqual(normalizeUpdatePacket(packet, state, flags), [])
})

test("does not emit motion for lastMotion zero after transition", () => {
  const state = { lastMotionByCamera: { cam1: 1000 }, lastRingByCamera: {} }
  const flags = { motion: true, ring: false, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: "cam1" },
    payload: { lastMotion: 0 },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 0)
  assert.equal(state.lastMotionByCamera.cam1, 0)
})

test("emits ring when lastRing becomes positive", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: true, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: "db1" },
    payload: { lastRing: 5000 },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, "ring")
  assert.equal(ev[0].ts, 5000)
})

test("does not emit ring when lastRing still zero", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: true, smart: false }
  const packet = {
    action: { action: "update", modelKey: "camera", id: "db1" },
    payload: { lastRing: 0 },
  }
  assert.deepEqual(normalizeUpdatePacket(packet, state, flags), [])
})

test("smart detect add emits one event per type", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: false, smart: true }
  const packet = {
    action: { action: "add", modelKey: "event", id: "evt1" },
    payload: {
      id: "evt1",
      camera: "camA",
      start: 777,
      smartDetectTypes: ["person", "vehicle"],
    },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 2)
  assert.equal(ev[0].type, "smart")
  assert.equal(ev[0].object, "person")
  assert.equal(ev[0].cameraId, "camA")
  assert.equal(ev[0].ts, 777)
  assert.equal(ev[1].object, "vehicle")
})

test("smart add skips empty types array", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: false, smart: true }
  const packet = {
    action: { action: "add", modelKey: "event", id: "evt1" },
    payload: { camera: "camA", smartDetectTypes: [] },
  }
  assert.deepEqual(normalizeUpdatePacket(packet, state, flags), [])
})

test("smart add skips non-string type entries", () => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: false, smart: true }
  const packet = {
    action: { action: "add", modelKey: "event", id: "evt1" },
    payload: {
      camera: "camA",
      smartDetectTypes: ["package", 3, ""],
    },
  }
  const ev = normalizeUpdatePacket(packet, state, flags)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].object, "package")
})

test("smart uses Date.now fallback when start missing", (t) => {
  const state = { lastMotionByCamera: {}, lastRingByCamera: {} }
  const flags = { motion: false, ring: false, smart: true }
  const nowSpy = t.mock.fn(() => 12_345)
  const realNow = Date.now
  Date.now = nowSpy
  try {
    const packet = {
      action: { action: "add", modelKey: "event", id: "evt1" },
      payload: {
        id: "evt1",
        camera: "camA",
        smartDetectTypes: ["animal"],
      },
    }
    const ev = normalizeUpdatePacket(packet, state, flags)
    assert.equal(ev[0].ts, 12_345)
  } finally {
    Date.now = realNow
  }
})
