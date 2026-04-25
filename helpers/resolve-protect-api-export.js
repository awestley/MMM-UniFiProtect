"use strict"

/**
 * @param {unknown} fn
 * @returns {boolean}
 */
function isLikelyProtectApiConstructor(fn) {
  if (typeof fn !== "function" || !fn.prototype) {
    return false
  }
  const p = fn.prototype
  return typeof p.login === "function"
    && (typeof p.retrieve === "function" || typeof p._retrieve === "function")
}

/**
 * Main `unifi-protect` entry is sometimes wrapped (MagicMirror/bundlers). Prefer
 * `import("unifi-protect/dist/protect-api.js")` first; this picks a usable constructor from the namespace.
 *
 * @param {Record<string, unknown> | null | undefined} mod
 * @returns {Function | null}
 */
function resolveProtectApiExport(mod) {
  if (!mod || typeof mod !== "object") {
    return null
  }
  const named = mod.ProtectApi
  if (typeof named === "function") {
    return named
  }
  const d = mod.default
  if (d && typeof d === "object" && typeof d.ProtectApi === "function") {
    return d.ProtectApi
  }
  if (typeof d === "function" && d.name === "ProtectApi") {
    return d
  }
  if (isLikelyProtectApiConstructor(d)) {
    return d
  }
  return null
}

module.exports = { resolveProtectApiExport, isLikelyProtectApiConstructor }
