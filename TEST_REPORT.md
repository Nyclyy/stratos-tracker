# Stratos test report

Date: 2026-10-18. Environment: Linux x64 cloud VM, Node v24.21.0, Python 3 (FreeStyle build). No simulator, iPhone, Windows host, Vercel account or browser system libraries were available.

## Passed

The `npm test` total is 32: 23 data-path tests, 2 module-graph tests, 5 DOM tests and 2 relay tests.

| Check | Command | Result |
| --- | --- | --- |
| Pure modules: geo, landing, career, replay, planner, telemetry | `npm test` | 23/23 pass |
| Module graph: every local import exists and is exported | `npm test` | 2/2 pass |
| DOM: career dashboard/customizer, settings render, dashboard layout helpers, customizer arrow reordering, weather center watchlist | `npm test` | 5/5 pass |
| Relay: pairing, ingest, state, revoke, origin and rate limits | `npm test` | 2/2 pass |
| Bridge lifecycle, dedupe, recovery, landing analysis | `npm run test:py` | 10/10 pass |
| Real bridge + relay: health, static shell, SSE, pair → claim → snapshot → revoke | `npm run test:integration` | 2/2 pass (~10.5 s) |
| NOAA weather API, live call for KJFK | in-process handler invocation | 200, real METAR and TAF, source NOAA |
| OurAirports API, `q=heathrow` | in-process handler invocation | 200, EGLL first, correct typed fields |
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
| Chromium layout, canvas, service worker install, iPhone Home Screen | Playwright downloaded Chromium, but the VM lacks `libnss3`, `libatk*`, `libgbm` etc. `playwright install-deps` requires `sudo`, which is blocked by the container’s no-new-privileges policy. Two linkedom DOM smoke tests cover the career dashboard and settings render; full browser layout, canvas and service-worker installation are not claimed. |
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
```

For a Windows installer, run the “Build Windows installer” workflow and check the “Verify installer and write checksum” step. Do not treat a started workflow as a built installer.
