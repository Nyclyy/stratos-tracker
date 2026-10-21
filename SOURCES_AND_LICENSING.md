# Sources and licensing

## Airport and navigation data

- **OurAirports** — public domain (CC0). CSV data is downloaded at runtime from `ourairports.com` / the maintained GitHub mirror and cached. Attribution is included in the UI even though CC0 does not require it.
- **OpenStreetMap** — Open Database License (ODbL). Airport layout/taxiway geometry is queried from the Overpass API (or the bridge cache). Main map tiles come from OpenStreetMap and Esri World Imagery (the World and Basic styles request no tiles at all); the Light, Dark, replay and route-preview surfaces use Esri's World Light/Dark Gray canvas, which needs no key or account. Attribution is shown on both map surfaces: “© OpenStreetMap contributors · Esri imagery” and “© Esri, HERE, Garmin · © OpenStreetMap contributors”. See https://openstreetmap.org/copyright and the respective provider terms.
- The bridge can build an offline data pack from these sources. The pack is user-generated and is not redistributed by the project.

## World map layer

- **Natural Earth** — public domain (no restrictions, no attribution required; credited anyway). The bundled file `app/js/data/world.js` is generated from the 1:110m `admin_0_countries`, `geography_regions_polys` and `geography_marine_polys` vectors by `scripts/build-world.mjs`, which rounds coordinates to two decimals and simplifies them. It contains country outlines and label points, continent label points and ocean/sea label points. No political boundary claim is intended: the outlines are the Natural Earth dataset as published, and borders are drawn as thin lines rather than as colours.
- The World style draws only this file. It makes no network request, so it works offline and needs no key. Rerun the build script with `--download` to regenerate it.

## Route Discovery

- Route recommendations are computed locally from the same airport records above: identifiers, coordinates, elevation and published runway lengths. Distances are great-circle distances; durations are estimates at a fixed cruise speed plus ground time, never ATC routings or winds.
- Terrain mentions come from a coarse set of geographic boxes (Alps, Rockies, Andes, Himalaya, Scandinavia, Iceland, Caribbean, Mediterranean, Japan, Hawaii, New Zealand, Patagonia, Southeast Asia, North Africa, Australia) sampled along the great circle. They describe terrain the path plausibly overflies, not a verified overflight of a specific landmark. No landmark, procedure, airway or navaid is invented.
- Storm Chasing is a **simulated** scenario. No live storm data is fetched or implied, and nothing on the page is real-world weather advice.
- Night Flight notes that lighting and city scenery depend on the user's simulator; no scenery database is queried.
- Preview map tiles are the same Esri gray-canvas tiles used by replay, with attribution shown in the corner of the map.

## Aircraft checklists

- Checklist content is a **simulator aid**, compiled from publicly documented Airbus/Boeing normal-flow structure and the publicly described ToLiss/FlightFactor add-on feature sets. No manufacturer manual, proprietary checklist card, or add-on EFB checklist file is copied, bundled or redistributed.
- Every profile is marked `community` and carries the same disclaimer in the UI: it is not verified against the aircraft manufacturer or the add-on manual and is not for real-world flight. The A340-600 profile describes the four-engine layout, fuel/trim-tank planning and long-haul considerations; it does not instruct the pilot to clear a normal ECAM memo such as `T TK XFRD`.
- Where the ToLiss EFB already provides a checklist, Stratos presents its own companion list and does not try to control or replace the aircraft's systems. No checklist item operates a switch automatically; the optional callouts are speech only and are off by default.
- Users can add, edit, import, export and reset their own checklist. A custom list is stored locally and remains labelled as unverified.

## QR code

The pairing QR is drawn by **qrcode-generator 1.4.4** by Kazuhiko Arase, vendored at `app/vendor/qrcode.js`. It is MIT licensed (`http://www.opensource.org/licenses/mit-license.php`) and is used only to encode the short-lived pairing URL on the PC; it makes no network request.

## Weather

- **NOAA Aviation Weather Center** — U.S. Government work, public domain. METAR/TAF are fetched from `https://aviationweather.gov/api/data/` either through `/api/weather` (Vercel) or the bridge’s `/weather`. Source and observation time are shown. NOAA availability is not guaranteed.
- **Route weather** reuses those same METARs for the airports on a planned route, at most eight stations per route. It reports the surface wind component against the course the route actually flies, and derives flight category only from reported visibility and ceiling. It does not claim winds aloft, turbulence, radar or simulator weather, and a station without a report is shown as unknown rather than estimated. This is real-world weather, kept visually separate from the simulator's own conditions.

## Traffic

- **adsb.fi**, **airplanes.live**, **adsb.lol**, **OpenSky Network** — community/public ADS-B sources with their own terms and rate limits. Aircraft shown are real reports from these providers. Stratos does not claim complete or worldwide coverage, and none of this is for real-world navigation.
- VATSIM METAR text is used as a fallback for VATSIM-style data in one legacy path; it is not an official weather source for flight planning.

## SimBrief

- The public SimBrief XML fetcher is used for route import when the user supplies a username or ID. SimBrief/Navigraph terms apply. No credentials are stored by Stratos.

## Charts

