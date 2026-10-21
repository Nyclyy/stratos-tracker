# Stratos test report

Date: 2026-10-19. Environment: Linux x64 cloud VM, Node v24.21.0, Python 3 (FreeStyle build), Chromium 156 via Playwright (headless, software rasterisation, private library prefix). No simulator, iPhone, Windows host or Vercel account was available.

## 2026-10-20 — route planner, checklists and LAN phone pairing (Windows 11 x64)

Environment: Windows 11 10.0.26300, Node v26.8.1, Python 3.15.0, Stratos bridge 2.1.14 with a temporary data directory, and Chromium previews at 1440x900 and 390x844. MSFS was installed on the host but no flight was running, so no live simulator telemetry was used. The current totals are **166 JavaScript tests** (`npm test`, including the route planner, checklist, update and update-interface suites) and **31 Python tests** (`npm run test:py`, including pairing persistence and revocation). Both pass. The Windows installer was rebuilt (90 MB).

| Check | Method | Result |
| --- | --- | --- |
| Leg geodesic values: KSFO→KLAX distance, initial true course, magnetic course fallback, ETE at planned and live groundspeed, zero-length legs | `node --test tests/routeplan.test.mjs` | 11/11 pass; distance and bearing equal the shared `geo` functions, magnetic course is null without variation and wraps correctly with it |
| Live leg inspector: select the KSFO→KLAX leg in the running app | Chromium, 1440x900 | pass — highlighted leg, “Leg 1 of 1”, 293.3 nm, 138°T, “Not available — no magnetic variation was supplied”, 0h 39m at 450 kt, both endpoint coordinates; the course/track note is now a collapsed disclosure |
| Route editing: add KLAS, select the waypoint, move it up, delete it, undo | DOM-driven clicks in Chromium | pass — 3 waypoints then two legs (498.6 nm total, 205.3 nm at 050°T), waypoint inspector showed KLAS, 36.0834°N 115.1518°W, estimated 2,181 ft (explicitly not a restriction), the adjacent KLAX leg, Move up/Move down/Direct/Delete; delete reduced to two points and Undo restored three |
| Route auto-name follows the endpoints | Chromium + source change | pass — adding/removing/reordering a waypoint updates the default “KSFO → KLAX” name; a name typed by the pilot (or a SimBrief name) is preserved |
| Magnetic course with supplied variation | `node --test tests/routeplan.test.mjs` | pass — mean variation of both endpoints is applied, true course is unchanged, implausible values (>180°) are rejected |
| Route progress / remaining distance / off-route honesty | `node --test tests/routeplan.test.mjs` | pass — on-leg midpoint, far-away position flagged rather than snapped, invalid input returns null |
| Drag data path | `node --test tests/routeplan.test.mjs` | pass — moving one waypoint keeps identifiers and the other points, does not mutate the original, invalid positions/indexes are ignored. The pointer gesture itself was not simulated in the browser. |
| Route planner on a phone | Chromium 390x844 | pass — map fills the workspace, header reports KSFO→KLAX, 293 nm / 1 leg / 0h 47m, plan sidebar opens from the toggle, no horizontal page scroll |
| A340-600 checklist profile | Chromium, profile selector | pass — 128 items, sections for pre-flight/ETOPS, four-engine start, long-haul management, descent, approach, landing, shutdown and emergency; COMMUNITY provenance shown; the simulator not reporting an aircraft still allows manual selection |
| Checklist engine: phases, progress, state merge, reset, custom sanitisation | `node --test tests/checklists.test.mjs` | pass |
| Checklist phone layout | Chromium 390x844 after the compact-header change | pass — title, profile selector, progress, phase bar and section tabs fit without horizontal page scroll; tabs are a horizontally scrollable row with 44 px targets; items remain readable |
| Checklist sync desktop → phone → desktop | Real bridge, cookie-authenticated phone client | pass — desktop revision 7 read by the phone, phone write revision 8 visible on the PC, an older revision 2 rejected in favour of 8 |
| QR pairing | Real bridge, phone origin `http://10.0.0.25:8765` | pass — single-use token redirects to `pilot.html#checklists`, the phone receives only `stratos_phone` (HttpOnly, 43 characters), `/health` is 200 with the cookie and 401 without it |
| Pairing survives a bridge restart | stop/start the real bridge, reuse the phone cookie | pass — `/health` stays 200 after restart; pairings are stored as SHA-256 hashes in `phone_pairs.json` and the secret is never on disk |
| Pairing revocation | PC-side `POST /pair/forget-client`, phone-side `POST /pair/self-revoke`, `POST /pair/revoke` | pass — forgetting one phone returns 401 for that phone and leaves the other at 200; self-revoke removes only itself; forget-all clears every phone and rotates the shared bridge token while loopback stays 200 |
| Open telemetry stream after revocation | real SSE stream, then forget the device | pass — the stream ends after 5.04 s instead of continuing to send data |
| Phone detects revocation without a reload | revoke while the checklist page is open, wait 9 s | pass — connection chip changes from Connected to “Pairing required”; clicking it opens `/pair` |
| Pairing page on a phone | Chromium 390x844 | pass after adding `box-sizing:border-box`; “Pair this phone”, code field and button fit with no horizontal overflow, and a revoked phone sees “This phone is no longer paired. Show a new code in Stratos on the PC.” |
| Second bridge instance | start a second `python3 stratos_bridge.py` on the same port | pass — exits 2 with “Could not start the bridge on port 8765”; Windows no longer permits two listeners to share the port |
| All JavaScript, Python and integration suites | `npm test`, `npm run test:py`, `PYTHON=python3 npm run test:integration` | 142/142, 31/31 and 2/2 pass; the integration run started the real bridge and relay on random ports, paired them and delivered a snapshot to a phone token |
| Windows installer | `npm run dist:win` | pass — `dist/Stratos-Setup.exe`, 89.9 MB, blockmap and `latest.yml`; `app.asar` contains `app/js/pilot/checklists.js`, `app/js/data/checklists.js`, `app/js/lib/checklists.js` and `app/vendor/qrcode.js` |

