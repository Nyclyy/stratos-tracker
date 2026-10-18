# Sources and licensing

## Airport and navigation data

- **OurAirports** — public domain (CC0). CSV data is downloaded at runtime from `ourairports.com` / the maintained GitHub mirror and cached. Attribution is included in the UI even though CC0 does not require it.
- **OpenStreetMap** — Open Database License (ODbL). Airport layout/taxiway geometry is queried from the Overpass API (or the bridge cache). Main map tiles come from OpenStreetMap and Esri World Imagery; replay/route preview tiles come from CARTO. Attribution is shown on both map surfaces: “© OpenStreetMap contributors · Esri imagery” and “© OpenStreetMap contributors · © CARTO”. See https://openstreetmap.org/copyright and the respective provider terms.
- The bridge can build an offline data pack from these sources. The pack is user-generated and is not redistributed by the project.

## Route Discovery

- Route recommendations are computed locally from the same airport records above: identifiers, coordinates, elevation and published runway lengths. Distances are great-circle distances; durations are estimates at a fixed cruise speed plus ground time, never ATC routings or winds.
- Terrain mentions come from a coarse set of geographic boxes (Alps, Rockies, Andes, Himalaya, Scandinavia, Iceland, Caribbean, Mediterranean, Japan, Hawaii, New Zealand, Patagonia, Southeast Asia, North Africa, Australia) sampled along the great circle. They describe terrain the path plausibly overflies, not a verified overflight of a specific landmark. No landmark, procedure, airway or navaid is invented.
- Storm Chasing is a **simulated** scenario. No live storm data is fetched or implied, and nothing on the page is real-world weather advice.
- Night Flight notes that lighting and city scenery depend on the user's simulator; no scenery database is queried.
- Preview map tiles are the same CARTO/OpenStreetMap tiles used by replay, with attribution shown under the map.

## Weather

- **NOAA Aviation Weather Center** — U.S. Government work, public domain. METAR/TAF are fetched from `https://aviationweather.gov/api/data/` either through `/api/weather` (Vercel) or the bridge’s `/weather`. Source and observation time are shown. NOAA availability is not guaranteed.

## Traffic

- **adsb.fi**, **airplanes.live**, **adsb.lol**, **OpenSky Network** — community/public ADS-B sources with their own terms and rate limits. Aircraft shown are real reports from these providers. Stratos does not claim complete or worldwide coverage, and none of this is for real-world navigation.
- VATSIM METAR text is used as a fallback for VATSIM-style data in one legacy path; it is not an official weather source for flight planning.

## SimBrief

- The public SimBrief XML fetcher is used for route import when the user supplies a username or ID. SimBrief/Navigraph terms apply. No credentials are stored by Stratos.

## Charts

- **FAA Digital Terminal Procedures (dTPP)** are U.S. Government works. Stratos links to the official `aeronav.faa.gov` PDFs and may display them in an embedded viewer. It does not redistribute a chart library.
- **ChartFox, SkyVector, AirNav, Navigraph/Jeppesen** are linked, not copied. Jeppesen charts are licensed per subscriber and are never bundled.
- **NAV CANADA** and other national AIP charts remain subject to their publishers’ terms; only links are provided.

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
