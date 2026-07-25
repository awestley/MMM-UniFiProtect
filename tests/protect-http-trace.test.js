"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { subscribeProtectHttpTrace } = require("../helpers/protect-http-trace")

test("subscribeProtectHttpTrace logs non-snapshot ends", () => {
  const lines = []
  const moduleLog = {
    debug: (label, detail) => {
      lines.push({ label, detail })
    },
  }
  /** @type {Array<(p: Record<string, unknown>) => void>} */
  const handlers = []
  const channels = {
    httpRequestEnd: {
      subscribe(fn) {
        handlers.push(fn)
      },
      unsubscribe(fn) {
        const i = handlers.indexOf(fn)
        if (i >= 0) {
          handlers.splice(i, 1)
        }
      },
    },
  }
  const unsub = subscribeProtectHttpTrace(channels, moduleLog)
  for (const h of handlers) {
    h({
      url: "https://192.168.1.1/proxy/protect/api/bootstrap",
      method: "GET",
      statusCode: 200,
      durationMs: 12,
      host: "192.168.1.1",
    })
    h({
      url: "https://192.168.1.1/proxy/protect/api/cameras/x/snapshot",
      method: "GET",
      statusCode: 200,
      durationMs: 5,
      host: "192.168.1.1",
    })
  }
  assert.equal(lines.length, 1)
  assert.ok(lines[0].label.startsWith("[retrieve#"))
  assert.equal(lines[0].detail.statusCode, 200)
  unsub()
  assert.equal(handlers.length, 0)
})

test("subscribeProtectHttpTrace noops without channel", () => {
  const unsub = subscribeProtectHttpTrace({}, { debug: () => {} })
  assert.equal(typeof unsub, "function")
  unsub()
})