Not executed in this session: a live X-Plane 12 or MSFS flight (no telemetry source), a physical iPhone/Safari local-network prompt and Home Screen install, a DHCP address change (the saved origin would need a new QR scan), a real pointer-drag on the canvas, the packaged Electron window (the installer was built and inspected but not launched), and the relay on a public HTTPS host. These are reported as limitations, not passes.

## Passed

*Historical snapshot (2026-10-19).* The `npm test` total then was 108 across the data-path, chart, module-graph, DOM/UI, Route Discovery, relay, route-weather and shared-map (`tests/minimap.test.mjs`) and winds-aloft (`tests/windsaloft.test.mjs`) suites; 117 passed on Windows with the additions made later that day. The current totals are in the 2026-10-20 section below. The winds endpoint was also exercised once against live NOAA data: 200 with `text/plain`, 400 for a bad forecast, 405 for POST, including the new Free/Premium chart rules and provider registry. `npm run test:py` passes 16/16 (added representative 100/200/500 fpm landing-rate classification for jet and piston classes) and `npm run test:integration` passes 2/2. The matching JS check in `tests/lib.test.mjs` uses the same thresholds, so the bridge and the web app agree on touchdown ratings.

## Charts and vertical profile (2026-10-19, Windows 11 x64)

Run on the development PC with Node 26, Chromium via Playwright, and the real Python bridge holding FAA d-TPP cycle 2610.

