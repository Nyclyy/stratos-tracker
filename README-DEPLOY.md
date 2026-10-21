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
4. Open the installed app. For live simulator data, pair it.

   **On the same Wi-Fi (no relay):** on the PC open **Pilot → Settings → Phone access → Show pairing QR**, then scan the code with the iPhone camera. The QR opens `http://<PC-IP>:8765/pair?t=…` on the phone, which exchanges the single-use code for its own HttpOnly cookie and redirects to Checklists. The PC lists each paired phone and can forget one or all; forgetting closes an already-open telemetry stream within about five seconds.

   **From outside the LAN:** enter the relay URL on the PC and generate a code, then use **Live → Relay URL + pairing code → Connect** on the phone. The relay is the only path that works over HTTPS from another network.

5. The phone stores only its own credential. **Disconnect phone / Forget this PC** removes it; **Disconnect relay** removes the whole relay session. Phones on the LAN do not use the relay at all. **Forget all paired phones** on the PC also rotates the shared bridge token, so a browser that unlocked the bridge by hand with the old token must enter the new one from `bridge_token.txt`.

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

`.github/workflows/release-windows.yml` runs on a tag (`v*`), or manually with a severity (`normal`, `important`, `critical`) and, for a critical release, the reason users will be shown. It:

1. installs Node 22 and Python 3.12;
2. runs `npm ci`, the JavaScript/relay suites, the Python bridge tests and the bridge + relay integration test;
3. builds `stratos-bridge.exe` with PyInstaller;
4. builds the installer with electron-builder;
5. verifies the installer exists, is larger than 30 MB and has a `latest.yml`, then writes `Stratos-Setup.exe.sha256`;
6. generates the release notes and the update manifest from the tagged commits (see below), with the installer URL, size and checksum recorded;
7. uploads the installer, checksum, `latest.yml`, blockmaps, `releases.json` and `release-notes.md` as a workflow artifact;
8. publishes those files to the GitHub Release, using the categorised markdown as the release body;
9. a separate `verify-release` job reads the published release back and fails if the manifest, checksum or installer disagree.

A workflow that merely starts is not a successful build. Check the job log for the “Verify installer” and “Generate release notes” steps, then confirm the release has all six assets. `npm run release:check` runs the same published-release check from a terminal (add `--deep` to download the installer and read its embedded version resource).

The installer is not code-signed. Windows SmartScreen will warn on the first install; choose **More info → Run anyway**. To sign it, set `CSC_LINK` (a base64 certificate or path to a `.pfx`) and `CSC_KEY_PASSWORD` as repository secrets; electron-builder picks them up without any config change, and the private key must never be committed. Without them, updates are still verified against the SHA-512 in `latest.yml` and the SHA-256 published beside the installer.

### Release notes and the update manifest

The app must never invent a version or a feature, so both come from one generated file: **`app/releases.json`**. It is the only place a latest version, release date, severity, minimum supported version, download URL and changelog live. The browser fetches it at `releases.json` on the app's own origin and falls back to the `releases.json` asset on the newest GitHub release; the desktop app uses the same notes while `electron-updater` handles the download.

`scripts/release-notes.mjs` builds it from real history:

```bash
node scripts/release-notes.mjs --version 2.1.15 --from v2.1.14 \
  --severity important --windows https://github.com/…/Stratos-Setup.exe \
  --sha256 <hash> --size <bytes> --markdown dist/release-notes.md
node scripts/release-notes.mjs --check        # validate the checked-in manifest
```

Commit subjects are classified by their conventional-commit type (`feat`, `fix`, `perf`, `style`/`ui`, `refactor`, `docs`, `chore`, …) and, when there is no type, by conservative keywords. Merge commits and version bumps are skipped. Anything doubtful goes under **Other changes** rather than being guessed into a feature. The categories are New features, Improvements, Bug fixes, Performance, Interface, Compatibility and important notices, and Other changes. History is retained (30 releases), so the Update centre can show older notes.

A commit subject is not a changelog. When a version needs notes written for a person — a squashed release, a change whose subject says nothing, a feature that took several commits — add it to **`release-notes/curated.json`**:

```json
{
  "2.1.15": {
    "summary": "One line for the dialog.",
    "changelog": { "features": ["What a pilot can now do."], "fixes": ["What stopped being wrong."] }
  }
}
```

The generator prefers a curated entry for the version it is building and falls back to the commits for every other version; `--no-curated` ignores the file. Curated entries are validated as strictly as generated ones — unknown categories, empty lines, a missing changelog or a key that is not a version fail `--check` and the release build, so a typo cannot quietly delete a line from the update dialog. A curated entry may be added for a version that is already released; the next build's manifest then carries the better notes for it.

