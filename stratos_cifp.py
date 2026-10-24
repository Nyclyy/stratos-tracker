"""Terminal procedure geometry from real navigation data.

Two providers, in this order:

* The simulator's own data on the pilot's PC. X-Plane 12 writes a comma
  separated ARINC 424 adaptation in its CIFP folder, together with the fix,
  navaid and runway coordinates in ``earth_fix.dat``, ``earth_nav.dat`` and the
  ``RWY:`` records of the same CIFP file.
* The dataset Stratos ships in ``navdata/cifp`` (see ``scripts/build-navdata.py``):
  the FAA's public-domain Coded Instrument Flight Procedures, converted to one
  file per airport, with runway thresholds from OurAirports. It covers United
  States airports and is used when the simulator has no data for the airport
  (MSFS, or no X-Plane installed).

Both providers return the published legs, in order, with real coordinates.

Rules kept deliberately strict:

* Only a leg whose fix can be resolved to a coordinate is returned. A leg that
  cannot be resolved is counted as ``skipped`` and the transition is marked
  ``complete: False``, so the app can say the path is partial.
* A runway transition is identified by the ARINC 424 name the file itself uses
  (``RW16L``, and ``RW16B`` for the combined "both" transition); nothing is
  inferred from an aircraft's position.
* No arc, turn radius, heading leg or leg terminator is synthesised. A leg is
  the straight segment between its fix and the next one, and the leg terminator
  is reported alongside it so the caller knows what the source actually said.
* Nothing is written back: this reads the simulator's files and never edits
  them.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import threading
import time

# Kinds as they appear in a CIFP file and as the app names them.
CIFP_KINDS = {"SID": "sid", "STAR": "star", "APPCH": "approach"}
MAX_POINTS_PER_TRANSITION = 200

# The procedure dataset shipped with Stratos, in the same shape this module
# returns for the simulator's own files.
def find_dataset_dir():
    """Where this build keeps ``navdata/cifp``.

    In a source checkout it sits next to this file. A PyInstaller one-file
    bridge unpacks it under ``sys._MEIPASS``, and the packaged Electron app
    copies it beside the bridge script, so all three are tried. The variable
    lets a test or a custom install point at another copy.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.environ.get("STRATOS_NAVDATA_DIR", "").strip(),
                  os.path.join(here, "navdata", "cifp")]
    bundle = getattr(sys, "_MEIPASS", "")
    if bundle:
        candidates.append(os.path.join(bundle, "navdata", "cifp"))
    if getattr(sys, "frozen", False):
        base = os.path.dirname(os.path.abspath(sys.executable))
        candidates.extend([os.path.join(base, "navdata", "cifp"),
                           os.path.join(os.path.dirname(base), "navdata", "cifp")])
    for candidate in candidates:
        if candidate and os.path.isdir(candidate):
            return candidate
    return os.path.join(here, "navdata", "cifp")


DATASET_DIR = find_dataset_dir()

_LOCK = threading.Lock()


# ── Locating the simulator's data ──────────────────────────────────
def _install_files():
    """Files X-Plane leaves behind that name its install directory."""
    home = os.path.expanduser("~")
    paths = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "x-plane_install_12.txt"),
        os.path.join(home, "Library", "Preferences", "x-plane_install_12.txt"),
        os.path.join(home, ".x-plane", "x-plane_install_12.txt"),
        os.path.join(home, ".x-plane", "x-plane_install_11.txt"),
    ]
    return [path for path in paths if path and os.path.isfile(path)]


def _default_dirs():
    return [
        r"C:\X-Plane 12",
        r"C:\Program Files\X-Plane 12",
        r"C:\Program Files (x86)\X-Plane 12",
        r"C:\Program Files (x86)\Steam\steamapps\common\X-Plane 12",
        r"C:\Program Files\Steam\steamapps\common\X-Plane 12",
        "/Applications/X-Plane 12",
        os.path.expanduser("~/X-Plane 12"),
    ]


def _looks_like_xplane(directory):
    return any(os.path.isdir(os.path.join(directory, *parts)) for parts in (
        ("Custom Data", "CIFP"),
        ("Resources", "default data", "CIFP"),
    ))


