# Stratos: build, deploy and operate

Stratos is one application with four delivery paths:

| Surface | Served from | Notes |
| --- | --- | --- |
| Website / PWA | repository root + `app/` | Vercel (recommended) or any static host. No build step. |
| Windows desktop | `electron-main.cjs` + `app/` | Electron loads `app/index.html` from the app bundle. |
| Simulator bridge | `stratos_bridge.py` + `bridge_logbook_addon.py` | Python 3.8+, standard library only. |
| Phone relay | `relay/server.mjs` | Node 18+. Optional, but required for live telemetry on an HTTPS phone. |

## Source of truth

There is exactly one copy of each application page:

- Map, charts, traffic, local live link: `app/index.html`
- Career, landings, replay, briefing, routes, airports, settings: `app/pilot.html` + `app/js/pilot/*`
- Logbook: `app/logbook.html`
- Mobile live dashboard: `app/live.html` + `app/js/live.js`
- Weather: `app/weather.html`
- Shared pure data code: `app/js/lib/*` (used by the desktop app and the website)
- Landing page: `index.html`
- Root `logbook.html` and `weather.html` are one-line redirects kept for old bookmarks. They are not application copies.

The old `stratos.html` duplicate was removed. Do not reintroduce a second copy of the tracker: edit `app/index.html` only. The Windows build and the bridge both package `app/` itself.

## 1. Website (Vercel)

1. Import the GitHub repository into Vercel.
2. Framework preset: **Other**. Root Directory: repository root. Build Command: empty. Output Directory: `.`.
3. Deploy. The landing page is `/`; the tracker is `/app/`; Pilot is `/app/pilot.html`.
4. No environment variables are required for the static site. `api/weather.js` and `api/ourairports.js` run as Node serverless functions automatically.
5. Set the Node.js runtime to 20 or newer in the project settings if Vercel does not select it automatically.

`vercel.json` only adds headers: the service worker must revalidate, the manifest is served as `application/manifest+json`, and static responses get `nosniff`/`Referrer-Policy`.

The landing page's Windows button resolves the latest GitHub release and checks that `Stratos-Setup.exe` is attached. If no release exists it opens the releases page instead of pretending there is a download.

GitHub Pages also works if you deploy the repository root (Settings → Pages → Deploy from branch → `main` / root). API routes are Vercel-only; the app already falls back to public data sources when `/api/weather` is unavailable.

## 2. iPhone / PWA

1. Deploy over **HTTPS**. Service workers and Home Screen installation do not work over plain HTTP except localhost.
2. On the iPhone, open `https://your-site/app/` in **Safari**.
3. Share → **Add to Home Screen** → Add.
4. Open the installed app. For live simulator data, pair it:
   - On the PC: Stratos desktop → **Pilot → Settings → Phone access**, enter the relay URL and generate a code.
   - On the phone: **Live → Relay URL + pairing code → Connect**.
5. The phone stores only its own read token. **Disconnect phone** revokes that token; **Disconnect relay** removes the whole session.

What works offline: the app shell and previously visited pages. What never works offline: live telemetry, weather, traffic and map tiles. The service worker explicitly refuses to cache `/api/*`, `/stream`, `/logbook.json`, `/health`, `/relay/*`, `/metar`, `/weather` and `/tile/*`, so stale data cannot be shown as live.

iOS limitations, stated honestly: a Home Screen web app can be suspended when it is in the background. Stratos reconnects when it is reopened. It does not claim background tracking, guaranteed landing notifications, or push delivery on iOS. The relay and bridge have no command channel, so the phone can never control the PC.

## 3. Windows desktop application

### Local build

```bash
npm ci
npm run dist:win
```

The output is `dist/Stratos-Setup.exe` (NSIS, x64, unsigned). The config is `electron-builder.config.cjs`, not an inline `build` block.

What gets packaged:

- `electron-main.cjs`, `electron-preload.cjs`, and `app/**/*` inside the asar.
- `stratos_bridge.py` and `bridge_logbook_addon.py` in `resources/bridge/`.
- A complete copy of `app/` in `resources/bridge/app/`, so the packaged bridge can serve the same UI on `127.0.0.1:8765`.
- `bridge-dist/stratos-bridge.exe` when it exists. The release workflow builds this with PyInstaller, so the installed app does **not** require Python. A local build without that file falls back to a system `py`/`python3`.

### GitHub Actions release

`.github/workflows/release-windows.yml` runs on a tag (`v*`) or manually. It:

1. installs Node 22 and Python 3.12;
2. runs `npm ci`, JavaScript/relay tests and Python bridge tests;
3. builds `stratos-bridge.exe` with PyInstaller;
4. builds the installer with electron-builder;
5. verifies the installer exists and is larger than 30 MB, then writes a SHA-256 file;
6. uploads the installer + checksum as a workflow artifact;
7. publishes both to the GitHub Release for a tag.

