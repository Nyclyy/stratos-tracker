# Stratos test report

Date: 2026-10-19. Environment: Linux x64 cloud VM, Node v24.21.0, Python 3 (FreeStyle build), Chromium 156 via Playwright (headless, software rasterisation, private library prefix). No simulator, iPhone, Windows host or Vercel account was available.

## 2026-10-25 — A phone opens Stratos with the PC switched off (Windows 11 x64)

Environment: Windows 11 x64, Playwright Chromium with an emulated **iPhone 13** (390×844, touch, `pointer: coarse`) against a throwaway HTTPS server on 127.0.0.1:8443 with a self-signed certificate, so the mixed-content branch runs exactly as it does on the deployed site; a stub bridge on 127.0.0.1:8765 stood in for the PC in the second half. No real iPhone, no simulator and no real `stratos_bridge.py` were used for this path.

| Check | Method | Result |
| --- | --- | --- |
| **The reported failure** | hosted HTTPS page, iPhone emulation, bridge off, PC address known | **failed, fixed** — the page navigated itself to the PC's address on load, so a phone with the sim off landed on the browser's *this site can't be reached*, a navigation no script can undo. The navigation is now a card that waits for a tap; the page stays on `https://…/index.html` with the full Flight Deck (map canvas, all six tabs) and no page error |
| The offer says what it opens | DOM | pass — `Live map from your PC · Your PC was last at http://192.168.1.50:8765. Stratos must be running on the PC.` with **Open PC map** and **Not now**, 331×129 at the bottom of a 390 px viewport, inside the app bounds |
| It can be put aside | click **Not now**, then reload | pass — the card is removed, `stratos.pcMapDismissed=1` is set for the session and the reload does not bring it back; a new session offers it again |
| The tap is the only navigation | click **Open PC map** | pass — one top-level request to `http://192.168.1.50:8765/pair/connect?next=%2Findex.html`; before the tap the page made no request to the PC at all |
| PC on: the tap lands on the PC's map | stub bridge (302 `/pair/connect` → `/index.html`, SSE `/stream`) | pass — landed on `http://127.0.0.1:8765/index.html`, the stream opened by itself with no tap or setting, `liveOk()` true, status **● Live from X-Plane**, `Simulator online` badge, no page error; a second frame was accepted and the aircraft stayed live |
| A phone that already knows the PC needs no discovery | stored `stratos.bridgeUrl` | pass — `bridgeOrigin()` supplies it, so the card names the machine and the tap goes straight there; a first visit falls back to `http://stratos.local:8765`, the name the bridge answers over multicast DNS |
| The desktop is untouched | `phoneSized()`, 1309×818 | pass — a non-touch or large viewport never sees the card, and the hosted desktop page still loads live traffic as before |
| Suites | `npm test`, `npm run test:py` | 314 JavaScript tests, the relay worker smoke and 72 Python tests pass |

Limitations: the stub bridge proves the phone's hand-off, the stream opening by itself and the live state; it does not prove the real bridge's frames, a real aircraft drawn over a flown route, a real iPhone's Safari, or the Add to Home Screen launch. A browser cannot call an HTTP LAN bridge from an HTTPS page, so the one tap cannot be removed — only made safe, which is what changed here.

## 2026-10-25 — Stratos EFB, and a trail that survives touchdown (Windows 11 x64)

Environment: Windows 11 x64, the project's `npm run dev` server on 127.0.0.1:8231, Chromium in the preview panel at 1309×818 and 390×844, with the stored KEWR→LEBL SimBrief plan (UAL828, B772, FL370, SID/RWY 22R, STAR GRAUS2W/RWY 24R) already in local storage. No simulator, no bridge and no iPhone were available, so live telemetry, a real touchdown and a real phone session are **not** claimed below.

