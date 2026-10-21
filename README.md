# Stratos

A lightweight flight-simulation companion: live map, public ADS-B traffic, airports and charts, a career logbook, flight replay, landing analytics, route planning, weather briefings, and a secure phone dashboard.

Stratos runs as a static website/PWA, an Electron desktop app, and an optional local Python simulator bridge. It is designed to be useful without a simulator, and explicit about what is live, estimated, or unavailable.

## What is implemented

| Area | Status |
| --- | --- |
| Map, airports, navaids, public ADS-B traffic, METAR/TAF | Working; data-provider dependent |
| Integrated charts (ILS/LOC free, the rest Premium) | The current FAA d-TPP catalogue per airport (diagrams, SIDs, STARs, approaches, minimums, hot spots) in a source-agnostic provider registry, a bundled pdf.js viewer with zoom, pan, fit, reset, pages, previous/next document, full screen and a document cache, and a trusted Premium gate. **ILS and LOC approach charts open for everyone**; the other categories need a verified licence. Search accepts an ICAO code or an airport name, every row is labelled Free or Premium, the airport header names the airport, country and available categories, and the last airport/chart is restored on return. Coverage is the United States and its territories; Canada, Europe and Australia show publisher links only (no embedded or mirrored charts), and **Open PDF…** displays a chart you downloaded from that publisher locally, without uploading or caching it |
| Route vertical profile | Planned altitude, climb/cruise/descent, TOC/TOD and per-waypoint inspection from the same estimate the planner reports; imported flight-plan altitudes are kept as constraints |
| Route weather along the plan | NOAA METAR at up to eight airports on the route with surface wind components against the flown course and honest IFR/gust/crosswind notes; real-world only, not winds aloft or simulator weather |
| Offline vector world map | Working; the **World** style draws bundled Natural Earth country outlines with muted country names, letter-spaced continent names and italic ocean names, adds seas only when zoomed past a whole-world view, and needs no tiles, key or network |
| X-Plane UDP bridge, MSFS SimConnect (optional package) | Implemented; not tested against a live simulator here |
| Flight recording, crash recovery, duplicate prevention | Working, tested |
| Flight replay with recorded/interpolated distinction | Working for flights with a recorded track |
| Landing analytics with per-aircraft thresholds | Working; runway/touchdown values are estimates |
| Career dashboard, records, milestones, drill-down | Working, with customizable tiles |
| Interactive route planner | The planned route is drawn on the Flight Deck map itself as soon as it exists — fitted to the route, labelled, with a **Route** layer toggle and two-way sync with the planner. The planner page keeps its own editing map with a collapsible plan sidebar and route header; selectable legs and waypoints; add, delete, reorder and drag waypoints; undo; a leg inspector with geodesic distance, initial true course, magnetic course only when variation is supplied, ETE at the planned/live groundspeed, leg position and endpoint coordinates; total distance/legs/ETE and live remaining distance. PLN/FMS/GPX import/export and SimBrief import stay on the same route |
| Aircraft checklists | Ten ToLiss/FlightFactor profiles plus a generic checklist, including a dedicated A340-600 flow; aircraft detection from telemetry with manual override; phase inference from groundspeed/altitude/vertical speed; per-flight progress, compact/full modes, custom items, import/export and reset; optional phase callouts off by default; **community simulator aid, not a verified aircraft manual** |
| Phone pairing on the local network | PC shows a QR code and six-digit single-use code; the phone exchanges it for its own HttpOnly secret, remembered across visits, Wi-Fi changes and bridge restarts; the PC lists paired phones and can forget one or all; revoked streams close within ~5 s and the phone returns to pairing. No IP typing after the first scan |
| Flight Deck shell | One grouped rail (Flight Operations / Flight Intelligence / Application) that opens icon-only, expands to a labelled sidebar, names each icon on hover and keyboard focus, and shares one keyboard ring with the bar; a top bar with the wordmark and its live state line, one centred search, Support Us / Go Premium and the UTC clock, and a full-bleed map: the flight card floats over it with real telemetry and a corner badge names the place and the live aircraft count |
| Flight overview dashboard | Reports the simulator link, the live flight, the saved route pair, planned cruise level, distance, ETE and airborne progress, and admits a value it does not have instead of inventing one |
| Top of descent from your own descents | Working; the bridge measures the real gradient of each completed flight and the tracker uses it, falling back to 200 ft/nm until one exists |
| Route Discovery (mood → three route ideas → planner) | Working; airports, distances and runway claims come from the airport database, and stretched durations are labelled |
| Airport explorer and briefing | Working; NOTAMs are not implemented |
| PWA / iPhone Home Screen | Implemented; HTTPS deployment and pairing required |
| Phone relay with short-lived pairing codes | Working, tested end-to-end locally; optional remote path when the phone is not on the PC's LAN |
| Automatic Windows bridge startup, diagnostics, packaging | Implemented; installer must be built on Windows/CI |
| Resource profiles (normal / low / minimal) | Working; recording is never reduced |
| Updates and release notes (Windows, web and PWA) | Every release publishes a categorised changelog and update manifest, generated from the tagged commits and able to be written by hand per version in `release-notes/curated.json`. A packaged build checks the newest stable GitHub release in the background, verifies the download against the published SHA-512 and installs it on quit. A download left over from an earlier session is applied at the next launch, without a prompt. **Settings → Updates** shows the installed and latest versions, the last check, progress, errors and a retry, every previous release with its notes, and a **Restart to update** action; a newer build opens a modal with **Update now**, **Remind me later** and **View full changelog**. Dismissals are remembered per build, and a critical release explains why it is required. The website and installed iPhone app activate a waiting service worker on request and never reload mid-flight. The first updater-aware build must be installed by hand |

See [README-DEPLOY.md](README-DEPLOY.md) for build and deployment, [PERFORMANCE.md](PERFORMANCE.md) for measured overhead, and [TEST_REPORT.md](TEST_REPORT.md) for exactly what was and was not tested.

## Quick start

- Website: open `index.html`, then `app/`.
- Windows: download `Stratos-Setup.exe` from the latest GitHub release, or build with `npm ci && npm run dist:win`.
- Simulator bridge: `python3 stratos_bridge.py` (the desktop app starts it automatically).
- Tests: `npm test`, `npm run test:py`, `npm run test:integration`.

No API keys are required for the app. The optional relay is a small Node server in `relay/`; see the deployment guide.

Running from source (`npm start`) reports a labelled development entitlement, so the Premium surfaces can be tested without a licence service. A packaged build needs `STRATOS_DEV_PREMIUM=1` or a configured `STRATOS_ENTITLEMENT_URL`.

## Honest limitations

The route planner, checklist engine and LAN pairing were exercised on Windows 11 with Chromium and the real Python bridge. No live X-Plane/MSFS telemetry, real iPhone/Safari session or production relay host was available, so those paths are implemented and source-tested but still need a flight on your hardware. Checklist content is community-compiled from public procedures and is deliberately labelled unverified; it does not replace the aircraft add-on's own checklists or manual. The bridge listens on the LAN by default for pairing, protected by the access token and per-phone cookies — use it only on a trusted network and never forward port 8765 from a router. The old `env.download` Vercel token is removed from the tree but remains in Git history — revoke it in Vercel.

Not for real-world navigation. Map data © OpenStreetMap contributors; airports from OurAirports (CC0); weather from NOAA. See [SOURCES_AND_LICENSING.md](SOURCES_AND_LICENSING.md).

MIT licensed; see [LICENSE](LICENSE).
