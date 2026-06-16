/** go2rtc `webrtc.html` (and similar players) need a permissive iframe sandbox for WebRTC APIs. */
const STREAM_IFRAME_SANDBOX
  = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"

/**
 * @param {{ streamUrl?: string | null, id: string }} cam
 * @param {{ streamUrlByCameraId?: Record<string, string>, protectNativeLive?: boolean }} cfg
 * @returns {boolean}
 */
function cameraWantsProtectNativeLiveClient(cam, cfg) {
  const per = typeof cam.streamUrl === "string" ? cam.streamUrl.trim() : ""
  if (per.length > 0) {
    return false
  }
  const map = cfg.streamUrlByCameraId && typeof cfg.streamUrlByCameraId === "object"
    ? cfg.streamUrlByCameraId
    : null
  const mapped = map && typeof map[cam.id] === "string" ? map[cam.id].trim() : ""
  if (mapped.length > 0) {
    return false
  }
  if (cfg.protectNativeLive === false) {
    return false
  }
  return true
}

/**
 * @param {string} b64
 * @returns {Uint8Array}
 */
function nativeLiveBase64ToU8(b64) {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    u8[i] = bin.charCodeAt(i)
  }
  return u8
}

/**
 * @param {string} codecLine e.g. "hev1.1.6.L150,mp4a.40.2"
 * @returns {string}
 */
function nativeLiveMimeFromCodecLine(codecLine) {
  const parts = String(codecLine || "").split(",").map(s => s.trim()).filter(Boolean)
  if (!parts.length) {
    return ""
  }
  return `video/mp4; codecs="${parts.join(", ")}"`
}

/**
 * @param {*} mod
 * @param {string} cameraId
 */
function nativeLiveMseTeardown(mod, cameraId) {
  const st = mod._nativeMseState && mod._nativeMseState[cameraId]
  if (!st) {
    return
  }
  try {
    if (st.sourceBuffer && typeof st._onUpdateEnd === "function") {
      st.sourceBuffer.removeEventListener("updateend", st._onUpdateEnd)
    }
  } catch {
    /* ignore */
  }
  try {
    if (st.mediaSource && st.mediaSource.readyState === "open") {
      st.mediaSource.endOfStream()
    }
  } catch {
    /* ignore */
  }
  try {
    if (st.objectUrl) {
      URL.revokeObjectURL(st.objectUrl)
    }
  } catch {
    /* ignore */
  }
  st.pendingInitU8 = null
  st.pendingInit = null
  st.queue = []
  delete mod._nativeMseState[cameraId]
}

/**
 * Tear down the active MSE pipeline (MediaSource, SourceBuffer, blob URL, queue) but preserve the
 * codec string and init segment so the stream can be re-attached to a fresh <video> element after
 * getDom() rebuilds the DOM — without needing a full RESYNC round-trip to the backend.
 *
 * @param {*} mod
 * @param {string} cameraId
 */
function nativeLiveMseSoftTeardown(mod, cameraId) {
  const st = mod._nativeMseState && mod._nativeMseState[cameraId]
  if (!st) {
    return
  }
  const savedCodec = typeof st.codecLine === "string" ? st.codecLine : ""
  // Prefer pendingInitU8 (not yet consumed). Fall back to initSegmentForReattach (already consumed
  // by a prior nativeLiveMseAttach call but kept permanently for exactly this scenario).
  const initSource = st.pendingInitU8 instanceof Uint8Array
    ? st.pendingInitU8
    : (st.initSegmentForReattach instanceof Uint8Array ? st.initSegmentForReattach : null)
  let savedInitU8 = null
  if (initSource) {
    const buf = initSource.buffer.slice(initSource.byteOffset, initSource.byteOffset + initSource.byteLength)
    savedInitU8 = new Uint8Array(buf)
  }
  nativeLiveMseTeardown(mod, cameraId)
  if (savedCodec || savedInitU8) {
    const newSt = nativeLiveMseEnsureState(mod, cameraId)
    newSt.codecLine = savedCodec
    newSt.pendingInitU8 = savedInitU8
    newSt.initSegmentForReattach = savedInitU8
  }
}

/**
 * @param {*} mod
 * @param {string} cameraId
 * @returns {object}
 */
function nativeLiveMseEnsureState(mod, cameraId) {
  if (!mod._nativeMseState) {
    mod._nativeMseState = Object.create(null)
  }
  if (!mod._nativeMseState[cameraId]) {
    mod._nativeMseState[cameraId] = {
      codecLine: "",
      pendingInit: null,
      /** @type {Uint8Array | null} */
      pendingInitU8: null,
      /** @type {Uint8Array | null} Permanent copy of the init segment, survives MSE attach cycles */
      initSegmentForReattach: null,
      mediaSource: null,
      sourceBuffer: null,
      objectUrl: "",
      queue: [],
      failed: false,
      /** @type {(() => void) | null} */
      _onUpdateEnd: null,
    }
  }
  return mod._nativeMseState[cameraId]
}

