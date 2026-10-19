# Stratos test report

Date: 2026-10-19. Environment: Linux x64 cloud VM, Node v24.21.0, Python 3 (FreeStyle build), Chromium 156 via Playwright (headless, software rasterisation, private library prefix). No simulator, iPhone, Windows host or Vercel account was available.

## Passed

The `npm test` total is 83 across the data-path, chart, module-graph, DOM/UI, Route Discovery and relay suites. All 83 pass, including from a simulated Windows (CRLF) checkout.

## Charts and vertical profile (2026-10-19, Windows 11 x64)

Run on the development PC with Node 26, Chromium via Playwright, and the real Python bridge holding FAA d-TPP cycle 2610.

| Check | Command / method | Result |
| --- | --- | --- |
| Chart catalogue rules: 28-day cycle codes and windows, metafile header, airport lookup, every published category (APD, DP, STR, IAP, MIN, HOT), runway and approach extraction, amendment dates, expiry states, search | `node --test tests/charts.test.mjs` | 8/8 pass |
| Premium entitlement: trusted desktop answer, a `premium:true` answer with `verified:false` refused, no desktop channel, browser storage ignored | `node --test tests/charts.test.mjs` | pass |
| Charts page DOM: free pilot gets the catalogue plus the upgrade panel and no canvas; verified Premium pilot gets the empty viewer | `node --test tests/charts.test.mjs` | pass |
| ChartFox removal: no `chartfox` or hard-coded FAA filenames remain in the Flight Deck, airports page links to the workspace, nav and section registry include Charts | `node --test tests/charts.test.mjs` | pass |
| Real catalogue through the bridge: `/charts?icao=KJFK` returns 31 documents in six categories, cycle 2610, window 2026-10-01 09:01Z to 2026-10-29 09:01Z; `EGLL` returns an explicit 404 coverage message | `curl http://127.0.0.1:8765/charts?icao=...` | pass |
| Real document through the bridge: `/chart?cycle=2610&file=00610AD.PDF` returns 301,837 bytes, `application/pdf`, starting `%PDF-1.4` | `curl` + `xxd` | pass |
| Real catalogue and document through the hosted handlers: `/api/charts?icao=KJFK` returns 38 documents for cycle 2610 with the FAA window; `/api/chart` proxies the same 301,837-byte PDF; `file=../secret.PDF` is refused with 400 before any request | in-process handler invocation against the live FAA host | pass |
| Native viewer in a real browser, 1440x900: six category groups and 31 rows for KJFK, the airport diagram paints at fit width (690 px page in a 710 px stage), zoom 178% → 278% re-renders to 1078 px, dragging changes the transform, Fit width returns to 690 px, switching to `DEEZZ SIX (RNAV)` loads a different document with its cycle and effective date, KDEN catalogues 74 documents, the `ILS` filter narrows to 12, no page or console errors | Playwright 1.64 + Chromium, screenshots inspected | pass |
| Premium gate in a real browser: 31 rows with 31 Premium badges, clicking a row shows the upgrade panel, no canvas or document request is made, the panel reports the missing licence service | Playwright, DOM state measured | pass |
| Vertical profile: TOC/TOD equal the route estimate's values, waypoint altitudes come from that estimate, imported `.pln` altitudes are kept as constraints and round-trip through export | `node --test tests/charts.test.mjs` | pass |
| Chart timings | bridge catalogue 1.5-2 ms warm; hosted API 1.87 s cold / 3 ms warm; first chart 254 ms, cached reopen 166 ms; zoom re-render ~100-125 ms; 9.4 MB heap with one chart open | see `PERFORMANCE.md` |

