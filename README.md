# Stratos

A lightweight flight-simulation companion: live map, public ADS-B traffic, airports and charts, a career logbook, flight replay, landing analytics, route planning, weather briefings, and a secure phone dashboard.

Stratos runs as a static website/PWA, an Electron desktop app, and an optional local Python simulator bridge. It is designed to be useful without a simulator, and explicit about what is live, estimated, or unavailable.

## What is implemented

| Area | Status |
| --- | --- |
| Map, airports, navaids, public ADS-B traffic, charts, METAR/TAF | Working; data-provider dependent |
| Offline vector world map | Working; the **World** style draws bundled Natural Earth country outlines with muted country names, letter-spaced continent names and italic ocean names, adds seas only when zoomed past a whole-world view, and needs no tiles, key or network |
| X-Plane UDP bridge, MSFS SimConnect (optional package) | Implemented; not tested against a live simulator here |
| Flight recording, crash recovery, duplicate prevention | Working, tested |
| Flight replay with recorded/interpolated distinction | Working for flights with a recorded track |
| Landing analytics with per-aircraft thresholds | Working; runway/touchdown values are estimates |
| Career dashboard, records, milestones, drill-down | Working, with customizable tiles |
| Route planner, PLN/FMS/GPX import/export, SimBrief import | Working; estimates are labelled |
| Flight Deck shell | One grouped sidebar (Flight Operations / Flight Intelligence / Application), a compact top bar with the page identity and simulator state, and an icon-only rail mode |
| Flight overview dashboard | Reports the simulator link, the live flight, the saved route pair, planned cruise level, distance, ETE and airborne progress, and admits a value it does not have instead of inventing one |
| Top of descent from your own descents | Working; the bridge measures the real gradient of each completed flight and the tracker uses it, falling back to 200 ft/nm until one exists |
| Route Discovery (mood → three route ideas → planner) | Working; airports, distances and runway claims come from the airport database, and stretched durations are labelled |
| Airport explorer and briefing | Working; NOTAMs are not implemented |
| PWA / iPhone Home Screen | Implemented; HTTPS deployment and pairing required |
| Phone relay with short-lived pairing codes | Working, tested end-to-end locally |
| Automatic Windows bridge startup, diagnostics, packaging | Implemented; installer must be built on Windows/CI |
| Resource profiles (normal / low / minimal) | Working; recording is never reduced |

See [README-DEPLOY.md](README-DEPLOY.md) for build and deployment, [PERFORMANCE.md](PERFORMANCE.md) for measured overhead, and [TEST_REPORT.md](TEST_REPORT.md) for exactly what was and was not tested.

## Quick start

- Website: open `index.html`, then `app/`.
- Windows: download `Stratos-Setup.exe` from the latest GitHub release, or build with `npm ci && npm run dist:win`.
- Simulator bridge: `python3 stratos_bridge.py` (the desktop app starts it automatically).
- Tests: `npm test`, `npm run test:py`, `npm run test:integration`.

No API keys are required for the app. The optional relay is a small Node server in `relay/`; see the deployment guide.

## Honest limitations

No simulator, iPhone, Windows host or production deployment was available while this upgrade was prepared. Features that depend on those are implemented but must be verified on your hardware. The old `env.download` Vercel token is removed from the tree but remains in Git history — revoke it in Vercel.

Not for real-world navigation. Map data © OpenStreetMap contributors; airports from OurAirports (CC0); weather from NOAA. See [SOURCES_AND_LICENSING.md](SOURCES_AND_LICENSING.md).

MIT licensed; see [LICENSE](LICENSE).