- **FAA Digital Terminal Procedures (d-TPP)** — U.S. Government work, public domain. Stratos reads the FAA's own `d-TPP_Metafile.xml` for the current 28-day cycle, so the catalogue carries the publisher's chart codes, titles, document names, amendment dates and the publication window. Documents are fetched on demand from `aeronav.faa.gov` (directly through the local bridge, or through Stratos' own narrow pass-through on the hosted site) and rendered in the app by the bundled pdf.js build. Stratos does not bundle, mirror or sell a chart library; the FAA PDFs stay on the FAA's servers and are cached on the user's own device only so the same chart is not downloaded twice.
- **Coverage** is exactly what the FAA publishes: airports in the United States and its territories. There is no invented coverage anywhere else; an airport without FAA charts gets an explicit "not covered / no charts" state instead of a generated diagram. Canada, Europe and Australia get links to the publisher that owns their charts, and the viewer can open a PDF the pilot downloaded from it.
- **Provider registry.** `app/js/lib/chartproviders.js` declares each provider's regions, categories, document format, update method, attribution and licence position. Only `faa-dtpp` has `status: 'integrated'`; the others are `link-only` (or EUROCONTROL's `portal` entries). The Charts page asks the registry before it fetches anything, so it cannot advertise a category for a region whose charts Stratos may not display.
- **Charts outside the United States are never mirrored.** NAV CANADA owns the Canada Air Pilot and its IFR charts and licenses them commercially. In Europe, DFS, LVNL, Avinor, Austro Control and PANSA require written permission to reproduce their AIS charts, and for the other states reviewed no third-party reuse grant was found. EUROCONTROL EAD Basic is free after registration but is a consultation tool, not an app feed. Airservices Australia publishes the Australian AIP and terminal procedures; no redistribution grant was found. The Charts page therefore links to the publisher (and the EUROCONTROL AIS index) instead of copying, framing or proxying anything.
- **Your own files.** A chart downloaded from one of those publishers can be opened with “Open PDF…”. The file is read from disk, rendered locally, never uploaded and never cached as an official document, and the viewer labels it as not coming from a verified source.
- **Which charts are free** is a product rule, not a licence term: these documents are public domain either way. ILS and LOC approach charts (including ILS OR LOC, LOC/DME and localizer-only procedures) open for everyone; diagrams, SIDs, STARs, RNAV/RNP, VOR, NDB and every other category are gated behind Stratos' own Premium entitlement. There is no daily quota on the free charts.
- **ChartFox** is not used at all: no redirect, no frame, no scraping. The old Flight Deck launcher pointed at `chartfox.org`; that path is gone.
- **NAV CANADA** publishes Canadian charts commercially (`NAV CANADA Aeronautical Publications`). Their terms do not grant redistribution or API display rights to a third-party app, so no Canadian charts are imported. A NAV CANADA adapter should only be added under a written licence; the catalogue and viewer are source-agnostic, and the provider registry has the entry ready to switch to `integrated` once a licence exists.
- **Airservices Australia** publishes the Australian AIP and terminal procedures. No redistribution grant was found, so Australian airports list the Airservices portal and use the same local-file path.
- **Jeppesen / Navigraph** charts are licensed per subscriber. They are never bundled, and a Stratos Premium entitlement is not a Jeppesen or Navigraph licence.
- **SkyVector, AirNav, OurAirports** remain optional outbound links from the airport page; they are not embedded and their terms are their own.

### Chart viewer and caching rules

- The catalogue request is answered by the bridge (`/charts?icao=`) or the hosted API (`/api/charts?icao=`). Both only ever read the FAA publication. An airport whose provider is not integrated is answered from the local registry without a network request, which is why a publisher link never looks like a failed chart fetch.
- A document request names a cycle and a PDF filename and nothing else: `^\d{4}$` for the cycle, `^[A-Z0-9]{1,12}\.PDF$` for the file. No arbitrary URL, header or credential is forwarded. The bridge refuses a document from a cycle other than the one it currently holds.
- Downloaded documents are cached in a separate IndexedDB database (`stratos_charts`), capped at 40 documents / 30 days. Clearing site data clears them.
- The FAA publication window from the metafile is shown with every chart. A document whose window has passed is labelled expired; if the window is missing it is labelled unverified. Stratos never calls a chart current without the publisher's dates.

## Relay and privacy

- The optional relay is part of this project. It stores SHA-256 token hashes and the latest telemetry snapshot; it does not store a flight history or user identity. It has no command channel to the simulator PC.
- No analytics, advertising SDK or third-party tracking is included. The logbook is local to the browser/desktop app; the relay is only used after the user explicitly pairs a phone.

## Project license

Stratos source code is released under the MIT License; see `LICENSE`. Third-party data, tiles, charts and APIs remain under their own licenses and terms. The MIT license does not grant rights to those datasets or to the Stratos name/logo beyond normal fair use.

---

**Attribution shown in the UI**

- Map: “© OpenStreetMap contributors · Esri imagery”.
- Weather: “NOAA Aviation Weather Center”, with observation time and a stale/error state.
- Airports: OurAirports links and source notes in the airport explorer.
- Charts: official provider links, with a note that generated diagrams are not official charts.

Stratos is not for real-world navigation.
