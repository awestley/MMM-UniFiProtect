"use strict"

/**
 * Map a unifi-protect v5 {@link TypedEvent} into this module’s UI/webhook payloads.
 *
 * @param {unknown} event
 * @param {{ motion: boolean, ring: boolean, smart: boolean }} flags
 * @returns {Array<Record<string, unknown>>}
 */
function typedEventsToUi(event, flags) {
  const out = []
  if (!event || typeof event !== "object") {
    return out
  }
  const e = /** @type {{ kind?: string, cameraId?: string, at?: number, eventId?: string, objectTypes?: unknown }} */ (event)
  const cameraId = typeof e.cameraId === "string" ? e.cameraId : ""
  const ts = typeof e.at === "number" && Number.isFinite(e.at) ? e.at : Date.now()
  const eventId = typeof e.eventId === "string" ? e.eventId : ""

  switch (e.kind) {
    case "motionDetected":
      if (flags.motion) {
        out.push({ type: "motion", cameraId, ts, eventId })
      }
      break
    case "doorbellRing":
      if (flags.ring) {
        out.push({ type: "ring", cameraId, ts, eventId })
      }
      break
    case "smartDetect":
      if (flags.smart && Array.isArray(e.objectTypes)) {
        for (const t of e.objectTypes) {
          if (typeof t === "string" && t.length > 0) {
            out.push({
              type: "smart",
              cameraId,
              object: t,
              ts,
              eventId,
            })
          }
        }
      }
      break
    default:
      break
  }

  return out
}

module.exports = { typedEventsToUi }
