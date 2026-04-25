"use strict"

const fs = require("fs")
const path = require("path")
const { createRequire } = require("module")

/** This module’s Node helper targets `unifi-protect` v4 (`login` / `getBootstrap` / `retrieve`, undici). */
const REQUIRED_UNIFI_PROTECT_MAJOR = 4

/**
 * @param {string | null | undefined} version
 * @returns {number | null}
 */
function semverMajor(version) {
  if (!version || typeof version !== "string") {
    return null
  }
  const m = /^v?(\d+)/.exec(version.trim())
  return m ? Number(m[1]) : null
}

/**
 * @param {{ version: string | null, packageJsonPath: string | null, error?: string }} meta
 * @returns {string | null} Error message if incompatible, else null
 */
function incompatibleUnifiProtectMessage(meta) {
  if (!meta || meta.error || !meta.version) {
    return null
  }
  const major = semverMajor(meta.version)
  if (major === null || major >= REQUIRED_UNIFI_PROTECT_MAJOR) {
    return null
  }
  return (
    `MMM-UniFiProtect requires unifi-protect v${REQUIRED_UNIFI_PROTECT_MAJOR}.x (see this module's package.json). `
    + `Found v${meta.version} at ${meta.packageJsonPath || "?"}. `
    + "Remove stale node_modules or rebuild your image, then from modules/MMM-UniFiProtect run: npm install"
  )
}

/**
 * Resolve `unifi-protect` the same way `node_helper.js` does (nearest `node_modules` from this module).
 *
 * @returns {{ version: string | null, packageJsonPath: string | null, error?: string }}
 */
function getUnifiProtectRuntimeMeta() {
  const anchor = path.join(__dirname, "..", "node_helper.js")
  try {
    const req = createRequire(anchor)
    const pkgPath = req.resolve("unifi-protect/package.json")
    const raw = fs.readFileSync(pkgPath, "utf8")
    const { version } = JSON.parse(raw)
    return { version: typeof version === "string" ? version : null, packageJsonPath: pkgPath }
  } catch (e) {
    return {
      version: null,
      packageJsonPath: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

module.exports = {
  getUnifiProtectRuntimeMeta,
  semverMajor,
  incompatibleUnifiProtectMessage,
  REQUIRED_UNIFI_PROTECT_MAJOR,
}
