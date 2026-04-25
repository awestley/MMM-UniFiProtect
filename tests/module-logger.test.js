"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const { createModuleLogger, PREFIX, resolveLogFilePath } = require("../helpers/module-logger")

test("PREFIX is stable", () => {
  assert.equal(PREFIX, "[MMM-UniFiProtect]")
})

test("disabled logger does not log", () => {
  const orig = console.log
  let calls = 0
  console.log = () => {
    calls++
  }
  try {
    createModuleLogger(false).debug("x")
    assert.equal(calls, 0)
  } finally {
    console.log = orig
  }
})

test("enabled logger logs with prefix", () => {
  const orig = console.log
  const seen = []
  console.log = (p, ...rest) => {
    seen.push([p, ...rest])
  }
  try {
    createModuleLogger(true).debug("hello", 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], PREFIX)
    assert.equal(seen[0][1], "hello")
    assert.equal(seen[0][2], 1)
  } finally {
    console.log = orig
  }
})

test("filePath logs without console", () => {
  const tmp = path.join(os.tmpdir(), `mmm-up-fl-${Date.now()}.log`)
  const orig = console.log
  let calls = 0
  console.log = () => {
    calls++
  }
  try {
    createModuleLogger({ consoleEnabled: false, filePath: tmp }).debug("file-only", { n: 2 })
    assert.equal(calls, 0)
    const content = fs.readFileSync(tmp, "utf8")
    assert.ok(content.includes("file-only"))
    assert.ok(content.includes("n: 2"))
    assert.ok(/\[\d{4}-\d{2}-\d{2}T/.test(content))
  } finally {
    console.log = orig
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
})

test("empty filePath does not create arbitrary file", () => {
  const tmp = path.join(os.tmpdir(), `mmm-up-missing-${Date.now()}.log`)
  createModuleLogger({ consoleEnabled: false, filePath: "" }).debug("nope")
  assert.equal(fs.existsSync(tmp), false)
})

test("resolveLogFilePath returns empty for blank", () => {
  assert.equal(resolveLogFilePath(""), "")
  assert.equal(resolveLogFilePath("   "), "")
})

test("resolveLogFilePath expands ~/ using HOME", () => {
  const prevHome = process.env.HOME
  const fakeHome = path.join(os.tmpdir(), `mmm-up-fakehome-${Date.now()}`)
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env.HOME = fakeHome
  try {
    const rel = "logs/up-tilde.log"
    const r = resolveLogFilePath(`~/${rel}`)
    assert.equal(r, path.resolve(path.join(fakeHome, rel)))
    createModuleLogger({ consoleEnabled: false, filePath: `~/${rel}` }).debug("tilde-line")
    assert.ok(fs.readFileSync(r, "utf8").includes("tilde-line"))
  } finally {
    process.env.HOME = prevHome
    try {
      fs.unlinkSync(path.join(fakeHome, "logs", "up-tilde.log"))
      fs.rmdirSync(path.join(fakeHome, "logs"))
      fs.rmdirSync(fakeHome)
    } catch {
      /* ignore */
    }
  }
})

test("resolveLogFilePath lone ~ uses HOME", () => {
  const prevHome = process.env.HOME
  const fakeHome = path.join(os.tmpdir(), `mmm-up-tildeonly-${Date.now()}`)
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env.HOME = fakeHome
  try {
    assert.equal(resolveLogFilePath("~"), path.resolve(fakeHome))
  } finally {
    process.env.HOME = prevHome
    fs.rmdirSync(fakeHome)
  }
})

test("resolveLogFilePath expands ~/ using USERPROFILE on Windows", { skip: process.platform !== "win32" }, () => {
  const prevUp = process.env.USERPROFILE
  const prevHome = process.env.HOME
  const fakeHome = path.join(os.tmpdir(), `mmm-up-winhome-${Date.now()}`)
  fs.mkdirSync(fakeHome, { recursive: true })
  delete process.env.HOME
  process.env.USERPROFILE = fakeHome
  try {
    const rel = "w/up.log"
    const r = resolveLogFilePath(`~/${rel}`)
    assert.equal(r, path.resolve(path.join(fakeHome, rel)))
  } finally {
    process.env.USERPROFILE = prevUp
    if (prevHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = prevHome
    }
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test("createModuleLogger(null) is inert", () => {
  const orig = console.log
  console.log = () => {
    assert.fail("should not console")
  }
  try {
    createModuleLogger(null).debug("x")
  } finally {
    console.log = orig
  }
})

test("log dir create failure prints once", () => {
  const blocker = path.join(os.tmpdir(), `mmm-up-block-${Date.now()}`)
  fs.writeFileSync(blocker, "x")
  const nested = path.join(blocker, "nope.log")
  const origErr = console.error
  const errs = []
  console.error = (...a) => errs.push(a.join(" "))
  try {
    const log = createModuleLogger({ consoleEnabled: false, filePath: nested })
    log.debug("a")
    log.debug("b")
    const mkdirMsgs = errs.filter(e => e.includes("log dir create failed"))
    assert.equal(mkdirMsgs.length, 1)
  } finally {
    console.error = origErr
    fs.unlinkSync(blocker)
  }
})

test("log file append failure prints once", () => {
  const tmp = path.join(os.tmpdir(), `mmm-up-append-${Date.now()}.log`)
  fs.writeFileSync(tmp, "")
  const origAppend = fs.appendFileSync
  fs.appendFileSync = () => {
    throw new Error("mock append fail")
  }
  const origErr = console.error
  const errs = []
  console.error = (...a) => errs.push(a.join(" "))
  try {
    const log = createModuleLogger({ consoleEnabled: false, filePath: tmp })
    log.debug("a")
    log.debug("b")
    const writeMsgs = errs.filter(e => e.includes("log file write failed"))
    assert.equal(writeMsgs.length, 1)
    assert.ok(writeMsgs[0].includes("mock append fail"))
  } finally {
    fs.appendFileSync = origAppend
    console.error = origErr
    fs.unlinkSync(tmp)
  }
})

test("logFileLine writes file only", () => {
  const tmp = path.join(os.tmpdir(), `mmm-up-lfl-${Date.now()}.log`)
  const origLog = console.log
  console.log = () => {
    assert.fail("logFileLine must not use console.log")
  }
  try {
    createModuleLogger({ consoleEnabled: true, filePath: tmp }).logFileLine("my-tag", "hello file")
    const content = fs.readFileSync(tmp, "utf8")
    assert.ok(content.includes("[my-tag] hello file"))
  } finally {
    console.log = origLog
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
})

test("logFileLine is no-op without file path", () => {
  const origLog = console.log
  console.log = () => {
    assert.fail("should not log")
  }
  try {
    createModuleLogger(false).logFileLine("t", "x")
  } finally {
    console.log = origLog
  }
})

test("log file append failure stringifies non-Error throw", () => {
  const tmp = path.join(os.tmpdir(), `mmm-up-append2-${Date.now()}.log`)
  fs.writeFileSync(tmp, "")
  const origAppend = fs.appendFileSync
  fs.appendFileSync = () => {
    throw 42
  }
  const origErr = console.error
  const errs = []
  console.error = (...a) => errs.push(a.join(" "))
  try {
    createModuleLogger({ consoleEnabled: false, filePath: tmp }).debug("a")
    assert.ok(errs.some(e => e.includes("log file write failed") && e.includes("42")))
  } finally {
    fs.appendFileSync = origAppend
    console.error = origErr
    fs.unlinkSync(tmp)
  }
})
