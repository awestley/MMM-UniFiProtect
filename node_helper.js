"use strict"

const https = require("https")
const http = require("http")
const util = require("util")
const { URL } = require("url")

const NodeHelper = require("node_helper")
const { typedEventsToUi } = require("./helpers/typed-event-ui")
const { shouldEmit } = require("./helpers/debounce")
const { debounceMsForEvent } = require("./helpers/event-debounce")
const { jpegToDataUrl } = require("./helpers/snapshot")
const { createModuleLogger, resolveLogFilePath } = require("./helpers/module-logger")
const { subscribeProtectHttpTrace } = require("./helpers/protect-http-trace")
const {
  getUnifiProtectRuntimeMeta,
  incompatibleUnifiProtectMessage,
} = require("./helpers/unifi-protect-runtime-meta")

/**
 * @param {Disposable | { dispose?: () => void } | null | undefined} sub
 */
function disposeSync(sub) {
  if (!sub) {
    return
  }
  try {
    if (typeof sub[Symbol.dispose] === "function") {
      sub[Symbol.dispose]()
    } else if (typeof sub.dispose === "function") {
      sub.dispose()
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {AsyncDisposable | null | undefined} client
 * @returns {Promise<void>}
 */
async function disposeProtectClient(client) {
  if (!client) {
    return
  }
  try {
    await client[Symbol.asyncDispose]()
  } catch {
    /* ignore */
  }
}

/** After a failed refresh, ignore duplicate connects for this many ms (same host+user). */
const CONNECT_FAILURE_BACKOFF_MS = 15000

/** First `import("unifi-protect")` can block on slow volumes; surface a clear error instead of hanging forever. */
const CONNECT_IMPORT_TIMEOUT_MS = 60000

/**
 * Prefer the UniFi Protect device name for UI labels when config only supplied a camera id
 * (or set `name` equal to `id`). Preserves an explicit custom `name` in config.
 *
 * @param {{ id: string, name: string, streamUrl: string | null }} entry
 * @param {Array<{ id?: string, name?: string }>} protectCameras
 */
function applyProtectDisplayName(entry, protectCameras) {
  if (!entry.id) {
    return entry
  }
  const device = protectCameras.find(c => c && c.id === entry.id)
  if (!device || typeof device.name !== "string" || device.name.length === 0) {
    return entry
  }
  const configured = entry.name
  const explicitLabel
    = typeof configured === "string"
      && configured.length > 0
      && configured !== entry.id
  if (explicitLabel) {
    return entry
  }
  return { ...entry, name: device.name }
}

/**
 * Attach `cameraName` from bootstrap so the UI can label events even when the camera is not in `config.cameras`.
 *
 * @param {Record<string, unknown>} ev
 * @param {unknown} bootstrapCameras
 * @returns {Record<string, unknown>}
 */
function enrichEventWithCameraName(ev, bootstrapCameras) {
  if (!ev || typeof ev !== "object") {
    return ev
  }
  const id = typeof ev.cameraId === "string" ? ev.cameraId : ""
  if (!id || !Array.isArray(bootstrapCameras)) {
    return ev
  }
  const device = bootstrapCameras.find(c => c && c.id === id)
  if (device && typeof device.name === "string" && device.name.length > 0) {
    return { ...ev, cameraName: device.name }
  }
  return ev
}

/**
 * @param {{ id: string, streamUrl: string | null }} cam
 * @param {{ streamUrlByCameraId?: Record<string, string> }} cfg
 * @returns {boolean}
 */
function cameraHasEmbeddedStream(cam, cfg) {
  if (cam && typeof cam.streamUrl === "string" && cam.streamUrl.trim().length > 0) {
    return true
  }
  const map = cfg && cfg.streamUrlByCameraId && typeof cfg.streamUrlByCameraId === "object"
    ? cfg.streamUrlByCameraId
    : null
  const id = cam && typeof cam.id === "string" ? cam.id : ""
  if (!id || !map) {
    return false
  }
  const u = map[id]
  return typeof u === "string" && u.trim().length > 0
}

/**
 * Use UniFi Protect fMP4 livestream (`camera.livestream()`) for this camera when no iframe URL is set.
 *
 * @param {{ id: string, streamUrl: string | null }} cam
 * @param {{ streamUrlByCameraId?: Record<string, string>, protectNativeLive?: boolean }} cfg
 * @returns {boolean}
 */
function cameraWantsProtectNativeLive(cam, cfg) {
  if (cameraHasEmbeddedStream(cam, cfg)) {
    return false
  }
  if (!cfg || typeof cfg !== "object") {
    return false
  }
  if (cfg.protectNativeLive === false) {
    return false
  }
  return true
}

/**
 * @param {string} raw
 * @returns {string}
 */
function sanitizeUrlForStreamDiag(raw) {
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!s) {
    return ""
  }
  try {
    const u = new URL(s)
    const redacted = new URL(u.toString())
    for (const k of [...redacted.searchParams.keys()]) {
      if (/^(token|password|pass|key|secret|auth)$/i.test(k)) {
        redacted.searchParams.set(k, "<redacted>")
      }
    }
    return redacted.toString()
  } catch {
    return s.length > 200 ? `${s.slice(0, 200)}…` : s
  }
}

/**
 * Log whether stream-related env vars exist in the Node process (length only; no values).
 * Helps distinguish "Compose/env not injected" vs "client config map empty".
 *
 * @param {{ logFileLine?: (tag: string, line: string) => void } | null} moduleLog
 */
function emitStreamEnvPresence(moduleLog) {
  const keys = [
    "UNIFI_PROTECT_STREAM_URL_CAM1",
    "UNIFI_PROTECT_STREAM_URL_CAM2",
    "UNIFI_PROTECT_STREAM_URL_CAM3",
    "UNIFI_PROTECT_STREAM_CAMERA_IDS",
    "UNIFI_PROTECT_CAMERA_IDS",
  ]
  const parts = []
  for (const k of keys) {
    const v = process.env[k]
    const s = typeof v === "string" ? v : ""
    parts.push(`${k}=${s.trim().length > 0 ? `set(len=${s.trim().length})` : "unset"}`)
  }
  const line = `process.env stream vars: ${parts.join(" ")}`
  console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
  if (moduleLog && typeof moduleLog.logFileLine === "function") {
    moduleLog.logFileLine("stream-diag", line)
  }
}

/**
 * @param {string} name
 * @returns {string[]}
 */
function readCsvEnv(name) {
  const v = process.env[name]
  if (typeof v !== "string") {
    return []
  }
  return String(v)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Build `streamUrlByCameraId` from Node `process.env` using the same rules as `config/config.js`.
 * @returns {Record<string, string>}
 */
function streamUrlByCameraIdFromProcessEnv() {
  const idList = readCsvEnv("UNIFI_PROTECT_STREAM_CAMERA_IDS")
  const cameraIds = readCsvEnv("UNIFI_PROTECT_CAMERA_IDS")
  const urls = [
    typeof process.env.UNIFI_PROTECT_STREAM_URL_CAM1 === "string" ? process.env.UNIFI_PROTECT_STREAM_URL_CAM1.trim() : "",
    typeof process.env.UNIFI_PROTECT_STREAM_URL_CAM2 === "string" ? process.env.UNIFI_PROTECT_STREAM_URL_CAM2.trim() : "",
    typeof process.env.UNIFI_PROTECT_STREAM_URL_CAM3 === "string" ? process.env.UNIFI_PROTECT_STREAM_URL_CAM3.trim() : "",
  ]
  const out = /** @type {Record<string, string>} */ ({})
  for (let i = 0; i < 3; i++) {
    if (!urls[i]) {
      continue
    }
    const key = idList[i] || cameraIds[i] || ""
    if (!key) {
      continue
    }
    out[key] = urls[i]
  }
  return out
}

/**
 * If the browser sent an empty stream map, merge in any stream URLs visible to the Node process.
 * Logs exactly what happened (keys + redacted URLs), without touching passwords.
 *
 * @param {unknown} cfg
 * @param {{ logFileLine?: (tag: string, line: string) => void } | null} moduleLog
 * @returns {boolean} true if cfg.streamUrlByCameraId was mutated
 */
function mergeProcessEnvStreamUrlsIntoCfg(cfg, moduleLog) {
  if (!cfg || typeof cfg !== "object") {
    return false
  }
  const cur = cfg.streamUrlByCameraId && typeof cfg.streamUrlByCameraId === "object"
    ? cfg.streamUrlByCameraId
    : {}
  const curKeys = Object.keys(cur).sort()
  if (curKeys.length > 0) {
    return false
  }
  const envMap = streamUrlByCameraIdFromProcessEnv()
  const envKeys = Object.keys(envMap).sort()
  if (envKeys.length === 0) {
    const line = "stream merge: skipped (client map empty; process.env has no UNIFI_PROTECT_STREAM_URL_CAMn entries that map to a camera id)"
    console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
    if (moduleLog && typeof moduleLog.logFileLine === "function") {
      moduleLog.logFileLine("stream-diag", line)
    }
    return false
  }
  cfg.streamUrlByCameraId = { ...cur, ...envMap }
  const mergedKeys = Object.keys(cfg.streamUrlByCameraId).sort()
  const parts = mergedKeys.map((k) => {
    const u = cfg.streamUrlByCameraId[k]
    const len = typeof u === "string" ? u.trim().length : 0
    return `${k}->len(${len}) url=${sanitizeUrlForStreamDiag(typeof u === "string" ? u : "")}`
  })
  const line = `stream merge: applied process.env stream map keys=${mergedKeys.join("|")} :: ${parts.join(" | ")}`
  console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
  if (moduleLog && typeof moduleLog.logFileLine === "function") {
    moduleLog.logFileLine("stream-diag", line)
  }
  return true
}

/**
 * @param {Array<{ id: string, name: string, streamUrl: string | null }>} cameras
 * @param {unknown} cfg
 */
function applyStreamUrlsFromCfgMap(cameras, cfg) {
  const map = cfg && typeof cfg === "object" && cfg.streamUrlByCameraId && typeof cfg.streamUrlByCameraId === "object"
    ? cfg.streamUrlByCameraId
    : null
  if (!map || !Array.isArray(cameras)) {
    return
  }
  for (const cam of cameras) {
    if (!cam || typeof cam.id !== "string") {
      continue
    }
    const existing = typeof cam.streamUrl === "string" ? cam.streamUrl.trim() : ""
    if (existing.length > 0) {
      continue
    }
    const u = typeof map[cam.id] === "string" ? map[cam.id].trim() : ""
    if (u.length > 0) {
      cam.streamUrl = u
    }
  }
}

/**
 * @param {unknown} cfg
 * @param {{ debug?: (...args: unknown[]) => void, logFileLine?: (tag: string, line: string) => void } | null} moduleLog
 */
function emitStreamConnectClientPayloadDiag(cfg, moduleLog) {
  if (!cfg || typeof cfg !== "object") {
    return
  }
  const want = cfg.streamDiagnostics === true || cfg.debugLogging === true
  if (!want) {
    return
  }
  const host = typeof cfg.host === "string" ? cfg.host : ""
  const user = typeof cfg.username === "string" ? cfg.username : ""
  const map = cfg.streamUrlByCameraId && typeof cfg.streamUrlByCameraId === "object"
    ? cfg.streamUrlByCameraId
    : null
  const mapKeys = map ? Object.keys(map).sort() : []
  const cams = Array.isArray(cfg.cameras) ? cfg.cameras : []
  const head = `UNIFIPROTECT_CONNECT stream summary host=${host} user=${user} cameras=${cams.length} streamDiagnostics=${cfg.streamDiagnostics === true} debugLogging=${cfg.debugLogging === true} mapKeys=${mapKeys.length ? mapKeys.join("|") : "<none>"}`
  console.info("[MMM-UniFiProtect]", "[stream-diag]", head)
  if (moduleLog && typeof moduleLog.logFileLine === "function") {
    moduleLog.logFileLine("stream-diag", head)
  }

  let idx = 0
  for (const e of cams) {
    idx += 1
    if (typeof e === "string") {
      const line = `UNIFIPROTECT_CONNECT camera[${idx}] type=string id=${e} streamUrl=<none>`
      console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
      if (moduleLog && typeof moduleLog.logFileLine === "function") {
        moduleLog.logFileLine("stream-diag", line)
      }
      continue
    }
    if (!e || typeof e !== "object") {
      const line = `UNIFIPROTECT_CONNECT camera[${idx}] type=${e === null ? "null" : typeof e}`
      console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
      if (moduleLog && typeof moduleLog.logFileLine === "function") {
        moduleLog.logFileLine("stream-diag", line)
      }
      continue
    }
    const id = typeof e.id === "string" ? e.id : ""
    const name = typeof e.name === "string" ? e.name : ""
    const su = typeof e.streamUrl === "string" ? e.streamUrl.trim() : ""
    const line = su.length > 0
      ? `UNIFIPROTECT_CONNECT camera[${idx}] type=object id=${id} name=${name} streamUrl=len(${su.length}) url=${sanitizeUrlForStreamDiag(su)}`
      : `UNIFIPROTECT_CONNECT camera[${idx}] type=object id=${id} name=${name} streamUrl=<empty>`
    console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
    if (moduleLog && typeof moduleLog.logFileLine === "function") {
      moduleLog.logFileLine("stream-diag", line)
    }
  }

  if (map) {
    for (const k of mapKeys) {
      const v = typeof map[k] === "string" ? map[k].trim() : ""
      const line = v.length > 0
        ? `UNIFIPROTECT_CONNECT streamUrlByCameraId[${k}]=len(${v.length}) url=${sanitizeUrlForStreamDiag(v)}`
        : `UNIFIPROTECT_CONNECT streamUrlByCameraId[${k}]=<empty>`
      console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
      if (moduleLog && typeof moduleLog.logFileLine === "function") {
        moduleLog.logFileLine("stream-diag", line)
      }
    }
  }
}

/**
 * @param {{ streamUrlByCameraId?: Record<string, string>, streamDiagnostics?: boolean, protectNativeLive?: boolean }} cfg
 * @param {Array<{ id: string, name: string, streamUrl: string | null }>} cameras
 * @param {{ debug?: (...args: unknown[]) => void, logFileLine?: (tag: string, line: string) => void } | null} moduleLog
 * @param {{ has?: (id: string) => boolean } | null} liveNativeMap
 */
function emitStreamDiagnostics(cfg, cameras, moduleLog, liveNativeMap) {
  if (!cfg || cfg.streamDiagnostics !== true) {
    return
  }
  emitStreamEnvPresence(moduleLog)
  const map = cfg.streamUrlByCameraId && typeof cfg.streamUrlByCameraId === "object"
    ? cfg.streamUrlByCameraId
    : {}
  const mapKeys = Object.keys(map).sort()
  const snapSec = typeof cfg.snapshotRefreshSeconds === "number" ? cfg.snapshotRefreshSeconds : 2
  const lineHead = `snapshotRefreshSeconds=${snapSec} mapKeys=${mapKeys.length ? mapKeys.join("|") : "<none>"}`
  console.info("[MMM-UniFiProtect]", "[stream-diag]", lineHead)
  if (moduleLog && typeof moduleLog.logFileLine === "function") {
    moduleLog.logFileLine("stream-diag", lineHead)
  }

  for (const cam of cameras || []) {
    const id = cam && typeof cam.id === "string" ? cam.id : ""
    if (!id) {
      continue
    }
    const per = typeof cam.streamUrl === "string" ? cam.streamUrl.trim() : ""
    const mapped = typeof map[id] === "string" ? map[id].trim() : ""
    const chosen = per.length > 0 ? per : mapped
    const hasIframe = chosen.length > 0
    const wantsNative = cameraWantsProtectNativeLive(cam, cfg)
    const nativeSession = !!(liveNativeMap && typeof liveNativeMap.has === "function" && liveNativeMap.has(id))
    const snap = hasIframe || (wantsNative && nativeSession) ? "off" : "on"
    const chosenSource = hasIframe
      ? (per.length > 0 ? "camera.streamUrl" : "streamUrlByCameraId[id]")
      : (wantsNative ? "protectNativeLive(fMP4)" : "<none>")
    const iframeStr = hasIframe ? "yes" : "no"
    const nativeStr = wantsNative ? (nativeSession ? "active" : "pending") : "off"
    const detailParts = [
      `cameraId=${id}`,
      `name=${typeof cam.name === "string" ? cam.name : ""}`,
      `iframeStream=${iframeStr}`,
      `protectNativeLive=${nativeStr}`,
      `snapshotPolling=${snap}`,
      `chosenSource=${chosenSource}`,
    ]
    if (hasIframe) {
      detailParts.push(`url=${sanitizeUrlForStreamDiag(chosen)}`)
    } else {
      if (mapKeys.length > 0) {
        detailParts.push(`mapKeyMatch=${mapped.length > 0 ? "yes" : "no"}`)
      }
      if (typeof cam.streamUrl === "string" && cam.streamUrl.trim().length === 0) {
        detailParts.push("note=camera.streamUrl is empty string")
      }
    }
    const line = `tile ${detailParts.join(" ")}`
    console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
    if (moduleLog && typeof moduleLog.logFileLine === "function") {
      moduleLog.logFileLine("stream-diag", line)
    }
  }
}

/**
 * @param {{ streamDiagnostics?: boolean, snapshotRefreshSeconds?: number }} cfg
 * @param {Array<{ id: string, streamUrl: string | null }>} cameras
 * @param {Array<{ id: string, streamUrl: string | null }>} snapshotCams
 * @param {{ logFileLine?: (tag: string, line: string) => void } | null} moduleLog
 */
function emitSnapshotPollingDiagnostics(cfg, cameras, snapshotCams, moduleLog) {
  if (!cfg || cfg.streamDiagnostics !== true) {
    return
  }
  const sec = typeof cfg.snapshotRefreshSeconds === "number" ? cfg.snapshotRefreshSeconds : 2
  const all = cameras || []
  const snap = snapshotCams || []
  const line = `snapshotPolling planned=${snap.length > 0 ? "yes" : "no"} intervalSec=${sec} snapshotCameraIds=${snap.map(c => c.id).join("|") || "<none>"} totalCameras=${all.length}`
  console.info("[MMM-UniFiProtect]", "[stream-diag]", line)
  if (moduleLog && typeof moduleLog.logFileLine === "function") {
    moduleLog.logFileLine("stream-diag", line)
  }
}

/**
 * Always print to stdout/stderr and mirror to log file when `logFileLine` exists (independent of `debugLogging`).
 *
 * @param {{ logFileLine?: (tag: string, line: string) => void } | null | undefined} moduleLog
 * @param {string} message
 * @param {unknown} [detail]
 */
function connectProgress(moduleLog, message, detail) {
  const extra = detail !== undefined ? ` ${util.inspect(detail, { depth: 6, colors: false })}` : ""
  const line = `${message}${extra}`
  console.info("[MMM-UniFiProtect]", line)
  if (moduleLog && typeof moduleLog.logFileLine === "function") {
    moduleLog.logFileLine("connect-step", line)
  }
}

module.exports = NodeHelper.create({
  start() {
    this.api = null
    this.moduleLog = createModuleLogger({ consoleEnabled: false, filePath: "" })
    this.snapshotTimers = []
    this.wsAttached = false
    this.wsHandler = null
    this._packetSub = null
    this._connectionLostSub = null
    this._connectionRecoveredSub = null
    this._httpTraceUnsub = null
    this._protectImportPromise = null
    this.debounceMap = new Map()
    this.lastConfig = null
    this._queuedConnect = null
    this._connectChain = null
    this._connectBackoffKey = null
    this._connectNotBefore = 0
    this._protectLiveByCamera = new Map()
    /** @type {Set<string>} */
    this._liveNativeFailed = new Set()
    /** @type {Array<{ id: string, name: string, streamUrl: string | null }>} */
    this._lastValidCameras = []
  },

  stop() {
    this.stopAllProtectNativeLivestreams()
    this.clearSnapshots()
    this.detachEvents()
    this.stopHttpTrace()
    const api = this.api
    this.api = null
    void disposeProtectClient(api)
  },

  stopHttpTrace() {
    if (typeof this._httpTraceUnsub === "function") {
      try {
        this._httpTraceUnsub()
      } catch {
        /* ignore */
      }
    }
    this._httpTraceUnsub = null
  },

  stopAllProtectNativeLivestreams() {
    for (const [, rec] of this._protectLiveByCamera) {
      try {
        if (rec.abort && typeof rec.abort.abort === "function") {
          rec.abort.abort()
        }
      } catch {
        /* ignore */
      }
      try {
        if (rec.ls && typeof rec.ls[Symbol.asyncDispose] === "function") {
          void rec.ls[Symbol.asyncDispose]()
        }
      } catch {
        /* ignore */
      }
    }
    this._protectLiveByCamera.clear()
  },

  clearSnapshots() {
    for (const t of this.snapshotTimers) {
      clearInterval(t)
    }
    this.snapshotTimers = []
  },

  detachEvents() {
    disposeSync(this._packetSub)
    disposeSync(this._connectionLostSub)
    disposeSync(this._connectionRecoveredSub)
    this._packetSub = null
    this._connectionLostSub = null
    this._connectionRecoveredSub = null
    this.wsHandler = null
    this.wsAttached = false
  },

  async importProtect() {
    if (!this._protectImportPromise) {
      this._protectImportPromise = Promise.race([
        import("unifi-protect"),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `import(unifi-protect) timed out after ${CONNECT_IMPORT_TIMEOUT_MS}ms — check node_modules on a fast volume, or NFS/Docker mount stalls`,
              ),
            )
          }, CONNECT_IMPORT_TIMEOUT_MS)
        }),
      ]).catch((err) => {
        this._protectImportPromise = null
        throw err
      })
    }
    return this._protectImportPromise
  },

  /**
   * @param {boolean} debug
   * @param {{ logFileLine?: (tag: string, line: string) => void } | null} moduleLog
   */
  makeLog(debug, moduleLog) {
    const prefix = "[MMM-UniFiProtect]"
    const fmt = (msg, ...params) => util.format(msg, ...params)
    const mirrorFile = (tag, line) => {
      if (moduleLog && typeof moduleLog.logFileLine === "function") {
        moduleLog.logFileLine(tag, line)
      }
    }
    return {
      debug: (msg, ...params) => {
        if (debug) {
          console.log(prefix, fmt(msg, ...params))
        }
      },
      info: (msg, ...params) => {
        if (debug) {
          console.log(prefix, fmt(msg, ...params))
        }
      },
      warn: (msg, ...params) => {
        const line = fmt(msg, ...params)
        console.warn(prefix, line)
        mirrorFile("unifi-protect:warn", line)
      },
      error: (msg, ...params) => {
        const line = fmt(msg, ...params)
        console.error(prefix, line)
        mirrorFile("unifi-protect:error", line)
      },
    }
  },

  async socketNotificationReceived(notification, payload) {
    if (notification === "UNIFIPROTECT_LIVE_RESYNC") {
      await this.handleProtectLiveResync(payload)
      return
    }
    if (notification !== "UNIFIPROTECT_CONNECT") {
      return
    }
    this._queuedConnect = payload
    if (this._connectChain) {
      return
    }
    this._connectChain = (async () => {
      try {
        while (this._queuedConnect) {
          const cfg = this._queuedConnect
          this._queuedConnect = null
          try {
            await this.connect(cfg)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error("[MMM-UniFiProtect] connect error:", msg)
            if (err instanceof Error && err.stack) {
              console.error(err.stack)
            }
            const detail = { message: msg }
            if (err instanceof Error) {
              detail.name = err.name
            }
            if (this.lastConfig?.debugLogging && err instanceof Error && err.stack) {
              detail.stack = err.stack
            }
            connectProgress(this.moduleLog, "connect error", detail)
            this.sendSocketNotification("UNIFIPROTECT_STATUS", {
              ok: false,
              error: msg,
            })
          }
        }
      } finally {
        this._connectChain = null
      }
    })()
    await this._connectChain
  },

  /**
   * Client lost MSE state (DOM rebuild); stop listed livestreams so Protect sends a fresh init segment.
   *
   * @param {unknown} payload
   */
  async handleProtectLiveResync(payload) {
    if (!this.api || !this.lastConfig) {
      return
    }
    const raw = payload && typeof payload === "object" && Array.isArray(payload.cameraIds)
      ? payload.cameraIds
      : []
    const ids = raw.filter(id => typeof id === "string" && id.length > 0)
    if (ids.length === 0) {
      return
    }
    const cfg = this.lastConfig
    for (const cameraId of ids) {
      this._liveNativeFailed.delete(cameraId)
      const rec = this._protectLiveByCamera.get(cameraId)
      if (rec) {
        try {
          if (rec.abort && typeof rec.abort.abort === "function") {
            rec.abort.abort()
          }
        } catch {
          /* ignore */
        }
        try {
          if (rec.ls && typeof rec.ls[Symbol.asyncDispose] === "function") {
            await rec.ls[Symbol.asyncDispose]()
          }
        } catch {
          /* ignore */
        }
      }
      this._protectLiveByCamera.delete(cameraId)
    }
    this.clearSnapshots()
    this.startSnapshots(cfg, this._lastValidCameras || [])
    await this.startProtectNativeLivestreams(cfg, this._lastValidCameras || [])
  },

  resolveCameras(entries, protectCameras) {
    const list = protectCameras || []
    const resolved = []
    for (const e of entries || []) {
      if (typeof e === "string") {
        resolved.push(applyProtectDisplayName({ id: e, name: e, streamUrl: null }, list))
        continue
      }
      if (e && typeof e === "object") {
        if (typeof e.id === "string") {
          const base = {
            id: e.id,
            name: typeof e.name === "string" ? e.name : e.id,
            streamUrl: typeof e.streamUrl === "string" ? e.streamUrl : null,
          }
          resolved.push(applyProtectDisplayName(base, list))
          continue
        }
        if (typeof e.name === "string") {
          const found = list.find(c => c.name === e.name)
          resolved.push({
            id: found ? found.id : "",
            name: e.name,
            streamUrl: typeof e.streamUrl === "string" ? e.streamUrl : null,
          })
        }
      }
    }
    return resolved
  },

  async connect(cfg) {
    this.lastConfig = cfg
    const logFileRaw = typeof cfg.logFile === "string" ? cfg.logFile : ""
    this.moduleLog = createModuleLogger({
      consoleEnabled: !!cfg.debugLogging,
      filePath: logFileRaw,
    })
    const logResolved = resolveLogFilePath(logFileRaw)
    if (logResolved) {
      console.info("[MMM-UniFiProtect] file logging:", logResolved)
    }

    mergeProcessEnvStreamUrlsIntoCfg(cfg, this.moduleLog)
    emitStreamConnectClientPayloadDiag(cfg, this.moduleLog)

    const host = cfg.host
    const username = cfg.username
    const password = cfg.password
    if (!host || !username || !password) {
      this.moduleLog.debug("connect aborted: set host, username, and password")
      this.sendSocketNotification("UNIFIPROTECT_STATUS", {
        ok: false,
        error: "host, username, and password are required",
      })
      return
    }

    const backoffKey = `${host}|${username}`
    const now = Date.now()
    if (now < this._connectNotBefore && this._connectBackoffKey === backoffKey) {
      this.moduleLog.debug("connect skipped (backoff after recent failure)", {
        retryAfterMs: this._connectNotBefore - now,
        host,
      })
      return
    }

    this.clearSnapshots()
    this.stopAllProtectNativeLivestreams()
    this._liveNativeFailed.clear()
    this.detachEvents()
    this.stopHttpTrace()
    await disposeProtectClient(this.api)
    this.api = null
    this.debounceMap = new Map()

    this.moduleLog.debug("connecting", host)
    const log = this.makeLog(!!cfg.debugLogging, this.moduleLog)
    const ufpDisk = getUnifiProtectRuntimeMeta()
    const versionBlock = incompatibleUnifiProtectMessage(ufpDisk)
    if (versionBlock) {
      connectProgress(this.moduleLog, "unifi-protect incompatible", { detail: versionBlock })
      throw new Error(versionBlock)
    }
    const protectMod = await this.importProtect()
    const { ProtectClient, channels } = protectMod
    if (typeof ProtectClient?.connect !== "function") {
      const exportKeys = Object.keys(protectMod || {}).sort()
      throw new Error(
        `MMM-UniFiProtect: no ProtectClient.connect (keys=${JSON.stringify(exportKeys)})`,
      )
    }
    const ufpLine = {
      version: ufpDisk.version,
      importFrom: "package",
      exportKeys: Object.keys(protectMod || {}).length,
    }
    if (ufpDisk.packageJsonPath) {
      ufpLine.packageJsonPath = ufpDisk.packageJsonPath
    }
    if (ufpDisk.error) {
      ufpLine.readError = ufpDisk.error
    }
    connectProgress(this.moduleLog, "unifi-protect", ufpLine)

    const hasApiKey = cfg.apiKey && typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0
    if (hasApiKey) {
      this.moduleLog.debug(
        "apiKey is configured but unifi-protect v5 authenticates with username/password only; apiKey is ignored",
      )
    }

    if (cfg.traceRetrieve !== false) {
      this._httpTraceUnsub = subscribeProtectHttpTrace(channels, this.moduleLog)
    }

    connectProgress(this.moduleLog, "session", { includeApiKey: false })
    try {
      if (cfg.debugLogging) {
        this.moduleLog.debug("ProtectClient.connect() …")
      }
      this.api = await ProtectClient.connect({
        host,
        username,
        password,
        log,
      })
    } catch (err) {
      this._connectBackoffKey = backoffKey
      this._connectNotBefore = Date.now() + CONNECT_FAILURE_BACKOFF_MS
      const msg = err instanceof Error ? err.message : String(err)
      this.moduleLog.debug("connect failed", {
        host,
        node: process.version,
        error: msg,
        name: err instanceof Error ? err.name : undefined,
        traceHint: "See [retrieve#n] lines for HTTP detail when traceRetrieve is true.",
      })
      this.stopHttpTrace()
      await probeUniFiOsLanding(host, this.moduleLog)
      this.sendSocketNotification("UNIFIPROTECT_STATUS", {
        ok: false,
        error: "Failed to connect or refresh devices (check host, credentials, and UniFi Protect version)",
      })
      this.api = null
      return
    }

    this._connectBackoffKey = null
    this._connectNotBefore = 0

    const resolved = this.resolveCameras(cfg.cameras, this.api.cameras ?? [])
    const valid = resolved.filter(c => c.id)
    if (resolved.length > 0 && valid.length === 0) {
      this.moduleLog.debug("no configured cameras matched Protect (check id or name)")
      this.sendSocketNotification("UNIFIPROTECT_STATUS", {
        ok: false,
        error: "No cameras matched config (check camera id or name)",
      })
    }

    this.moduleLog.debug("session ok", { configuredCameras: valid.length })
    this._lastValidCameras = valid
    applyStreamUrlsFromCfgMap(valid, cfg)
    emitStreamDiagnostics(cfg, valid, this.moduleLog, this._protectLiveByCamera)
    this.sendSocketNotification("UNIFIPROTECT_STATUS", { ok: true })
    this.sendSocketNotification("UNIFIPROTECT_CAMERAS", {
      cameras: valid,
    })

    this.attachEvents(cfg)
    this.startSnapshots(cfg, valid)
    void this.startProtectNativeLivestreams(cfg, valid)
  },

  /**
   * Start Protect controller fMP4 livestreams for cameras without iframe `streamUrl` (see `cameraWantsProtectNativeLive`).
   *
   * @param {unknown} cfg
   * @param {Array<{ id: string, name: string, streamUrl: string | null }>} cameras
   */
  async startProtectNativeLivestreams(cfg, cameras) {
    if (!this.api || !cfg || typeof cfg !== "object") {
      return
    }
    const list = cameras || []
    for (const cam of list) {
      if (!cam || typeof cam.id !== "string" || !cam.id) {
        continue
      }
      if (!cameraWantsProtectNativeLive(cam, cfg)) {
        continue
      }
      if (this._liveNativeFailed.has(cam.id)) {
        continue
      }
      if (this._protectLiveByCamera.has(cam.id)) {
        continue
      }

      const camera = this.api.camera(cam.id)
      if (!camera) {
        this._liveNativeFailed.add(cam.id)
        continue
      }

      const cameraId = cam.id
      let sawSegment = false
      const abort = new AbortController()
      let timeoutId = null

      const refreshSnapshots = () => {
        this.clearSnapshots()
        this.startSnapshots(cfg, this._lastValidCameras || list)
      }

      const failNative = (reason) => {
        if (this._liveNativeFailed.has(cameraId)) {
          return
        }
        this._liveNativeFailed.add(cameraId)
        this.moduleLog.debug("protect native live disabled for camera", cameraId, reason)
        try {
          abort.abort()
        } catch {
          /* ignore */
        }
        this._protectLiveByCamera.delete(cameraId)
        refreshSnapshots()
      }

      let ls
      try {
        ls = camera.livestream({
          segmentLength: 400,
          chunkSize: 8192,
          timestamps: false,
          signal: abort.signal,
          discardOnDispose: true,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.moduleLog.debug("protect livestream subscribe threw", cameraId, msg)
        this._liveNativeFailed.add(cameraId)
        refreshSnapshots()
        continue
      }

      this._protectLiveByCamera.set(cameraId, { ls, abort })

      timeoutId = setTimeout(() => {
        if (!sawSegment) {
          failNative("(timeout waiting for first fMP4 segment)")
        }
      }, 15000)

      void (async () => {
        try {
          for await (const segment of ls) {
            if (!segment || typeof segment !== "object") {
              continue
            }
            if (segment.type === "init") {
              const codec = typeof segment.codec === "string" ? segment.codec : (ls.codec || "")
              this.sendSocketNotification("UNIFIPROTECT_LIVE_CODEC", { cameraId, codec })
              const b = Buffer.isBuffer(segment.data) ? segment.data : Buffer.from(segment.data)
              if (b.length > 0) {
                this.sendSocketNotification("UNIFIPROTECT_LIVE_FMP4", {
                  cameraId,
                  kind: "init",
                  data: b.toString("base64"),
                })
              }
              continue
            }
            const b = Buffer.isBuffer(segment.data) ? segment.data : Buffer.from(segment.data)
            if (b.length === 0) {
              continue
            }
            if (!sawSegment) {
              sawSegment = true
              if (timeoutId) {
                clearTimeout(timeoutId)
                timeoutId = null
              }
              refreshSnapshots()
            }
            this.sendSocketNotification("UNIFIPROTECT_LIVE_FMP4", {
              cameraId,
              kind: "segment",
              data: b.toString("base64"),
            })
          }
        } catch (e) {
          if (!abort.signal.aborted) {
            const msg = e instanceof Error ? e.message : String(e)
            this.moduleLog.debug("protect livestream iteration ended", cameraId, msg)
            failNative(msg)
            return
          }
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId)
          }
          this._protectLiveByCamera.delete(cameraId)
          if (cfg.debugLogging) {
            this.moduleLog.debug("protect native livestream close", cameraId, { sawSegment })
          }
          refreshSnapshots()
        }
      })()
    }
    const anyNative = list.some(c => cameraWantsProtectNativeLive(c, cfg))
    if (anyNative && cfg.streamDiagnostics === true && this._lastValidCameras) {
      emitStreamDiagnostics(cfg, this._lastValidCameras, this.moduleLog, this._protectLiveByCamera)
    }
  },

  attachEvents(cfg) {
    if (!this.api || this.wsAttached) {
      return
    }
    const flags = {
      motion: cfg.showMotionEvents !== false,
      ring: cfg.showRingEvents !== false,
      smart: cfg.showSmartEvents !== false,
    }
    const eventDebounceMs = typeof cfg.eventDebounceMs === "number" ? cfg.eventDebounceMs : 1500

    this.wsHandler = (event) => {
      const events = typedEventsToUi(event, flags)
      const now = Date.now()
      for (const ev of events) {
        const key = `${ev.type}:${ev.cameraId}:${ev.object || ""}`
        const ms = debounceMsForEvent(
          String(ev.type),
          eventDebounceMs,
          cfg.doorbellRingDebounceMs,
        )
        if (!shouldEmit(key, now, ms, this.debounceMap)) {
          continue
        }
        const enriched = enrichEventWithCameraName(ev, this.api?.cameras)
        this.sendSocketNotification("UNIFIPROTECT_EVENT", enriched)
        if (ev.type === "ring") {
          if (cfg.doorbellSnapshotBurst !== false) {
            this.moduleLog.debug("ring", ev.cameraId, "snapshot-burst")
          } else {
            this.moduleLog.debug("ring", ev.cameraId)
          }
        }
        this.maybeWebhook(cfg.webhookUrl, enriched)
        if (ev.type === "ring" && cfg.doorbellSnapshotBurst !== false) {
          void this.pullOneSnapshot(ev.cameraId)
        }
      }
    }

    this._packetSub = this.api.on("packet", this.wsHandler)
    this._connectionLostSub = this.api.connection.on("controllerLost", () => {
      this.moduleLog.debug("realtime connection lost")
      this.sendSocketNotification("UNIFIPROTECT_STATUS", {
        ok: false,
        error: "Protect realtime connection closed",
      })
    })
    this._connectionRecoveredSub = this.api.connection.on("controllerRecovered", () => {
      this.moduleLog.debug("realtime connection recovered")
      this.sendSocketNotification("UNIFIPROTECT_STATUS", { ok: true })
    })
    this.wsAttached = true
    this.moduleLog.debug("realtime listener active")
  },

  async maybeWebhook(url, ev) {
    if (!url || typeof url !== "string") {
      return
    }
    try {
      await postJson(url, ev)
    } catch (e) {
      this.moduleLog.debug("webhook failed", e.message)
    }
  },

  startSnapshots(cfg, cameras) {
    const sec = typeof cfg.snapshotRefreshSeconds === "number" ? cfg.snapshotRefreshSeconds : 2
    const snapshotCams = (cameras || []).filter((c) => {
      if (cameraHasEmbeddedStream(c, cfg)) {
        return false
      }
      if (cameraWantsProtectNativeLive(c, cfg) && this._protectLiveByCamera.has(c.id)) {
        return false
      }
      return true
    })
    emitSnapshotPollingDiagnostics(cfg, cameras, snapshotCams, this.moduleLog)
    if (sec <= 0 || !this.api || snapshotCams.length === 0) {
      if (sec <= 0 && cameras.length > 0) {
        this.moduleLog.debug("snapshot polling disabled (snapshotRefreshSeconds <= 0)")
      }
      if (cameras.length > 0 && snapshotCams.length === 0 && sec > 0) {
        const allIframe = (cameras || []).every(c => cameraHasEmbeddedStream(c, cfg))
        const allNativeLive = (cameras || []).every(c =>
          cameraWantsProtectNativeLive(c, cfg) && this._protectLiveByCamera.has(c.id))
        let why = "all tiles use iframe streamUrl or Protect native fMP4 livestream"
        if (allIframe) {
          why = "all tiles use iframe streamUrl / streamUrlByCameraId"
        } else if (allNativeLive) {
          why = "all tiles use Protect native fMP4 livestream (no JPEG polling)"
        }
        this.moduleLog.debug(`snapshot polling skipped (${why})`)
      }
      return
    }
    const intervalMs = Math.max(500, Math.round(sec * 1000))
    this.moduleLog.debug("snapshot polling", { intervalMs, cameras: snapshotCams.length })
    const timer = setInterval(() => {
      this.pullSnapshots(snapshotCams)
    }, intervalMs)
    this.snapshotTimers.push(timer)
    this.pullSnapshots(snapshotCams)
  },

  async pullSnapshots(cameras) {
    if (!this.api) {
      return
    }
    for (const cam of cameras) {
      if (!cam.id) {
        continue
      }
      await this.pullOneSnapshot(cam.id)
    }
  },

  async pullOneSnapshot(cameraId) {
    if (!this.api || !cameraId) {
      return
    }
    try {
      const device = this.api.camera(cameraId)
      if (!device) {
        return
      }
      const raw = await device.snapshot()
      if (!raw) {
        return
      }
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const dataUrl = jpegToDataUrl(buf)
      if (dataUrl) {
        this.sendSocketNotification("UNIFIPROTECT_SNAPSHOT", {
          cameraId,
          dataUrl,
        })
      }
    } catch (e) {
      this.moduleLog.debug("snapshot failed", cameraId, e.message)
    }
  },
})