| Check | Command / method | Result |
| --- | --- | --- |
| Chart catalogue rules: 28-day cycle codes and windows, metafile header, airport lookup, every published category (APD, DP, STR, IAP, MIN, HOT), runway and approach extraction, amendment dates, expiry states, search | `node --test tests/charts.test.mjs` | pass (17/17 in the file) |
| Free/Premium rules: ILS, ILS OR LOC, LOC, LOC/DME and LOCALIZER are free; RNAV, VOR, NDB, SID, STAR and diagrams are Premium; `canOpenChart()` opens a free chart with no licence and refuses a Premium chart without one | `node --test tests/charts.test.mjs` | pass |
| Provider registry: only `faa-dtpp` is integrated; CYYZ→NAV CANADA, EGLL→NATS AIS, EDDF→DFS and YSSY→Airservices Australia are declared link-only with regions, categories, format, update method, attribution and licence; an unlisted airport invents no source; the summary never claims worldwide coverage | `node --test tests/charts.test.mjs` | pass |
| Premium entitlement: trusted desktop answer, a `premium:true` answer with `verified:false` refused, no desktop channel, browser storage ignored | `node --test tests/charts.test.mjs` | pass |
| Charts page DOM: every row carries a Free/Premium label; a free pilot sees 2 free and 6 locked rows with ILS and LOC, opens the LOC chart without a dialog, and gets the upgrade dialog for a diagram; a verified Premium pilot sees no locks and opens the first chart in all six categories (diagram, SID, STAR, approach, minimums, hot spot) without a prompt; the airport header shows name, country and category counts; the selected airport/chart is restored on a second mount | `node --test tests/charts.test.mjs` | pass |
| Official sources for Canada, Europe and Australia: CYYZ lists only NAV CANADA; EGLL lists NATS AIS, EUROCONTROL EAD Basic and the AIS index; YSSY lists Airservices Australia; an unlisted European state falls back to EUROCONTROL; no source is invented outside those regions; the module links to publishers and fetches no chart document | `node --test tests/charts.test.mjs` | pass |
| Publisher licensing review (2026-10-19): NAV CANADA licenses CAP and its IFR charts commercially; DFS, LVNL, Avinor, Austro Control and PANSA require written permission to reproduce their AIS charts; for the other European states reviewed no third-party reuse grant was found; EAD Basic is a consultation tool, not an app feed; no open-licensed source of current European or Canadian instrument approach charts was found | publisher pages, linked in `SOURCES_AND_LICENSING.md` | no mirroring added |
| Outside-FAA page in a real browser: CYYZ shows the NAV CANADA link and “Open PDF…”; EGLL shows NATS AIS, EAD Basic and the AIS index with each publisher's note, and states that Stratos does not license or mirror them | Chromium, DOM text and screenshot | pass |
| Local PDF: a 264 KB FAA chart downloaded to disk and opened with **Open PDF…** paints a 646 px canvas, the footer reads “Local file · opened from this device · not cached or uploaded”, the status warns it is not from a verified source, and there is no official-document link or upgrade panel | Chromium 130, real PDF, file input driven with a `File` | pass |
| Free charts in a real browser (no licence at all), KMIA: 50 rows, 50 Free/Premium labels, 8 free and 42 locked, no unprompted upgrade panel; `LOC RWY 08L` opens a 690 px canvas with no dialog; `ILS OR LOC RWY 08R` opens too; `AIRPORT DIAGRAM` shows the compact dialog, downloads nothing, and **Back to charts** closes it to the empty state | Playwright 1.64 + Chromium, screenshots inspected | pass |
| Premium charts in a real browser, KJFK: 31 rows, 31 labels, 0 locks; six category groups; airport header reads John F. Kennedy International Airport / United States / 31 documents / 8 free / 23 Premium; the diagram paints at fit width (690 px page in a 710 px stage), zoom 178% → 278%, dragging moves the transform, Reset view and Fit width return to 690 px, and previous/next chart switches AIRPORT DIAGRAM → DEEZZ SIX (RNAV) and back | Playwright 1.64 + Chromium, screenshots inspected | pass |
| Publisher links in a real browser: CYYZ renders one NAV CANADA source and zero chart rows; EGLL renders NATS AIS, EAD Basic and the AIS index with zero rows; neither requests a chart document | Playwright 1.64 + Chromium | pass |
| Mobile 390x844: the catalogue and viewer stack with no horizontal overflow (`scrollWidth === innerWidth`), and a LOC chart opens in the viewer without a dialog | Playwright 1.64 + Chromium, screenshot | pass |
| The bundled viewer on the shipped Chromium: `ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/Stratos.exe` reports Chromium 138.0.7204.251 / V8 13.8 with `toHex`, `toBase64`, `fromBase64`, `getOrInsert` and `getOrInsertComputed` all undefined, and pdf.js 6.4.299 calls all of them — every document failed with “a.toHex is not a function”. `app/vendor/pdfjs/compat.mjs` plus the `worker-compat.mjs` worker entry now supply them, and the same chart opens in Chromium 130 | packaged runtime probe + Chromium 130 | pass |
| ChartFox removal: no `chartfox` or hard-coded FAA filenames remain in the Flight Deck, airports page links to the workspace, nav and section registry include Charts | `node --test tests/charts.test.mjs` | pass |
| Real catalogue through the bridge: `/charts?icao=KJFK` returns 31 documents in six categories, cycle 2610, window 2026-10-01 09:01Z to 2026-10-29 09:01Z; `EGLL` returns an explicit 404 coverage message | `curl http://127.0.0.1:8765/charts?icao=...` | pass |
| Real document through the bridge: `/chart?cycle=2610&file=00610AD.PDF` returns 301,837 bytes, `application/pdf`, starting `%PDF-1.4` | `curl` + `xxd` | pass |
| Real catalogue and document through the hosted handlers: `/api/charts?icao=KJFK` returns 38 documents for cycle 2610 with the FAA window; `/api/chart` proxies the same 301,837-byte PDF; `file=../secret.PDF` is refused with 400 before any request | in-process handler invocation against the live FAA host | pass |
| Native viewer in a real browser, 1440x900: six category groups and 31 rows for KJFK, the airport diagram paints at fit width (690 px page in a 710 px stage), zoom 178% → 278% re-renders to 1078 px, dragging changes the transform, Fit width returns to 690 px, switching to `DEEZZ SIX (RNAV)` loads a different document with its cycle and effective date, KDEN catalogues 74 documents, the `ILS` filter narrows to 12, no page or console errors | Playwright 1.64 + Chromium, screenshots inspected | pass |
| Premium gate in a real browser: 31 rows with 31 Premium badges, clicking a row shows the upgrade panel, no canvas or document request is made, the panel reports the missing licence service | Playwright, DOM state measured | pass |
| Vertical profile: TOC/TOD equal the route estimate's values, waypoint altitudes come from that estimate, imported `.pln` altitudes are kept as constraints and round-trip through export | `node --test tests/charts.test.mjs` | pass |
| Chart timings | bridge catalogue 1.5-2 ms warm; hosted API 1.87 s cold / 3 ms warm; first chart 254 ms, cached reopen 166 ms; zoom re-render ~100-125 ms; 9.4 MB heap with one chart open | see `PERFORMANCE.md` |