Severity is a published fact, not a nag screen:

- `normal` — optional; **Remind me later** is offered and a dismissal is remembered for that build;
- `important` — still optional, but a dismissal from an earlier, less serious copy of the same release no longer suppresses the prompt;
- `critical` — requires `--reason`; the dialog explains why. It is only treated as *required* when a real `minimumSupported` version excludes this install or the reason is supplied. There is no hidden kill switch.

Do not hand-edit `app/releases.json` into an inconsistent state: `--check` enforces valid semantic versions, unique releases, a `latest` that really is the newest stable release, ISO dates and a reason on critical entries, and validates every curated entry. The workflow regenerates the manifest at tag time, so notes reflect what is actually committed. The GitHub Action needs only the default `GITHUB_TOKEN` with `contents: write`; no extra secrets are required for the manifest.

### Automatic updates

A packaged Windows build checks the newest stable release eight seconds after the window appears and every six hours after that (`electron-main.cjs`). Development runs and unpacked builds never check (`app.isPackaged`). A newer installer downloads in the background; `electron-updater` verifies it against the SHA-512 in `latest.yml` before emitting `update-downloaded`, and Stratos installs it when it quits.

**Settings → Updates** is the Update centre. It shows the installed version, the latest published version and date, the last successful check, a Check for updates button, live download progress, errors and a retry, every published release with its notes, and a **Restart to update** action once a download is verified. The preload exposes `getUpdateStatus`, `checkForUpdates`, `installUpdate` and `onUpdateProgress`; the main process answers on `updater:status`, `updater:check`, `updater:install` and pushes `updater:event`. The first time a release is offered, the same notes appear in a modal with **Update now**, **Remind me later** and **View full changelog**. Dismissing writes the release version, its severity and a fingerprint of its notes, so the same build is not raised again — but a changed release or a higher severity is.

The website checks the same manifest shortly after load, when the tab returns to the foreground (at most hourly) and every six hours while it stays open; a hidden tab is never polled. The first location tried is `releases.json` on the app's own origin (which is what the web deployment actually serves), with the newest GitHub release asset as the fallback for the packaged app, where a `file://` page cannot read a relative manifest. In a browser or installed iPhone PWA the manifest provides the version and notes, while the service worker provides the update itself. The service worker no longer calls `skipWaiting()` on an update: a new build waits, the page shows “A new Stratos build is ready” (or the modal), and accepting it posts `STRATOS_SKIP_WAITING`, claims the page and reloads once. A first install still takes over immediately. Nothing reloads while a flight is being tracked unless the pilot accepts, and IndexedDB (logbook, routes, settings) is never touched. `app/sw.js` stamps a distinct cache name per release so the browser can tell an update from a first install, and `releases.json` is explicitly never cached.

What makes this work:

- `electron-updater` is a **runtime** dependency (`dependencies`, not `devDependencies`), so it is packed into the asar.
- `electron-builder.config.cjs` sets a GitHub `publish` provider; that writes `app-update.yml` into `resources/` with the repository and channel.
- Every release must attach **`latest.yml`** (the version and SHA-512), the **`.blockmap`**, **`releases.json`** and the notes. The workflow verifies `latest.yml` and fails rather than shipping an app that cannot update.
- The version comes from `package.json` and is stamped by `scripts/stamp-version.py` into `app/js/lib/version.js` (what Settings and the About card show), `bridge_logbook_addon.py` and the service-worker cache name. `npm version` and the stamp must agree; `tests/modules.test.mjs` fails if they drift.
- The installer is unsigned, so the **first** install of an updater-aware build shows the SmartScreen warning. Updates themselves are verified against the SHA-512 in `latest.yml`.
- Never publish the same version twice: `electron-updater` compares the installed version with `latest.yml`, and the manifest rejects duplicate releases. Bump the patch version for every release; tags are immutable.

Limits worth stating: this only updates installs created by the NSIS installer on Windows. A build started with `npm start`, a portable/unpacked copy, or the browser/PWA version is not touched by `electron-updater`; the browser is updated by the service worker. The first build that contains the updater has to be installed manually. The app never claims an installer ran: the Update centre shows the installed version after restart, and that is the confirmation.

### Verifying an update end to end

`.github/workflows/update-smoke.yml` proves the real update path with two published releases. It runs **by itself after every successful Windows release build** (`workflow_run` on *Build Windows installer*, skipping failed builds and non-tag runs), testing the newest stable release against the one before it. `workflow_dispatch` remains for checking a specific pair: set `from_version` and `to_version`, or leave them empty for the newest pair. It:

