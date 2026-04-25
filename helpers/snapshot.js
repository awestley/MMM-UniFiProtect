"use strict"

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function jpegToDataUrl(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return ""
  }
  return `data:image/jpeg;base64,${buf.toString("base64")}`
}

module.exports = { jpegToDataUrl }
