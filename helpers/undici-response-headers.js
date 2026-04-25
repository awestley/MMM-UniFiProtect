"use strict"

/**
 * unifi-protect reads `response.headers["set-cookie"]` etc. Node `https` uses plain
 * objects; undici uses Web `Headers` where bracket access often returns `undefined`.
 * Normalize to an IncomingMessage-style plain object so loginController can read
 * Set-Cookie and CSRF headers.
 *
 * @param {import("undici").Response} res
 * @returns {import("undici").Response}
 */
function wrapResponseHeadersForUniFiLibrary(res) {
  if (!res || !res.headers || typeof res.headers.get !== "function") {
    return res
  }
  const plain = undiciHeadersToPlain(res.headers)
  return new Proxy(res, {
    get(target, prop) {
      if (prop === "headers") {
        return plain
      }
      // Use `target` as receiver so undici Response private fields (e.g. status) still resolve.
      return Reflect.get(target, prop, target)
    },
  })
}

/**
 * @param {import("undici").Headers} headers
 * @returns {Record<string, string | string[]>}
 */
function undiciHeadersToPlain(headers) {
  const out = /** @type {Record<string, string | string[]>} */ ({})
  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie()
    if (cookies.length === 1) {
      out["set-cookie"] = cookies[0]
    } else if (cookies.length > 1) {
      out["set-cookie"] = cookies
    }
  }
  for (const name of headers.keys()) {
    const lower = name.toLowerCase()
    if (lower === "set-cookie" && out["set-cookie"] !== undefined) {
      continue
    }
    if (lower === "set-cookie") {
      out["set-cookie"] = headers.get(name) ?? ""
    } else {
      out[lower] = headers.get(name) ?? ""
    }
  }
  return out
}

module.exports = { wrapResponseHeadersForUniFiLibrary, undiciHeadersToPlain }
