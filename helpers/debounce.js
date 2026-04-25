"use strict"

/**
 * @param {string} key
 * @param {number} nowMs
 * @param {number} debounceMs
 * @param {Map<string, number>} lastMap
 * @returns {boolean}
 */
function shouldEmit(key, nowMs, debounceMs, lastMap) {
  if (debounceMs <= 0) {
    return true
  }
  const prev = lastMap.get(key)
  if (prev !== undefined && nowMs - prev < debounceMs) {
    return false
  }
  lastMap.set(key, nowMs)
  return true
}

module.exports = { shouldEmit }