/**
 * @param {*} mod
 * @param {string} cameraId
 * @param {Uint8Array} u8
 */
function nativeLiveMseQueueAppend(mod, cameraId, u8) {
  const st = nativeLiveMseEnsureState(mod, cameraId)
  if (st.failed) {
    return
  }
  const copy = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
  st.queue.push(copy)
  const pump = () => {
    if (!st.sourceBuffer || st.sourceBuffer.updating || st.queue.length === 0 || st.failed) {
      return
    }
    const next = st.queue.shift()
    if (!next) {
      return
    }
    try {
      st.sourceBuffer.appendBuffer(next)
    } catch (e) {
      Log.error("[MMM-UniFiProtect][mse]", cameraId, "queueAppend appendBuffer FAILED:", e && e.message, "queueLen:", st.queue.length)
      st.failed = true
    }
  }
  if (!st._onUpdateEnd) {
    st._onUpdateEnd = () => pump()
  }
  pump()
}

/**
 * @param {*} mod
 * @param {string} cameraId
 * @param {HTMLVideoElement} video
 * @param {string} codecLine
 * @param {Uint8Array} initU8
 */
function nativeLiveMseAttach(mod, cameraId, video, codecLine, initU8) {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported) {
    Log.warn("[MMM-UniFiProtect][mse]", cameraId, "MediaSource API not available in this browser")
    return
  }
  const tryMimes = []
  const full = nativeLiveMimeFromCodecLine(codecLine)
  if (full) {
    tryMimes.push(full)
  }
  const first = String(codecLine || "").split(",")[0].trim()
  if (first && !tryMimes.some(m => m.includes(first))) {
    tryMimes.push(`video/mp4; codecs="${first}"`)
  }
  let mime = ""
  for (const m of tryMimes) {
    if (MediaSource.isTypeSupported(m)) {
      mime = m
      break
    }
  }
  if (!mime) {
    Log.warn("[MMM-UniFiProtect][mse]", cameraId, "no supported MIME for codec:", codecLine, "tried:", tryMimes)
    nativeLiveMseEnsureState(mod, cameraId).failed = true
    return
  }
  Log.log("[MMM-UniFiProtect][mse]", cameraId, "attaching MSE mime:", mime)
  const st = nativeLiveMseEnsureState(mod, cameraId)
  st.codecLine = codecLine
  st.pendingInit = initU8.buffer.slice(initU8.byteOffset, initU8.byteOffset + initU8.byteLength)
  st.mediaSource = new MediaSource()
  st.objectUrl = URL.createObjectURL(st.mediaSource)
  video.src = st.objectUrl
  video.play().catch(e => Log.warn("[MMM-UniFiProtect][mse]", cameraId, "play() rejected:", e && e.message))
  st.mediaSource.addEventListener("sourceopen", () => {
    if (st.failed || !st.pendingInit) {
      Log.warn("[MMM-UniFiProtect][mse]", cameraId, "sourceopen but state invalid, failed=" + st.failed)
      return
    }
    try {
      st.sourceBuffer = st.mediaSource.addSourceBuffer(mime)
    } catch (e) {
      Log.error("[MMM-UniFiProtect][mse]", cameraId, "addSourceBuffer failed:", e && e.message)
      st.failed = true
      return
    }
    st.sourceBuffer.addEventListener("error", (e) => {
      Log.error("[MMM-UniFiProtect][mse]", cameraId, "SourceBuffer error:", e)
      st.failed = true
    })
    st.sourceBuffer.addEventListener("abort", () => {
      Log.warn("[MMM-UniFiProtect][mse]", cameraId, "SourceBuffer abort")
    })
    st._onUpdateEnd = () => {
      if (st.queue.length && st.sourceBuffer && !st.sourceBuffer.updating && !st.failed) {
        const next = st.queue.shift()
        if (next) {
          try {
            st.sourceBuffer.appendBuffer(next)
          } catch (e) {
            Log.error("[MMM-UniFiProtect][mse]", cameraId, "segment appendBuffer failed:", e && e.message)
            st.failed = true
          }
        }
      }
    }
    st.sourceBuffer.addEventListener("updateend", st._onUpdateEnd)
    try {
      st.sourceBuffer.appendBuffer(st.pendingInit)
    } catch (e) {
      Log.error("[MMM-UniFiProtect][mse]", cameraId, "init appendBuffer failed:", e && e.message)
      st.failed = true
      return
    }
    st.pendingInit = null
  }, { once: true })
  video.addEventListener("error", () => {
    const err = video.error
    Log.error("[MMM-UniFiProtect][mse]", cameraId, "video error code:", err && err.code, err && err.message)
  }, { once: false })
  video.addEventListener("stalled", () => {
    Log.warn("[MMM-UniFiProtect][mse]", cameraId, "video stalled, readyState:", video.readyState)
  })
  video.addEventListener("playing", () => {
    Log.log("[MMM-UniFiProtect][mse]", cameraId, "video playing")
  })
}

