# Stratos performance notes

These are measurements from the development container, not simulator FPS claims. The machine is a Linux x64 cloud VM with Node v24.21.0 and Python 3 (FreeStyle build). Windows, Electron rendering and a live simulator were not available.

## What changed to reduce overhead

- **Tracker render loop:** one `requestAnimationFrame` loop with a profile cap (60/30/15 fps), skipped entirely while the tab is hidden. Previously every frame stepped and painted regardless of frame budget.
- **Traffic polling:** 6 s normal, 12 s low, 20 s minimal. Traffic positions still interpolate between polls.
- **Trails:** per-aircraft cap of 900 normal / 350 low / 0 minimal. Minimal stops allocating trail arrays entirely.
- **Map:** minimal profile uses the vector base map instead of raster tiles, so no tile decode/upload. Tile cache is bounded at 500 entries.
- **DOM:** the map is a single canvas; telemetry updates update text nodes, not full-page HTML. Pilot sections are dynamically imported only when opened.
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
| Summarize 2,000 landings | 1.34 ms | 744/s |
| Career totals, 2,000 flights | 14.24 ms | 70/s |
| Route totals, 25 points | 0.0041 ms | ~245k/s |
| Heap used after benchmark | 89.4 MiB | — |

Interpretation: opening a replay of a very long flight costs roughly 17 ms of main-thread work once; playback sampling is negligible. A full career recalculation over 2,000 flights costs ~14 ms, which happens on logbook refresh, not per animation frame. These numbers exclude canvas painting and the browser’s layout.

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
