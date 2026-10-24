#!/usr/bin/env python3
"""Build the bundled terminal-procedure dataset from public, redistributable data.

Two sources, both public domain / CC0:

* The FAA's Coded Instrument Flight Procedures (``FAACIFP18``), published in
  ARINC 424 fixed-width records. It carries the published SID and STAR legs in
  order, each leg's fix, region, section and path terminator, plus the airport,
  terminal-waypoint, en-route-waypoint and navaid records that give every fix a
  real coordinate. It covers United States airports.
* OurAirports ``runways.csv`` (CC0) for the runway threshold coordinates the FAA
  file does not carry.

The output is one JSON file per airport in the shape the bridge already returns
from ``stratos_cifp.build_airport``, so the app cannot tell which provider
produced it, plus an ``index.json`` describing the cycle and coverage.

Nothing is invented. A leg whose fix cannot be resolved is counted as
``skipped`` and its transition is marked ``complete: false``; a leg with no fix
at all (a heading or course leg off a runway) is simply not turned into a point.

Usage::

    python scripts/build-navdata.py                     # download both sources
    python scripts/build-navdata.py --cifp FAACIFP18 --runways runways.csv
    python scripts/build-navdata.py --airports KSEA,KPDX --out /tmp/navdata
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from stratos_cifp import dms_to_decimal  # noqa: E402  (same DMS form the bridge reads)

CIFP_LISTING = "https://aeronav.faa.gov/Upload_313-d/cifp/"
RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
DEFAULT_OUT = os.path.join(ROOT, "navdata", "cifp")
CACHE = os.path.join(ROOT, ".navdata-cache")

# Record layout of an ARINC 424 record in the FAA file, from the specification's
# Section 4.1.9.1 (Airport SID/STAR/Approach primary records).
SECTION = 4
AIRPORT = (6, 10)
ICAO_CODE = (10, 12)
SUBSECTION = 12
PROCEDURE = (13, 19)      # SID/STAR identifier: six characters
ROUTE_TYPE = 19
TRANSITION = (20, 25)
SEQUENCE = (26, 29)
FIX = (29, 34)
FIX_REGION = (34, 36)
FIX_SECTION = 36
FIX_SUBSECTION = 37
CONTINUATION = 38
TERMINATOR = (47, 49)

WAYPOINT_IDENT = (13, 19)  # waypoint, navaid and airport records
WAYPOINT_REGION = (19, 21)
LAT = (32, 41)
LON = (41, 51)

KINDS = {"D": "sid", "E": "star"}


def field(line, span):
    return line[span[0]:span[1]].strip() if isinstance(span, tuple) else line[span].strip()


def fetch(url, name):
    """Download once into .navdata-cache and reuse it."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return path
    print("download", url, flush=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Stratos-navdata/1"}), timeout=180) as response:
        data = response.read()
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def latest_cifp_url():
    """The newest CIFP archive in the FAA's directory listing."""
    with urllib.request.urlopen(urllib.request.Request(CIFP_LISTING, headers={"User-Agent": "Stratos-navdata/1"}), timeout=60) as response:
        listing = response.read().decode("utf-8", "replace")
    found = re.findall(r'CIFP_(\d{6})\.zip', listing)
    if not found:
        raise SystemExit("No CIFP archive is listed at " + CIFP_LISTING)
    return CIFP_LISTING + "CIFP_%s.zip" % max(found)


def cifp_text(source):
    """FAACIFP18 text from a local file, a zip, or the FAA URL of a zip."""
    if os.path.isfile(source):
        if source.lower().endswith(".zip"):
            with zipfile.ZipFile(source) as archive:
                name = next(n for n in archive.namelist() if n.upper().endswith("FAACIFP18"))
                return archive.read(name).decode("latin-1")
        with open(source, "r", encoding="latin-1") as handle:
            return handle.read()
    url = source if source.startswith("http") else latest_cifp_url()
    cycle = re.search(r"CIFP_(\d{6})", url)
    path = fetch(url, "CIFP_%s.zip" % (cycle.group(1) if cycle else "latest"))
    with zipfile.ZipFile(path) as archive:
        name = next(n for n in archive.namelist() if n.upper().endswith("FAACIFP18"))
        return archive.read(name).decode("latin-1")


def runways_csv(source):
    if os.path.isfile(source):
        with open(source, "r", encoding="utf-8", newline="") as handle:
            return handle.read()
    with urllib.request.urlopen(urllib.request.Request(source, headers={"User-Agent": "Stratos-navdata/1"}), timeout=180) as response:
        return response.read().decode("utf-8", "replace")


def parse_runways(text):
    """airport ident -> {designator: {lat, lon}} from OurAirports runways.csv."""
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        ident = (row.get("airport_ident") or "").strip().upper()
        if not ident or (row.get("closed") or "").strip() == "1":
            continue
        per_airport = out.setdefault(ident, {})
        for side in ("le", "he"):
            designator = (row.get("%s_ident" % side) or "").strip().upper()
            if not re.fullmatch(r"\d{2}[LRCB]?", designator):
                continue
            try:
                lat = float(row.get("%s_latitude_deg" % side) or "")
                lon = float(row.get("%s_longitude_deg" % side) or "")
            except ValueError:
                continue
            if -90 <= lat <= 90 and -180 <= lon <= 180 and designator not in per_airport:
                per_airport[designator] = {"lat": round(lat, 6), "lon": round(lon, 6)}
    return {ident: runways for ident, runways in out.items() if runways}


def scan(lines):
    """Collect the fix indexes and the SID/STAR rows, one pass over the file."""
    waypoints = {}
    enroute = {}
    navaids = {}
    airports = {}
    procedures = {}

    def coordinate(line):
        lat = dms_to_decimal(line[LAT[0]:LAT[1]])
        lon = dms_to_decimal(line[LON[0]:LON[1]])
        if lat is None or lon is None:
            return None
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return None
        return (round(lat, 6), round(lon, 6))

    for line in lines:
        if len(line) < 60 or line[0] != "S":
            continue
        section = line[SECTION]
        if section == "P":
            subsection = line[SUBSECTION]
            airport = line[AIRPORT[0]:AIRPORT[1]].strip().upper()
            if subsection == "A":
                point = coordinate(line)
                if point and re.fullmatch(r"[A-Z0-9]{4}", airport):
                    airports.setdefault(airport, point)
            elif subsection == "C":
                point = coordinate(line)
                ident = field(line, WAYPOINT_IDENT).upper()
                if point and ident:
                    waypoints.setdefault(ident, []).append(
                        (point[0], point[1], airport, field(line, WAYPOINT_REGION).upper()))
            elif subsection in KINDS:
                row = {
                    "kind": KINDS[subsection],
                    "airport": airport,
                    "procedure": field(line, PROCEDURE).upper(),
                    "transition": field(line, TRANSITION).upper(),
                    "sequence": field(line, SEQUENCE),
                    "fix": field(line, FIX).upper(),
                    "region": field(line, FIX_REGION).upper(),
                    "section": line[FIX_SECTION].upper(),
                    "subsection": line[FIX_SUBSECTION].upper(),
                    "terminator": field(line, TERMINATOR).upper(),
                    "continuation": line[CONTINUATION],
                }
                if not row["procedure"]:
                    continue
                # A continuation record repeats a leg with extra fields; the
                # primary record already carries the leg itself.
                if row["continuation"] not in ("0", " ", ""):
                    continue
                procedures.setdefault(airport, []).append(row)
        elif section in ("E", "D"):
            point = coordinate(line)
            ident = field(line, WAYPOINT_IDENT).upper()
            if not point or not ident:
                continue
            target = enroute if section == "E" else navaids
            target.setdefault(ident, []).append(
                (point[0], point[1], field(line, WAYPOINT_REGION).upper()))
    return waypoints, enroute, navaids, airports, procedures


def resolve_fix(row, airport, runways, waypoints, enroute, navaids, airports):
    """The coordinate for one procedure leg, or None when the data cannot place it."""
    ident = row["fix"]
    if not ident:
        return None
    runway = re.fullmatch(r"RW(\d{2}[LRCB]?)", ident)
    if runway:
        threshold = (runways.get(airport) or {}).get(runway.group(1))
        return threshold
    region = row["region"]
    section = row["section"]
    if section == "P" and row["subsection"] == "C":
        here = [c for c in waypoints.get(ident, []) if c[2] == airport]
        if not here and region:
            here = [c for c in waypoints.get(ident, []) if c[3] == region]
        candidates = here or ways(waypoints.get(ident, []))
    elif section == "P" and row["subsection"] == "A" or section == "A":
        # The airport reference point: a STAR's "expect vectors" leg, and the
        # point a procedure record names for the field itself.
        point = airports.get(ident)
        candidates = [point] if point else []
    elif section == "E":
        here = [c for c in enroute.get(ident, []) if c[2] == region]
        candidates = here or ways(enroute.get(ident, []))
    elif section == "D":
        here = [c for c in navaids.get(ident, []) if c[2] == region]
        candidates = here or ways(navaids.get(ident, []))
    else:
        candidates = ways(waypoints.get(ident, [])) + ways(enroute.get(ident, [])) + ways(navaids.get(ident, []))
    if len(candidates) != 1:
        return None
    return {"lat": candidates[0][0], "lon": candidates[0][1]}


def ways(entries):
    """Distinct coordinates from an ident's candidates; several places is no answer."""
    distinct = {(round(entry[0], 5), round(entry[1], 5)) for entry in entries}
    if len(distinct) != 1:
        return []
    return [(entries[0][0], entries[0][1])]


def build_airport(airport, rows, runways, waypoints, enroute, navaids, airports, source, cycle):
    """The payload shape stratos_cifp.build_airport returns, from ARINC 424 rows."""
    grouped = {}
    for row in rows:
        grouped.setdefault(row["kind"], {}).setdefault(row["procedure"], {}).setdefault(row["transition"], []).append(row)
    kinds = {}
    for kind in ("sid", "star"):
        procedures = []
        for name in sorted(grouped.get(kind, {})):
            transitions = []
            for transition in sorted(grouped[kind][name]):
                ordered = sorted(grouped[kind][name][transition], key=lambda r: r["sequence"])
                points = []
                skipped = 0
                seen = set()
                for row in ordered:
                    if not row["fix"]:
                        # A heading or course leg has no fix; it is not turned
                        # into a point, and the runway threshold supplies the
                        # start of a runway transition.
                        continue
                    point = resolve_fix(row, airport, runways, waypoints, enroute, navaids, airports)
                    if not point:
                        skipped += 1
                        continue
                    entry = {"id": row["fix"], "lat": point["lat"], "lon": point["lon"]}
                    if row["fix"].startswith("RW"):
                        entry["runway"] = True
                    entry["terminator"] = row["terminator"]
                    key = (row["fix"], round(point["lat"], 5), round(point["lon"], 5))
                    if key in seen:
                        continue
                    seen.add(key)
                    points.append(entry)
                if not points:
                    continue
                # The designator the transition belongs to: 16L for RW16L, and
                # 16 for the combined RW16B, matching stratos_cifp._runway_of.
                runway = ""
                number = re.fullmatch(r"RW(\d{2})([LRCB]?)", transition)
                if number:
                    runway = number.group(1) + ("" if number.group(2) == "B" else number.group(2))
                transitions.append({
                    "id": transition,
                    "runway": runway,
                    "combined": bool(re.fullmatch(r"RW\d{2}B", transition)),
                    "points": points,
                    "skipped": skipped,
                    "complete": skipped == 0,
                })
            if transitions:
                procedures.append({"id": name, "transitions": transitions})
        if procedures:
            kinds[kind] = procedures
    if not kinds:
        return None
    return {
        "ok": True,
        "airport": airport,
        "source": source,
        "cycle": cycle,
        "runways": runways.get(airport, {}),
        "procedures": kinds,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cifp", default="", help="FAACIFP18 file, CIFP zip, or FAA zip URL")
    parser.add_argument("--runways", default=RUNWAYS_URL, help="OurAirports runways.csv path or URL")
    parser.add_argument("--out", default=DEFAULT_OUT, help="output directory")
    parser.add_argument("--airports", default="", help="comma separated ICAO codes to build only")
    parser.add_argument("--cycle", default="", help="AIRAC cycle, read from the file when omitted")
    args = parser.parse_args(argv)

    text = cifp_text(args.cifp or latest_cifp_url())
    header = text[:1500]
    air_cycle = args.cycle or (re.search(r"VOLUME (\d{4})", header) or [None, ""])[1]
    effective = ""
    found = re.search(r"EFFECTIVE (\d{2} [A-Z]{3} \d{4})", header)
    if found:
        effective = dt.datetime.strptime(found.group(1), "%d %b %Y").date().isoformat()
    lines = text.splitlines()
    print("records", len(lines), "cycle", air_cycle or "?", "effective", effective or "?")

    runways = parse_runways(runways_csv(args.runways))
    waypoints, enroute, navaids, airports, procedures = scan(lines)
    print("airports", len(airports), "terminal waypoints", len(waypoints),
          "en-route waypoints", len(enroute), "navaids", len(navaids),
          "airports with SID/STAR rows", len(procedures))

    wanted = {code.strip().upper() for code in args.airports.split(",") if code.strip()}
    os.makedirs(args.out, exist_ok=True)
    source = "FAA CIFP (FAACIFP18, United States)"
    index = {}
    written = 0
    for airport in sorted(procedures):
        if wanted and airport not in wanted:
            continue
        payload = build_airport(airport, procedures[airport], runways, waypoints, enroute,
                                navaids, airports, source, air_cycle)
        if not payload:
            continue
        target = os.path.join(args.out, airport + ".json")
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
        index[airport] = {kind: len(items) for kind, items in payload["procedures"].items()}
        written += 1

    manifest = {
        "format": 1,
        "source": source,
        "cycle": air_cycle,
        "effective": effective,
        "generated": dt.date.today().isoformat(),
        "coverage": "United States airports that publish SID and STAR procedures",
        "runwaySource": "OurAirports runways.csv (CC0)",
        "airports": index,
    }
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)
        handle.write("\n")
    print("wrote", written, "airport files to", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