/**
 * @param {*} mod
 * @param {string} cameraId
 */
function nativeLiveTryAttachFromDom(mod, cameraId) {
  // MagicMirror does not set module.dom — query the live document directly.
  const video = document.querySelector(`video.mmm-unifiprotect-native-live[data-camera-id="${cameraId}"]`)
  if (!video || !(video instanceof HTMLVideoElement)) {
    return
  }
  const st = mod._nativeMseState && mod._nativeMseState[cameraId]
  if (!st || st.failed || !st.codecLine || !st.pendingInitU8 || st.mediaSource) {
    return
  }
  const initCopy = st.pendingInitU8
  st.pendingInitU8 = null
  nativeLiveMseAttach(mod, cameraId, video, st.codecLine, initCopy)
}

/**
 * @param {*} mod
 * @param {{ cameraId: string, codec: string }} payload
 */
function nativeLiveOnCodec(mod, payload) {
  const cameraId = typeof payload.cameraId === "string" ? payload.cameraId : ""
  const codec = typeof payload.codec === "string" ? payload.codec : ""
  if (!cameraId) {
    return
  }
  const st = nativeLiveMseEnsureState(mod, cameraId)
  st.codecLine = codec
  nativeLiveTryAttachFromDom(mod, cameraId)
}

/**
 * @param {*} mod
 * @param {{ cameraId: string, kind: string, data: string }} payload
 */
function nativeLiveOnFmp4(mod, payload) {
  const cameraId = typeof payload.cameraId === "string" ? payload.cameraId : ""
  const kind = typeof payload.kind === "string" ? payload.kind : ""
  const data = typeof payload.data === "string" ? payload.data : ""
  if (!cameraId || !data) {
    return
  }
  const u8 = nativeLiveBase64ToU8(data)
  if (kind === "init") {
    const st = nativeLiveMseEnsureState(mod, cameraId)
    st.pendingInitU8 = u8
    // Permanently store a copy so softTeardown can reuse it after nativeLiveMseAttach consumes pendingInitU8
    const initCopyBuf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    st.initSegmentForReattach = new Uint8Array(initCopyBuf)
    nativeLiveTryAttachFromDom(mod, cameraId)
    return
  }
  if (kind === "segment") {
    nativeLiveMseQueueAppend(mod, cameraId, u8)
  }
}

/**
 * Attach MSE to `<video>` elements found in the live document. If init/codec state was lost
 * (e.g. `getDom` ran before socket chunks arrived), ask node_helper to restart the Protect livestream.
 *
 * @param {*} mod
 */
function nativeLiveFlushAttachToDom(mod) {
  // MagicMirror does not set module.dom — always query the live document directly.
  const nativeCams = (mod.cameras || []).filter(c => cameraWantsProtectNativeLiveClient(c, mod.config))
  for (const cam of nativeCams) {
    nativeLiveTryAttachFromDom(mod, cam.id)
  }
  requestAnimationFrame(() => {
    /** @type {string[]} */
    const resyncIds = []
    for (const cam of nativeCams) {
      const id = cam.id
      nativeLiveTryAttachFromDom(mod, id)
      const video = document.querySelector(`video.mmm-unifiprotect-native-live[data-camera-id="${id}"]`)
      if (!video || !(video instanceof HTMLVideoElement)) {
        continue
      }
      const st = mod._nativeMseState && mod._nativeMseState[id]
      const waitingBlob = !video.src || !String(video.src).startsWith("blob:")
      // Need RESYNC if: no active pipeline AND we cannot attach (missing codec OR missing init)
      const hasActivePipeline = !!(st && st.mediaSource)
      const canAttach = !!(st && !st.failed && st.codecLine && st.pendingInitU8)
      if (waitingBlob && !hasActivePipeline && !canAttach) {
        resyncIds.push(id)
      }
    }
    if (resyncIds.length > 0) {
      Log.log("[MMM-UniFiProtect][mse]", "requesting resync for cameras:", resyncIds)
      mod.sendSocketNotification("UNIFIPROTECT_LIVE_RESYNC", { cameraIds: resyncIds })
    }
  })
}