A workflow that merely starts is not a successful build. Check the job log for the “Verify installer” step and confirm the release has both files.

The installer is not code-signed. Windows SmartScreen will warn; choose **More info → Run anyway**. Code signing requires a certificate you own; do not put one in the repository.

### Automatic updates

From 2.1.12 onwards a packaged Windows build updates itself. Eight seconds after the window appears, and every six hours after that, `electron-main.cjs` asks GitHub for the latest release through `electron-updater`. A newer installer is downloaded in the background and installed when Stratos quits; the next launch is the new version. Development runs and unpacked builds skip the check (`app.isPackaged`).

What makes this work:

- `electron-updater` is a **runtime** dependency (`dependencies`, not `devDependencies`), so it is packed into the asar.
- `electron-builder.config.cjs` sets a GitHub `publish` provider; that writes `app-update.yml` into `resources/` with the repository and channel.
- Every release must attach **`latest.yml`** (the manifest with the version and SHA-512) and the **`.blockmap`** for differential downloads, not just `Stratos-Setup.exe`. The workflow verifies `latest.yml` exists before uploading and publishes all of them; a build without the manifest fails instead of shipping an app that cannot update.
- The installer is still unsigned, so the **first** install of an updater-aware build shows the SmartScreen warning. Updates themselves are verified against the SHA-512 in `latest.yml` and install without the wizard.
- Never publish the same version twice: `electron-updater` compares the installed version with `latest.yml`, so a rebuilt 2.1.12 will not reach copies that already have 2.1.12. Bump the patch version for every release.

Limits worth stating: this only updates installs created by the NSIS installer on Windows. A build started with `npm start`, a portable/unpacked copy, or the browser/PWA version is not touched. The first build that contains the updater has to be installed manually — there is nothing in the older version that could fetch it.

### Bridge lifecycle in the desktop app

`electron-main.cjs` owns the bridge:

- single-instance lock prevents two copies of Stratos from starting two bridges;
- probes `http://127.0.0.1:8765/health` before spawning;
- adopts a bridge that is already healthy instead of starting a duplicate;
- refuses to fight another program that owns the port;
- prefers the bundled `stratos-bridge.exe`, then a bundled Python, then system Python;
- captures stdout/stderr into the app log and exposes the last 120 lines through **Settings → Diagnostics**;
- restarts an unexpectedly stopped bridge with exponential backoff (max 6), and stops retrying when the app is quitting;
- kills only the child process tree it started; an adopted external bridge is never killed;
- on quit, uses a synchronous `taskkill /T /F` on Windows so a PyInstaller child does not survive;
- exposes only four IPC operations to the renderer through a sandboxed preload: status, restart, stop and diagnostics.

If the port is changed with `STRATOS_HTTP_PORT`, the desktop UI does not know the new port; that override is for manual/standalone bridge runs. Keep the default 8765 for the desktop app.

### Bridge setup

- **X-Plane 11/12:** Settings → Data Output, enable rows 3 (speeds), 17 (heading) and 20 (position/altitude), send to UDP port 49003 on the PC running the bridge. Start a flight.
- **MSFS 2020/2024:** the optional SimConnect Python package (`pip install SimConnect`) is needed for the MSFS connector. Start a flight. If it is unavailable, the app reports “not installed (optional)” and MSFS telemetry is not claimed.
- The bridge HTTP server now binds to **127.0.0.1** by default. To use the legacy direct-on-LAN phone page, explicitly set `STRATOS_HOST=0.0.0.0`; the access token is then required on every remote request. The relay is the recommended phone path and never needs an inbound port.
- UDP telemetry listens on `0.0.0.0:49003` so a simulator on another machine can send data. Set `STRATOS_UDP_HOST` to restrict it.

Useful variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STRATOS_HTTP_PORT` | `8765` | Bridge HTTP port |
| `STRATOS_HOST` | `127.0.0.1` | HTTP bind address |
| `STRATOS_UDP_PORT` | `49003` | X-Plane data output port |
| `STRATOS_UDP_HOST` | `0.0.0.0` | UDP bind address |
| `STRATOS_DATA_DIR` | script folder | Logbook, token, replay data, caches |
| `STRATOS_BRIDGE_TOKEN` | generated | Fixed LAN access token (optional) |

## 4. Phone relay

`relay/server.mjs` has no npm dependencies.

```bash
PORT=8787 HOST=0.0.0.0 \
RELAY_DATA_DIR=/var/lib/stratos-relay \
ALLOWED_ORIGINS=https://your-site.example \
node relay/server.mjs
```

Put it behind HTTPS (Render, Fly.io, a VPS with Caddy, etc.). The bridge refuses to send its token to a non-HTTPS relay except loopback, so `http://` is only usable for local tests.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `RELAY_DATA_DIR` | `relay/data` | Persisted session file |
| `ALLOWED_ORIGINS` | `*` | Comma-separated browser origins allowed by CORS |
| `READ_TOKEN_DAYS` | `30` | Phone token lifetime |
| `STALE_SECONDS` | `15` | When a snapshot is shown as stale |
| `TRUST_PROXY` | off | Trust `X-Forwarded-For` (only behind a known proxy) |
| `RELAY_PERSIST` | on | Set `0` for memory-only |

