"use strict"

const { wrapResponseHeadersForUniFiLibrary } = require("./undici-response-headers")

/**
 * Walk the prototype chain (class methods live on prototypes, not the instance).
 * @param {object} instance
 * @param {string} methodName
 * @returns {Function | null}
 */
function bindMethodFromPrototypeChain(instance, methodName) {
  for (let proto = Object.getPrototypeOf(instance); proto; proto = Object.getPrototypeOf(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, methodName)
    if (d && typeof d.value === "function") {
      return d.value.bind(instance)
    }
  }
  return null
}

/**
 * undici `Response.headers` is a Web `Headers` object; unifi-protect reads `headers["set-cookie"]`
 * (IncomingMessage style). Wrap HTTP where the library implements it — usually `_retrieve`.
 *
 * Does not use `ProtectApi.prototype` alone: bundled/minified builds may expose a different class.
 *
 * @param {object} api
 * @param {{ debug: (...args: unknown[]) => void }} moduleLog
 * @param {boolean} trace
 * @returns {{ patchLayer: "_retrieve" | "retrieve" }}
 */
function patchProtectApiRetrieve(api, moduleLog, trace) {
  const origRetrieve = bindMethodFromPrototypeChain(api, "_retrieve")
  const origPublicRetrieve = origRetrieve ? null : bindMethodFromPrototypeChain(api, "retrieve")

  if (!origRetrieve && !origPublicRetrieve) {
    const chain = []
    for (let p = Object.getPrototypeOf(api); p && chain.length < 8; p = Object.getPrototypeOf(p)) {
      chain.push(Object.getOwnPropertyNames(p).filter(n => n === "retrieve" || n === "_retrieve" || n.includes("etrieve")))
    }
    throw new Error(
      `MMM-UniFiProtect: ProtectApi has no retrieve/_retrieve on prototype chain (hints=${JSON.stringify(chain)}). `
      + "This module requires unifi-protect v4.x; v3 uses a different API — run npm install in MMM-UniFiProtect.",
    )
  }

  const orig = /** @type {Function} */ (origRetrieve || origPublicRetrieve)
  const patchRetrieveOnly = !origRetrieve

  let seq = 0
  const wrap = async (url, options, retrieveOptions) => {
    const res = await orig(url, options, retrieveOptions)
    const out = wrapResponseHeadersForUniFiLibrary(res)
    if (trace) {
      const urlStr = typeof url === "string" ? url : String(url)
      const quiet = urlStr.includes("/snapshot")
        || urlStr.includes("package-snapshot")
      if (!quiet) {
        const h = out && out.headers
        moduleLog.debug(`[retrieve#${++seq}]`, {
          url: urlStr.length > 200 ? urlStr.slice(0, 200) + "…" : urlStr,
          method: options?.method || "GET",
          responseNull: res == null,
          statusCode: out && out.statusCode,
          headerKeys: h && typeof h === "object" ? Object.keys(h).sort() : [],
          hasSetCookie: Boolean(h && h["set-cookie"]),
          hasXUpdatedCsrf: Boolean(h && h["x-updated-csrf-token"]),
          hasXCsrf: Boolean(h && h["x-csrf-token"]),
          patchLayer: patchRetrieveOnly ? "retrieve" : "_retrieve",
        })
      }
    }
    return out
  }

  const patchLayer = patchRetrieveOnly ? "retrieve" : "_retrieve"
  if (patchRetrieveOnly) {
    api.retrieve = wrap
  } else {
    api._retrieve = wrap
  }
  return { patchLayer }
}

module.exports = { patchProtectApiRetrieve, bindMethodFromPrototypeChain }
