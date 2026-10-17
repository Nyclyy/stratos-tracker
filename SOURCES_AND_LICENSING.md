# Sources and Licensing

## Airport data
- **OurAirports** – public domain (CC0). CSV files are fetched at runtime from https://ourairports.com/data/. Attribution is not required, but we include a note for transparency.
- **OpenStreetMap** – Open Database License (ODbL). Map tiles are loaded from the official OSM tile server (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`). Attribution: "© OpenStreetMap contributors" with a link to https://openstreetmap.org/copyright.

## Weather data
- **NOAA Aviation Weather Center** – public domain data via the Aviation Weather API (https://aviationweather.gov/data/api/). No authentication is required. The data is served through our proxy (`/api/weather`) which respects the provider's caching guidelines.

## SimBrief
- **SimBrief public API** – free to use for personal projects. No authentication is required when requesting a plan with a public user ID. Documentation: https://developers.navigraph.com/docs/simbrief/introduction.

## Chart data
- **FAA Digital Terminal Procedures Publications (DTPP)** – public PDFs that may be linked directly. Redistribution is not permitted; we provide direct links to the official FAA site.
- **Canadian NAV CANADA charts** – similar restrictions; we provide links only.

## Licensing of this project
- The source code of Stratos‑project is released under the MIT License (see `LICENSE`).
- All new code added by this work is also MIT‑licensed.

---
**Attribution in the UI**
- The map widget displays the required OSM attribution at the lower‑right corner.
- Weather panels include a note: "Data from NOAA Aviation Weather Center (public domain)."
- Airport diagrams generated from OurAirports data include a banner: "Generated from OurAirports (public domain) – not official charts."