1. downloads both installers from the published GitHub releases;
2. installs the older one silently (`/S`) and asserts that the uninstall registry and the exe's product version report that build;
3. launches the installed app with `--update-smoke` — headless, with no window and no simulator bridge;
4. lets `electron-updater` read the packaged `app-update.yml`, find the newer release, download it and verify it against `latest.yml`; the app writes a JSON receipt and calls `quitAndInstall(true, false)` so the NSIS installer runs silently;
5. runs `scripts/check-update-smoke.mjs`, which fails unless the receipt names the exact from/to versions, reports `verified: true` and carries no error;
6. polls the uninstall registry and the exe product version until they report the new release, then uploads the receipt as an artifact.

The smoke flag exists in every packaged build but does nothing unless `app.isPackaged` is true and the flag is present; it starts no bridge and no window. It proves the download was verified and the installed version changed. It does not exercise the GUI — the Settings/Update centre confirmation is covered by the browser and DOM tests.

Both releases must understand the smoke flag, which first ships in 2.1.14 — so the first usable pair is 2.1.14 → 2.1.15, which is exactly what the automatic run tests on the 2.1.15 release. The workflow refuses an older `from_version` instead of hanging on a build that ignores the flag. The automatic run starts only after the release has been published, so it can never block the upload; a red smoke run after a green release means the artifacts are live but their update path is unproven, and that is worth treating as a blocker on announcing the version.

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
- The bridge HTTP server binds to **0.0.0.0** by default so the QR code can be opened by a phone on the same trusted network. Every non-loopback request needs the bridge token or a phone pairing cookie; the PC is trusted by loopback. Set `STRATOS_HOST=127.0.0.1` to disable LAN access entirely (and use the relay for phones). Never forward port 8765 from a router.
- On Windows the bridge binds the HTTP port exclusively, so a second copy exits with `Could not start the bridge on port 8765` instead of competing with the first. The desktop app also probes `/health` before spawning.
- UDP telemetry listens on `0.0.0.0:49003` so a simulator on another machine can send data. Set `STRATOS_UDP_HOST` to restrict it.