## Route weather along the plan (2026-10-19, Windows 11 x64)

| Check | Command / method | Result |
| --- | --- | --- |
| METAR decoding, visibility tokens, flight category, wind components, station sampling and course assignment | `node --test tests/routeweather.test.mjs` | 8/8 pass |
| Live card with the running bridge, saved `KSFO → KLAX` route: two stations, VFR at both, KSFO 280° 11 kt gusting 20 on course 138° shown as a 16 kt tailwind and 12 kt right crosswind, and the note names the tailwind as surface wind rather than winds aloft | Chromium against `127.0.0.1:8765`, DOM text and screenshot | pass |
| No bridge: the card reports that weather for the route is not reachable instead of showing a placeholder observation, and the rest of the planner still renders | browser, bridge stopped | pass |
| Route change and teardown: the in-flight request is aborted and the 5-minute cache is keyed by station, so reopening the same route makes no new request | unit test + source review | pass |
| Six columns fit the planner's left card at 931 px: `scrollWidth` equals the wrap width, the course/wind column is fully visible, wind stays on one line and the station name clamps | Chromium, measured widths and screenshot | pass |

## Map tiles (2026-10-19)

| Check | Method | Result |
| --- | --- | --- |
| The previous tile host | `curl` a z6 CARTO tile | 200 `image/png`, 2049 bytes: an “API KEY REQUIRED” placeholder, so the Light and Dark styles, replay and route preview painted a watermark instead of a map |
| Replacement: Esri World Light/Dark Gray canvas | `curl` plus Chromium | 200 real JPEG tiles; the Light style, the Dark style and the route-preview minimap render the map, and the in-map credit reads “© Esri, HERE, Garmin · © OpenStreetMap contributors” |
| No key, no account, no sign-up | direct tile request from the app | pass |
| Regression guard | `node --test tests/ui.test.mjs` | fails if `basemaps.cartocdn.com` or the old CARTO credit returns to the tracker, the minimap or Discover |

## Other suites