/**
 * UniFi OS exposes `X-CSRF-Token` on GET `/`. Many home gateways answer HTTPS on :443 without that header.
 *
 * @param {string} host
 * @param {{ debug: (...args: unknown[]) => void }} moduleLog
 * @returns {Promise<void>}
 */
function probeUniFiOsLanding(host, moduleLog) {
  return new Promise((resolve) => {
    const finish = () => resolve()
    const req = https.request(
      {
        host,
        port: 443,
        path: "/",
        method: "GET",
        rejectUnauthorized: false,
        headers: { Accept: "text/html,*/*" },
      },
      (res) => {
        const csrf = res.headers["x-csrf-token"]
        moduleLog.debug("HTTPS probe GET /", {
          host,
          statusCode: res.statusCode,
          hasXCsrfToken: Boolean(csrf),
          hint: csrf
            ? "CSRF header present (UniFi OS–like); failure is likely login, cookies, or bootstrap API."
            : "No X-CSRF-Token on GET / — on newer UniFi OS this is common; unifi-protect v5 logs in without that preflight. If login still fails, check VLAN/route/proxy, or that this IP is really your UniFi console.",
        })
        res.resume()
        finish()
      },
    )
    req.setTimeout(5000, () => {
      req.destroy()
      moduleLog.debug("HTTPS probe timeout", { host })
      finish()
    })
    req.on("error", (err) => {
      moduleLog.debug("HTTPS probe failed", { host, err: err.message })
      finish()
    })
    req.end()
  })
}

/**
 * @param {string} urlString
 * @param {Record<string, unknown>} body
 * @returns {Promise<void>}
 */
function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlString)
    } catch {
      reject(new Error("invalid webhook URL"))
      return
    }
    const data = JSON.stringify(body)
    const opts = {
      method: "POST",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }
    const lib = u.protocol === "https:" ? https : http
    const req = lib.request(opts, (res) => {
      res.resume()
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      resolve()
    })
    req.on("error", reject)
    req.write(data)
    req.end()
  })
}
