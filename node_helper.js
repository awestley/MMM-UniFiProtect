"use strict"

const https = require("https")
const http = require("http")
const util = require("util")
const { URL } = require("url")

const NodeHelper = require("node_helper")
const { normalizeUpdatePacket } = require("./helpers/normalize-update")
const { shouldEmit } = require("./helpers/debounce")
const { debounceMsForEvent } = require("./helpers/event-debounce")
const { jpegToDataUrl } = require("./helpers/snapshot")
const { createModuleLogger, resolveLogFilePath } = require("./helpers/module-logger")
const { patchProtectApiRetrieve } = require("./helpers/protect-api-retrieve-patch")
const { resolveProtectApiExport } = require("./helpers/resolve-protect-api-export")
const {
  getUnifiProtectRuntimeMeta,
  incompatibleUnifiProtectMessage,
} = require("./helpers/unifi-protect-runtime-meta")

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
 * Use UniFi Protect fMP4 livestream (`unifi-protect` ProtectLivestream) for this camera when no iframe URL is set.
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
    this.wsCloseHandler = null
    this._protectImportPromise = null
    this.normalizeState = {
      lastMotionByCamera: Object.create(null),
      lastRingByCamera: Object.create(null),
    }
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
    this.detachWs()
    this.api = null
  },

  stopAllProtectNativeLivestreams() {
    for (const [, rec] of this._protectLiveByCamera) {
      try {
        rec.ls.removeAllListeners()
      } catch {
        /* ignore */
      }
      try {
        rec.ls.stop()
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

  detachWs() {
    if (this.api && this.wsHandler) {
      this.api.removeListener("message", this.wsHandler)
    }
    const ws = this.api?._eventsWs
    if (ws && this.wsCloseHandler) {
      ws.removeEventListener("close", this.wsCloseHandler)
    }
    this.wsCloseHandler = null
    this.wsHandler = null
    this.wsAttached = false
  },

  async importProtect() {
    if (!this._protectImportPromise) {
      /**
       * Prefer the real ESM file so `ProtectApi` is the class from `dist/protect-api.js`.
       * Some hosts only resolve the package root to a broken interop bundle.
       */
      const load = async () => {
        try {
          const namespace = await import("unifi-protect/dist/protect-api.js")
          return {
            namespace,
            source: "unifi-protect/dist/protect-api.js",
            subpathError: null,
          }
        } catch (err) {
          const namespace = await import("unifi-protect")
          const subpathError = err instanceof Error ? err.message : String(err)
          return {
            namespace,
            source: "unifi-protect",
            subpathError,
          }
        }
      }
      this._protectImportPromise = Promise.race([
        load(),
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
          rec.ls.removeAllListeners()
        } catch {
          /* ignore */
        }
        try {
          rec.ls.stop()
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
    this.detachWs()
    this.normalizeState = {
      lastMotionByCamera: Object.create(null),
      lastRingByCamera: Object.create(null),
    }
    this.debounceMap = new Map()

    this.moduleLog.debug("connecting", host)
    const log = this.makeLog(!!cfg.debugLogging, this.moduleLog)
    const ufpDisk = getUnifiProtectRuntimeMeta()
    const versionBlock = incompatibleUnifiProtectMessage(ufpDisk)
    if (versionBlock) {
      connectProgress(this.moduleLog, "unifi-protect incompatible", { detail: versionBlock })
      throw new Error(versionBlock)
    }
    const ufpImport = await this.importProtect()
    const protectMod = ufpImport.namespace
    const exportKeys = Object.keys(protectMod || {}).sort()
    const ufpLine = {
      version: ufpDisk.version,
      importFrom: ufpImport.source.includes("protect-api") ? "dist" : "package",
      exportKeys: exportKeys.length,
    }
    if (ufpDisk.packageJsonPath) {
      ufpLine.packageJsonPath = ufpDisk.packageJsonPath
    }
    if (ufpDisk.error) {
      ufpLine.readError = ufpDisk.error
    }
    if (ufpImport.subpathError) {
      ufpLine.subpathFallback = ufpImport.subpathError
    }
    if (exportKeys.length > 10) {
      ufpLine.exportKeysSample = exportKeys.slice(0, 12)
    }
    connectProgress(this.moduleLog, "unifi-protect", ufpLine)
    const ProtectApi = resolveProtectApiExport(protectMod)
    if (typeof ProtectApi !== "function") {
      throw new Error(
        `MMM-UniFiProtect: no ProtectApi constructor (keys=${JSON.stringify(exportKeys)})`,
      )
    }
    if (cfg.debugLogging) {
      this.moduleLog.debug("ProtectApi prototype", {
        name: ProtectApi.name,
        retrieve: typeof ProtectApi.prototype.retrieve,
        _retrieve: typeof ProtectApi.prototype._retrieve,
      })
    }
    const hasApiKey = cfg.apiKey && typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0

    const traceRetrieve = cfg.traceRetrieve !== false

    const tryConnect = async (includeApiKey) => {
      const next = new ProtectApi(log)
      const patchMeta = patchProtectApiRetrieve(next, this.moduleLog, traceRetrieve)
      connectProgress(this.moduleLog, "session", {
        includeApiKey: !!includeApiKey,
        patchLayer: patchMeta.patchLayer,
      })
      if (includeApiKey) {
        next.headers["x-api-key"] = String(cfg.apiKey).trim()
      }
      if (cfg.debugLogging) {
        this.moduleLog.debug("Protect login() …")
      }
      if (!(await next.login(host, username, password))) {
        this.moduleLog.debug("Protect login() returned false", {
          host,
          includeApiKey: !!includeApiKey,
          node: process.version,
          traceHint: "See [retrieve#n] lines for HTTP detail when traceRetrieve is true.",
        })
        return null
      }
      if (cfg.debugLogging) {
        this.moduleLog.debug("Protect getBootstrap() …")
      }
      const bootstrapOk = await next.getBootstrap()
      if (bootstrapOk) {
        return next
      }
      // getBootstrap() ties success to BOTH HTTP bootstrap and the realtime WSS channel. In Docker / some
      // networks WSS can fail while HTTPS login + bootstrap still work — keep a usable session for snapshots.
      const camCount = next.bootstrap?.cameras?.length ?? 0
      if (camCount > 0) {
        this.moduleLog.debug(
          "Protect getBootstrap() returned false but bootstrap has cameras — continuing without realtime WebSocket (snapshots OK; motion/ring/smart toasts need WSS). Often fix: host firewall, or run MagicMirror with Node 20+ and a network path that allows wss to the console.",
          { host, cameraCount: camCount, node: process.version },
        )
        return next
      }
      this.moduleLog.debug("Protect getBootstrap() returned false (no camera list on session)", {
        host,
        node: process.version,
      })
      return null
    }

    this.api = await tryConnect(hasApiKey)
    if (!this.api && hasApiKey) {
      this.moduleLog.debug("connect failed with x-api-key, retrying without api key header")
      this.api = await tryConnect(false)
    }

    const ok = Boolean(this.api)
    if (!ok) {
      this._connectBackoffKey = backoffKey
      this._connectNotBefore = Date.now() + CONNECT_FAILURE_BACKOFF_MS
      this.moduleLog.debug("connect/bootstrap failed — see [retrieve#n] trace and [unifi-protect:error] if any.")
      this.moduleLog.debug("state after connect failure", { host, node: process.version })
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

    const resolved = this.resolveCameras(cfg.cameras, this.api.bootstrap?.cameras ?? [])
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

    this.attachWs(cfg)
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

      const ls = this.api.createLivestream()
      const cameraId = cam.id
      let sawSegment = false

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
          ls.removeAllListeners()
        } catch {
          /* ignore */
        }
        try {
          ls.stop()
        } catch {
          /* ignore */
        }
        this._protectLiveByCamera.delete(cameraId)
        refreshSnapshots()
      }

      const timeoutId = setTimeout(() => {
        if (!sawSegment) {
          failNative("(timeout waiting for first fMP4 segment)")
        }
      }, 15000)

      ls.on("codec", (codec) => {
        const c = typeof codec === "string" ? codec : ""
        this.sendSocketNotification("UNIFIPROTECT_LIVE_CODEC", { cameraId, codec: c })
      })

      ls.on("initsegment", (buf) => {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
        if (b.length === 0) {
          return
        }
        this.sendSocketNotification("UNIFIPROTECT_LIVE_FMP4", {
          cameraId,
          kind: "init",
          data: b.toString("base64"),
        })
      })

      ls.on("segment", (buf) => {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
        if (b.length === 0) {
          return
        }
        if (!sawSegment) {
          sawSegment = true
          clearTimeout(timeoutId)
          refreshSnapshots()
        }
        this.sendSocketNotification("UNIFIPROTECT_LIVE_FMP4", {
          cameraId,
          kind: "segment",
          data: b.toString("base64"),
        })
      })

      ls.on("close", () => {
        clearTimeout(timeoutId)
        this._protectLiveByCamera.delete(cameraId)
        if (cfg.debugLogging) {
          this.moduleLog.debug("protect native livestream close", cameraId, { sawSegment })
        }
        try {
          ls.removeAllListeners()
        } catch {
          /* ignore */
        }
        refreshSnapshots()
      })

      let started = false
      try {
        started = await ls.start(cameraId, 0, {
          segmentLength: 400,
          chunkSize: 8192,
          emitTimestamps: false,
          lens: 0,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.moduleLog.debug("protect livestream start threw", cameraId, msg)
      }
      if (!started) {
        clearTimeout(timeoutId)
        try {
          ls.removeAllListeners()
        } catch {
          /* ignore */
        }
        try {
          ls.stop()
        } catch {
          /* ignore */
        }
        this._liveNativeFailed.add(cameraId)
        refreshSnapshots()
        continue
      }

      this._protectLiveByCamera.set(cameraId, { ls })
    }
    const anyNative = list.some(c => cameraWantsProtectNativeLive(c, cfg))
    if (anyNative && cfg.streamDiagnostics === true && this._lastValidCameras) {
      emitStreamDiagnostics(cfg, this._lastValidCameras, this.moduleLog, this._protectLiveByCamera)
    }
  },

  attachWs(cfg) {
    if (!this.api || this.wsAttached) {
      return
    }
    const ws = this.api._eventsWs
    if (!ws) {
      this.moduleLog.debug("realtime updates unavailable (no websocket)")
      return
    }
    const flags = {
      motion: cfg.showMotionEvents !== false,
      ring: cfg.showRingEvents !== false,
      smart: cfg.showSmartEvents !== false,
    }
    const eventDebounceMs = typeof cfg.eventDebounceMs === "number" ? cfg.eventDebounceMs : 1500

    this.wsHandler = (packet) => {
      const normalized = toNormalizePacket(packet)
      const events = normalizeUpdatePacket(normalized, this.normalizeState, flags)
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
        const enriched = enrichEventWithCameraName(ev, this.api?.bootstrap?.cameras)
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

    this.api.on("message", this.wsHandler)
    this.wsCloseHandler = () => {
      this.moduleLog.debug("realtime connection closed")
      this.sendSocketNotification("UNIFIPROTECT_STATUS", {
        ok: false,
        error: "Protect realtime connection closed",
      })
    }
    ws.addEventListener("close", this.wsCloseHandler)
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
      const device = this.api.bootstrap?.cameras?.find(c => c.id === cameraId)
      if (!device) {
        return
      }
      const raw = await this.api.getSnapshot(device)
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
 * unifi-protect v4 emits decoded packets as `{ header, payload }`; our normalizer expects `{ action, payload }`.
 *
 * @param {unknown} packet
 * @returns {unknown}
 */
function toNormalizePacket(packet) {
  if (!packet || typeof packet !== "object") {
    return packet
  }
  const p = /** @type {{ header?: unknown, payload?: unknown }} */ (packet)
  if (p.header && typeof p.header === "object") {
    return { action: p.header, payload: p.payload }
  }
  return packet
}

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
            : "No X-CSRF-Token on GET / — on newer UniFi OS this is common; unifi-protect v4+ logs in without that preflight. If you are still on v3 of this library, upgrade. Otherwise check VLAN/route/proxy, or that this IP is really your UniFi console.",
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
