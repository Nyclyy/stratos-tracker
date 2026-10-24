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

   **On the same Wi-Fi (no relay):** open Stratos on the phone and tap **Connect to Simulator**. The bridge answers multicast DNS for `stratos.local`, so the phone opens `http://stratos.local:8765/pair/connect`, receives its own HttpOnly secret and is redirected to the live dashboard — nothing to scan and nothing to type. Opening the same page again reconnects with the stored cookie. The PC lists each paired phone and can forget one or all; forgetting closes an already-open telemetry stream within about five seconds.

   **Fallback (multicast blocked, or an unusual network):** use **Pilot → Settings → Phone access → Show pairing code** and enter the six-digit code, or open the LAN address shown in Settings (`http://<PC-IP>:8765`). The QR code encodes the single-use token instead of the code. Either route issues the same per-phone cookie.

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

`.github/workflows/release.yml` is the only release pipeline. It runs by itself when `package.json` gains a version on `main` that has no published release yet, when a `v*` tag is pushed, or when started by hand (**Run workflow**, with a severity — `normal`, `important` or `critical` — and, for a critical release, the reason users will be shown). A run for a version that is already published never rebuilds it: a push stops quietly, and a manual run fails with a message to bump the version. A push to `main` that does not change the version does nothing. It:

1. decides from the version, the tag and any existing release whether to release; a draft left by an earlier failed run is replaced;
2. runs `npm ci`, the JavaScript/relay suites, the Python bridge tests and the bridge + relay integration test on Windows;
3. builds the Windows installer, the macOS DMG and ZIP for arm64 and x64, and the Linux AppImage in parallel. Each platform builds `stratos-bridge` with PyInstaller, so the installed app does not require Python, and checks that its installer and update feed exist;
4. merges the two macOS update feeds into one `latest-mac.yml`, so both architectures are offered updates; writes `Stratos-Setup.exe.sha256` and the download table; and generates the release notes and manifest from the tagged commits (see below);
5. creates the release as a **draft** with every asset, verifies the draft with `scripts/check-release.mjs --draft`, and only then publishes it and checks the live release. A failed build or check leaves no public release.

The last job is named **Publish release**; the update smoke test waits for it (see below). A workflow that merely starts is not a successful build. Check the job log for the “Check the build output” and “Check the draft against every platform” steps, then confirm the release has every asset. `npm run release:check` runs the same published-release check from a terminal (add `--deep` to download the installer and read its embedded version resource).


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

Do not hand-edit `app/releases.json` into an inconsistent state: `--check` enforces valid semantic versions, unique releases, a `latest` that really is the newest stable release, ISO dates and a reason on critical entries, and validates every curated entry. The release workflow regenerates the manifest at release time, so notes reflect what is actually committed. The GitHub Action needs only the default `GITHUB_TOKEN` with `contents: write`; no extra secrets are required for the manifest.

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

`.github/workflows/update-smoke.yml` proves the real update path with two published releases. It runs **by itself after every *Release* run whose *Publish release* job succeeded** (`workflow_run` on *Release*; runs that published nothing or failed do not start it), testing the newest stable release against the one before it. `workflow_dispatch` remains for checking a specific pair: set `from_version` and `to_version`, or leave them empty for the newest pair. It:

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
- The bridge HTTP server binds to **0.0.0.0** by default so a phone on the same trusted network can reach it. Every non-loopback request needs the bridge token or a phone pairing cookie; the PC is trusted by loopback. Set `STRATOS_HOST=127.0.0.1` to disable LAN access entirely (and use the relay for phones). Never forward port 8765 from a router.
- **Terminal procedures:** `GET /procedures.json?airport=KSEA[&kind=sid&id=BANGR9]` returns the published SID, STAR and approach legs for one airport, each fix resolved to a coordinate, each runway threshold supplied where the source has one. Two providers, in order: the PC's X-Plane 12 installation (`Custom Data/CIFP` first, then `Resources/default data/CIFP`; `STRATOS_XPLANE_DIR` points the bridge at an install it cannot find), then the dataset Stratos ships in `navdata/cifp` — the FAA's public-domain Coded Instrument Flight Procedures, one JSON file per United States airport, rebuilt with `python scripts/build-navdata.py`. The dataset is what gives MSFS users, and PCs without X-Plane, real SID/STAR geometry from the runway transition to the terminal fix; outside the United States only a simulator that has the procedure installed can supply it. `/health` reports `navdata` (simulator source and cycle) and `navdata.dataset` (cycle, effective date, airport count). A fix the source cannot place is counted as `skipped` and the transition is marked incomplete rather than guessed. Many procedures publish no runway-specific legs at all (a common `ALL` trunk plus en-route transitions); the page then draws those verified legs and does not join the runway to them, because the source states no such leg. The first request for a simulator airport reads its fix and navaid files once (about a second) and is then cached for the life of the bridge; the dataset answers immediately. A procedure the simulator's older cycle lacks is looked up in the dataset before the answer is `not-found`.
- **Observed traffic trails:** `POST /traffic/track` with `{"points":[[hex,lat,lon,alt,tMs],…]}` records the positions a page has seen (at most 2000 per request, batched by the page to one post every 15 s); `GET /traffic/trail?hex=<hex or callsign>` returns that aircraft's path as `[[lat,lon,alt,tMs],…]`, oldest first. The store keeps 45 minutes (`STRATOS_TRAFFIC_RETENTION`) and 360 samples per aircraft, drops `0,0` positions, repeated samples and anything older than the newest one, and writes to `traffic_trails.json` in the data folder at most every 8 s, so a trail survives a page reload and a bridge restart. Nothing is fetched from a historical source: a trail begins at the first observation.
- **Aircraft photos:** `GET /api/photo?reg=<registration>` proxies the Planespotters lookup for pages the bridge serves (the API refuses a browser User-Agent). A found photo is cached in memory for 24 h and a miss for 1 h, so a card that redraws at telemetry rate asks the service once; an unknown registration answers `{"photos":[]}`, an unreachable source a 502.
- **One-tap pairing:** the bridge answers multicast DNS on `224.0.0.251:5353` for `stratos.local` (best effort; if the port is held by the OS the bridge still serves and Settings says discovery is unavailable). `GET /pair/connect` enrolls a phone that arrives from a private address and redirects it to `/live.html`; `POST /pair/auto` does the same for the app. Both are rate limited per address and are disabled by `STRATOS_AUTO_PAIR=0`, which leaves the code/QR path. Enrollment still issues an authenticated per-phone cookie: telemetry is never unauthenticated.
- **X-Plane identity:** the bridge subscribes over UDP to `sim/aircraft/view/acf_tailnum`, `acf_ICAO` and `acf_descrip` one character at a time (RREF) so the registration and type appear without a plugin or hand-typed values. A value saved in Settings still wins. `STRATOS_XPLANE_HOST` points the requests at a simulator on another machine.
- On Windows the bridge binds the HTTP port exclusively, so a second copy exits with `Could not start the bridge on port 8765` instead of competing with the first. The desktop app also probes `/health` before spawning.
- UDP telemetry listens on `0.0.0.0:49003` so a simulator on another machine can send data. Set `STRATOS_UDP_HOST` to restrict it.