Set `ALLOWED_ORIGINS` to your real PWA origin in production. `*` still requires a bearer token, but narrowing it limits abuse. The relay stores only SHA-256 hashes of tokens. Sessions are written with mode 0600 when persistence is enabled. Pairing codes expire after five minutes; claim and pair endpoints are rate-limited.

The relay only accepts data from the desktop. There is no route that sends a command, keypress or file to the PC.

## 5. API

- `GET /api/weather?icao=KJFK` → `{ metar, taf, decoded, fetchedAt, source }`. NOAA Aviation Weather Center, public domain. Cached five minutes.
- `GET /api/ourairports?q=heathrow&limit=25&country=GB` → `{ results, count, totalMatches, source, fetchedAt, stale }`. OurAirports CC0. Cached 24 hours; parser handles quoted CSV fields and falls back to a stale copy with a `Warning` header if the upstream is down.

Both reject invalid input with 400 and never echo secrets.

## 6. Tests and checks

```bash
npm ci
npm test                     # 21 data tests + 4 module/UI tests + 2 relay tests
npm run test:py              # 10 bridge lifecycle/landing tests
npm run test:integration     # real bridge + relay + SSE + pairing (about 10 s)
node scripts/benchmark.mjs   # data-path benchmark
```

Static JS syntax check used in development:

```bash
for f in app/js/*.js app/js/lib/*.js app/js/pilot/*.js; do node --check "$f" || exit 1; done
```

There is no browser automation in this environment (Chromium system libraries were unavailable and `sudo` is blocked), so layout, canvas rendering, Home Screen installation and iPhone signing were **not** executed here. See `TEST_REPORT.md`.

## 7. Data and migration

- Browser/desktop logbook: IndexedDB `stratos_logbook`, version 3. The upgrade only adds the `settings` store; it never deletes `flights` or `profile`. Old v2 data remains readable.
- Bridge logbook: `stratos_logbook.json`, written atomically through a temp file. In-progress flights are snapshotted to `stratos_inprogress.json` and recovered after a crash; recovered flights are marked incomplete and excluded from career totals, not deleted.
- Flight IDs are deduplicated on both sides. `mergeFlights` keeps a richer copy and never removes local records.
- Settings, routes, dashboard layout and backups live in the same database. “Export backup” produces JSON containing flights and settings.
- Uninstalling the Windows app does not delete the bridge's data directory (`deleteAppDataOnUninstall: false`).
- That directory lives at `%APPDATA%\stratos-desktop\bridge-data` on Windows: Electron derives the per-user folder from the package `name` field (`stratos-desktop`), not from electron-builder's `productName: 'Stratos'`, which only names the installer, Start Menu entry and shortcuts. So the folder is `stratos-desktop` even though the app is called Stratos. The bridge's pairing token is `bridge_token.txt` inside it.

## 8. Remaining limitations

- No real simulator, iPhone, or Windows machine was available here. Simulator compatibility is implemented from the documented UDP/SimConnect interfaces but is **not** verified against a live sim in this environment.
- Landing runway matching depends on the bridge's airport/runway data. It is labelled an estimate when the runway is inferred from position.
- NOTAMs are not implemented. No legitimate free NOTAM API is wired in, so the briefing says so instead of inventing them.
- Push notifications and QR pairing are not implemented. Pairing uses a short code.
- Replay is available only for flights recorded after track logging was enabled. Older flights without a track show an explicit explanation.
- The relay keeps sessions in memory by default; a restart invalidates pairings unless `RELAY_PERSIST` and a persistent disk are used.
- The public ADS-B providers and NOAA can rate-limit or block a network. The UI reports the failure; it does not substitute demo aircraft.
- The leaked `VERCEL_OIDC_TOKEN` from the old `env.download` file is removed from the working tree, but it remains in Git history. **Revoke that token in Vercel** and do not restore the file. Rewriting history is intentionally left to the repository owner.

## 9. Attribution

Map data © OpenStreetMap contributors (ODbL). Airport data from OurAirports (CC0). Weather from NOAA Aviation Weather Center (public domain). FAA charts are linked from the official site and are not redistributed. See `SOURCES_AND_LICENSING.md`.

Stratos is not for real-world navigation.
