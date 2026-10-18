# Stratos

A lightweight flight-simulation companion: live map, public ADS-B traffic, airports and charts, a career logbook, flight replay, landing analytics, route planning, weather briefings, and a secure phone dashboard.

Stratos runs as a static website/PWA, an Electron desktop app, and an optional local Python simulator bridge. It is designed to be useful without a simulator, and explicit about what is live, estimated, or unavailable.

## What is implemented

| Area | Status |
| --- | --- |
| Map, airports, navaids, public ADS-B traffic, charts, METAR/TAF | Working; data-provider dependent |
| X-Plane UDP bridge, MSFS SimConnect (optional package) | Implemented; not tested against a live simulator here |
| Flight recording, crash recovery, duplicate prevention | Working, tested |
| Flight replay with recorded/interpolated distinction | Working for flights with a recorded track |
| Landing analytics with per-aircraft thresholds | Working; runway/touchdown values are estimates |
| Career dashboard, records, milestones, drill-down | Working, with customizable tiles |
| Route planner, PLN/FMS/GPX import/export, SimBrief import | Working; estimates are labelled |
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
