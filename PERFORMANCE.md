# Stratos performance notes

These are measurements from the development container, not simulator FPS claims. The machine is a Linux x64 cloud VM with Node v24.21.0 and Python 3 (FreeStyle build). Windows, Electron rendering and a live simulator were not available.

## What changed to reduce overhead

- **Tracker render loop:** one `requestAnimationFrame` loop with a profile cap (60/30/15 fps), skipped entirely while the tab is hidden. Previously every frame stepped and painted regardless of frame budget.
- **Traffic polling:** 6 s normal, 12 s low, 20 s minimal. Traffic positions still interpolate between polls. The phone polls the VATSIM feed once every 15 s (8 s timeout, one request per poll) and reuses the bridge's ADS-B snapshot that already arrives on its SSE stream, so a second feed is never fetched for it; nothing is requested and nothing is drawn while the phone's Traffic layer is hidden.
- **Trails:** per-aircraft cap of 900 normal / 350 low / 0 minimal. Minimal stops allocating trail arrays entirely.
- **Map:** minimal profile uses the vector base map instead of raster tiles, so no tile decode/upload. Tile cache is bounded at 500 entries.
- **DOM:** the map is a single canvas; telemetry updates update text nodes, not full-page HTML. The floating flight card rebuilds only when one of its rendered values changes, which is at most once a minute (the UTC arrival time) plus the traffic refresh. Pilot sections are dynamically imported only when opened.
- **Route planner:** selecting a leg or waypoint is a local class change plus one canvas redraw; it does not re-render the page or rebuild the waypoint list. Telemetry repaints are capped at 2 Hz and only refresh the four summary chips and the aircraft position. The route canvas keeps one tile cache and one `MiniMap` instance; the plan sidebar is a CSS width toggle. The vertical profile uses the same route estimate, so opening it adds no second calculation path.
- **Checklists:** checking an item updates that row and the progress bar, not the whole checklist. A sync is debounced by 2.5 s and sends one small JSON body; there is no polling loop. The phone performs one `/checklist` read at mount and otherwise adopts state from the existing SSE frames. The bridge re-checks a stream's credential every 5 s, which is one hash comparison for a paired phone.
- **Pairing:** a paired phone keeps one HttpOnly cookie; the bridge stores only its SHA-256 hash. No repeated IP entry, no discovery broadcast, and no extra polling. Revocation is an in-memory dictionary removal plus one small atomic file write.
- **Relayed traffic:** the bridge posts its ADS-B list and only the trail samples the relay has not seen to `/api/traffic` every 15 s (at most 400 points), rather than replaying the store; a stale-telemetry bridge stops posting. The relay keeps the list and trails in memory with the bridge's own caps, and a phone on the relay fetches the list on its 15 s poll and one path when a target is tapped.
- **Replay:** recorded tracks are Douglas–Peucker simplified in a local nautical-mile projection and capped for rendering; the full track is kept for statistics. A 12,000-point track renders as ~566 points (95% reduction) in the benchmark.
- **Service worker:** shell-only cache. Live/private endpoints are bypassed, so the browser does not repeatedly store and evict JSON.
- **Bridge:** no busy loop on telemetry; `relay_loop` sends snapshots only when paired and scales its sleep to 2 s while telemetry is fresh, 5 s otherwise. Telemetry is processed once per UDP position sample. Logbook writes are atomic but not per-packet.
- **Bridge polling in the UI:** EventSource (server push) instead of polling. Reconnect backoff is capped at 15 s and pauses when the page is hidden.
- **Electron:** a single bridge process, health probe instead of blind spawn, no duplicate process on app restart, GPU process recovery, and a renderer with `nodeIntegration:false`/`sandbox:true`.

## Resource profiles

| Profile | Render cap | Traffic poll | Trail cap | Base map |
| --- | --- | --- | --- | --- |
| Normal | 60 fps | 6 s | 900 points | Raster tiles |
| Low resource | 30 fps | 12 s | 350 points | Raster tiles |
| Minimal | 15 fps | 20 s | none | Vector |

Recording and logbook processing are never reduced. Switching profiles does not clear a recording or reconnect the simulator. The map reads `stratos.resourceMode` on load; changing it in Settings persists the choice for Pilot and the next tracker load.

## Data-path benchmark

Reproduce with:

```bash
node scripts/benchmark.mjs
```

Inputs: synthetic 12,000-point curved track; 2,000 completed flights with a 60-point track and landing record; 25-waypoint route request. Node v24.21.0, Linux x64.

| Operation | Mean | Throughput |
| --- | ---: | ---: |
| Normalize + prepare 12k replay | 16.95 ms | 59/s |
| Sample prepared replay | 0.0011 ms | ~897k/s |
| Simplify 12k track only | 4.36 ms | 229/s |
| Rebuild the world basemap sheet (177 countries, ~9,500 points, 1,280x800 at dpr 1, headless Chromium) | 1.3-1.5 ms at z6-z9, 2.7-4.1 ms on a whole-world view | ~245-760/s |
| Pan one frame with the world basemap cached | one `drawImage`, no re-pathing | — |
| Summarize 2,000 landings | 1.34 ms | 744/s |
| Career totals, 2,000 flights | 14.24 ms | 70/s |
| Route totals, 25 points | 0.0041 ms | ~245k/s |
| Heap used after benchmark | 89.4 MiB | — |