| Check | Command | Result |
| --- | --- | --- |
| Pure modules: geo, landing, career, replay, planner, telemetry | `npm test` | 23/23 pass |
| Module graph: every local import exists and is exported | `npm test` | 2/2 pass |
| DOM: career dashboard/customizer, settings render, dashboard layout helpers, customizer arrow reordering, weather center watchlist, weather center station naming, shell status/rail, shared grid rule, Discover page, planner handoff | `npm test` | 12/12 pass |
| Flight Deck shell: grouped sidebar (three groups, eleven destinations, unchanged ids and links), icon-only rail that opens collapsed and remembers the toggle, the page's own state line under the wordmark instead of duplicate status pills, the search moved into the bar, Support Us / Go Premium, the UTC clock reading HHMMZ, and honest simulator/live reporting | `npm test` | pass |
| Flight Deck chrome: the flight card converts remaining time into a UTC arrival instead of a countdown, the corner badge names the simulator instead of printing the long feed sentence, the rail pages centre the search on the bar itself, the phone bar drops the wide controls, and the shell's single column cannot be widened by its content | `npm test` | pass |
| Narrow desktop bar: with the six pilot nav links, `pilot.html` keeps `scrollWidth` equal to the window at 1024, 900, 800 and 768 px (it overflowed by 153 px at 817 px before the change), Support Us and the resource profile drop out below 1024 px and the clock below 800 px, and the `Day mode` label stays on one 26 px line instead of being clipped; `index.html` restores all three controls at 1440 px with no overflow | Chromium 156, measured `scrollWidth`, computed styles and screenshots | pass |
| Automatic updates: `electron-updater` is a runtime dependency, the main process only checks when packaged and only installs on quit, the builder points at this GitHub repository, and the workflow requires `latest.yml`, ships it with the blockmap and the generated manifest, and fails instead of publishing an app that cannot update | `npm test` | pass |
| Update centre: the main process answers `updater:status`, `updater:check` and `updater:install`, validates the download against `latest.yml` before `update-downloaded`, pushes progress on `updater:event`, and the preload exposes `getUpdateStatus` / `checkForUpdates` / `installUpdate` / `onUpdateProgress`; Settings mounts the shared centre, which drives the desktop updater when present and the manifest/service worker otherwise | `npm test` | pass |
| Update semantics: numeric semantic-version comparison (including prereleases and build metadata), malformed and stale manifests rejected, HTTPS-only download entries, optional/important/critical classification, a required update only with a real minimum version or a critical reason, duplicate or out-of-order releases refused, a waiting service worker activated only on request, and the Windows smoke receipt accepted only with the exact from/to versions and `verified: true` | `node --test tests/updates.test.mjs` | 19/19 pass |
| Windows update smoke workflow: the YAML parses with both triggers (`workflow_dispatch`, optional versions resolved from the published release list), the install helper parses in PowerShell, and the receipt checker is unit-tested; the workflow itself was not executed here because it needs two published releases and a Windows runner | `js-yaml`, PowerShell parser, `node --test` | static checks pass; end-to-end run is a documented limitation |
| Update prompting: a newer release is announced, the installed version never is, a dismissal suppresses the same build, a severity increase or republished notes raise it again, a missing network with a cached answer reports the cached release (and says so), and a corrupt cache is ignored | `node --test tests/updates.test.mjs` | pass |
| Changelog generation: conventional types and conservative keywords classify real commits, merge and version-bump commits are skipped, duplicates removed, uncertain changes land under Other, history is sorted with a stable `latest`, and the checked-in manifest matches the app version | `node --test tests/updates.test.mjs` | pass |
| Update interface: the modal names both versions, the date, the real note groups and the desktop verification wording; Remind me later closes without applying; a genuinely required update shows its reason and drops postponement; the Update centre renders installed/latest/last-check, the saved-answer warning and every release with a working changelog viewer | `node --test tests/updateui.test.mjs` | 5/5 pass |
| Update interface in a browser: the Settings Update centre reads the real `app/releases.json` through the bridge (v2.1.14 installed and latest, 8 previous releases with dates and summaries, “live from the release manifest”), and the announcement dialog was rendered at 1440x900 and 390x844; the mobile version fits the viewport, scrolls, and pins its action row to the bottom | Chromium preview against `127.0.0.1:8765` | pass |
| PWA build update, real browser: serving a changed `app/sw.js` cache name installed a new worker and left it waiting; the page showed one “A new Stratos build is ready” notice (the first run produced two and the duplicate guard now keeps it to one), **Reload now** posted `STRATOS_SKIP_WAITING`, the new worker activated, the old cache was deleted, the page reloaded itself and the notice disappeared with no waiting worker left | Chromium preview, service-worker state and `caches.keys()` inspected | pass |
| Startup flow, real manifest: serving a temporary 2.1.15 entry made the app open the modal after its background check with the installed/available versions, the date, the categorised notes, **Remind me later** and **Update now**. Dismissing stored `{version: 2.1.15, severity: important, fingerprint, at}` and a reload did not prompt again. Raising that same release to `critical` with a reason re-opened the modal, showed “Why this update is required”, and removed the postpone action. Restoring the real 2.1.14 manifest and clearing the cache returned the centre to “v2.1.14 is current” with no modal | Chromium preview, real startup path | pass |
| Mobile overflow in Settings: the bridge data-directory value widened the page to 423 px in a 373 px viewport; `.kv` values now wrap inside their column and `scrollWidth === clientWidth` at 390x844 | Chromium, measured widths | pass |
| Windows checkout: the whole suite passes from a CRLF copy of the tree, matching the `windows-latest` runner; the world-layer test no longer splits the bundled payload on a hard-coded LF | in-process CRLF checkout | 70/70 pass |
| Rail and focus states: the toggle reports `aria-expanded` in both modes, the icon rail drops its native titles and shows one focus-aware tooltip whose text is the destination name, the tooltip closes on blur and never opens in the labelled sidebar, and the stylesheet keeps expanded rows horizontal and sentence case, hides labels when collapsed, suppresses the live-feed tab as a second current page, and draws the rail ring inside the pill | `npm test` | 3/3 pass |
| World layer data: 177 countries with valid closed rings and rounded coordinates, seven continent labels, ocean and sea labels, and every country label point inside its own outline | `npm test` | pass |
| World layer rendering: continents, oceans and country names appear at world zoom, the local country is named when closer, and 60 frames of panning reuse the cached sheet (6 rebuilds, one blit per frame) | `npm test` | pass |
| World layer legibility: seas are held back until the view is closer than the whole world, water names are set in italic serif, country names use the muted ink at world zoom and the bright ink when zoomed in, long official names are shortened, and land is painted with the night tone only in the night theme | `npm test` | pass |
| World layer start-up regression: the render loop begins on the first animation frame after the script is evaluated, and the bundled data is resolved through a hoisted binding, so a saved World style cannot throw a temporal-dead-zone error and freeze the map | `npm test` | pass |
| Dashboard flight overview: saved-route pair, planned-versus-flown labels, admitted missing cruise level, airborne progress against the planned track, designed empty state | `npm test` | 3/3 pass |
| Tracker descent rate: a measured descent replaces the default, an offline bridge keeps the default, an implausible rate is refused, a cached measurement is used, TOD lands just past NOSIT at 200 ft/nm, and the old 3 degree rate still reproduces the reported bug | `npm test` | 6/6 pass |
| Route Discovery: all 10 categories × 5 durations return three distinct cards; distance equals the sum of great-circle legs; airports exist in the database with real coordinates; estimated hours match the chosen aircraft; seeds repeat and vary; departure and region constraints honoured; easier/harder change the offering; island legs stay short and island-only; long haul keeps ≥500 nm; cards declare when they fall outside the requested window; region claims follow the great circle across the antimeridian; bush requests either use real short fields or declare the limitation | `node --test tests/discover.test.mjs` | 13/13 pass |
| Route Discovery DOM: ten moods render, three cards appear with a map panel, selecting a card updates the preview, Fly This Route writes the planner payload, alternatives return three cards | `npm test` | pass |
| Discovery engine timing (bundled 152 airports) | in-process measurement | 17–67 ms per generation; 100–180 ms with a synthetic 900-airport pool |
| Relay: pairing, ingest, state, revoke, origin and rate limits | `npm test` | 2/2 pass |
| Bridge lifecycle, dedupe, recovery, landing analysis, descent-gradient measurement and profile | `npm run test:py` | 15/15 pass |
| Real bridge + relay: health, static shell, SSE, pair → claim → snapshot → revoke | `npm run test:integration` | 2/2 pass (~10.5 s) |
| NOAA weather API, live call for KJFK | in-process handler invocation | 200, real METAR and TAF, source NOAA |
| OurAirports API, `q=heathrow` | in-process handler invocation | 200, EGLL first, correct typed fields |
| Flight Deck chrome in a real browser, 1440x810: search centre at x=720 (exactly half) and 520 px wide, card floating over a full-bleed map with `off 0211Z / eta 0257Z` and five live readouts, rail rows 43 px apart with the collapse chevron pinned to the rail bottom, corner badge "North Pacific Ocean / Simulator online"; day theme identical; no page errors | Playwright 1.64 + Chromium 156 headless, screenshots inspected | pass |
| Flight Deck chrome, 1100x720 and 390x844: at 1100 the search returns to the flex row (centre 340) with no overlap against the clock and profile controls; at 390 the bar keeps the brand, search and pilot, Support/clock/profile are hidden, the card spans the width and `scrollWidth` equals the 390 px viewport, so the page no longer scrolls sideways | Playwright, measured boxes | pass |
| Other pages keep their own bar: `pilot.html` retains the nav, status pills, Support, clock, theme and profile with no overlap between the nav and the search slot; `logbook.html` has no shell bar and no horizontal overflow at 1440 or 390 | Playwright, measured boxes | pass |
| Rail and keyboard focus in a real browser, 1440x900, 1280x720, 1280x560, 1100x720 and 390x844: expanded rail 244 px wide with 42 px icon-beside-label rows (icon x=21, label x=49), every label fits including "Data & Performance", one current destination only (the live feed's tab keeps a green icon and no fill), identical 42 px rhythm when collapsed, and a sticky Collapse control that stays reachable at 560 px with the rail scrolling underneath; Tab reaches every bar control and rail row with a 2 px accent ring (offset 2 px, -2 px inside rail pills) and a halo on the search field; focusing a collapsed icon shows its name 8 px right of the rail (x=68) within 30 ms; a pointer waits about 140 ms before the first name (still hidden at 60 ms, shown by 240 ms) and a 30 ms-per-row sweep from rest shows only the icon it settles on, while a pointer already showing a name swaps rows immediately; the phone keeps `scrollWidth` 390 and never shows the side tooltip | Playwright 1.64 + Chromium 156 headless, boxes and computed styles measured, screenshots inspected | pass |
| World basemap in a real browser: the World style renders at z2.2, z2.9, z4.5 and z6.2 in the night theme and at z3.4 in the day theme; 177 country fills and borders, muted country names, letter-spaced continent names, italic serif ocean names, seas appearing only past z4.4, airports and traffic drawn on top; no page errors | Playwright 1.64 + Chromium 156 headless, screenshots inspected | pass |
| World basemap cost in a real browser: sheet rebuild 1.3-1.5 ms at z6-z9 and 2.7-4.1 ms on a whole-world view across runs; cached pan frame 2.7-4.5 ms with software rasterisation | `node scripts/world-bench.mjs` | pass |
| JavaScript syntax, all shared and pilot modules | `node --check` loop | pass |
| Inline script syntax, tracker/logbook/weather/pilot/landing | extracted blocks + `node --check` | pass |
| ES module import graph | resolver script | 0 missing files |
| Local `href`/`src` references on all pages | resolver script | pass (`about:blank` iframe is intentional) |
| Manifest JSON, icons 180/192/512/maskable | JSON parse + image dimensions | pass |
| PWA service worker caching rules | code inspection + JS syntax | live/private endpoints bypassed |

The integration test is the important one: it starts the real Python bridge and the real Node relay, pairs them over HTTP, claims the code as a phone would, waits for an outbound snapshot, verifies `bridgeVersion` and freshness, then revokes the token and confirms 401.

## Not executed (reported as limitations, not passes)

| Check | Why |
| --- | --- |
| Route Discovery visual review in a real browser, and the map preview tiles | Same missing Chromium libraries as below. Card layout, selection states, the single reusable `MiniMap` canvas and the mobile breakpoints are covered by a linkedom DOM test and CSS review only; the map is described as implemented but not visually confirmed here. |
| Route Discovery with the bridge's worldwide airport list | Needs the Python bridge with its airport pack. The bundled snapshot has 152 airports and no field shorter than 5,000 ft, so Bush Flying falls back to demanding-terrain alternatives and says so; island hopping is limited to the New Zealand, Japan and Southeast Asia fields it contains. |
| Automatic update end-to-end (install 2.1.12, publish 2.1.13, quit, relaunch) | Needs two Windows releases and an installed copy. This environment has no Windows host and no Wine, so the Windows package could not be built here; the dependency, packaged-only guard, publish provider and release-asset requirements are source-tested, and the workflow refuses to publish without `latest.yml`. |
| Premium purchase and licence delivery | No payment provider or licence service is configured, so no purchase path was exercised. The entitlement check itself is implemented and tested (desktop IPC, licence endpoint, development override); the setup still required is listed in the app and in `SOURCES_AND_LICENSING.md`. |
| Charts for Canada, Europe or Australia | NAV CANADA, Airservices Australia and the European AIP publishers do not grant redistribution/display rights without a licence, so no adapter was added and no chart data for those regions is embedded. The registry reports the publisher and the missing licence instead of substituting a diagram; only a locally downloaded PDF can be opened. |
| Packaged Electron run of the chart viewer and entitlement IPC | The browser check used Chromium with a stubbed desktop bridge; the packaged app, its preload IPC and Electron's bundled Chromium were not launched here. The IPC handler, preload surface and gating rules are source-tested. |
| Multi-page procedure documents in the viewer | Every current FAA d-TPP document is a single page, so page navigation was exercised as UI state only (1 / 1); no multi-page document was available from an authorized source. |
| Interactive shell states in a real browser | The bar, both rail modes, the card, focus rings and responsive breakpoints were seen in browser screenshots. Hover, the resource-profile change and the Support dialog were exercised through DOM tests and computed styles only, and touch gestures were not available. |
| Chromium without a private library prefix | Playwright's Chromium could not start from the stock image (`libnspr4`, `libnss3`, `libatk*`, `libX*`, `libasound`, `libatspi` missing, and `playwright install-deps` needs `sudo`, which the container blocks). For this report the required Ubuntu 24.04 packages were downloaded and unpacked into a private prefix and exposed through `LD_LIBRARY_PATH` plus a minimal fontconfig file with DejaVu and Liberation fonts. A stock machine does not need that step. |
| GPU compositing, iPhone Safari, Home Screen install | The browser run was headless with software rasterisation and substituted fonts. Safari, touch gestures, PWA installation and GPU frame timing were not available. |
| Windows installer: packaged app launch and the update path | The NSIS installer for 2.1.14 was built on Windows 11 with electron-builder 26.15.3 (`npm run dist:win`, unsigned, `dist/Stratos-Setup.exe`, 94 MB, with `latest.yml` and a blockmap). The bundled `app.asar` was checked: version 2.1.14, the route-weather code present, no ChartFox and no CARTO URL, and the pdf.js compat shims present. Its Electron runtime was probed through `ELECTRON_RUN_AS_NODE=1` (Chromium 138.0.7204.251, V8 13.8). Launching the packaged window, its preload IPC and updating an installed 2.1.13 by hand were not exercised here. |
| Updating from an older installed version | Needs a Windows host with two published releases. `.github/workflows/update-smoke.yml` now performs exactly this on a Windows runner (silent install of the older build → verified download → silent installer → registry/exe version check); it was syntax- and unit-checked here but not run, because no release pair or Windows runner was available in this session. The build keeps `deleteAppDataOnUninstall:false`; the IndexedDB upgrade only adds stores. |
| X-Plane / MSFS telemetry | No simulator or SimConnect installation. The UDP parser and logbook lifecycle are covered by unit tests with synthetic data, not live sim compatibility. |
| Relay on a real HTTPS host / iPhone sign-in | No deployment credentials or iPhone. Local HTTP pairing is tested; HTTPS is enforced by the bridge for non-loopback relays. |
| Simulator FPS with Stratos open vs closed | No simulator. See `PERFORMANCE.md` for the reproducible protocol; no FPS improvement is claimed. |
| Vercel production deployment | No Vercel access. Local static serving is trivial; the Vercel config is inspected but not deployed. |

## Security checks performed

- The Vercel OIDC token that was committed in `env.download` is deleted from the working tree; it remains in Git history and must be revoked in Vercel.
- Bridge binds HTTP to `0.0.0.0` by default so LAN pairing works; loopback is trusted, every remote request needs the bridge token or a per-phone secret, and `STRATOS_HOST=127.0.0.1` disables LAN access. On Windows the port is bound exclusively, so a second bridge exits rather than competing.
- Remote bridge requests compare tokens in constant time; state-changing requests require same-origin or loopback. A paired phone's secret is stored only as SHA-256 and can be revoked per phone or for all phones; an open SSE stream re-checks its credential every 5 seconds and closes when revoked.
- Relay stores SHA-256 hashes only; desktop and phone tokens are separate; codes expire after 5 minutes; claim/pair are rate-limited; there is no command channel.
- `ALLOWED_ORIGINS` is configurable; production should not use `*`.
- Electron CORS header injection is limited to named public data hosts. Frame-header stripping is limited to official chart hosts. Renderer has no Node integration and a four-method preload API.
- No API keys or credentials are required for the static site or the bridge. The relay needs no third-party account.

## Data migration checks

- Browser DB `stratos_logbook` version 3 creates only missing stores; existing `flights` and `profile` are untouched.
- `mergeFlights` deduplicates and keeps richer records; it never deletes local flights.
- Bridge logbook writes use a temp file + atomic replace; in-progress flights are recovered and marked incomplete rather than discarded.
- The Windows uninstaller does not delete user data (`deleteAppDataOnUninstall:false`).

## Reproduce

```bash
npm ci
npm test
npm run test:py
npm run test:integration
node scripts/benchmark.mjs
npx playwright install chromium && node scripts/world-bench.mjs

# Charts in a real browser (needs the bridge on 127.0.0.1:8765)
python stratos_bridge.py --no-sim &
npm install --no-save playwright && npx playwright install chromium
node scripts/chart-check.mjs
```

For a Windows installer, run the “Build Windows installer” workflow and check the “Verify installer and write checksum” step. Do not treat a started workflow as a built installer.