| Check | Command | Result |
| --- | --- | --- |
| Pure modules: geo, landing, career, replay, planner, telemetry | `npm test` | 23/23 pass |
| Module graph: every local import exists and is exported | `npm test` | 2/2 pass |
| DOM: career dashboard/customizer, settings render, dashboard layout helpers, customizer arrow reordering, weather center watchlist, weather center station naming, shell status/rail, shared grid rule, Discover page, planner handoff | `npm test` | 12/12 pass |
| Flight Deck shell: grouped sidebar (three groups, eleven destinations, unchanged ids and links), icon-only rail that opens collapsed and remembers the toggle, the page's own state line under the wordmark instead of duplicate status pills, the search moved into the bar, Support Us / Go Premium, the UTC clock reading HHMMZ, and honest simulator/live reporting | `npm test` | pass |
| Flight Deck chrome: the flight card converts remaining time into a UTC arrival instead of a countdown, the corner badge names the simulator instead of printing the long feed sentence, the rail pages centre the search on the bar itself, the phone bar drops the wide controls, and the shell's single column cannot be widened by its content | `npm test` | pass |
| Automatic updates: `electron-updater` is a runtime dependency, the main process only checks when packaged and only installs on quit, the builder points at this GitHub repository, and the workflow requires `latest.yml`, ships it with the blockmap, and fails instead of publishing an app that cannot update | `npm test` | pass |
| Automatic updates on demand: the main process answers `updater:status`, `updater:check` and `updater:install`, installs a downloaded build with `quitAndInstall()`, the preload exposes `getUpdateStatus` / `checkForUpdates` / `installUpdate`, and the Settings button drives the real updater instead of the service worker | `npm test` | pass |
| Settings click handling: the theme switcher selects `button[data-theme]`, so the document element (`<html data-theme>`) is no longer treated as a theme button and a click anywhere in Settings no longer re-renders the page; a downloaded update relabels the button to Restart to update and installs on the next click | `npm test` | pass |
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
| Charts for Canada or other national authorities | NAV CANADA and other AIP publishers do not grant redistribution/display rights without a commercial licence, so no adapter was added and no chart data for those regions is shown. The catalogue reports the lack of coverage instead of substituting a diagram. |
| Packaged Electron run of the chart viewer and entitlement IPC | The browser check used Chromium with a stubbed desktop bridge; the packaged app, its preload IPC and Electron's bundled Chromium were not launched here. The IPC handler, preload surface and gating rules are source-tested. |
| Multi-page procedure documents in the viewer | Every current FAA d-TPP document is a single page, so page navigation was exercised as UI state only (1 / 1); no multi-page document was available from an authorized source. |
| Interactive shell states in a real browser | The bar, both rail modes, the card, focus rings and responsive breakpoints were seen in browser screenshots. Hover, the resource-profile change and the Support dialog were exercised through DOM tests and computed styles only, and touch gestures were not available. |
| Chromium without a private library prefix | Playwright's Chromium could not start from the stock image (`libnspr4`, `libnss3`, `libatk*`, `libX*`, `libasound`, `libatspi` missing, and `playwright install-deps` needs `sudo`, which the container blocks). For this report the required Ubuntu 24.04 packages were downloaded and unpacked into a private prefix and exposed through `LD_LIBRARY_PATH` plus a minimal fontconfig file with DejaVu and Liberation fonts. A stock machine does not need that step. |
| GPU compositing, iPhone Safari, Home Screen install | The browser run was headless with software rasterisation and substituted fonts. Safari, touch gestures, PWA installation and GPU frame timing were not available. |
| Windows installer build and launch | Building an NSIS Windows target on Linux requires Wine; no Windows runner was available. The GitHub Actions workflow is the reproducible build path and has not been run from this session. |
| Updating from an older installed version | Needs a Windows host with the previous build. The build keeps `deleteAppDataOnUninstall:false`; the IndexedDB upgrade only adds stores. |
| X-Plane / MSFS telemetry | No simulator or SimConnect installation. The UDP parser and logbook lifecycle are covered by unit tests with synthetic data, not live sim compatibility. |
| Relay on a real HTTPS host / iPhone sign-in | No deployment credentials or iPhone. Local HTTP pairing is tested; HTTPS is enforced by the bridge for non-loopback relays. |
| Simulator FPS with Stratos open vs closed | No simulator. See `PERFORMANCE.md` for the reproducible protocol; no FPS improvement is claimed. |
| Vercel production deployment | No Vercel access. Local static serving is trivial; the Vercel config is inspected but not deployed. |

## Security checks performed

- The Vercel OIDC token that was committed in `env.download` is deleted from the working tree; it remains in Git history and must be revoked in Vercel.
- Bridge binds HTTP to `127.0.0.1` by default. LAN binding requires an explicit `STRATOS_HOST=0.0.0.0` and the generated token.
- Remote bridge requests require a constant-time token check; state-changing requests require same-origin or loopback.
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
```

For a Windows installer, run the “Build Windows installer” workflow and check the “Verify installer and write checksum” step. Do not treat a started workflow as a built installer.