The world basemap sheet is rebuilt only when the projected centre moves past the snap step, the zoom changes or the theme changes; every other frame is a single `drawImage` of the cached sheet. A rebuild costs 1.3-1.5 ms at z6-z9 and 2.7-4.1 ms on a whole-world view (run to run on a shared VM), where the most country names and continent labels are tested for overlap. Blitting the cached sheet and repainting the overlay costs 2.7-4.5 ms per frame under headless software rasterisation, which is the pessimistic case; a GPU-backed browser composites the same blit on the GPU.

Reproduce with:

```bash
npx playwright install chromium
node scripts/world-bench.mjs
```

The script serves `app/` from a throwaway static server, opens the tracker with the World style saved, and times sheet rebuilds, cached pan frames and centre changes at z2.9, z6 and z9. Chromium 156, Linux x64, software rasterisation.

Interpretation: opening a replay of a very long flight costs roughly 17 ms of main-thread work once; playback sampling is negligible. A full career recalculation over 2,000 flights costs ~14 ms, which happens on logbook refresh, not per animation frame. These numbers exclude canvas painting and the browser’s layout.

## Charts

Measured on Windows 11 x64, Node v26, Chromium (Playwright headless) at 1440x900, with the bridge serving the FAA cycle 2610 catalogue.

| Operation | Measurement |
| --- | ---: |
| Bridge catalogue for one airport, warm (`/charts?icao=KJFK`, 31 documents) | 1.5-2.0 ms |
| Hosted API, cold (download + parse the 16 MB FAA metafile) | 1.87 s |
| Hosted API, warm instance | 3 ms |
| First chart open (300 KB PDF: download, pdf.js parse, fit-width paint) | 254 ms |
| Second chart open (168 KB PDF) | 132 ms |
| Reopening a chart from the IndexedDB cache | 166 ms |
| Zoom re-render (fit width → next scale, same page) | ~100-125 ms |
| JS heap after one chart is open | 9.4 MB |

Why this does not compete with the simulator:

- pdf.js (1.9 MB with standard fonts) is dynamically imported the first time a pilot opens a chart, free or Premium. Browsing the catalogue downloads no renderer at all, and an airport whose provider is not integrated is answered from the local registry without a network request.
- The viewer owns exactly one canvas and one pdf.js document. Switching charts destroys the previous document; zooming cancels the in-flight render task before starting the next one.
- The backing store is capped at device pixel ratio 2, and at 1.25 above 200% zoom, so a deep zoom costs a bounded amount of canvas memory instead of growing with zoom².
- Documents are cached in their own IndexedDB database, keyed by cycle and filename, capped at 40 entries / 30 days. A repeated open does no network request.
- The catalogue is fetched per airport, not as a global collection. The 16 MB metafile is parsed by the bridge (already resident) or by the hosted function; it is never downloaded to a tablet or phone.
- No timers run while a chart is idle; panning and zooming are pointer and wheel driven, and the only animation is the loading spinner.

## Bridge measurements

Method: start `python3 stratos_bridge.py` with `STRATOS_HOST=127.0.0.1`, a temporary data directory and free ports; wait 15 s for startup; read `/proc/<pid>/stat` ticks over a 15 s window and RSS from `ps`.

| Scenario | CPU over 15 s | RSS |
| --- | ---: | ---: |
| Idle after startup, no simulator | 0 ticks → ~0% | ~80 MB |
| 150 X-Plane-style UDP position packets at 10 Hz / 15 s | 5 ticks → ~0.33% | ~80 MB |

Startup to a healthy `/health` response: 0.120 s, 0.139 s, 0.168 s across three runs (system Python; PyInstaller one-file startup will be longer).

The RSS includes the loaded airport/runway database and caches. It is independent of the number of flights in this measurement. A very large logbook will increase memory when bridge JSON is serialized; the bridge caps replay tracks at 12,000 points per flight and the relay sends at most 600 points for the three most recent flights.

No before/after comparison is claimed: the original bridge was not benchmarked under identical conditions. The changes above are architectural and can be measured with the commands in this file.

## Simulator FPS protocol (not executed here)

Run this on your PC with the same simulator settings, weather, aircraft and location for every run:

1. Record baseline: simulator running, Stratos closed. Sit parked for 60 s, then fly a repeatable 5-minute route. Capture the simulator’s FPS overlay (average and 1% low) and Windows Task Manager GPU/CPU.
2. Open Stratos with the bridge connected, Normal profile. Repeat the exact flight. Record FPS, Stratos CPU, Stratos working set, bridge CPU/RSS.
3. Repeat with Low resource and Minimal profiles.
4. Leave Stratos open for 60 minutes on the ground; record memory every 10 minutes and check for growth.
5. Use the same driver, resolution, scenery and time of day. Do not compare runs across driver updates.

Report Strato’s overhead, not an FPS “improvement”. If Strato’s FPS impact is within run-to-run noise, say so. This environment could not run MSFS/X-Plane, so no FPS numbers are claimed.

## Known performance limits

- A 12,000-point replay is prepared in one synchronous call. On a very slow phone this may be noticeable; it runs only when the replay section is opened.
- The tracker’s main page is a single 121 KB HTML file with inline CSS/JS. It parses quickly but cannot be code-split without a larger rewrite.
- `career totals` recomputes all flights after a sync. At 10,000+ flights this is a visible pause; a future change should cache aggregates by flight ID.
- The bridge loads worldwide airports into memory (~80 MB RSS) to support offline airport and runway matching. Minimal mode does not remove that server-side data.