Useful variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STRATOS_HTTP_PORT` | `8765` | Bridge HTTP port |
| `STRATOS_HOST` | `0.0.0.0` | HTTP bind address; set `127.0.0.1` to disable LAN/QR pairing |
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
- `GET /api/charts?icao=KJFK` → `{ source, cycle, effective, expires, checkedAt, charts[] }` from the FAA d-TPP metafile. The metafile (about 16 MB) is fetched once per warm instance, reused for six hours and never shipped with the site. An airport outside the FAA publication returns 404 with an explicit coverage message.
- `GET /api/chart?cycle=2610&file=00610AD.PDF` → the FAA PDF (`application/pdf`, immutable cache). Only a four-digit cycle and a `[A-Z0-9]{1,12}.PDF` name are accepted; the host is fixed. This is a pass-through of a public-domain document, not a chart library.

All of them reject invalid input with 400 and never echo secrets.

### Premium entitlement (charts)

ILS and LOC approach charts — including ILS OR LOC, LOC/DME and localizer-only procedures — are free for everyone. Every other category needs a verified Premium entitlement. The same rule is applied by `accessLevel()` / `canOpenChart()` in `app/js/lib/charts.js`, so the catalogue label and the viewer gate cannot drift apart. There is **no payment implementation** in this repository, and the app does not treat a browser flag as a purchase. The Electron main process decides:

- Running from source (`npm start`, or `electron .`) reports a labelled development entitlement automatically, so a developer can test the gated surfaces without configuring anything.
- A packaged build needs one of the variables below.

| Variable | Purpose |
| --- | --- |
| `STRATOS_ENTITLEMENT_URL` | HTTPS endpoint that receives `{ token, product }` and answers `{ active, plan, expiresAt }`. Without it, no purchase can be verified. |
| `STRATOS_DEV_PREMIUM=1` | Development override for a packaged build. The UI labels it “Development entitlement — this build has no payment step”, so it can never be mistaken for a purchase. |

The token is read from `entitlement.json` in the app's user-data folder (beside `stratos.log`), so it never enters the page, the DOM or browser storage. Hosted pages have no trusted channel: they can open the free ILS/LOC approaches and nothing else until a licence service exists for them.

Chart providers are declared in `app/js/lib/chartproviders.js`: regions, categories, format, update method, attribution and licence position. `faa-dtpp` is the only `integrated` provider; Canada, Europe and Australia are `link-only` until a redistribution licence exists. Add a licensed provider by adding its descriptor and fetch adapter, then flipping its status — the catalogue and viewer do not need to change.

The bundled pdf.js 6 build calls JavaScript helpers newer than Chromium 138 (Electron 37): typed-array `toHex`/`fromHex`/`toBase64`/`fromBase64` and the Map upsert helpers. `app/vendor/pdfjs/compat.mjs` installs them on the page, and `worker-compat.mjs` is the worker entry that does the same in pdf.js's module worker. Keep both imports when upgrading pdf.js; without them every document fails with “toHex is not a function”.

## 6. Tests and checks

```bash
npm ci
npm test                     # data, chart, module, DOM/UI, Discovery, relay and route-weather suites
npm run test:py              # 31 bridge lifecycle, landing, checklist and pairing tests
npm run test:integration     # real bridge + relay + SSE + pairing (about 10 s)
node scripts/benchmark.mjs   # data-path benchmark
```

Static JS syntax check used in development:

```bash
for f in app/js/*.js app/js/lib/*.js app/js/pilot/*.js; do node --check "$f" || exit 1; done
```

Browser automation was available for the charts check on Windows (Playwright + Chromium); the earlier layout/rail checks used a private Chromium prefix, and Home Screen installation and iPhone signing were **not** executed. See `TEST_REPORT.md` for what each run covered.

## 7. Data and migration

- Browser/desktop logbook: IndexedDB `stratos_logbook`, version 3. The upgrade only adds the `settings` store; it never deletes `flights` or `profile`. Old v2 data remains readable.
- Bridge logbook: `stratos_logbook.json`, written atomically through a temp file. In-progress flights are snapshotted to `stratos_inprogress.json` and recovered after a crash; recovered flights are marked incomplete and excluded from career totals, not deleted.
- Flight IDs are deduplicated on both sides. `mergeFlights` keeps a richer copy and never removes local records.
- Settings, routes, dashboard layout and backups live in the same database. “Export backup” produces JSON containing flights and settings.
- Phone pairings are stored in `phone_pairs.json` in the bridge data directory as SHA-256 hashes with a label and timestamp; the secrets exist only in each phone's HttpOnly cookie. Deleting that file un-pairs every phone. The bridge token is `bridge_token.txt` in the same folder.
- Uninstalling the Windows app does not delete the bridge's data directory (`deleteAppDataOnUninstall: false`).
- That directory lives at `%APPDATA%\stratos-desktop\bridge-data` on Windows: Electron derives the per-user folder from the package `name` field (`stratos-desktop`), not from electron-builder's `productName: 'Stratos'`, which only names the installer, Start Menu entry and shortcuts. So the folder is `stratos-desktop` even though the app is called Stratos. The bridge's pairing token is `bridge_token.txt` inside it.

## 8. Remaining limitations

- No real simulator, iPhone, or Windows machine was available here. Simulator compatibility is implemented from the documented UDP/SimConnect interfaces but is **not** verified against a live sim in this environment.
- Landing runway matching depends on the bridge's airport/runway data. It is labelled an estimate when the runway is inferred from position.
- NOTAMs are not implemented. No legitimate free NOTAM API is wired in, so the briefing says so instead of inventing them.
- Automatic local-network discovery (mDNS/DNS-SD) is not used: browsers do not expose it to a web page, and iOS restricts local-network probing. Pairing therefore stores the reachable bridge origin on the phone and reconnects to it; if the PC's DHCP address changes, scan a new QR code. A small-screen phone cannot be paired through an HTTPS page to an HTTP LAN bridge (mixed content), so open the QR's HTTP address directly.
- Push notifications are not implemented. Pairing uses a QR code or a short code.
- Replay is available only for flights recorded after track logging was enabled. Older flights without a track show an explicit explanation.
- The relay keeps sessions in memory by default; a restart invalidates pairings unless `RELAY_PERSIST` and a persistent disk are used.
- The public ADS-B providers and NOAA can rate-limit or block a network. The UI reports the failure; it does not substitute demo aircraft.
- The leaked `VERCEL_OIDC_TOKEN` from the old `env.download` file is removed from the working tree, but it remains in Git history. **Revoke that token in Vercel** and do not restore the file. Rewriting history is intentionally left to the repository owner.

## 9. Attribution

Map data © OpenStreetMap contributors (ODbL). Airport data from OurAirports (CC0). Weather from NOAA Aviation Weather Center (public domain). FAA terminal procedures are fetched from the official site and shown in the in-app viewer; Stratos does not redistribute a chart library. See `SOURCES_AND_LICENSING.md`.

Stratos is not for real-world navigation.
