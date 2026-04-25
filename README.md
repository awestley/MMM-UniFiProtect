# MMM-UniFiProtect

MagicMirror² module for **UniFi Protect**: live camera video (native fMP4 via Media Source Extensions), realtime **motion** and **doorbell ring** signals, and **smart (AI) detection** events (person, vehicle, package, animal, and other types your cameras report).

**Doorbell rings** get dedicated UX: longer, high-visibility toasts; optional **fullscreen overlay** with the doorbell camera snapshot; **highlighted** tile for that camera; optional **chime** sound; and an immediate **snapshot burst** from the helper so the image updates right away.

Credentials and HTTP/WebSocket traffic stay in **`node_helper.js`** on the MagicMirror host. The browser receives derived notifications: fMP4 video segments (streamed natively from Protect via the helper), snapshots as data URLs, event labels, and optional iframe URLs you configure.

## Prerequisites

- MagicMirror² with Node.js **20+** (required by `unifi-protect` v4 used by this module).
- A UniFi OS console running **UniFi Protect** (stable release; Early Access is unsupported by Ubiquiti for third-party clients and may break without notice).
- A **local** administrator on the console (UniFi cloud-only accounts cannot authenticate the way this module does). Ubiquiti’s current guidance is to create a local admin with full Protect access and, when the console offers it, an **API key** used together with your username and password.
- **RTSPS** (or RTSP) enabled on camera channels only if you plan to point **go2rtc** or another player at those URLs for `streamUrl` iframe embedding (optional; not required for native live or snapshots).

## Installation

1. Copy this folder into your MagicMirror `modules/` directory as `MMM-UniFiProtect` (or clone your fork and symlink it there).
2. From the module directory install dependencies:

   ```bash
   cd ~/MagicMirror/modules/MMM-UniFiProtect
   npm install --omit=dev
   ```

3. Add a block to `config/config.js` (see **Configuration** below).
4. Restart MagicMirror.

### TLS and the UniFi OS certificate

