# Stratos test report

Date: 2026-10-19. Environment: Linux x64 cloud VM, Node v24.21.0, Python 3 (FreeStyle build), Chromium 156 via Playwright (headless, software rasterisation, private library prefix). No simulator, iPhone, Windows host or Vercel account was available.

## Passed

The `npm test` total is 65: 23 data-path tests, 4 module-graph tests, 23 DOM tests, 13 Route Discovery tests and 2 relay tests. All 65 pass.

| Check | Command | Result |
| --- | --- | --- |
| Pure modules: geo, landing, career, replay, planner, telemetry | `npm test` | 23/23 pass |
| Module graph: every local import exists and is exported | `npm test` | 2/2 pass |
| DOM: career dashboard/customizer, settings render, dashboard layout helpers, customizer arrow reordering, weather center watchlist, weather center station naming, shell status/rail, shared grid rule, Discover page, planner handoff | `npm test` | 12/12 pass |
| Flight Deck shell: grouped sidebar (three groups, eleven destinations, unchanged ids and links), icon-only rail toggle, page title in the top bar, honest simulator/live reporting, four home totals | `npm test` | pass |
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
| World basemap in a real browser: the World style renders at z2.2, z2.9, z4.5 and z6.2 in the night theme and at z3.4 in the day theme; 177 country fills and borders, muted country names, letter-spaced continent names, italic serif ocean names, seas appearing only past z4.4, airports and traffic drawn on top; no page errors | Playwright 1.64 + Chromium 156 headless, screenshots inspected | pass |
| World basemap cost in a real browser: sheet rebuild 1.3 ms at z6-z9 and 2.7-3.2 ms on a whole-world view; cached pan frame 2.7-4.5 ms with software rasterisation | `node scripts/world-bench.mjs` | pass |
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
| Visual review of the redesigned shell and dashboard | The shell chrome, sidebar and stat strip were seen in the browser screenshots taken for the World map, but their interactive states (collapsed rail, resource selector, dialogs) were verified through the DOM tests only. |
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
