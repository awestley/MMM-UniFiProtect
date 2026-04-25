"use strict"

/**
 * Normalize decoded UniFi Protect update packets into small UI/webhook payloads.
 * @param {{ action: Record<string, unknown>, payload: unknown }} packet
 * @param {{ lastMotionByCamera: Record<string, number>, lastRingByCamera: Record<string, number> }} state
 * @param {{ motion: boolean, ring: boolean, smart: boolean }} flags
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeUpdatePacket(packet, state, flags) {
  const out = []
  if (!packet || typeof packet !== "object") {
    return out
  }
  const action = packet.action
  const payload = packet.payload
  if (!action || typeof action !== "object") {
    return out
  }
  const a = action.action
  const modelKey = action.modelKey
  const id = typeof action.id === "string" ? action.id : ""

  if (a === "update" && modelKey === "camera" && payload && typeof payload === "object") {
    const p = /** @type {Record<string, unknown>} */ (payload)
    if (flags.motion && "lastMotion" in p) {
      const lm = toPositiveNumber(p.lastMotion)
      if (lm !== null) {
        const prev = state.lastMotionByCamera[id] ?? 0
        if (lm !== prev) {
          state.lastMotionByCamera[id] = lm
          if (lm > 0) {
            out.push({ type: "motion", cameraId: id, ts: lm })
          }
        }
      }
    }
    if (flags.ring && "lastRing" in p) {
      const lr = toPositiveNumber(p.lastRing)
      if (lr !== null) {
        const prev = state.lastRingByCamera[id] ?? 0
        if (lr !== prev && lr > 0) {
          state.lastRingByCamera[id] = lr
          out.push({ type: "ring", cameraId: id, ts: lr })
        }
      }
    }
  }

  if (a === "add" && modelKey === "event" && flags.smart && payload && typeof payload === "object") {
    const ev = /** @type {Record<string, unknown>} */ (payload)
    const types = ev.smartDetectTypes
    if (!Array.isArray(types) || types.length === 0) {
      return out
    }
    const cameraField = ev.camera
    const cameraId = typeof cameraField === "string" ? cameraField : ""
    const start = toPositiveNumber(ev.start) ?? Date.now()
    const eventId = typeof ev.id === "string" ? ev.id : ""
    for (const t of types) {
      if (typeof t === "string" && t.length > 0) {
        out.push({
          type: "smart",
          cameraId,
          object: t,
          ts: start,
          eventId,
        })
      }
    }
  }

  return out
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function toPositiveNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v
  }
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) {
      return n
    }
  }
  return null
}

module.exports = {
  normalizeUpdatePacket,
  toPositiveNumber,
}