| Check | Method | Result |
| --- | --- | --- |
| A second product is visible on the index | Flight Deck rail, 1309 px | pass — a `Stratos EFB` card at the foot of the rail (245×43) above the collapse control, and the `EFB` control in the top bar on every page; the five destinations are unchanged (five `.tab` items counted) |
| It opens the real application | click on the rail card | pass — navigates to `efb.html`, home screen visible, 11 app icons and the dock rendered |
| The rail card survives collapsing | rail toggle, both states | pass — 43 px icon-only tile with the label hidden, 244 px when expanded |
| Home screen, not a dashboard | DOM | pass — status bar (connection, UTC, battery), flight strip, icon grid, dock, Home control; no sidebar, table or card grid |
| Tablet proportions | computed styles | pass — six columns of ~184 px with 76 px icons on a wide frame (was eleven 97 px columns with 68 px icons floating in them), four columns of 86 px with 54 px icons at 390 px, no horizontal overflow at either size |
| No tablet inside a tablet | 1024×768, 1366×1024, 390×844, 1636×1091 | **failed, fixed** — the decorative bezel was dropped only below 860 px, so an iPad in landscape (and every tablet-sized window) drew a framed tablet inside the real one. The screen now fills the viewport on touch devices (`hover: none` / `pointer: coarse`), below 1100 px, and on any window up to 1400×1024; at 1024×768 and 1366×1024 the tablet is exactly the viewport with no radius, border, padding or shadow, while a 1636×1091 desktop window keeps the framed 1320×920 tablet. The status bar and dock honour the safe-area insets in full-bleed mode. The grid follows the same sizes: five columns of 68 px icons at tablet-portrait widths (745–820 px) and six columns of 76 px in landscape, with no overflow at either orientation |
| Wallpaper and units persist | Settings: `lb`, then a wallpaper swatch | pass — `#efb-screen[data-wall]` follows the swatch at once and both are written to `stratos.efb.prefs` |
| Dictation of the dock and Home | dock icon, then Home | pass — dock opens `#/live`, Home returns to the grid (`#app-view` hidden, home visible) and clears the hash |
| Every app opens with its own content | each of the 11 icons clicked in one pass | pass — 11/11 mounted with content and no page error; Settings 15 controls, Documents 106, Charts 9, Performance 6 |
| Charts catalogue | KEWR in Charts | **failed, fixed** — the catalogue was read as `catalogue.charts` while `normaliseCatalogue` answers with the records themselves, so every airport said "the catalogue was empty". The payload is now wrapped by `catalogueFromPayload`; KEWR loads 52 documents, cycle 2610, `CURRENT` per row, grouped diagrams/SID/STAR/approach/minimums/hot spots, with the Premium gate on the non-ILS/LOC categories and the official PDF link. `tests/efb.test.mjs` pins the shape |
| Briefing from the real stored plan | Briefing | pass — UAL828 · B772 · N218UA, KEWR→LEBL, FL370, 3,480 nm, runway 22R, STAR GRAUS2W/24R, ZFW 174,121 kg, TOW 224,120 kg, block 50,634 kg, landing 7,810 kg, every value labelled `OFP`, and "not available" for flight time, departure/arrival time and alternate rather than a guess |
| Weather is decoded, not invented | Weather | pass — live NOAA METAR/TAF for KEWR and LEBL, wind/visibility/cloud/temperature/QNH decoded, runway wind components, observation age; the TAF's unrecognised `SKC` is listed as not decoded; no SIGMET feed is claimed and the official sources are linked |
| Performance refuses to invent numbers | Performance, no dataset | pass — pressure altitude, ISA deviation, density altitude and wind components computed; V-speeds and field lengths shown as unavailable with the reason, no bundled type data, an import path for a dataset the pilot is entitled to use, and a "simulator planning aid, not certified" line |
| Weight & balance and fuel reconcile | Weight & Balance, Fuel | pass — plan weights against the plan's own limits with margins, CG refused because no station/arm data exists for the 777; fuel components sum to the filed block with `balanced` and the arrival/reserve figures stated |
| Trail survives touchdown | source + tests | pass — the bridge ends the flight record after the aircraft parks and the next sample opens a new id at the same position; the desktop, the phone and the EFB live map now keep the drawn path and append the new recording (`appendTrack`), while a flight that starts elsewhere still replaces it. Covered by `tests/lib.test.mjs` (continuation and append) and `tests/ui.test.mjs` / `tests/efb.test.mjs` (each map's wiring) |
| The EFB installs as its own home-screen app | dev server in Chromium, manifest and worker inspected | pass — `manifest-efb.webmanifest` parses (name `Stratos EFB`, start `./efb.html`, standalone, own id, 192/512/maskable icons, three shortcuts), the page links it with the iOS standalone metas, `navigator.serviceWorker` registers `sw.js` at scope `/`, and the active shell cache already holds `efb.html`, `efb.css` and the manifest. Adding `body.efb-standalone` hides the EFB clock (the OS status bar carries the time) and removing it brings the clock back. `wantsEfb` sends an offline navigation for the bag to the bag, not to `index.html`. The real Add to Home Screen action needs a tablet and is not claimed |
| Suites | `npm test`, `npm run test:py` | 314 JavaScript tests, the relay worker smoke and 72 Python tests pass |

Limitations: nothing above exercised the bridge or a simulator, so a touchdown in flight, the EFB's live map with real telemetry and the live logbook were not observed in this pass — the continuity change is verified against the bridge's phase logic, its tests and the page wiring, not against a flight. Chart documents stay behind the existing Premium rule (ILS/LOC free, the rest gated); no SIGMET feed and no licensed performance dataset are configured, and both surfaces say so. The EFB has no iPhone/Safari pass yet.

## 2026-10-24 — SimBrief SID and STAR import (Windows 11 x64)

The real `json=v2` payload for the saved plan (WZZ2469, LHBP→EPWA, Pilot ID 1049175) was fetched in the preview browser. It showed three things the importer assumed otherwise: the procedures live in `general.sid_ident` / `general.star_ident` (the airport blocks carry none), each ident is shortened by one character in the OFP text (`LITK2X` for `LITKU2X`, `LOGD6N` for `LOGDA6N`), and a plan with Detailed Navlog off returns no navlog fixes at all.

| Check | Method | Result |
| --- | --- | --- |
| SID and STAR are read | `parseOfp` against the live payload | pass — `LITKU2X` and `LOGDA6N`, with departure runway 31L and arrival runway 11 |
| The shortened ident is restored | live payload's `general.route_ifps` | pass — only when removing exactly one character rebuilds the filed name; a different procedure is never substituted |
| The Flight Deck card shows them | stored plan in Chromium | pass — SID `LITKU2X` / RWY 31L and STAR `LOGDA6N` / RWY 11, including a plan stored before the fix (derived from its own route text) |
| A plan without navlog fixes still imports its procedures | `fetchSimbriefPlan` with `navlog.fix: []` | pass — fixes stay empty, the OFP (SID, STAR, runways) is returned and saved, and the current route is kept with a clear message |
| Nothing is invented | airway/fix-only routes | pass — `Y301`, `UL984`, `KALIF` and `DCT` are never read as a procedure |
| Suites | `npm test` | 295 JavaScript tests pass |

Limitations: the bridge was not running, so the imported SID/STAR were not rendered as procedure geometry in this pass; the procedure lookups now receive the full idents.

## 2026-10-24 — five-tab shell, flight-plan card and colour board (Windows 11 x64)

Environment: Windows 11 x64, the project's `npm run dev` server on 127.0.0.1:8123, Chromium in the preview panel at 1280×820 and 390×844, a stored KSEA→KPDX route and a stored SimBrief-shaped OFP (CYUL→CYYZ, A321, SID BMO/24L, STAR VERDO/05) built in the page to exercise the expanded card. No simulator and no bridge were running, so weather stayed honestly missing.

| Check | Method | Result |
| --- | --- | --- |
| Five destinations, never more | rail inspected at 1280 and 390 | pass — Flight Deck, Flight Planning, Logbook, Explore, Profile; active state moves between the two in-page tabs and the three links |
| Every former tab still reachable | map tools menu and Explore inspected | pass — Live, Charts, Weather and Data live in the Layers menu; Weather, Airports, Charts, Statistics and Live are linked from Explore |
| Same five on pages without a rail | pilot.html and discover.html at 390 | pass — the bar puts the five on a second row (92 px), no sideways scroll, Profile marked current on the pilot page |
| Same five in the legacy bottom bars | logbook, weather and live at 390 | pass — five items each; the weather search no longer overflows after the input got `min-width:0` |
| The pencil control is gone | source and DOM | pass — `#bPlan` removed, Plan mode is a control in the route sheet and the card has Build a route |
| Empty card | route and OFP cleared | pass — "Import flight plan" prompt, primary Import Flight Plan button, Build a route beside it, above the tab bar and clear of the controls |
| Loaded card | stored plan, expanded | pass — ASA123/B738, KSEA→KPDX, SID SUMMA2 with RWY 16L, STAR HELNS6 with RWY 28R, FL350, 124 nm, 0:59 |
| Rich card | built OFP with alternate, weights, pax, cargo and fuel | pass — CYUL→CYYZ, BMO/24L, VERDO/05, FL360, 280 nm, 2:04, alternate CYOW, ZFW 63,000 kg, TOW 75,000 kg, LW 68,000 kg, 168 passengers, 3,000 kg cargo, block 12,000 kg, landing 2,500 kg |
| Missing data is not invented | no bridge and no METAR route | pass — "No live METAR yet", an OFP without weights says to refresh it, a plan without a runway says "runway not in plan" |
| The old flight summary still renders | Flight summary action | **failed, fixed** — the header printed `[object Object] → [object Object]` because `overviewHeader` printed the plan's airport object; it now prints the ICAO for both object and string endpoints (`tests/overview.test.mjs`) |
| Colour board | Settings in Chromium | pass — eight swatches with HEX and jobs, the chips compute to those exact colours, the demo button uses `#38BDF8` on `#092127`, no page overflow at 390 |
| Colour tokens are the live ones | source | pass — night `--acc`, the rail accent and the marker selection colour now all carry the board's values |
| Reduced motion | source | pass — every entrance animation is inside `prefers-reduced-motion: no-preference` |
| Suites | `npm test`, `npm run test:py` | 289 JavaScript and 69 Python tests pass |

Limitations: the bridge was not running, so the card's auto-fetched METARs, live progress and the phone handshake were verified only as honest missing states in this pass (they were exercised against the real bridge earlier); the card's weather freshness is marked after 90 minutes, and the stored OFP used in the rich-card check was local test data, not a live SimBrief response.

## 2026-10-23 — hosted phone: the desktop's traffic through the relay (Windows 11 x64)

Environment: Windows 11 x64, the real bridge on 8765, `relay/server.mjs` 1.1.0 on loopback 8787, the dev server on 8123 standing in for `https://www.stratos-tracker.com/app/` (same app, relay-paired phone, no bridge reachable), the local test feed and the live VATSIM feed.

| Check | Method | Result |
| --- | --- | --- |
| The relay takes the list and new samples | `POST /api/traffic` with the desktop token: one valid list entry, a `(0,0)` entry, a non-numeric entry, two identical samples and one sample older than the window | pass — `{"ok":true,"added":2}`: the repeat, the stale sample and the unusable list entries refused |
| The phone reads it with its own token | `GET /api/traffic`, `GET /api/traffic?hex=swr219` with the read token | pass — the list held only `SWR219` with its altitude, and the path came back oldest-first as `[12000,16000]` under the normalised key |
| Roles cannot be swapped | read token on `POST`, desktop token on `GET` | pass — both 401 |
| A bad post cannot empty a good list | `POST` with non-array fields | pass — `added: 0`, the previous list still served |
| The bridge sends only what is new | bridge unit test: build a batch, advance the cursor, rebuild | pass — the second batch is empty until a new position is recorded, then contains just that sample |
| The bridge's real push arrives | bridge paired to the local relay, 20 s later | pass — the relay held 47 aircraft with altitudes, speeds and headings from the bridge's ADS-B loop, `at` 12 s old |
| The hosted-style phone uses it | page on 8123, paired through the relay, tapped QXE2128 | pass — the card showed ADS-B / 12,680 ft / 335 kt / 007° / 8 nm and “4 recorded positions in its trail **from the relay**”; the oldest point was 63 s old on a 51 s-old page, so it predates the page |
| Network cost | relay requests observed during the test | pass — one `OPTIONS` + one `GET /api/traffic` per 15 s, one `GET /api/traffic?hex=` on a tap; no errors |
| Suites | `npm test`, `python -m unittest tests.test_bridge` | 286 JavaScript and 56 bridge tests pass |

Limitations: the relay's traffic lives in its memory, so a relay restart keeps pairings but clears the trails; a phone on the relay cannot write positions, so it sees what the desktop recorded, not its own observations; and nothing is invented for the part of a flight nobody observed.

## 2026-10-23 — nearby traffic on the phone's live map, with the bridge's trails (Windows 11 x64)

Environment: Windows 11 x64, the real bridge on port 8765 serving the phone page on a 390×844 viewport, Chromium, the live VATSIM feed and the bridge's own ADS-B polling. The request: show nearby traffic on the phone's small live map, and give a tapped target the same bridge-backed trail the desktop uses.

| Check | Method | Result |
| --- | --- | --- |
| Nearby traffic is drawn | phone page at `http://127.0.0.1:8765/live.html`, map inspected after the first poll | pass — 25 targets within 180 nm (24 from the bridge's ADS-B feed, 1 VATSIM), each a heading glyph; own aircraft drawn on top |
| Both sources share one list | keys inspected after a poll | pass — 25 targets, 25 distinct keys (24 ADS-B, 1 VATSIM); the merge is keyed by callsign, and VATSIM wins when both feeds report the same aircraft because it carries the filed route and level |
| Tapping a target selects it | click at the projected position of ASA1385 (FL310, 505 kt, 179°, 36 nm) | pass — `map.trafficSelected` became `ASA1385`, the card showed **ADS-B**, altitude FL310, 505 kt, 179°, 36 nm and “4 recorded positions in its trail”, with no invented type, route, runway or procedure |
| The trail is the bridge's, not the page's | `GET /traffic/trail?hex=ASA1385` after the tap, compared with the page's own age | pass — the store held 3 points for that aircraft, the oldest **270 s** old, while the page had been open 40 s: the line spans before the page load |
| It survives a reload | reload, re-select CES998 (and later FDX1223 after the bridge was restarted on a fresh data directory) | pass — 9 points with the first **142 s** old; on the fresh store, a 7-second-old page got 5 points whose oldest was **57 s** old, i.e. recorded before the reload and served back from `traffic_trails.json` |
| A hidden layer costs nothing | press **Traffic** off, wait 35 s, read the network log | pass — no feed request, no trail request, no position post; toggling it back on polled within 3 s and refreshed the selected target's trail |
| Aircraft are picked before the route under them | unit test with a fix and an aircraft at the same position | pass — `{ kind: 'traffic', index: 0 }`; with the layer hidden the same point hit-tests as the waypoint |
| A stale selection cannot outlive its aircraft | unit test: `setTraffic()` without the selected key | pass — selection and its trail are cleared instead of leaving a path with no target |
| No page errors | console and network logs for the whole session | pass — every request 200, `GET /traffic/trail` and `POST /traffic/track` included; the only console entries were two aborted connections during a reload, and 20 s of polling afterwards produced none |
| Suites | `npm test`, `python -m unittest tests.test_bridge tests.test_cifp` | 285 JavaScript and 66 Python tests pass |

Limitations confirmed: the phone reads the VATSIM feed directly, so it needs internet for that source; the bridge's ADS-B list is used exactly as the bridge last published it (the desktop shows the same last-known positions), and a hosted page served through the relay receives no ADS-B list, so there it shows VATSIM only. A trail still starts when Stratos first observes the aircraft — no history is invented — and a phone paired through the relay has no bridge store, so its trails live only as long as the page.

## 2026-10-23 — traffic trails kept by the bridge, across reloads (Windows 11 x64)

Environment: Windows 11 x64, the real bridge on port 8765, Chromium, the live VATSIM feed. The request: keep the observed traffic trails so a clicked aircraft's path survives a reload rather than starting from the moment the page opened.

| Check | Method | Result |
| --- | --- | --- |
| The bridge records posted positions | `POST /traffic/track` with three points, two of them real samples and one at `0,0` | pass — `{"ok":true,"added":1}`: the duplicate and the `0,0` sentinel were refused, the real sample stored |
| A path reads back oldest first | `GET /traffic/trail?hex=4ca1b2` | pass — `{"ok":true,"hex":"4CA1B2","points":[[47.1,-122.3,12000.0,…]],"retentionSeconds":2700}`, the key normalised from lower case |
| A bad request says so | `GET /traffic/trail?hex=` | pass — 400 with “A hex address or callsign is required.” |
| The store survives a restart | stop the bridge, start it again, read the same trail | pass — the point written before the restart is served afterwards from `traffic_trails.json` |
| The page reports what it sees | live VATSIM feed, 35 s of polling | pass — fourteen aircraft recorded in the file (SWR219, GFA020, THA27LP, FDX4900, RYR2PW, THY1759, …), two samples each |
| A reload keeps the path | reload the page, click SWR219 | pass — the page had two live samples; after the backfill its trail held **five** points, the first **118 s** old, i.e. from before the reload, with the newest one current |
| Order is never rewound | bridge unit test with a stale sample posted after a fresh one | pass — the stale point is dropped instead of being appended at the end |
| Write cost | debounced save | 8 s between writes (`STRATOS_TRAFFIC_SAVE`, fixed), 360 samples and 45 minutes per aircraft, 400 aircraft overall |
| Suites | `npm test`, `python -m unittest tests.test_bridge` | 283 JavaScript and 53 bridge tests pass |

Limitations confirmed: the phone's live page did not show other traffic at that point (superseded by the phone-traffic entry above). The trail still begins when Stratos first observes an aircraft — VATSIM and the public ADS-B feeds publish only a current position. A hosted deployment without the bridge has no store, so trails there last as long as the page does.

## 2026-10-23 — a clicked aircraft's own path, for both traffic sources (Windows 11 x64)

Environment: Windows 11 x64, the real bridge on port 8765, Chromium, the live VATSIM feed (2–18 pilots in view depending on the area).

| Check | Method | Result |
| --- | --- | --- |
| The cause | reading the traffic path in the page | **failed, fixed** — ADS-B polling recorded trails, but the VATSIM refresh removed every VATSIM entry and pushed brand-new objects without recording a position, so no VATSIM aircraft ever had a trail and a selection could not survive a refresh |
| VATSIM pilots are recorded | live feed, 35 s of refreshes, `TRL` inspected | pass — eleven pilots each held a two-point trail after two refreshes (SWR219, THA671, THA27LP, FDX4900, RYR2PW, THY1759, DLH766, TVS1082, …), where the map previously held none |
| A click draws that aircraft's path | `sel = SWR219`, `fCard()`, canvas pixels read along its recorded points | pass — the line is stroked in the same altitude ramp: `rgb(240,104,144)` at FL362, alpha 255, with the card reporting “Trail 9 nm in 1 min” |
| The open card and selection survive a refresh | objects updated in place via `known.get(id)` | pass — the same object is mutated rather than replaced, and a selected pilot that leaves the view is kept until cleared |
| Both sources use one path | ADS-B `wtMerge` and VATSIM `vatsimTraffic` | pass — both call `trlAdd` with `hx||id`, and `trlGC` expires silent trails on the same cycle |
| Suites | `npm test` | 282 JavaScript tests pass |

Limitations confirmed: VATSIM and the public ADS-B feeds publish only a current position, so a target's trail begins when Stratos first observes it — there is no history to fetch and none is invented, and the card states how much has been recorded. The screenshot used to show this was taken from the live feed, not from stored data.

## 2026-10-23 — flown path drawn as an altitude-coloured trajectory (Windows 11 x64)

Environment: Windows 11 x64, Node v26.8.1, Python 3.15.0, Chromium through the app's own bridge on port 8765. The request was for the aircraft's path to look like a tracking app's trajectory — one continuous line, not a fading contrail — and to change colour with height, white on the ground.

| Check | Method | Result |
| --- | --- | --- |
| The path is one solid line, not a contrail | code path `drawTrail` | pass — a 6 px dark casing under a 3 px line, opaque (`globalAlpha` = 1); the old per-segment width/alpha taper and its colour constant are gone |
| The colour follows height above ground | `trailInk()` evaluated in the page | pass — `trailInk(0)` = `rgb(255,255,255)`, `trailInk(12000)` = `rgb(160,232,56)`, `trailInk(42000)` = `rgb(216,72,240)`, interpolated in 8-value steps between stops |
| The rendered pixels change with the climb | a 60-point synthetic track drawn on the live canvas, then `getImageData` at six points | pass — 0 ft `rgb(255,255,255)` white, 12,203 ft `rgb(168,232,56)`, 20,339 ft `rgb(255,201,65)`, 27,797 ft `rgb(248,137,71)`, 35,932 ft `rgb(240,104,144)`, every sample alpha 255 |
| A taxiway at a high-altitude airport still reads as ground | recorded samples carry AGL; `seedTrail` keeps it | pass — a track of `[430 ft MSL, AGL 0]`, `[12,000 ft, AGL 11,570]`, `[36,000 ft, AGL 35,570]` seeded into the map keeps its AGL and renders white, lime and rose |
| The bridge sends AGL with the recorded track | `stream_track` and `tests/test_bridge.py` | pass — a fifth value per point, `null` when the simulator gave none; the stream cache key now includes the first sample as well, because two flights can share a sample count and end time and would otherwise receive each other's points |
| The recording is not eroded | `seedTrail` refreshes from the bridge's whole-flight sample on every snapshot that grows | pass — a page opened mid-flight keeps the departure end instead of losing one point per telemetry frame |
| Suites | `npm test`, `python -m unittest discover -s tests -p 'test_*.py'` | 278 JavaScript and 60 Python tests pass |

The phone's small map now uses the same ramp from the shared module `app/js/lib/trailcolor.js`: rendered there, a 30-point track returned white at AGL 0, `rgb(136,224,80)` at 10,800 ft, `rgb(248,152,64)` at 25,200 ft and `rgb(224,80,200)` at 39,600 ft, while a preview without altitudes still drew the accent colour `#4d9fe8` exactly.

Limitations confirmed: a flight recorded by a bridge older than this change has no AGL per sample, so its trail is coloured by height above its lowest recorded altitude, which is the departure elevation for a flight recorded from the gate. The end-of-track marker dot still sits on top of the line in its own colour.

## 2026-10-23 — shipped SID/STAR dataset, and procedures with no runway leg (Windows 11 x64)

Environment: Windows 11 x64, Node v26.8.1, Python 3.15.0, X-Plane 12 (Steam, Navigraph Custom Data, AIRAC 2610), Chromium through the app's own bridge on port 8765. The dataset was built from the FAA's `CIFP_261029.zip` (cycle 2611, effective 2026-10-29) and OurAirports `runways.csv`; both are public domain / CC0 and only the converted JSON is committed.

| Check | Method | Result |
| --- | --- | --- |
| The dataset builds from the published source | `python scripts/build-navdata.py` | pass — 739 files, 738 airports with procedures, 2,124 SIDs, 1,946 STARs, 19,384 transitions, 8.3 MB; `index.json` carries cycle, effective date, coverage and the airport list |
| The simulator's data still wins | `GET /health`, `GET /procedures.json?airport=KSEA&kind=sid&id=SUMMA2` | pass — `/health` reports `navdata {source: 'Custom Data', cycle: '2610'}` **and** `navdata.dataset {cycle: '2611', airports: 738}`; SUMMA2 answers `source: X-Plane 12 CIFP (Custom Data)` |
| The dataset answers when the simulator's cycle lacks a procedure | real FAACIFP18 rows for `06FA` `VUUDU3` (absent from the installed 2610 data, present in 2611) | pass — `GET /procedures.json?airport=06FA&kind=star&id=VUUDU3` answers `source: FAA CIFP (FAACIFP18, United States)`, cycle 2611, with its ten en-route transitions and every fix resolved |
| Real legs, side by side with the simulator | `tests/procedures.test.mjs` against `navdata/cifp/KSEA.json` and `KPDX.json` | pass — KSEA `BANGR9`/16L is `RW16L → CAVOB → RENBE → RICHR → TOMRE → BANGR` from the 16L threshold `47.463794, -122.30775`; KPDX `HELNS6`/10L runs `BTG → … → RW10L`, i.e. it ends on the runway, not at the airport centre |
| **Procedures with no runway leg are no longer dropped** | 65.7% of the dataset's 4,070 procedures publish no runway transition (measured over the whole dataset); KLAX `ANJLL4` and `CHATY5` are real examples | **failed, fixed** — these previously produced “has no runway transition”, so nothing was drawn. The verified geometry is now returned instead: `ANJLL4`/24R with a KLAX plan gives `HAKMN → SHTNR → SMASH → SALYY → GLESN → ANJLL → CAANN → BOYEL → CRCUS` (`transition: HAKMN+ALL`, `runwayConnector: false`), `CHATY5` gives `CHATY → JOSUL → CASTA → GMN`, and the runway is **not** joined to either by a straight line. A trunk of one fix still refuses, because one point is not a path |
| The page follows the same path live | Chromium at `http://127.0.0.1:8765` with a stored KSEA→KLAX plan (SUMMA2/16L, ANJLL4/24R) | pass — `PROCG.star` holds `ANJLL, CAANN, BOYEL, CRCUS`, `PROCG.sid` holds `RW16L, NEVJO, SUMMA`, and the card note reads “ANJLL4 ALL legs from AIRAC 2610 · the source publishes no runway leg, so the runway is not joined”. No console errors, and the request count stayed at one per airport/kind/procedure |
| The plan's own legs are untouched | `tests/ui.test.mjs` (byte-for-byte route-line test) and the procedure block's “never edits the route” assertion | pass — the procedure layer still only reads `route`; the 12 px waypoint line is unchanged and the procedure path is painted beneath it |
| Packaging | `electron-builder.config.cjs` extraResources, PyInstaller steps in `.github/workflows/release.yml` | pass (static) — the app ships `bridge/navdata`, and each one-file bridge build passes `--add-data navdata/cifp`, which is where `stratos_cifp.find_dataset_dir()` looks (`here/navdata/cifp`, `sys._MEIPASS/navdata/cifp`, beside the frozen executable). Not exercised by an actual installer build here |
| Suites | `npm test`, `python -m unittest discover -s tests -p 'test_*.py'` | 277 JavaScript and 59 Python tests pass |

Limitations confirmed: the dataset covers United States airports only, so a European procedure needs a simulator that has it installed; approach procedures are returned by the bridge but not drawn by the map; arcs, turn radii, holds and leg terminators are reported, not synthesised; and a procedure with no published runway leg is drawn without a runway connection and says so rather than being completed by a straight line. An installer was not built here, so the packaged copies of `navdata` are verified by reading the configuration, not by running the artifact.

## 2026-10-23 — terminal procedure geometry from the simulator's own CIFP data (Windows 11 x64)

Environment: Windows 11 with X-Plane 12 installed through Steam (`C:\Program Files (x86)\Steam\steamapps\common\X-Plane 12`, Navigraph Custom Data, AIRAC 2610), the real bridge on port 8765 and Chromium. This round adds a navigation-data source, so every claim below was checked against the installed files, not only against fixtures.

| Check | Method | Result |
| --- | --- | --- |
| The bridge finds the simulator's data | `stratos_cifp.find_xplane_dir()` on this PC, and `/health` | pass — found the Steam install from `x-plane_install_12.txt`; `/health` reports `navdata: {available: true, cycle: '2610', source: 'Custom Data'}` |
| Real SID geometry | `GET /procedures.json?airport=KSEA&kind=sid&id=SUMMA2` | pass — `SUMMA2` returns the RW16L transition `NEVJO → SUMMA`, the RW16C/RW16R/34L/34R transitions and the BKE/LKV en-route transitions, each fix with real coordinates, plus the 16L threshold `47.463794, -122.30775` from the `RWY:` record |
| Real STAR geometry | `GET /procedures.json?airport=KPDX&kind=star&id=HELNS6` | pass — runway transitions RW03, RW10B, RW21 and RW28B, each `BTG → KPDX` and complete; the 28R threshold comes from the file |
| A fix the data cannot place is not invented | synthetic fixture with an unknown fix | pass — the transition lists the verified fixes, `skipped: 1`, `complete: false`, and the unknown name is absent (`tests/test_cifp.py`) |
| VOR/DME duplicates do not make a name ambiguous | real `BTG` (VOR record 3 and DME record 12, a few hundred metres apart) | **failed, fixed** — the two records were treated as two different places and BTG was dropped. Same ident in the same region within 0.02° is now one station; BTG resolves and HELNS6 is complete |
| Runway thresholds parse correctly | DMS `N47255222,W122182894` | pass — 47.431172, -122.30775 etc. A 9-digit longitude (previously rejected) is now read |
| The app draws only the runway connection the plan lacks | KSEA→KPDX plan with SUMMA2/16L and HELNS6/28R in Chromium | pass — the SID path is RW16L → NEVJO → SUMMA (stops at the first plan fix), the STAR path is BTG → RW28R, and the airport point is replaced by the threshold instead of drawing into the field and back out |
| The path is on the map and under the route line | canvas pixel sampling after fitting the route | pass — 36 cyan pixels on the SID threshold leg and 64 on the STAR leg; `drawProcedurePaths()` runs before the unchanged route-line statement, which still passes its byte-for-byte test |
| A missing transition is reported, not fabricated | plan with HELNS6/28R before the resolver fix, and a runway with no published transition | pass — card note reads “HELNS6 has no runway transition for 28R in this data”, and no path is drawn; after the fix it reads “HELNS6 28R transition from AIRAC 2610 · combined runway transition” |
| The AIRAC cycle is shown | card hint and payload | pass — `AIRAC 2610`, read from `cycle_info.txt`/`cycle.json` |
| Cost | first request per airport, then cached | ~1 s for the first airport (one pass over the 15 MB fix file and the 2.6 MB navaid file), then served from memory; the fetch is asynchronous and never blocks the map |
| Suites | `npm test`, `python -m unittest tests.test_bridge tests.test_cifp` | 275 JavaScript and 53 Python tests pass |

Limitations confirmed: this reads X-Plane 12's data on the PC running the bridge. A hosted page on another machine, or MSFS (proprietary navdata), gets no procedure geometry and says so. Only the runway transition is painted: the plan's own fixes still come from the plan, and arcs, turns and leg terminators are reported but not synthesised. No licensed navigation file is committed to the repository; the tests use a synthetic fixture in the same format.

## 2026-10-23 — phone reconnect, TOC/TOD cache, plan hand-off and traffic card (Windows 11 x64)

Environment: Windows 11 10.0.26300, Node v26.8.1, Python 3.15.0, the real bridge running from a temporary data directory on port 8765, Chromium previews at 1048x879, and X-Plane-style `DATA3` UDP rows fed from a test harness (`artifacts/simfeed.mjs`, test-only). No real X-Plane or MSFS session and no iPhone were available. Totals: **265 JavaScript tests** and **46 Python bridge tests**, all passing.

| Check | Method | Result |
| --- | --- | --- |
| Phone pairing without a code, QR or typed URL | real bridge; `curl` from the LAN address and from loopback | pass — `GET /pair/connect` from `192.168.50.157` answers 303 to `/live.html` and sets only the HttpOnly `stratos_phone` cookie; `/health` and `/stream` are 401 from the LAN without it and 200 with it; loopback is trusted and returns 303 without a cookie |
| Phone dashboard receives live telemetry | Chromium on `http://127.0.0.1:8765/live.html` with the UDP feed | pass — “Simulator live”, altitude/groundspeed/heading/vertical speed, aircraft position on the mini map, flight time advancing |
| Phone recovers after the bridge restarts | kill the bridge, watch the page, start it again | pass — status went `Simulator live` → `Connecting…` → `Simulator live` with telemetry flowing again, no reload and no user action |
| Desktop page recovers on its own | same restart, Flight Deck tab | pass — the EventSource reopened, `liveOk()` true, header returned to “Live from X-Plane” |
| TOC/TOD appear at all with a plan | Flight Deck with a 5-point KSEA→KPDX plan carrying plan altitudes | **failed, fixed** — `planTocTod()` cached an empty result from the first frame, before the deferred profile module loaded, so the markers never appeared. The cache key now includes whether `window.PROFILE` exists; re-checked: cruise 35,000 ft, TOC at 62 nm (SUMMA→BLUIT), TOD at 82 nm (BLUIT→CHINS), both from the plan's own altitudes |
| TOC/TOD follow the route, not a great circle | same route, markers read back from `planTocTod()` | pass — both are interpolated inside their own leg (`legIndex` 1 and 2), never beyond the segment, and a plan with no room returns `ok:false` instead of two stacked markers (`tests/profile.test.mjs`) |
| Airport symbols survive the planner→map hand-off | route from `stratos.activeRoute` with the planner's `airport`/`navaid` names | **failed, fixed** — the map only knew `apt`/`nav`, so a planned airport drew as an ordinary waypoint. `routeKindName()` normalises on load and `sendToMap` translates both directions; re-checked: kinds `apt, sid, air, wp, apt` |
| SID/STAR tags and the stored plan survive a Route Planner import | source + unit tests | **failed, fixed** — the planner dropped `is_sid_star`, `via_airway` and the SimBrief plan, so a plan imported there reached the map with every fix as an ordinary waypoint and a card with no procedures. It now keeps both tags, stores the normalised OFP and sends the same plan the Flight Deck import does (`tests/simbrief.test.mjs`, `tests/ui.test.mjs`) |
| Waypoint selection with a mouse | pointer events on the map canvas at BLUIT | pass — the point was selected, the route card opened with identifier, coordinates, planned altitude, distance from departure/previous/next, type and both connected legs |
| Selection is purple and does not touch the route line | canvas pixel comparison at a leg midpoint, before/during/after selection | pass — 471 purple pixels at the selected marker; the sampled route pixels were identical (`494110`) in all three states; the line statement itself is unchanged (locked by `tests/ui.test.mjs`) |
| Marker types stay distinct | `routeKind()` on a SID fix, an airway fix, an ordinary fix and both airports | pass — `sid`, `air`, `wp`, `apt` |
| Traffic card shows the target's own flight, not the PC's | synthetic VATSIM entry rendered through `fcAircraftHtml` | **failed, fixed** — `fcProcedures` fell back to the live PC flight's airports for every target. A target now uses its own filed `dep`/`arr`, and shows its filed route and planned cruise when the feed carries them; the synthetic ASA123 card reads KSEA → KPDX, “SUMMA2 SUMMA J523 BLUIT HRMNS3”, FL360, with SID/STAR honestly “not in the plan” |
| VATSIM filed route and cruise level | `parsePilots` unit test | pass — `cruiseFt` 36000 and the route text are kept; a pilot with no flight plan gets nulls |
| Tracking card minimizes to SID/STAR and runways | `fcProcHtml` with a stored plan | pass — SID SUMMA2 with `RWY 16L` under it, STAR HRMNS3 with `RWY 28R`; the same block is in both the expanded and minimized branches, and the expanded/minimized choice is remembered in `stratos.cardExpanded` |
| Flight trail is recorded, not decorative | `TRL.get('own')` after a fed flight | pass — 206 timestamped points from the first recorded position to the last (35,500 ft → 355 ft), each with lat/lon/alt/time; a new flight id clears the old trail, and the phone seeds from the same bridge track |
| Map cost per frame | 30 consecutive `draw()` calls with a 5-point route and a 206-point trail | 4.61 ms per frame at the normal profile (60 fps budget 16.7 ms); no route rebuild on telemetry, and the card only replaces its HTML when the rendered string changes |
| Aircraft photo through the bridge | `GET /api/photo?reg=N8312C` on the running bridge, then the app's own card | **added** — the bridge now proxies the Planespotters lookup for the pages it serves. The endpoint answered 200 with a published photo, 400 for `12345`, and the cached second request in 0.117 s; the card showed the real photo with “Planespotters © Mingfei S” and the registration, type, SID and STAR. Before this the bridge-served page had no photo route (404) |
| Watching a dead stream | restart the bridge with the Flight Deck tab open, then check the page | pass — the tab reopened the stream on its own (fresh payload within seconds) and now also reopens after twelve seconds of silence, which covers the half-open socket a restart can leave behind (`tests/ui.test.mjs`) |
| Whole suites | `npm test`, `python -m unittest tests.test_bridge` | 265/265 and 46/46 pass |

Limitations confirmed in this round: procedure geometry is limited to the fixes the imported plan lists — there is no CIFP/ARINC dataset here, so runway transitions and leg terminators are not synthesised and a plan that starts at the airport draws its SID from that node. No real simulator or iPhone was connected, so the UDP/SimConnect identity reads and Safari behaviour remain source-tested only.

## 2026-10-21 — route on the main Flight Deck map (2.1.16)

The planner writes `stratos.activeRoute` on every edit and the Flight Deck map reads it, so the route draws there without pressing a button. On load the map fits the route into view and keeps it updated when the planner changes it in another page. A Layers toggle (Route) hides and shows it. Checks: `npm test` 172/172 pass; `npm run test:py` passes. Chromium 1440x900 on a local static server, with a stored KSFO→KLAX route: the map fitted both airports, drew the dashed route with labels, and the screenshot is saved as `artifacts/route-main-map-2116.png`. The Windows installer was not rebuilt in this session.

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
| Published releases v2.1.14 and v2.1.15: each tag built on a Windows runner, `build-windows` and `verify-release` both succeeded, and each release carries `Stratos-Setup.exe`, its `.sha256`, `.blockmap`, `latest.yml`, `releases.json` and `release-notes.md` | GitHub Actions runs 39594119065 and the 2.1.15 run, `npm run release:check` against the live releases | pass — each manifest names its own version, its download points at that tag's installer and its checksum matches the published bytes |
| Update check against the live manifest: the app's own `checkForUpdate` reads `releases/latest/download/releases.json` and reports `current` for an installed 2.1.14 and `available` for 2.1.13, 2.1.10 and 2.0.0, naming the published installer URL and SHA256 | `node --input-type=module` against the real module and the real published manifest | pass |
| Windows update smoke workflow, first automatic run: the 2.1.15 release build succeeded and published six assets, and the smoke workflow it triggered installed 2.1.14, then failed while confirming the installed version. Two real defects: electron-builder lists the uninstall entry as “Stratos 2.1.14” (its `uninstallDisplayName` appends the version), so the exact `DisplayName -eq 'Stratos'` lookup never matched; and `runAfterFinish` launched the app after the silent install, so its single-instance lock would have blocked the `--update-smoke` run that follows | GitHub Actions run 39595858995, then reproduced locally with the published 2.1.14 installer | fixed — the lookup accepts the version-suffixed name (and `stratos-desktop`), the workflow stops the launched app and waits for it to exit, and the registry read is polled instead of read once |
| Windows update end to end, on a real installation: the published 2.1.14 installer (SHA256 matching the manifest) was installed silently on Windows 11, the installed app ran `--update-smoke`, downloaded and verified 2.1.15, wrote `{"downloadedVersion":"2.1.15","verified":true}` and ran the NSIS installer silently; the uninstall registry went from “Stratos 2.1.14” to “Stratos 2.1.15” and `Stratos.exe` from 2.1.14.0 to 2.1.15.0, with no Stratos process left running | `scripts/check-update-smoke.mjs --from 2.1.14 --to 2.1.15` plus registry and file-version reads | pass — this is the first time the download, verification and silent install have been exercised rather than asserted |
| Update prompting: a newer release is announced, the installed version never is, a dismissal suppresses the same build, a severity increase or republished notes raise it again, a missing network with a cached answer reports the cached release (and says so), and a corrupt cache is ignored | `node --test tests/updates.test.mjs` | pass |
| Changelog generation: conventional types and conservative keywords classify real commits, merge and version-bump commits are skipped, duplicates removed, uncertain changes land under Other, history is sorted with a stable `latest`, and the checked-in manifest matches the app version | `node --test tests/updates.test.mjs` | pass |
| Changelog honesty for 2.1.14 | The generator reads commit subjects, and this release landed as one squashed commit, so the published 2.1.14 notes list one feature (the commit subject) and one other change rather than the full scope. The notes written by hand for 2.1.14 in `release-notes/curated.json` fix this from 2.1.15 onward, whose published manifest carries them; the already-published 2.1.14 asset keeps the thin version it was built with. |
| Hand-written release notes: a curated entry replaces the generated summary and categories, a version without one falls back to its commits, an entry with no summary gets the generated one, and an empty entry, an unknown category or a key that is not a version fails rather than being dropped; the release build refuses an invalid file and leaves the manifest untouched | `node --test tests/updates.test.mjs` | 5/5 pass, including a real CLI run against a temporary manifest |
| Automatic update smoke test: the workflow triggers on a completed *Build Windows installer* run, skips failed and non-tag builds, checks out the release it is testing, and keeps `workflow_dispatch` for a hand-picked pair | YAML parse, and the 2.1.15 release producing a `workflow_run` smoke run with no one dispatching it | trigger and resolution pass; the run itself failed on the two installer defects above, both fixed and re-tested locally |
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
| Automatic update relaunching its own window at the new version | `--update-smoke` calls `quitAndInstall(true, false)`, which installs silently and deliberately does not relaunch, so the visible restart into the new build is not part of the smoke path. The installed version was confirmed from the registry and the exe instead. |
| Premium purchase and licence delivery | No payment provider or licence service is configured, so no purchase path was exercised. The entitlement check itself is implemented and tested (desktop IPC, licence endpoint, development override); the setup still required is listed in the app and in `SOURCES_AND_LICENSING.md`. |
| Charts for Canada, Europe or Australia | NAV CANADA, Airservices Australia and the European AIP publishers do not grant redistribution/display rights without a licence, so no adapter was added and no chart data for those regions is embedded. The registry reports the publisher and the missing licence instead of substituting a diagram; only a locally downloaded PDF can be opened. |
| Packaged Electron run of the chart viewer and entitlement IPC | The browser check used Chromium with a stubbed desktop bridge; the packaged app, its preload IPC and Electron's bundled Chromium were not launched here. The IPC handler, preload surface and gating rules are source-tested. |
| Multi-page procedure documents in the viewer | Every current FAA d-TPP document is a single page, so page navigation was exercised as UI state only (1 / 1); no multi-page document was available from an authorized source. |
| Interactive shell states in a real browser | The bar, both rail modes, the card, focus rings and responsive breakpoints were seen in browser screenshots. Hover, the resource-profile change and the Support dialog were exercised through DOM tests and computed styles only, and touch gestures were not available. |
| Chromium without a private library prefix | Playwright's Chromium could not start from the stock image (`libnspr4`, `libnss3`, `libatk*`, `libX*`, `libasound`, `libatspi` missing, and `playwright install-deps` needs `sudo`, which the container blocks). For this report the required Ubuntu 24.04 packages were downloaded and unpacked into a private prefix and exposed through `LD_LIBRARY_PATH` plus a minimal fontconfig file with DejaVu and Liberation fonts. A stock machine does not need that step. |
| GPU compositing, iPhone Safari, Home Screen install | The browser run was headless with software rasterisation and substituted fonts. Safari, touch gestures, PWA installation and GPU frame timing were not available. |
| Windows installer: packaged app launch and the update path | The NSIS installer for 2.1.14 was built on Windows 11 with electron-builder 26.15.3 (`npm run dist:win`, unsigned, `dist/Stratos-Setup.exe`, 99 MB, with `latest.yml` and a blockmap) and the same build is what the release published. The bundled `app.asar` was checked: version 2.1.14, the route-weather code present, no ChartFox and no CARTO URL, and the pdf.js compat shims present. Its Electron runtime was probed through `ELECTRON_RUN_AS_NODE=1` (Chromium 138.0.7204.251, V8 13.8), and `dist/win-unpacked/Stratos.exe --update-smoke` ran the packaged main process headlessly, read `resources/app-update.yml` (`owner: Nyclyy`, `repo: stratos-tracker`), checked GitHub and exited with an honest up-to-date receipt. The packaged **window** itself, its preload IPC and installing an older build by hand were not exercised here. |
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

## Website download offer

The public site offers the packaged build from the tracker itself, as website chrome only:

- `app/js/downloads.js` mounts only on an `https` page that is not loopback and has no `window.stratosDesktop`, so the packaged app (`file://`), the bridge's plain http page and a local dev server never render it.
- Installers come from `app/releases.json` — the table the release workflow writes for each tag, with its URL and size — and, only when that table is missing, from the GitHub release's own attached assets. No asset URL is built by hand, and a manifest that cannot be read leaves a link to the releases page instead of a dead button.
- Dismissal is stored per version: `×` hides the panel in place and leaves a `↓ Downloads` control that reopens it, and a later installer may ask once more.

Verified with `node scripts/dl-offer-check.mjs`, a real Chromium against `app/` served over https under a mapped, non-loopback host name: 14/14 checks — the panel lists the four published installers with the release's own URLs, it measures 436×221 and overlaps none of `#fab`, `#tabs`, the layers button or the location badge, the map stays mounted underneath, `×` hides it without a reload, the chip reopens it, a reload keeps it dismissed, a 390 px phone gets a 374 px panel clear of the bottom rail, and both the plain http page and the `file://` desktop page mount nothing. `npm test` runs 323 passing tests, including `tests/downloads.test.mjs`.

## Reproduce

```bash
npm ci
npm test
npm run test:py
npm run test:integration
node scripts/benchmark.mjs
npx playwright install chromium && node scripts/world-bench.mjs
node scripts/dl-offer-check.mjs   # the website download offer, over https

# Charts in a real browser (needs the bridge on 127.0.0.1:8765)
python stratos_bridge.py --no-sim &
npm install --no-save playwright && npx playwright install chromium
node scripts/chart-check.mjs
```

For a Windows installer, run the “Release” workflow (`.github/workflows/release.yml`) and check its “Build Windows installer” job, the “Check the build output” step and the “Publish release” job. Do not treat a started workflow as a built installer.