The underlying [`unifi-protect`](https://github.com/hjdhjd/unifi-protect) client connects with **`rejectUnauthorized: false`** so self-signed certificates on LAN controllers work. That trades strict certificate verification for convenience. Prefer placing the mirror and console on a trusted network; consider importing the console CA on the mirror host if you need stricter TLS.

## Configuration

Minimal example:

```javascript
{
  module: "MMM-UniFiProtect",
  position: "top_right",
  config: {
    host: "192.168.1.1",
    username: "local_admin",
    password: "your_password",
    apiKey: "",
    cameras: [
      { name: "Front door" },
      { id: "<camera-id-from-bootstrap>" },
    ],
    snapshotRefreshSeconds: 2,
    webhookUrl: "",
  },
},
```

### Finding camera names and IDs

For each camera you only need **one** identifier: **`name`** *or* **`id`** (not both). Use **`name`** when it is unique in Protect and matches the app exactly; use **`id`** when you prefer the stable UUID (e.g. duplicate names, or keys for `streamUrlByCameraId`).

#### Option 1 — Use the camera name (no ID required)

1. Open the **UniFi Protect** app or the Protect section in the **local** UniFi web UI (`https://<your-console-ip>`).
2. Note the **exact** camera name (e.g. `Front door`, `G4 Doorbell`). Spelling and capitalization must match.
3. In MagicMirror `config.js`, use:

   ```javascript
   cameras: [{ name: "Front door" }],
   ```

   Skip the rest of this section unless you need an `id` (duplicate names, or `streamUrlByCameraId` keys).

#### Option 2 — Get the camera `id` from the Protect bootstrap API (browser)

The console exposes a JSON snapshot of Protect at **`/proxy/protect/api/bootstrap`**. Each camera’s **`id`** is a UUID string (letters, numbers, hyphens).

1. **Use the same address you put in `config.host`.**  
   Examples: `192.168.1.1`, `unifi.local`, or your Dream Machine’s LAN IP. Do not use `unifi.ui.com` for this step; use the **direct** console address.

2. **Log in locally.**  
   In a desktop browser, go to `https://<console-host>` (accept the certificate warning if you use the default self-signed cert). Sign in with a **local** administrator account (the same kind of account you use for this module).

3. **Open the bootstrap URL in the same browser.**  
   In a **new tab** (same browser, same session), open:

   ```text
   https://<console-host>/proxy/protect/api/bootstrap
   ```

   Replace `<console-host>` with the same host or IP as step 1 (no trailing slash).

4. **Read the JSON.**  
   You should see a large JSON document (not an HTML login page). If you see a login page or an error, complete step 2 again in that browser, then retry step 3.

5. **Find the `cameras` array.**  
   Search the page for `"cameras"` (with quotes). You will see an array of objects. Each object includes at least:
   - **`id`** — the value to copy into `config.js` (UUID format).
   - **`name`** — the friendly name (should match what you see in Protect).

   Example shape (abbreviated):

   ```json
   "cameras": [
     {
       "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
       "name": "Front door",
       ...
     }
   ]
   ```

6. **Copy the `id` into your config** (quotes, no spaces):

   ```javascript
   cameras: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Front door" }],
   ```

   The `name` in config is optional when you use `id`; it only affects labels on the mirror.

**Tips**

- If the JSON is hard to read, use a JSON-formatting browser extension, or “Pretty-print” in Firefox, or save the page and open it in an editor that folds JSON.
- **`streamUrlByCameraId`** uses these same **`id`** strings as keys.
- This endpoint is a normal **GET** request; the browser sends your **session cookie** from step 2. The module does not need to call this URL at runtime if you already copied the ids into `config.js`.

#### Option 3 — Advanced: scripted `curl`

Bootstrap requires authentication (cookies or API token, depending on UniFi OS version). Doing that from a script is possible but fiddly. For most people, **Option 1** or **Option 2** is enough.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | string | `""` | UniFi OS console hostname or IP (no `https://`). |
| `username` | string | `""` | Local Protect user. |
| `password` | string | `""` | Password for that user. |
| `apiKey` | string | `""` | If your console issues API keys, set it here; sent as `X-API-Key` after login (Ubiquiti has changed details over time—if login fails, try updating `unifi-protect` or use password-only). |
| `cameras` | array | `[]` | Entries may be a camera id string, `{ id, name?, streamUrl? }`, or `{ name, streamUrl? }` matched against Protect device names. |
| `protectNativeLive` | boolean | `true` | Stream live fMP4 video directly from UniFi Protect via Media Source Extensions (MSE). When `true` and no `streamUrl` is configured for a camera, the tile shows a `<video>` element fed by the Protect livestream WebSocket. Set `false` to fall back to JPEG snapshots. |
| `snapshotRefreshSeconds` | number | `2` | Interval to pull JPEG snapshots for cameras using snapshot mode (i.e. `protectNativeLive` is `false` or a `streamUrl` is set). Snapshot polling is skipped entirely for cameras using native live. Set `0` to disable snapshots. |
| `showMotionEvents` | boolean | `true` | Emit UI toasts for motion (`lastMotion` updates). |
| `showRingEvents` | boolean | `true` | Emit toasts for doorbell rings (`lastRing`). |
| `showSmartEvents` | boolean | `true` | Emit toasts for AI smart detection (`smartDetectTypes` on Protect event adds). |
| `eventDebounceMs` | number | `1500` | Minimum gap between duplicate event keys before another toast/webhook fires. |
| `useMagicMirrorAlerts` | boolean | `true` | When `true`, motion / ring / smart events use MagicMirror’s **`alert`** module (`SHOW_ALERT` notifications) so they match the default mirror notification UI. Set `false` for the legacy toast stack **under** the camera tile. Requires the `alert` module in `config.js`. |
| `maxEventToasts` | number | `6` | Cap on stacked rows when `useMagicMirrorAlerts` is `false`. |
| `eventToastDurationMs` | number | `8000` | How long each embedded toast stays (or the **`alert`** timer when using MagicMirror alerts). |
| `streamUrlByCameraId` | object | `{}` | Map of camera id → URL for an **iframe** (e.g. go2rtc player page on your LAN). Takes priority over native live for that camera. If both are set, per-camera `streamUrl` wins over this map. |
| `webhookUrl` | string | `""` | If set, each normalized event is POSTed as JSON (`Content-Type: application/json`). |
| `debugLogging` | boolean | `false` | When `true`, emits **sparse** diagnostics: Node (connect, session, realtime listener, rings, snapshot polling summary, failures) via `[MMM-UniFiProtect]` and browser `Log.log` for status, camera count, and doorbell UI. Motion/smart events and per-frame snapshots are **not** logged. The `unifi-protect` library still uses your log adapter for its own messages when this is on. |
| `traceRetrieve` | boolean | `true` | When `true`, logs **`[retrieve#n]`** for each `unifi-protect` HTTP call (except snapshot URLs): URL, `statusCode`, `responseNull`, sorted **`headerKeys`**, and booleans for `set-cookie` / CSRF headers **after** this module normalizes undici’s `Headers` object (see troubleshooting below). Set `false` to silence. |
| `streamDiagnostics` | boolean | `false` | When `true`, logs explicit **stream vs snapshot** decisions: server lines prefixed with **`[stream-diag]`** (also mirrored to `logFile` when configured) and browser `Log.log` lines prefixed with **`[MMM-UniFiProtect][stream]`**. URLs are logged with common secret-like query params redacted. |
| `logFile` | string | `""` | **Node (server) only:** path on the MagicMirror machine for append-only UTF-8 logging. When non-empty, each sparse `moduleLog` line is written with an ISO timestamp (same messages as above **excluding** browser `Log.log`). Independent of `debugLogging`: you can log to a file with `logFile` set and `debugLogging` `false`. Parent directories are created if missing. Leading `~/` expands using `HOME` (POSIX) or `USERPROFILE` (Windows). On start, the helper prints `file logging: <absolute path>` in the **MagicMirror server** terminal. If the file cannot be written, a **one-time** error is printed there (writes are otherwise silent). Relative paths are resolved from MagicMirror’s process working directory. |
| `title` | string | `""` | Optional static header. When empty and there is **one** camera, the header shows that camera’s name (no default “UniFi Protect”). With **multiple** cameras, leave empty to omit the header and use per-tile labels only. |
| `compactMode` | boolean | `false` | Smaller snapshot and iframe sizes. |
| `doorbellToastDurationMs` | number | `20000` | How long doorbell toasts stay visible (longer than `eventToastDurationMs`). |
| `doorbellOverlay` | boolean | `true` | Full-viewport overlay with “Doorbell” title, camera name, and latest snapshot for that camera. |
| `doorbellOverlayDurationMs` | number | `14000` | How long the overlay stays before auto-dismiss. |
| `doorbellHighlightSeconds` | number | `12` | Duration the matching camera tile shows a highlight outline after a ring. |
| `doorbellSound` | string | `""` | Relative path under this module to a sound file (e.g. `"assets/doorbell.mp3"`). Empty disables chime. Uses MagicMirror’s `file()` URL. **Autoplay:** some browsers block audio until the user has interacted with the page; if the chime is silent, tap the mirror UI once or try another client. |
| `doorbellSnapshotBurst` | boolean | `true` | When a ring event is emitted, immediately fetch one snapshot for that camera (in addition to the normal interval). |
| `doorbellRingDebounceMs` | number | *(unset)* | If set, used **only** for `ring` debouncing instead of `eventDebounceMs` (e.g. longer gap to absorb double-presses while still allowing a later ring). |

The helper debounces using a key `type:cameraId:object`. For `ring` events, the debounce interval is `doorbellRingDebounceMs` when that option is a number; otherwise `eventDebounceMs`.

### Environment variables (Docker / Compose)

This repository’s sample `config/config.js` can read **`UNIFI_PROTECT_*`** from the process environment (see `service.yml.example`). Each variable maps to the **Options** table above. Use a **`.env`** file next to your Compose file for secrets (`UNIFI_PROTECT_PASSWORD`, `UNIFI_PROTECT_API_KEY`); do not commit real credentials.

**Booleans** (for `SHOW_*`, `DEBUG_LOGGING`, `TRACE_RETRIEVE`, `STREAM_DIAG`, `COMPACT_MODE`, `USE_MM_ALERTS`, `DOORBELL_*` except sounds/numbers): `true`, `false`, `1`, `0`, `yes`, `on` (case-insensitive). **Numbers** must parse as finite values.

| Environment variable | Config key | What to populate |
|------------------------|------------|------------------|
| `UNIFI_PROTECT_HOST` | `host` | UniFi OS console **IP or hostname** (no `https://`). Same idea as **Finding camera names and IDs** — use the LAN address you use in the browser. |
| `UNIFI_PROTECT_USERNAME` | `username` | Local Protect user (not a cloud-only account). |
| `UNIFI_PROTECT_PASSWORD` | `password` | That user’s password. Prefer `.env`, not inline in `service.yml`. |
| `UNIFI_PROTECT_API_KEY` | `apiKey` | Optional console API key if your UniFi OS version issues one; sent after login. Leave empty if unused. |
| `UNIFI_PROTECT_CAMERA_IDS` | `cameras` | **Comma-separated** Protect camera **UUIDs** (from bootstrap / Protect UI). Becomes `[{ id }, …]`. Same IDs as in **Option 2** above. |
| `UNIFI_PROTECT_NATIVE_LIVE` | `protectNativeLive` | `true` (default) to stream live fMP4 video from Protect via MSE; `false` to fall back to JPEG snapshots. |
| `UNIFI_PROTECT_SNAPSHOT_REFRESH_SECONDS` | `snapshotRefreshSeconds` | Seconds between JPEG refreshes for tiles in snapshot mode; `0` disables. Skipped for cameras using native live. |
| `UNIFI_PROTECT_SHOW_MOTION` | `showMotionEvents` | Motion toasts. |
| `UNIFI_PROTECT_SHOW_RING` | `showRingEvents` | Doorbell ring toasts. |
| `UNIFI_PROTECT_SHOW_SMART` | `showSmartEvents` | AI smart-detection toasts. |
| `UNIFI_PROTECT_EVENT_DEBOUNCE_MS` | `eventDebounceMs` | Min ms between duplicate event keys (see debounce note above). |
| `UNIFI_PROTECT_MAX_EVENT_TOASTS` | `maxEventToasts` | Max stacked toast rows. |
| `UNIFI_PROTECT_EVENT_TOAST_DURATION_MS` | `eventToastDurationMs` | Ordinary event toast lifetime (ms). |
| `UNIFI_PROTECT_STREAM_URL_CAM1` … `CAM3` | `streamUrlByCameraId` | **Full URL** of a page to embed in an **iframe** for that camera (e.g. go2rtc or WebRTC player page on your LAN). |
| `UNIFI_PROTECT_STREAM_CAMERA_IDS` | *(keys for stream map)* | Optional **comma-separated UUIDs**, **same order** as `CAM1` → `CAM2` → `CAM3`. If unset, `config/config.js` maps `CAMn` to the **n-th** id from `UNIFI_PROTECT_CAMERA_IDS` (so a single-camera install can set only `CAM1` + `UNIFI_PROTECT_CAMERA_IDS`). |
| `UNIFI_PROTECT_WEBHOOK_URL` | `webhookUrl` | Optional HTTPS URL; each normalized event is `POST`ed as JSON. |
| `UNIFI_PROTECT_DEBUG_LOGGING` | `debugLogging` | Verbose server/client logging (not the same as `logFile`). |
| `UNIFI_PROTECT_TRACE_RETRIEVE` | `traceRetrieve` | Logs **`[retrieve#n]`** HTTP lines from the Protect client (see troubleshooting). |
| `UNIFI_PROTECT_STREAM_DIAG` | `streamDiagnostics` | Stream vs snapshot diagnostics (`[stream-diag]` / `[MMM-UniFiProtect][stream]`). |
| `UNIFI_PROTECT_LOG_FILE` | `logFile` | **Absolute path** on the MagicMirror **host** for append-only logs (e.g. under a Docker volume mount). Empty disables file logging. |
| `UNIFI_PROTECT_TITLE` | `title` | Optional header; empty uses camera name (single camera) or no header (multiple). |
| `UNIFI_PROTECT_COMPACT_MODE` | `compactMode` | Smaller tiles. |
| `UNIFI_PROTECT_USE_MM_ALERTS` | `useMagicMirrorAlerts` | `true`: use MagicMirror **`alert`** notifications; `false`: toasts under the tile. |
| `UNIFI_PROTECT_DOORBELL_TOAST_MS` | `doorbellToastDurationMs` | Doorbell toast duration (ms). |
| `UNIFI_PROTECT_DOORBELL_OVERLAY` | `doorbellOverlay` | Fullscreen doorbell overlay on/off. |
| `UNIFI_PROTECT_DOORBELL_OVERLAY_MS` | `doorbellOverlayDurationMs` | Overlay auto-dismiss (ms). |
| `UNIFI_PROTECT_DOORBELL_HIGHLIGHT_SECONDS` | `doorbellHighlightSeconds` | Tile highlight after ring (seconds). |
| `UNIFI_PROTECT_DOORBELL_SOUND` | `doorbellSound` | Path **relative to this module** (e.g. `assets/doorbell.mp3`). Empty disables sound. |
| `UNIFI_PROTECT_DOORBELL_SNAPSHOT_BURST` | `doorbellSnapshotBurst` | Fetch an extra snapshot immediately on ring. |
| `UNIFI_PROTECT_DOORBELL_RING_DEBOUNCE_MS` | `doorbellRingDebounceMs` | Optional; if set, used **only** for ring debouncing. Leave unset to use `eventDebounceMs` for rings. |

### No log file or console output?

- **`npm test` / `npm run lint`** only exercise unit tests; they do not run MagicMirror or touch your configured `logFile`.
- **`debugLogging`** controls **console** lines from this module and the browser `Log.log` lines in the **client** devtools—not a file. Set `logFile` for a file.
- **`logFile`** must be set to a non-empty string in `config.js`. Default is `""` (no file).
- Logs from the **node_helper** appear in the terminal where you start MagicMirror (the Node/electron **server**), not in the browser console unless you use `debugLogging` and look at `Log.log` in devtools.
- If the path is wrong or permissions deny writes, check the server terminal for `log file write failed` or `log dir create failed`.

### `bad unifi-protect export` or wrong `ProtectApi` (bundled MagicMirror / Docker)

The helper loads **`unifi-protect/dist/protect-api.js`** first, then falls back to the package root. **`[connect-step]`** lines are compact: **`unifi-protect`** (installed **version**, **importFrom** `dist` or `package`, optional **subpathFallback**, **exportKeys** count, and **`packageJsonPath`**), then **`session`** (**patchLayer** for the undici header shim, **includeApiKey**). With **`debugLogging`**, the log file also gets **stack** traces on connect errors and extra **moduleLog.debug** lines. If **`exportKeys`** is large, a short **`exportKeysSample`** may appear.

Ensure **`npm install`** ran inside **`modules/MMM-UniFiProtect`** on the host that runs MagicMirror so **`node_modules/unifi-protect`** matches **`package.json`** (v4.x, Node 20+).

If the log shows **`unifi-protect` v3.x** or **`unifi-protect incompatible`**, the running host still has an **old `node_modules`**. This module **requires v4** (`package.json` pins it). On the machine or in the Docker build, run **`npm install`** in **`modules/MMM-UniFiProtect`** (prefer **`package-lock.json`** in CI), then redeploy — do not copy a stale **`node_modules`** from an older image.

### `connect/bootstrap failed` in the log file

Login or bootstrap failed (before cameras load). The `unifi-protect` library logs the specific reason with **`[unifi-protect:error]`** or **`[unifi-protect:warn]`** lines in your **`logFile`** (and on the server console as `[MMM-UniFiProtect] …`) **when it calls `log.error`**. Some failures are still easiest to read from this module’s summary lines and the **`HTTPS probe GET /`** entry below.

After each failed connect, the helper logs a probe of **`https://HOST/`** (same TLS behavior as the library: self-signed OK):

- **`hasXCsrfToken: false`** — **not** definitive on newer UniFi OS: the landing page can be **nginx** with **no** `X-CSRF-Token` on `GET /` while the controller is still correct. This module uses **`unifi-protect` v4**, which authenticates via the login API (and `X-Updated-CSRF-Token` / cookies) without requiring that preflight header. If login still fails, check VLAN/route/proxy, or that `HOST` is really your console (on split networks, `.1` may not be the UniFi device).
- **`hasXCsrfToken: true`** — classic UniFi OS landing fingerprint; focus on **username/password**, **local user** with Protect access, and controller health.

Typical fixes:

- Use a **local Protect user** (UniFi OS → Users) with a password; verify the account in the Protect web UI.
- Prefer the console **LAN IP** if **`unifi.local`** is flaky (mDNS / VLAN / Docker).
- Confirm the Protect app works from the same subnet; firewalls must allow **HTTPS to the console** (library uses `https://HOST/...`).
- Update the **`unifi-protect`** dependency if UniFi OS was upgraded and the API changed.

The helper applies a **15s backoff** after a failed refresh (same host + username) so repeated `UNIFIPROTECT_CONNECT` messages do not hammer the controller or flood the log; you will see **`connect skipped (backoff after recent failure)`** until the window passes.

### Why `curl` / `wget` to `/api/auth/login` “works” but `Protect login()` failed

Node’s **`https`** stack returns **`IncomingMessage.headers`** as a **plain object** with lowercase keys, so `headers["set-cookie"]` works. **`unifi-protect` v4** uses **undici**; responses use the Web **`Headers`** API. The library reads `response.headers["set-cookie"]` (bracket style), which is often **`undefined`** on undici `Headers`, so `loginController` thinks there is no cookie/CSRF even when **`POST /api/auth/login` returned 200** with headers.

**This module wraps every `retrieve()` response** so `headers` look like Node’s plain object (and logs **`[retrieve#n]`** when `traceRetrieve` is true). That fixes the mismatch; use **`[retrieve#n]`** lines—not a separate manual POST probe—to see what the library actually received.

### Snapshots work but no motion / doorbell / smart toasts

`unifi-protect` treats **`getBootstrap()` as failed** if the **WebSocket** to `wss://<host>/proxy/protect/ws/updates` never opens, even when HTTPS login and the bootstrap JSON succeeded. Some Docker or firewall setups block that WSS path.

This module **falls back to a “snapshots only” session** when bootstrap already contains cameras: you should see a debug line like *continuing without realtime WebSocket*. Tiles update; **motion / ring / smart events need WSS** until the network allows that WebSocket.

If you still see many `connecting` lines, you may have **more than one** `MMM-UniFiProtect` block in `config.js`; each instance triggers a connect (connects are **serialized** so they do not overlap).

## Live video

### Native Protect live stream (default)

By default (`protectNativeLive: true`) the module streams live video **directly from UniFi Protect** with no intermediate server. The `node_helper` opens the Protect livestream WebSocket (`/proxy/protect/api/ws/livestream`) for each camera and forwards fMP4 segments to the browser over the MagicMirror socket. The browser plays them via the **Media Source Extensions (MSE)** API in a `<video>` element.

Typical latency is 1–3 seconds. The stream uses whichever codec the camera negotiates with Protect (commonly H.265/HEVC on newer cameras, H.264 on older ones). Codec support depends on the browser/renderer:

- **Electron (MagicMirror kiosk)** — H.264 and H.265 (with hardware decode on supported platforms).
- **Chrome / Edge** — H.264 universally; H.265 on macOS 13+ and Windows with supported GPU.
- **Firefox** — H.264 universally; H.265 is limited (platform-dependent).
- **Safari** — H.264 and H.265.

If the browser does not support the negotiated codec, the tile will be blank and the browser console will log a `no supported MIME for codec` warning. Set `protectNativeLive: false` to fall back to JPEG snapshots.

### iframe embedding (go2rtc / WebRTC)

If you run [go2rtc](https://github.com/AlexxIT/go2rtc) or another player on your network, you can embed its player page in a sandboxed `<iframe>` instead of using native live. Set either `streamUrl` on a camera entry or `streamUrlByCameraId` to the player page URL. A configured `streamUrl` or map entry takes priority over native live for that camera.

## Frontend ↔ node_helper notifications

| Direction | Name | Payload |
|-----------|------|---------|
| Browser → helper | `UNIFIPROTECT_CONNECT` | Connection and filter options (sent automatically on `start`). |
| Helper → browser | `UNIFIPROTECT_STATUS` | `{ ok: boolean, error?: string }` |
| Helper → browser | `UNIFIPROTECT_CAMERAS` | `{ cameras: [{ id, name, streamUrl? }] }` |
| Helper → browser | `UNIFIPROTECT_SNAPSHOT` | `{ cameraId, dataUrl }` JPEG data URL |
| Helper → browser | `UNIFIPROTECT_EVENT` | Normalized event (see below). |
| Helper → browser | `UNIFIPROTECT_LIVE_CODEC` | `{ cameraId, codec }` — codec string (e.g. `hev1.1.6.L120,mp4a.40.2`) sent once per stream start before the init segment. |
| Helper → browser | `UNIFIPROTECT_LIVE_FMP4` | `{ cameraId, kind: "init" \| "segment", data }` — base64-encoded fMP4 bytes. `"init"` carries the initialization segment; `"segment"` carries each subsequent media segment. |
| Browser → helper | `UNIFIPROTECT_LIVE_RESYNC` | `{ cameraIds: string[] }` — browser requests the helper to restart the Protect livestream for the listed cameras (used automatically when the MSE pipeline is lost after a DOM rebuild). |

### Normalized `UNIFIPROTECT_EVENT` shapes

| `type` | Fields | Source (Protect updates API) |
|--------|--------|------------------------------|
| `motion` | `cameraId`, `ts` | Camera `update` when `lastMotion` changes to a new positive timestamp. |
| `ring` | `cameraId`, `ts` | Camera `update` when `lastRing` changes to a new positive timestamp. |
| `smart` | `cameraId`, `object`, `ts`, `eventId` | Event `add` with `smartDetectTypes` (e.g. `person`, `vehicle`, `package`, `animal`). |

## Development

From the module directory:

```bash
npm install
npm run lint
npm test
npm run test:coverage
```

Coverage thresholds apply to `helpers/*.js` (pure logic). Run `npm run test:coverage` to enforce **≥95%** lines/branches/functions/statements on those files.

## License

MIT — see [LICENSE](LICENSE).
