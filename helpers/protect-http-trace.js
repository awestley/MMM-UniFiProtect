"use strict"

/**
 * Subscribe to unifi-protect v5 HTTP diagnostics (`channels.httpRequestEnd`) and mirror
 * non-snapshot requests as `[retrieve#n]` debug lines (same log shape operators already use).
 *
 * @param {{ httpRequestEnd?: { subscribe: (fn: (payload: Record<string, unknown>) => void) => void, unsubscribe: (fn: (payload: Record<string, unknown>) => void) => void } }} channels
 * @param {{ debug: (...args: unknown[]) => void }} moduleLog
 * @returns {() => void} unsubscribe
 */
function subscribeProtectHttpTrace(channels, moduleLog) {
  const end = channels && channels.httpRequestEnd
  if (!end || typeof end.subscribe !== "function") {
    return () => {}
  }
  let seq = 0
  /** @param {Record<string, unknown>} payload */
  const onEnd = (payload) => {
    const url = typeof payload.url === "string" ? payload.url : String(payload.url || "")
    if (url.includes("/snapshot") || url.includes("package-snapshot")) {
      return
    }
    moduleLog.debug(`[retrieve#${++seq}]`, {
      url: url.length > 200 ? `${url.slice(0, 200)}…` : url,
      method: payload.method || "GET",
      statusCode: payload.statusCode,
      durationMs: payload.durationMs,
      error: payload.error,
      host: payload.host,
    })
  }
  end.subscribe(onEnd)
  return () => {
    try {
      if (typeof end.unsubscribe === "function") {
        end.unsubscribe(onEnd)
      }
    } catch {
      /* ignore */
    }
  }
}

module.exports = { subscribeProtectHttpTrace }