Module.register("MMM-UniFiProtect", {

  defaults: {
    host: "",
    username: "",
    password: "",
    apiKey: "",
    cameras: [],
    snapshotRefreshSeconds: 2,
    showMotionEvents: true,
    showRingEvents: true,
    showSmartEvents: true,
    eventDebounceMs: 1500,
    /**
     * When true (default), motion / ring / smart events use MagicMirror’s **alert** module (`SHOW_ALERT`
     * notifications) so they match the mirror UI. Set false to show the legacy toast stack under the tile.
     * Requires the `alert` module in your MagicMirror config.
     */
    useMagicMirrorAlerts: true,
    maxEventToasts: 6,
    eventToastDurationMs: 8000,
    streamUrlByCameraId: {},
    webhookUrl: "",
    debugLogging: false,
    /** Log each unifi-protect `retrieve()` (except snapshot URLs) with status + header keys. Default true. */
    traceRetrieve: true,
    logFile: "",
    /** Optional static header; when empty, a single camera uses its name as the header (no "UniFi Protect"). */
    title: "",
    compactMode: false,
    doorbellToastDurationMs: 20000,
    doorbellOverlay: true,
    doorbellOverlayDurationMs: 14000,
    doorbellHighlightSeconds: 12,
    doorbellSound: "",
    doorbellSnapshotBurst: true,
    /** When true, log explicit stream-vs-snapshot decisions (no credentials). */
    streamDiagnostics: false,
    /**
     * When true (default), cameras without an iframe `streamUrl` use UniFi Protect fMP4 livestream
     * (`unifi-protect` ProtectLivestream) in the browser via MSE. Set false to use JPEG snapshots only.
     */
    protectNativeLive: true,
  },

  start() {
    this.statusOk = false
    this.statusError = ""
    this.cameras = []
    this.snapshots = {}
    this.eventToasts = []
    this._flushScheduled = false
    this.doorbellOverlayUntil = 0
    this.doorbellOverlayCameraId = ""
    this.doorbellHighlightUntil = Object.create(null)
    /** @type {number} next wall-clock ms when a highlight expires (0 = none) */
    this._nextHighlightExpiry = 0
    /** @type {string} */
    this._streamDiagFp = ""
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._nativeDomFlushTimer = null

    this.startToastSweep()
    this.dbg("module started")
    this.logClientStreamConnectSummary()

    this.sendSocketNotification("UNIFIPROTECT_CONNECT", {
      host: this.config.host,
      username: this.config.username,
      password: this.config.password,
      apiKey: this.config.apiKey,
      cameras: this.config.cameras,
      streamUrlByCameraId: this.config.streamUrlByCameraId,
      streamDiagnostics: this.config.streamDiagnostics === true,
      protectNativeLive: this.config.protectNativeLive !== false,
      snapshotRefreshSeconds: this.config.snapshotRefreshSeconds,
      showMotionEvents: this.config.showMotionEvents,
      showRingEvents: this.config.showRingEvents,
      showSmartEvents: this.config.showSmartEvents,
      eventDebounceMs: this.config.eventDebounceMs,
      webhookUrl: this.config.webhookUrl,
      debugLogging: this.config.debugLogging,
      traceRetrieve: this.config.traceRetrieve !== false,
      logFile: this.config.logFile,
      doorbellSnapshotBurst: this.config.doorbellSnapshotBurst,
      doorbellRingDebounceMs: this.config.doorbellRingDebounceMs,
    })
  },

  suspend() {
    if (this.toastSweepTimer) {
      clearInterval(this.toastSweepTimer)
      this.toastSweepTimer = null
    }
  },

  resume() {
    this.startToastSweep()
  },

  startToastSweep() {
    if (this.toastSweepTimer) {
      return
    }
    this.toastSweepTimer = setInterval(() => {
      const now = Date.now()
      let dirty = false
      const beforeToasts = this.eventToasts.length
      this.eventToasts = this.eventToasts.filter(x => x.until > now)
      if (this.eventToasts.length !== beforeToasts) {
        dirty = true
      }
      if (this.doorbellOverlayUntil > 0 && now >= this.doorbellOverlayUntil) {
        this.doorbellOverlayUntil = 0
        this.doorbellOverlayCameraId = ""
        dirty = true
      }
      if (this._nextHighlightExpiry > 0 && now >= this._nextHighlightExpiry) {
        this._nextHighlightExpiry = 0
        let anyRemoved = false
        for (const id of Object.keys(this.doorbellHighlightUntil)) {
          if (this.doorbellHighlightUntil[id] <= now) {
            delete this.doorbellHighlightUntil[id]
            anyRemoved = true
          }
        }
        if (anyRemoved) {
          dirty = true
        }
        let next = 0
        for (const id of Object.keys(this.doorbellHighlightUntil)) {
          const t = this.doorbellHighlightUntil[id]
          if (t > now && (next === 0 || t < next)) {
            next = t
          }
        }
        this._nextHighlightExpiry = next
      }
      if (dirty) {
        if (this._anyNativeLiveCamera()) {
          this.patchDomTimerState()
        } else {
          this.updateDom()
        }
      }
    }, 1000)
  },

  /**
   * @returns {boolean}
   */
  _anyNativeLiveCamera() {
    return (this.cameras || []).some(c => cameraWantsProtectNativeLiveClient(c, this.config))
  },

  /**
   * Update highlight / overlay / legacy toast tray without rebuilding the grid (keeps MSE `<video>` alive).
   */
  patchDomTimerState() {
    // MagicMirror does not set module.dom — query the live document for our module's wrapper.
    const root = document.getElementById(this.identifier)
    if (!root) {
      this.updateDom()
      return
    }
    const now = Date.now()
    for (const cell of root.querySelectorAll(".mmm-unifiprotect-cell")) {
      const id = typeof cell.dataset.cameraId === "string" ? cell.dataset.cameraId : ""
      if (!id) {
        continue
      }
      cell.classList.toggle("doorbell-active", !!(this.doorbellHighlightUntil[id] > now))
    }
    const ov = root.querySelector(".mmm-unifiprotect-doorbell-overlay")
    const needOv = this.config.doorbellOverlay !== false
      && this.doorbellOverlayUntil > now
      && !!this.doorbellOverlayCameraId
    if (ov && !needOv) {
      ov.remove()
    } else if (needOv && !ov) {
      this.updateDom()
      return
    }
    if (this.config.useMagicMirrorAlerts !== false) {
      return
    }
    const tray = root.querySelector(".mmm-unifiprotect-toasts")
    if (!tray) {
      return
    }
    tray.replaceChildren()
    for (const t of this.eventToasts) {
      if (t.until <= now) {
        continue
      }
      const row = document.createElement("div")
      row.className = "mmm-unifiprotect-toast" + (t.variant === "doorbell" ? " doorbell" : "")
      row.textContent = t.text
      tray.appendChild(row)
    }
  },

  dbg(...args) {
    if (this.config.debugLogging) {
      Log.log("[MMM-UniFiProtect]", ...args)
    }
  },

  streamDiag(...args) {
    if (this.config.streamDiagnostics === true) {
      Log.log("[MMM-UniFiProtect][stream]", ...args)
    }
  },

  /**
   * @param {string} raw
   * @returns {string}
   */
  sanitizeUrlForDiag(raw) {
    const s = typeof raw === "string" ? raw.trim() : ""
    if (!s) return ""
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
  },

  /**
   * @param {string} reason
   * @param {string} mode
   * @param {string} detail
   */
  logTileDecision(cam, streamUrl, reason, mode, detail) {
    this.streamDiag("tile", {
      cameraId: cam?.id,
      name: cam?.name,
      mode,
      reason,
      detail,
      streamUrlPresent: Boolean(streamUrl),
      streamUrl: streamUrl ? this.sanitizeUrlForDiag(streamUrl) : "",
    })
  },

  logClientStreamConnectSummary() {
    const want = this.config.streamDiagnostics === true || this.config.debugLogging === true
    if (!want) {
      return
    }
    const map = this.config.streamUrlByCameraId && typeof this.config.streamUrlByCameraId === "object"
      ? this.config.streamUrlByCameraId
      : {}
    const mapKeys = Object.keys(map).sort()
    const cams = Array.isArray(this.config.cameras) ? this.config.cameras : []
    const host = typeof this.config.host === "string" ? this.config.host : ""
    const user = typeof this.config.username === "string" ? this.config.username : ""
    Log.log("[MMM-UniFiProtect][stream]", "CLIENT stream summary", {
      host,
      user,
      cameras: cams.length,
      streamDiagnostics: this.config.streamDiagnostics === true,
      debugLogging: this.config.debugLogging === true,
      streamUrlByCameraIdKeys: mapKeys,
    })
    let idx = 0
    for (const e of cams) {
      idx += 1
      if (typeof e === "string") {
        Log.log("[MMM-UniFiProtect][stream]", `CLIENT camera[${idx}]`, { type: "string", id: e })
        continue
      }
      if (!e || typeof e !== "object") {
        Log.log("[MMM-UniFiProtect][stream]", `CLIENT camera[${idx}]`, { type: e === null ? "null" : typeof e })
        continue
      }
      const id = typeof e.id === "string" ? e.id : ""
      const name = typeof e.name === "string" ? e.name : ""
      const su = typeof e.streamUrl === "string" ? e.streamUrl.trim() : ""
      Log.log("[MMM-UniFiProtect][stream]", `CLIENT camera[${idx}]`, {
        type: "object",
        id,
        name,
        streamUrlLen: su.length,
        streamUrl: su ? this.sanitizeUrlForDiag(su) : "",
      })
    }
    for (const k of mapKeys) {
      const v = typeof map[k] === "string" ? map[k].trim() : ""
      Log.log("[MMM-UniFiProtect][stream]", "CLIENT streamUrlByCameraId entry", {
        cameraId: k,
        len: v.length,
        url: v ? this.sanitizeUrlForDiag(v) : "",
      })
    }
  },

  getStyles() {
    return ["unifi-protect.css"]
  },

  /**
   * Header line: explicit `config.title`, else one camera’s name; multiple cameras use per-tile labels only.
   * @returns {string}
   */
  getHeaderText() {
    const explicit = typeof this.config.title === "string" ? this.config.title.trim() : ""
    if (explicit.length > 0) {
      return explicit
    }
    if (this.cameras.length === 1) {
      const c = this.cameras[0]
      return String(c.name || c.id || "").trim()
    }
    return ""
  },

  getDom() {
    // Soft-teardown cameras that will continue as native live (preserves codec + init segment for
    // immediate re-attach after MagicMirror installs the new DOM, no RESYNC needed).
    // Hard-teardown anything being removed or switching away from native live.
    const keepNativeIds = new Set(
      (this.cameras || [])
        .filter(c => cameraWantsProtectNativeLiveClient(c, this.config))
        .map(c => c.id),
    )
    if (this._nativeMseState) {
      for (const id of Object.keys(this._nativeMseState)) {
        if (keepNativeIds.has(id)) {
          nativeLiveMseSoftTeardown(this, id)
        } else {
          nativeLiveMseTeardown(this, id)
        }
      }
    }
    const root = document.createElement("div")
    root.className = "mmm-unifiprotect" + (this.config.compactMode ? " compact" : "")
    root.id = "mmm-unifiprotect-" + this.identifier

    const headerText = this.getHeaderText()
    if (headerText) {
      const title = document.createElement("div")
      title.className = "mmm-unifiprotect-title"
      title.textContent = headerText
      root.appendChild(title)
    }

    if (!this.statusOk && this.statusError) {
      const err = document.createElement("div")
      err.className = "mmm-unifiprotect-error"
      err.textContent = this.statusError
      root.appendChild(err)
      return root
    }

    if (this.cameras.length === 0) {
      const hint = document.createElement("div")
      hint.className = "mmm-unifiprotect-hint"
      hint.textContent = this.statusOk ? "No cameras configured." : "Connecting…"
      root.appendChild(hint)
    }

    const now = Date.now()
    const grid = document.createElement("div")
    grid.className = "mmm-unifiprotect-grid"

    const showTileLabels = this.cameras.length > 1

    for (const cam of this.cameras) {
      const cell = document.createElement("div")
      cell.className = "mmm-unifiprotect-cell"
      cell.dataset.cameraId = cam.id
      if (this.doorbellHighlightUntil[cam.id] > now) {
        cell.classList.add("doorbell-active")
      }

      if (showTileLabels) {
        const label = document.createElement("div")
        label.className = "mmm-unifiprotect-label"
        label.textContent = cam.name || cam.id
        cell.appendChild(label)
      }

      const map = this.config.streamUrlByCameraId && typeof this.config.streamUrlByCameraId === "object"
        ? this.config.streamUrlByCameraId
        : null
      const mapHitRaw = map && typeof map[cam.id] === "string" ? map[cam.id] : ""
      const mapHit = typeof mapHitRaw === "string" ? mapHitRaw.trim() : ""
      const streamUrl = (typeof cam.streamUrl === "string" && cam.streamUrl.trim().length > 0)
        ? cam.streamUrl
        : (mapHit || "")
      if (streamUrl) {
        const frame = document.createElement("iframe")
        frame.className = "mmm-unifiprotect-stream"
        frame.setAttribute("sandbox", STREAM_IFRAME_SANDBOX)
        frame.setAttribute("allow", "autoplay; fullscreen; microphone; camera; display-capture")
        frame.setAttribute("referrerpolicy", "no-referrer")
        frame.src = streamUrl
        cell.appendChild(frame)
        if (this.config.streamDiagnostics === true) {
          const from = typeof cam.streamUrl === "string" && cam.streamUrl.trim().length > 0
            ? "camera.streamUrl"
            : "streamUrlByCameraId[cameraId]"
          this.logTileDecision(cam, streamUrl, "stream-selected", "iframe", from)
        }
      } else if (cameraWantsProtectNativeLiveClient(cam, this.config)) {
        const vid = document.createElement("video")
        vid.className = "mmm-unifiprotect-native-live"
        vid.dataset.cameraId = cam.id
        vid.muted = true
        vid.playsInline = true
        vid.setAttribute("playsinline", "")
        vid.autoplay = true
        const snap = this.snapshots[cam.id]
        if (snap) {
          vid.poster = snap
        }
        cell.appendChild(vid)
        if (this.config.streamDiagnostics === true) {
          this.logTileDecision(cam, "", "protect-native-live", "video", "Protect fMP4 livestream via MSE")
        }
      } else {
        const img = document.createElement("img")
        img.className = "mmm-unifiprotect-snapshot"
        img.alt = cam.name || cam.id
        const snap = this.snapshots[cam.id]
        if (snap) {
          img.src = snap
        }
        cell.appendChild(img)
        if (this.config.streamDiagnostics === true) {
          const mapKeys = map ? Object.keys(map).sort() : []
          let detail = "no streamUrl on camera and no map entry for this id"
          if (typeof cam.streamUrl === "string" && cam.streamUrl.trim().length === 0) {
            detail = "camera.streamUrl is empty string"
          }
          if (!map || mapKeys.length === 0) {
            detail = "streamUrlByCameraId is empty"
          } else if (!mapHit) {
            detail = `streamUrlByCameraId has keys but none match cameraId (keys=${mapKeys.join(",")})`
          }
          this.logTileDecision(cam, "", "snapshot-selected", "img", detail)
        }
      }

      grid.appendChild(cell)
    }

    root.appendChild(grid)

    if (this.config.useMagicMirrorAlerts === false) {
      const tray = document.createElement("div")
      tray.className = "mmm-unifiprotect-toasts"
      for (const t of this.eventToasts) {
        if (t.until <= now) {
          continue
        }
        const row = document.createElement("div")
        row.className = "mmm-unifiprotect-toast" + (t.variant === "doorbell" ? " doorbell" : "")
        row.textContent = t.text
        tray.appendChild(row)
      }
      root.appendChild(tray)
    }

    if (this.config.doorbellOverlay !== false
      && this.doorbellOverlayUntil > now
      && this.doorbellOverlayCameraId) {
      const cam = this.cameras.find(c => c.id === this.doorbellOverlayCameraId)
      const camLabel = cam ? (cam.name || cam.id) : this.doorbellOverlayCameraId
      const ov = document.createElement("div")
      ov.className = "mmm-unifiprotect-doorbell-overlay"
      ov.setAttribute("role", "alert")
      const inner = document.createElement("div")
      inner.className = "mmm-unifiprotect-doorbell-overlay-inner"
      const head = document.createElement("div")
      head.className = "mmm-unifiprotect-doorbell-overlay-title"
      head.textContent = "Doorbell"
      inner.appendChild(head)
      const sub = document.createElement("div")
      sub.className = "mmm-unifiprotect-doorbell-overlay-sub"
      sub.textContent = camLabel
      inner.appendChild(sub)
      const mapOv = this.config.streamUrlByCameraId && typeof this.config.streamUrlByCameraId === "object"
        ? this.config.streamUrlByCameraId
        : null
      const mapHitOv = mapOv && typeof mapOv[cam.id] === "string" ? mapOv[cam.id] : ""
      const streamUrlOv = cam
        && ((typeof cam.streamUrl === "string" && cam.streamUrl.trim().length > 0)
          ? cam.streamUrl
          : (typeof mapHitOv === "string" && mapHitOv.trim().length > 0 ? mapHitOv : ""))
      const snapUrl = this.snapshots[this.doorbellOverlayCameraId]
      if (streamUrlOv) {
        const frame = document.createElement("iframe")
        frame.className = "mmm-unifiprotect-doorbell-overlay-stream"
        frame.setAttribute("sandbox", STREAM_IFRAME_SANDBOX)
        frame.setAttribute("allow", "autoplay; fullscreen; microphone; camera; display-capture")
        frame.setAttribute("referrerpolicy", "no-referrer")
        frame.src = streamUrlOv
        inner.appendChild(frame)
      } else if (snapUrl) {
        const oimg = document.createElement("img")
        oimg.className = "mmm-unifiprotect-doorbell-overlay-image"
        oimg.src = snapUrl
        oimg.alt = camLabel
        inner.appendChild(oimg)
      }
      ov.appendChild(inner)
      root.appendChild(ov)
    }

    return root
  },

  notificationReceived(notification) {
    if (notification === "MODULE_DOM_CREATED") {
      nativeLiveFlushAttachToDom(this)
      return
    }
    // MODULE_DOM_UPDATED fires every time ANY module updates its DOM (e.g. the clock every second).
    // DOM_OBJECTS_UPDATED fires only once at startup — do NOT use it for the recurring flush.
    if (notification === "MODULE_DOM_UPDATED") {
      if (!this._anyNativeLiveCamera()) {
        return
      }
      if (this._nativeDomFlushTimer) {
        clearTimeout(this._nativeDomFlushTimer)
      }
      this._nativeDomFlushTimer = setTimeout(() => {
        this._nativeDomFlushTimer = null
        nativeLiveFlushAttachToDom(this)
      }, 120)
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "UNIFIPROTECT_STATUS") {
      this.statusOk = !!payload.ok
      this.statusError = payload.error || ""
      if (payload.ok) {
        this.dbg("status ok")
      } else {
        this.dbg("status error", this.statusError)
      }
      this.scheduleUpdateDom()
      return
    }
    if (notification === "UNIFIPROTECT_CAMERAS") {
      this.cameras = Array.isArray(payload.cameras) ? payload.cameras : []
      this.dbg("cameras configured", this.cameras.length)
      if (this.config.streamDiagnostics === true) {
        const map = this.config.streamUrlByCameraId && typeof this.config.streamUrlByCameraId === "object"
          ? this.config.streamUrlByCameraId
          : {}
        const fp = JSON.stringify({
          c: this.cameras.map(x => ({ id: x.id, hasStream: typeof x.streamUrl === "string" && x.streamUrl.trim().length > 0 })),
          k: Object.keys(map).sort(),
        })
        if (fp !== this._streamDiagFp) {
          this._streamDiagFp = fp
          this.streamDiag("config snapshot", {
            streamUrlByCameraIdKeys: Object.keys(map).sort(),
            cameras: this.cameras.map(c => ({
              id: c.id,
              name: c.name,
              hasCameraStreamUrl: typeof c.streamUrl === "string" && c.streamUrl.trim().length > 0,
            })),
          })
        }
      }
      this.scheduleUpdateDom()
      return
    }
    if (notification === "UNIFIPROTECT_SNAPSHOT") {
      if (payload?.cameraId && payload.dataUrl) {
        const prev = this.snapshots[payload.cameraId]
        if (prev === payload.dataUrl) {
          return
        }
        this.snapshots[payload.cameraId] = payload.dataUrl
        const cam = this.cameras.find(c => c.id === payload.cameraId)
        const mapSn = this.config.streamUrlByCameraId && typeof this.config.streamUrlByCameraId === "object"
          ? this.config.streamUrlByCameraId
          : null
        const mapHitSn = mapSn && typeof mapSn[payload.cameraId] === "string" ? mapSn[payload.cameraId] : ""
        const streamUrl = cam
          && ((typeof cam.streamUrl === "string" && cam.streamUrl.trim().length > 0)
            ? cam.streamUrl
            : (typeof mapHitSn === "string" && mapHitSn.trim().length > 0 ? mapHitSn : ""))
        const overlayNeedsSnap = this.config.doorbellOverlay !== false
          && this.doorbellOverlayUntil > Date.now()
          && this.doorbellOverlayCameraId === payload.cameraId
          && !streamUrl
        const wantsNative = cam && cameraWantsProtectNativeLiveClient(cam, this.config)
        const gridNeedsSnap = !streamUrl && !wantsNative
        if (overlayNeedsSnap || gridNeedsSnap) {
          this.scheduleUpdateDom()
        }
      }
      return
    }
    if (notification === "UNIFIPROTECT_LIVE_CODEC") {
      nativeLiveOnCodec(this, payload || {})
      return
    }
    if (notification === "UNIFIPROTECT_LIVE_FMP4") {
      nativeLiveOnFmp4(this, payload || {})
      return
    }
    if (notification === "UNIFIPROTECT_EVENT") {
      this.pushEventToast(payload)
    }
  },

  scheduleUpdateDom() {
    if (this._flushScheduled) {
      return
    }
    this._flushScheduled = true
    requestAnimationFrame(() => {
      this._flushScheduled = false
      this.updateDom()
    })
  },

  playDoorbellSound() {
    const f = this.config.doorbellSound
    if (!f || typeof f !== "string") {
      return
    }
    try {
      const a = new Audio(this.file(f))
      a.play().catch(() => {})
    } catch {
      /* ignore invalid path */
    }
  },

  pushEventToast(ev) {
    const isRing = ev.type === "ring"
    const t = ev.type === "smart" ? `AI: ${ev.object || "?"}` : isRing ? "Doorbell" : "Motion"
    const cam = this.cameras.find(c => c.id === ev.cameraId)
    const fromBootstrap = typeof ev.cameraName === "string" ? ev.cameraName.trim() : ""
    const camLabel = fromBootstrap
      || (cam ? (cam.name || cam.id) : "")
      || (ev.cameraId || "")
    const text = `${t} — ${camLabel}`
    const defaultMs = typeof this.config.eventToastDurationMs === "number" ? this.config.eventToastDurationMs : 8000
    const ringMs = typeof this.config.doorbellToastDurationMs === "number" ? this.config.doorbellToastDurationMs : 20000
    const ms = isRing ? ringMs : defaultMs
    const max = typeof this.config.maxEventToasts === "number" ? this.config.maxEventToasts : 6
    const variant = isRing ? "doorbell" : "default"
    const useMmAlert = this.config.useMagicMirrorAlerts !== false

    if (isRing) {
      this.dbg("doorbell ui", camLabel || ev.cameraId)
      this.playDoorbellSound()
      if (this.config.doorbellOverlay !== false && ev.cameraId) {
        const od = typeof this.config.doorbellOverlayDurationMs === "number"
          ? this.config.doorbellOverlayDurationMs
          : 14000
        this.doorbellOverlayUntil = Date.now() + od
        this.doorbellOverlayCameraId = ev.cameraId
      }
      const sec = typeof this.config.doorbellHighlightSeconds === "number"
        ? this.config.doorbellHighlightSeconds
        : 12
      if (ev.cameraId && sec > 0) {
        const until = Date.now() + sec * 1000
        this.doorbellHighlightUntil[ev.cameraId] = until
        if (this._nextHighlightExpiry === 0 || until < this._nextHighlightExpiry) {
          this._nextHighlightExpiry = until
        }
      }
    }

    if (useMmAlert) {
      this.sendNotification("SHOW_ALERT", {
        type: "notification",
        title: t,
        message: camLabel,
        titleType: "text",
        messageType: "text",
        timer: ms,
      })
    } else {
      this.eventToasts.push({ text, until: Date.now() + ms, variant })
      while (this.eventToasts.length > max) {
        this.eventToasts.shift()
      }
    }

    if (!useMmAlert || isRing) {
      this.scheduleUpdateDom()
    }
  },
})
