"use strict"

/**
 * @param {string} type
 * @param {number} eventDebounceMs
 * @param {number | undefined} doorbellRingDebounceMs
 * @returns {number}
 */
function debounceMsForEvent(type, eventDebounceMs, doorbellRingDebounceMs) {
  const base = typeof eventDebounceMs === "number" && Number.isFinite(eventDebounceMs)
    ? eventDebounceMs
    : 1500
  if (type === "ring"
    && typeof doorbellRingDebounceMs === "number"
    && Number.isFinite(doorbellRingDebounceMs)) {
    return doorbellRingDebounceMs
  }
  return base
}

module.exports = { debounceMsForEvent }