Useful variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STRATOS_HTTP_PORT` | `8765` | Bridge HTTP port |
| `STRATOS_HOST` | `0.0.0.0` | HTTP bind address; set `127.0.0.1` to disable LAN pairing |
| `STRATOS_AUTO_PAIR` | `1` | Set `0` to require the six-digit code for every new phone |
| `STRATOS_MDNS_HOST` | `stratos.local` | The name the bridge answers over multicast DNS |
| `STRATOS_XPLANE_HOST` | `127.0.0.1` | Where UDP dataref requests for aircraft identity are sent |
| `STRATOS_XPLANE_UDP_PORT` | `49000` | X-Plane's UDP dataref port |
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
| `TRAFFIC_RETENTION_SECONDS` | `2700` | How long a relayed traffic trail is kept |

Set `ALLOWED_ORIGINS` to your real PWA origin in production. `*` still requires a bearer token, but narrowing it limits abuse. The relay stores only SHA-256 hashes of tokens. Sessions are written with mode 0600 when persistence is enabled. Pairing codes expire after five minutes; claim and pair endpoints are rate-limited.

The relay only accepts data from the desktop. There is no route that sends a command, keypress or file to the PC.

A paired phone that is not on the PC's network still gets the desktop's traffic. The bridge posts the aircraft it has polled and the new samples of each recorded trail to `POST /api/traffic` every 15 s (desktop token, list capped at 60 aircraft, only samples the relay has not seen). The phone reads `GET /api/traffic` for the list and `GET /api/traffic?hex=KEY` for one aircraft's path (read token). Traffic lives in relay memory with the same 45-minute retention, per-aircraft cap (360) and duplicate/rewind rules as the bridge store, so a relay restart clears the trails but leaves sessions and pairing intact. There is no route by which a phone can write traffic.

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
npm run test:py              # bridge lifecycle, landing, checklist, discovery and identity tests
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
- SID/STAR geometry follows verified procedure legs, never an invented straight line: the bundled dataset is FAA CIFP data, so procedures outside the United States come only from a simulator that has them installed, and a leg whose fix the source cannot place is reported as skipped rather than drawn. Arcs, turn radii and holding patterns are not drawn, and the plan's own waypoint-to-waypoint lines are untouched — only the procedure's runway connection is added beneath them.
- Landing runway matching depends on the bridge's airport/runway data. It is labelled an estimate when the runway is inferred from position.
- NOTAMs are not implemented. No legitimate free NOTAM API is wired in, so the briefing says so instead of inventing them.
- A web page cannot scan the local network, and an HTTPS page cannot call an HTTP LAN bridge (mixed content). One-tap pairing therefore uses the one mechanism that works: the bridge answers multicast DNS for a fixed name, and the phone follows a **top-level navigation** to `http://stratos.local:8765/pair/connect`. Networks that block multicast, or client isolation on guest Wi-Fi, will not resolve the name; the code/QR fallback and the LAN address in Settings remain. The phone's stored bridge origin is tried first after that, so an unchanged DHCP lease reconnects instantly.
- Push notifications are not implemented. A new phone can connect with one tap, or with a QR code or short code when multicast is unavailable.
- Replay is available only for flights recorded after track logging was enabled. Older flights without a track show an explicit explanation.
- The relay keeps sessions in memory by default; a restart invalidates pairings unless `RELAY_PERSIST` and a persistent disk are used.
- The public ADS-B providers and NOAA can rate-limit or block a network. The UI reports the failure; it does not substitute demo aircraft.
- The leaked `VERCEL_OIDC_TOKEN` from the old `env.download` file is removed from the working tree, but it remains in Git history. **Revoke that token in Vercel** and do not restore the file. Rewriting history is intentionally left to the repository owner.

## 9. Attribution

Map data © OpenStreetMap contributors (ODbL). Airport data from OurAirports (CC0). Weather from NOAA Aviation Weather Center (public domain). The bundled SID/STAR dataset is the FAA's Coded Instrument Flight Procedures (public domain) with runway thresholds from OurAirports (CC0). FAA terminal procedures are fetched from the official site and shown in the in-app viewer; Stratos does not redistribute a chart library. See `SOURCES_AND_LICENSING.md`.

Stratos is not for real-world navigation.
