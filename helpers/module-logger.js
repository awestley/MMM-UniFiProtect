"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const util = require("util")

const PREFIX = "[MMM-UniFiProtect]"

const warnedMkdir = new Set()
const warnedAppend = new Set()

/**
 * @returns {string}
 */
function homeDir() {
  if (process.platform === "win32") {
    const up = process.env.USERPROFILE
    if (typeof up === "string" && up.length > 0) {
      return up
    }
    const drive = process.env.HOMEDRIVE
    const pth = process.env.HOMEPATH
    if (typeof drive === "string" && typeof pth === "string") {
      return `${drive}${pth}`
    }
  }
  const h = process.env.HOME
  if (typeof h === "string" && h.length > 0) {
    return h
  }
  return os.homedir()
}

/**
 * Absolute path used for log file writes. Expands leading `~/` like a shell (uses `HOME` / `USERPROFILE` when set).
 * @param {string} filePath
 * @returns {string} empty string when input is empty/whitespace
 */
function resolveLogFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return ""
  }
  let p = filePath.trim()
  if (p.startsWith("~/")) {
    const home = homeDir()
    p = home ? path.join(home, p.slice(2)) : path.resolve(p)
  } else if (p === "~") {
    const home = homeDir()
    p = home || path.resolve(p)
  }
  return path.resolve(p)
}

/**
 * @param {Set<string>} seen
 * @param {string} key
 * @param {string} detail
 * @param {unknown} err
 */
function warnOnce(seen, key, detail, err) {
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  const msg = err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : String(err)
  console.error(PREFIX, detail + ":", key, msg)
}

/**
 * @param {boolean | { consoleEnabled?: boolean, filePath?: string }} input
 * @returns {{ consoleEnabled: boolean, filePath: string }}
 */
function normalizeLoggerOptions(input) {
  if (typeof input === "boolean") {
    return { consoleEnabled: input, filePath: "" }
  }
  const o = input && typeof input === "object" ? input : {}
  const fp = o.filePath
  return {
    consoleEnabled: !!o.consoleEnabled,
    filePath: typeof fp === "string" ? fp.trim() : "",
  }
}

/**
 * @param {string} filePath
 * @param {string} line
 */
function appendLineSync(filePath, line) {
  const abs = resolveLogFilePath(filePath)
  if (!abs) {
    return
  }
  const dir = path.dirname(abs)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    warnOnce(warnedMkdir, abs, "log dir create failed", err)
    return
  }
  try {
    fs.appendFileSync(abs, line, "utf8")
  } catch (err) {
    warnOnce(warnedAppend, abs, "log file write failed", err)
  }
}

/**
 * @param {unknown[]} args
 * @returns {string}
 */
function formatArgs(args) {
  return args
    .map(a => (typeof a === "string" ? a : util.inspect(a, { depth: 6, colors: false })))
    .join(" ")
}

/**
 * Logs to console and/or a file. File lines are ISO-timestamped, one event per line.
 * @param {boolean | { consoleEnabled?: boolean, filePath?: string }} input
 * Pass `true`/`false` for console-only (backward compatible), or an object:
 * - `consoleEnabled` — mirror `debugLogging` in config
 * - `filePath` — non-empty absolute or relative path on the MagicMirror host (Node); same messages as sparse `debug()` calls
 */
function createModuleLogger(input) {
  const { consoleEnabled, filePath } = normalizeLoggerOptions(input)
  return {
    debug(...args) {
      if (consoleEnabled) {
        console.log(PREFIX, ...args)
      }
      if (filePath) {
        const ts = new Date().toISOString()
        const body = formatArgs(args)
        appendLineSync(filePath, `[${ts}] ${PREFIX} ${body}\n`)
      }
    },
    /**
     * Append one line to the log file only (no console). Used for unifi-protect adapter messages.
     * @param {string} tag e.g. unifi-protect:error
     * @param {string} line formatted message (no trailing newline)
     */
    logFileLine(tag, line) {
      if (!filePath) {
        return
      }
      const ts = new Date().toISOString()
      const safeTag = typeof tag === "string" ? tag : "library"
      const body = typeof line === "string" ? line : String(line)
      appendLineSync(filePath, `[${ts}] ${PREFIX} [${safeTag}] ${body}\n`)
    },
  }
}

module.exports = { createModuleLogger, PREFIX, resolveLogFilePath }