def find_xplane_dir(explicit: str = "") -> str:
    """The X-Plane folder that holds CIFP data, or an empty string."""
    candidates = []
    if explicit:
        candidates.append(explicit)
    override = os.environ.get("STRATOS_XPLANE_DIR", "").strip()
    if override:
        candidates.append(override)
    for install_file in _install_files():
        try:
            with open(install_file, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    found = line.strip()
                    if found:
                        candidates.append(found)
        except OSError:
            continue
    candidates.extend(_default_dirs())
    seen = set()
    for candidate in candidates:
        directory = os.path.normpath(os.path.expanduser(candidate))
        if directory in seen:
            continue
        seen.add(directory)
        # A CIFP directory itself is accepted, so the variable can point at it.
        if os.path.basename(directory).upper() == "CIFP" and os.path.isdir(directory):
            parent = os.path.dirname(directory)
            return os.path.dirname(parent) if os.path.basename(parent) == "Custom Data" else parent
        if os.path.isdir(directory) and _looks_like_xplane(directory):
            return directory
    return ""


def data_dirs(xplane_dir: str):
    """Directories to read, newest first: Custom Data then the shipped default."""
    if not xplane_dir:
        return []
    return [
        os.path.join(xplane_dir, "Custom Data"),
        os.path.join(xplane_dir, "Resources", "default data"),
    ]


def read_cycle(xplane_dir: str) -> dict:
    """The AIRAC cycle the simulator's data says it is, or an empty record."""
    for directory in data_dirs(xplane_dir):
        for name in ("cycle_info.txt", "cycle.json"):
            path = os.path.join(directory, name)
            if not os.path.isfile(path):
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    text = handle.read(400)
            except OSError:
                continue
            found = re.search(r"cycle\D{0,12}(\d{4})", text, re.IGNORECASE)
            if found:
                return {"cycle": found.group(1), "source": "Custom Data" if "Custom" in directory else "X-Plane default data"}
    return {}


# ── Coordinates ────────────────────────────────────────────────────
def dms_to_decimal(text: str):
    """``N47274966`` / ``W122182790`` as a signed decimal degree, or None."""
    value = str(text or "").strip().upper()
    match = re.fullmatch(r"([NSEW])(\d{5,9})", value)
    if not match:
        return None
    hemisphere, digits = match.group(1), match.group(2)
    degrees = len(digits) - 6
    if degrees < 2:
        return None
    try:
        whole = int(digits[:degrees])
        minutes = int(digits[degrees:degrees + 2])
        seconds = int(digits[degrees + 2:]) / 100.0
    except ValueError:
        return None
    if minutes >= 60 or seconds >= 60:
        return None
    decimal = whole + minutes / 60.0 + seconds / 3600.0
    return -decimal if hemisphere in ("S", "W") else decimal


def parse_runways(lines):
    """Runway designator -> threshold coordinate, from the file's RWY: records."""
    runways = {}
    for line in lines:
        if not line.startswith("RWY:"):
            continue
        designator = line[4:].split(",", 1)[0].strip().upper()
        tail = line.split(";", 1)
        if len(tail) < 2 or not designator:
            continue
        parts = tail[1].split(",")
        if len(parts) < 2:
            continue
        lat = dms_to_decimal(parts[0])
        lon = dms_to_decimal(parts[1])
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        # Keyed by the designator the plan and the app use (16L), not the
        # file's RW16L, so a plan's runway matches a CIFP transition directly.
        runways[designator[2:] if designator.startswith("RW") else designator] = {
            "lat": round(lat, 6), "lon": round(lon, 6)}
    return runways


# ── CIFP rows ──────────────────────────────────────────────────────
def parse_rows(lines):
    """Procedure rows as dictionaries, in the file's own order.

    A row is ``SID:010,4,BANGR9,RW16C,OTLIE,K1,P,C,EY  , ,   ,DF,...``; the
    fields used here are the sequence, the procedure, its transition, the fix,
    the fix's region, its section and the leg terminator. Nothing else is read.
    """
    rows = []
    for line in lines:
        head, _, rest = line.partition(",")
        kind = head.split(":", 1)[0].upper() if ":" in head else ""
        if kind not in CIFP_KINDS:
            continue
        try:
            sequence = int(head.split(":", 1)[1])
        except (IndexError, ValueError):
            continue
        fields = rest.split(",")
        if len(fields) < 12:
            continue
        # rest starts after "SID:<sequence>", so: route type, procedure,
        # transition, fix, region, section, subsection, description, turn,
        # blank, terminator.
        ident = (fields[1] or "").strip().upper()
        if not ident:
            continue
        rows.append({
            "kind": CIFP_KINDS[kind],
            "sequence": sequence,
            "procedure": ident,
            "transition": (fields[2] or "").strip().upper(),
            "fix": (fields[3] or "").strip().upper(),
            "region": (fields[4] or "").strip().upper(),
            "section": (fields[5] or "").strip().upper(),
            "subsection": (fields[6] or "").strip().upper(),
            "description": (fields[7] or "").strip().upper(),
            "terminator": (fields[10] or "").strip().upper(),
        })
    rows.sort(key=lambda row: (row["kind"], row["procedure"], row["transition"], row["sequence"]))
    return rows


# ── Coordinate lookup ──────────────────────────────────────────────
class FixResolver:
    """Resolves idents through earth_fix.dat and earth_nav.dat.

    Both files are large (earth_fix.dat is tens of megabytes), so each ident is
    scanned for once and every candidate is remembered; the geometry builder
    resolves a whole airport in one pass, not one fix at a time. A name that
    exists in several places is only used when the airport, or the region the
    CIFP file names, picks exactly one of them.
    """

    def __init__(self, directories, airports):
        self.directories = list(directories or [])
        self.airports = set(airports or [])
        self.cache = {}

    def _files(self, name):
        return [path for path in (os.path.join(directory, name) for directory in self.directories) if os.path.isfile(path)]

    def resolve(self, idents, airport="", regions=None):
        """{ident: (lat, lon)} for the idents this airport can identify."""
        wanted = {str(ident or "").upper() for ident in idents if ident}
        if not wanted:
            return {}
        regions = regions or {}
        with _LOCK:
            missing = {ident for ident in wanted if ident not in self.cache}
            if missing:
                self.cache.update(self._scan(missing))
            answers = {}
            for ident in wanted:
                candidates = self.cache.get(ident) or []
                if not candidates:
                    continue
                here = [c for c in candidates if c[2] == airport]
                if not here:
                    wanted_regions = {str(value).upper() for value in (regions.get(ident) or ()) if value}
                    here = [c for c in candidates if c[3] in wanted_regions]
                if not here:
                    # One place only is an answer; several are not.
                    here = candidates if len({(round(c[0], 5), round(c[1], 5)) for c in candidates}) == 1 else []
                if len({(round(c[0], 5), round(c[1], 5)) for c in here}) != 1:
                    continue
                answers[ident] = (here[0][0], here[0][1])
            return answers

    def _scan(self, wanted):
        found = {}

        def offer(ident, lat, lon, airport, region):
            if ident not in wanted:
                return
            entries = found.setdefault(ident, [])
            for entry in entries:
                if entry[2] == airport and abs(entry[0] - lat) < 1e-6 and abs(entry[1] - lon) < 1e-6:
                    return
                # A VOR and its DME are one station: the same ident in the same
                # region a few hundred metres apart is not a second candidate.
                if entry[3] == region and abs(entry[0] - lat) < 0.02 and abs(entry[1] - lon) < 0.02:
                    return
            entries.append((lat, lon, airport, region))

        for path in self._files("earth_fix.dat"):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    for line in handle:
                        parts = line.split()
                        if len(parts) < 5 or parts[0].startswith(("I", "A", "1200", "Copyright")):
                            continue
                        try:
                            lat, lon = float(parts[0]), float(parts[1])
                        except ValueError:
                            continue
                        offer(parts[2].upper(), lat, lon, parts[3].upper(), parts[4].upper())
            except OSError:
                continue

        for path in self._files("earth_aptmeta.dat"):
            # Airport reference points, so a procedure that ends at its airport
            # (a STAR's "expect vectors" leg) still has a real coordinate.
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    for line in handle:
                        parts = line.split()
                        if len(parts) < 4:
                            continue
                        identifier = parts[0].upper()
                        if len(identifier) != 4 or not identifier.isalnum():
                            continue
                        try:
                            lat, lon = float(parts[2]), float(parts[3])
                        except ValueError:
                            continue
                        offer(identifier, lat, lon, identifier, parts[1].upper())
            except OSError:
                continue

        for path in self._files("earth_nav.dat"):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    for line in handle:
                        parts = line.split()
                        # type lat lon elev freq range bearing ident airport region ...
                        if len(parts) < 10:
                            continue
                        try:
                            int(parts[0])
                            lat, lon = float(parts[1]), float(parts[2])
                        except ValueError:
                            continue
                        offer(parts[7].upper(), lat, lon, parts[8].upper(), parts[9].upper())
            except OSError:
                continue

        return found


# ── Procedures ─────────────────────────────────────────────────────
def _transition_points(rows, resolved, runways):
    """Ordered points for one transition, plus how many legs were skipped."""
    points = []
    skipped = 0
    seen = set()
    for row in rows[:MAX_POINTS_PER_TRANSITION]:
        fix = row["fix"]
        if not fix:
            # A heading or course leg has no fix. The runway transition starts
            # at a threshold, which is supplied by the caller; the leg itself is
            # not turned into an invented point.
            continue
        runway_key = fix[2:] if fix.startswith("RW") else fix
        if row["section"] == "R" and runway_key in runways:
            point = {"id": fix, "lat": runways[runway_key]["lat"], "lon": runways[runway_key]["lon"], "runway": True}
        else:
            coordinate = resolved.get(fix)
            if not coordinate:
                skipped += 1
                continue
            point = {"id": fix, "lat": round(coordinate[0], 6), "lon": round(coordinate[1], 6)}
        point["terminator"] = row["terminator"]
        key = (point["id"], round(point["lat"], 5), round(point["lon"], 5))
        if key in seen:
            # A repeated fix in a transition is part of a hold or a turn-back;
            # it is not drawn twice, but the leg count stays honest.
            continue
        seen.add(key)
        points.append(point)
    return points, skipped


def _runway_of(transition):
    match = re.fullmatch(r"RW(\d{2})([LRCB])", transition or "")
    if not match:
        return ""
    return match.group(1) + ("" if match.group(2) == "B" else match.group(2))


def build_airport(cifp_text, airport, resolver, source="X-Plane 12 CIFP", cycle=""):
    """Procedures for one airport, from the text of its CIFP file."""
    lines = [line.rstrip("\r\n") for line in cifp_text.splitlines()]
    runways = parse_runways(lines)
    rows = parse_rows(lines)
    # One pass over the simulator's fix and navaid files for the whole airport.
    regions = {}
    idents = set()
    for row in rows:
        fix = row["fix"]
        if not fix:
            continue
        idents.add(fix)
        if row["region"]:
            regions.setdefault(fix, set()).add(row["region"])
    resolved = resolver.resolve(idents, airport=airport, regions=regions)
    out = {}
    for kind in CIFP_KINDS.values():
        grouped = {}
        for row in rows:
            if row["kind"] != kind:
                continue
            procedure = grouped.setdefault(row["procedure"], {})
            procedure.setdefault(row["transition"], []).append(row)
        procedures = []
        for name in sorted(grouped):
            transitions = []
            for transition in sorted(grouped[name]):
                points, skipped = _transition_points(grouped[name][transition], resolved, runways)
                if not points:
                    continue
                runway = _runway_of(transition)
                transitions.append({
                    "id": transition,
                    "runway": runway,
                    "combined": transition.endswith("B"),
                    "points": points,
                    "skipped": skipped,
                    "complete": skipped == 0,
                })
            if transitions:
                procedures.append({"id": name, "transitions": transitions})
        out[kind] = procedures
    return {
        "ok": True,
        "airport": airport,
        "source": source,
        "cycle": cycle,
        "runways": runways,
        "procedures": out,
    }


class ProcedureDataset:
    """The procedure dataset Stratos ships, read one airport at a time.

    ``index.json`` names the cycle, the coverage and the airports that carry a
    SID or STAR, so the bridge can answer without touching an airport file. A
    missing or unreadable dataset is simply unavailable: no geometry is made up
    to fill the gap.
    """

    def __init__(self, directory=DATASET_DIR):
        self.directory = directory or ""
        self._index = None
        self._index_stamp = None
        self._cache = {}

    def _load_index(self):
        path = os.path.join(self.directory, "index.json")
        try:
            stamp = os.path.getmtime(path)
        except OSError:
            self._index, self._index_stamp = None, None
            return None
        if self._index is not None and stamp == self._index_stamp:
            return self._index
        try:
            with open(path, "r", encoding="utf-8") as handle:
                self._index = json.load(handle)
            self._index_stamp = stamp
        except (OSError, ValueError):
            self._index, self._index_stamp = None, None
        return self._index

    @property
    def available(self):
        index = self._load_index()
        return bool(index and isinstance(index.get("airports"), dict))

    def has(self, airport):
        index = self._load_index()
        return bool(index and str(airport or "").upper() in (index.get("airports") or {}))

    def summary(self):
        index = self._load_index()
        if not index:
            return {"available": False, "directory": self.directory}
        return {
            "available": True,
            "directory": self.directory,
            "source": index.get("source", ""),
            "cycle": index.get("cycle", ""),
            "effective": index.get("effective", ""),
            "coverage": index.get("coverage", ""),
            "airports": len(index.get("airports") or {}),
        }

    def procedures(self, airport):
        """The whole payload for one airport, or None when it is not shipped."""
        code = str(airport or "").upper()
        if not self.has(code):
            return None
        path = os.path.join(self.directory, code + ".json")
        try:
            stamp = os.path.getmtime(path)
        except OSError:
            return None
        cached = self._cache.get(code)
        if cached and cached[0] == stamp:
            return cached[1]
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            return None
        if not isinstance(payload, dict) or not payload.get("ok"):
            return None
        self._cache[code] = (stamp, payload)
        return payload


class NavData:
    """Caches one airport's procedures, from the simulator or the shipped dataset."""

    def __init__(self, xplane_dir="", dataset_dir=DATASET_DIR):
        self.xplane_dir = xplane_dir or find_xplane_dir()
        self.cycle = read_cycle(self.xplane_dir) if self.xplane_dir else {}
        self.dataset = ProcedureDataset(dataset_dir)
        self._cache = {}
        self._resolver = None

    @property
    def available(self):
        sim = bool(self.xplane_dir and any(os.path.isdir(os.path.join(directory, "CIFP")) for directory in data_dirs(self.xplane_dir)))
        return sim or self.dataset.available

    def summary(self):
        return {
            "available": self.available,
            "directory": self.xplane_dir,
            **self.cycle,
            "dataset": self.dataset.summary(),
        }

    def _cifp_path(self, airport):
        for directory in data_dirs(self.xplane_dir):
            path = os.path.join(directory, "CIFP", airport + ".dat")
            if os.path.isfile(path):
                return path, directory
        return "", ""

    def procedures(self, airport, kind="", ident=""):
        code = re.sub(r"[^A-Z0-9]", "", str(airport or "").upper())[:4]
        if len(code) != 4:
            return {"ok": False, "reason": "bad-request", "error": "An airport is a four-letter ICAO code."}
        payload = self._simulator_procedures(code)
        if not payload.get("ok"):
            shipped = self.dataset.procedures(code)
            if shipped:
                payload = shipped
            elif not self.available:
                return {"ok": False, "reason": "no-navdata",
                        "error": "No simulator navigation data was found on this PC and the shipped dataset does not cover %s." % code}
            elif payload.get("reason") == "no-navdata":
                coverage = self.dataset.summary().get("coverage") or "the United States"
                return {"ok": False, "reason": "not-found",
                        "error": "The simulator has no navigation data on this PC; the shipped dataset covers %s." % coverage}
        result = _filtered(payload, kind, ident, code)
        if not result.get("ok") and str(payload.get("source", "")).startswith("X-Plane"):
            # The simulator's cycle can be older than the shipped dataset; a
            # procedure it does not list is looked up there before giving up.
            shipped = self.dataset.procedures(code)
            if shipped:
                alternative = _filtered(shipped, kind, ident, code)
                if alternative.get("ok"):
                    return alternative
        return result

    def _simulator_procedures(self, code):
        """One airport's payload from the simulator's CIFP files, or an error."""
        if not (self.xplane_dir and any(os.path.isdir(os.path.join(directory, "CIFP")) for directory in data_dirs(self.xplane_dir))):
            return {"ok": False, "reason": "no-navdata", "error": "No X-Plane navigation data was found on this PC."}
        path, directory = self._cifp_path(code)
        if not path:
            return {"ok": False, "reason": "not-found", "error": "The simulator has no procedure file for %s." % code}
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = time.time()
        cached = self._cache.get(code)
        if cached and cached[0] == mtime:
            payload = cached[1]
        else:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    text = handle.read()
            except OSError as exc:
                return {"ok": False, "reason": "read-error", "error": "Could not read %s: %s" % (path, exc)}
            cycles = read_cycle(self.xplane_dir)
            if self._resolver is None:
                self._resolver = FixResolver(data_dirs(self.xplane_dir), [code])
            else:
                self._resolver.airports.add(code)
            payload = build_airport(
                text, code, self._resolver,
                source="X-Plane 12 CIFP (Custom Data)" if "Custom" in directory else "X-Plane 12 CIFP",
                cycle=cycles.get("cycle", ""),
            )
            self._cache[code] = (mtime, payload)
        return payload


def _filtered(payload, kind, ident, code):
    """The payload narrowed to one kind and one procedure, or a not-found error."""
    if not kind and not ident:
        return payload
    wanted_kind = str(kind or "").lower()
    wanted_ident = str(ident or "").upper()
    procedures = payload["procedures"]
    kinds = [wanted_kind] if wanted_kind in procedures else list(procedures)
    filtered = {}
    for key in kinds:
        items = procedures.get(key, [])
        if wanted_ident:
            items = [item for item in items if item["id"] == wanted_ident]
        if items:
            filtered[key] = items
    if not filtered:
        where = "the simulator's data" if payload.get("source", "").startswith("X-Plane") else "the shipped dataset"
        return {"ok": False, "reason": "not-found", "error": "%s %s is not in %s for %s." % (
            wanted_kind.upper() or "Procedure", wanted_ident, where, code)}
    return {**payload, "procedures": filtered}
