"""Navigation points near a position, from the simulator's own nav database.

The Flight Planner needs to show the real fixes, VORs, NDBs and airports around
whatever the pilot is looking at, and to name the point they click. Stratos
already reads the simulator's ``earth_fix.dat``, ``earth_nav.dat`` and
``earth_aptmeta.dat`` to resolve procedure legs; this module reads the same
three files once, indexes them on a one-degree grid, and answers "what is near
this place" with a true great-circle distance filter.

Nothing here is bundled or redistributed. The files are read from the pilot's
own X-Plane installation (Navigraph/Jeppesen data licensed to that pilot) or, for
airports, from the OurAirports public-domain set the bridge already downloads.
If no simulator nav data is installed, the answer says so and the page falls back
to the OurAirports airports and navaids it can fetch on its own.

Every record carries the source it came from so the interface can say where a
point was published rather than implying one worldwide database.
"""

import json
import math
import os
import threading
import time

import stratos_cifp

EARTH_R_NM = 3440.065

# X-Plane's earth_nav.dat type codes, as its own documentation lists them. The
# descriptive text at the end of the line is used when a code is one this map
# does not name, so an unknown facility is still described, never guessed at.
NAV_TYPES = {
    2: ("ndb", "NDB"),
    3: ("vor", "VOR"),
    4: ("loc", "Localizer"),
    5: ("loc", "Localizer"),
    6: ("gs", "Glide slope"),
    7: ("om", "Outer marker"),
    8: ("mm", "Middle marker"),
    9: ("im", "Inner marker"),
    12: ("dme", "DME"),
    13: ("tacan", "TACAN"),
}

# Kinds a route may hold. A fix is a published intersection; a nav is a radio
# facility; an apt is an airport. The map draws each differently.
WANTED_KINDS = ("fix", "nav", "apt")

_LOCK = threading.Lock()
_INDEX = None
_PROBE = None
_PROBE_AT = 0.0
PROBE_SECONDS = 20.0


def _dirs():
    """Nav-data directories to read, newest first, or empty when none exist."""
    xplane = stratos_cifp.find_xplane_dir()
    return stratos_cifp.data_dirs(xplane), xplane


def _cycle(xplane_dir):
    return stratos_cifp.read_cycle(xplane_dir) if xplane_dir else {}


def _bucket(lat, lon):
    """One-degree cell, with longitude wrapped so the antimeridian is one row."""
    return (int(math.floor(lat)), int(math.floor(((lon + 180.0) % 360.0) - 180.0)))


def _haversine_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_NM * math.asin(min(1.0, math.sqrt(a)))


def _describe(parts):
    """The facility description X-Plane writes after the region fields."""
    tail = " ".join(parts[10:]).strip()
    return tail[:40]


def _nav_kind(code, text):
    mapped = NAV_TYPES.get(code)
    if mapped:
        return mapped
    # An unnamed code keeps the publisher's own words rather than a guess.
    label = text.split()[0] if text else "Navaid"
    return ("nav", label[:14] or "Navaid")


def _build():
    """Parse the three files once into flat point records plus a grid index."""
    dirs, xplane = _dirs()
    points = []
    seen = set()
    counts = {"fix": 0, "nav": 0, "apt": 0}

    def add(ident, name, kind, lat, lon, elev, freq, region, source):
        ident = str(ident or "").strip().upper()
        if not ident or not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            return
        # The same facility appears in both the Custom Data copy and the shipped
        # copy; a VOR and its co-located DME are one station within a few metres.
        key = (ident, kind, round(lat, 4), round(lon, 4))
        if key in seen:
            return
        seen.add(key)
        counts[kind] = counts.get(kind, 0) + 1
        points.append({
            "id": ident, "name": name or ident, "kind": kind, "lat": round(lat, 6),
            "lon": round(lon, 6), "elev": elev, "freq": freq, "region": region,
            "source": source,
        })

    def files(name):
        return [os.path.join(d, name) for d in dirs if os.path.isfile(os.path.join(d, name))]

    for path in files("earth_fix.dat"):
        label = "X-Plane 12 CIFP" if "Custom Data" not in path else "X-Plane 12 CIFP (Custom Data)"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    parts = line.split()
                    # lat lon IDENT REGION COUNTRY backend region-code
                    if len(parts) < 5 or not parts[0][0] in "-0123456789":
                        continue
                    try:
                        lat, lon = float(parts[0]), float(parts[1])
                    except ValueError:
                        continue
                    ident = parts[2]
                    # The grid-name fixes (05S015W) are Navigraph's own coordinate
                    # marks, not published intersections; they are kept as fixes
                    # because that is what the data calls them.
                    add(ident, ident, "fix", lat, lon, None, None, parts[3], label)
        except OSError:
            continue

    for path in files("earth_aptmeta.dat"):
        label = "Simulator airport data"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    parts = line.split()
                    if len(parts) < 5:
                        continue
                    ident = parts[0].upper()
                    if len(ident) != 4 or not ident.isalnum():
                        continue
                    try:
                        lat, lon = float(parts[2]), float(parts[3])
                        elev = float(parts[4])
                    except ValueError:
                        continue
                    add(ident, ident, "apt", lat, lon, int(elev) if abs(elev) < 20000 else None,
                        None, parts[1], label)
        except OSError:
            continue

    for path in files("earth_nav.dat"):
        label = "X-Plane 12 nav data"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    parts = line.split()
                    # type lat lon elev freq range bearing ident airport region name...
                    if len(parts) < 10:
                        continue
                    try:
                        code = int(parts[0])
                        lat, lon = float(parts[1]), float(parts[2])
                        elev = float(parts[3])
                        freq = float(parts[4])
                    except ValueError:
                        continue
                    text = _describe(parts)
                    kind, type_label = _nav_kind(code, text)
                    # Localizers, glide slopes and marker beacons belong to one
                    # runway, not to a route; they are not offered as waypoints.
                    if kind in ("loc", "gs", "om", "mm", "im", "nav"):
                        continue
                    # A DME paired with an ILS carries the internal ident the
                    # installer assigned it (IBEJ at KSEA), not the ident a pilot
                    # flies. Its localizer is already excluded above, so it goes
                    # with it rather than appearing as a waypoint nobody can file.
                    upper = text.upper()
                    if any(word in upper for word in ("ILS", "LOCALIZER", "GLIDESLOPE", "MARKER")):
                        continue
                    name = text or parts[7]
                    add(parts[7], name, "nav", lat, lon,
                        int(elev) if abs(elev) < 20000 else None,
                        _freq_text(code, freq), parts[9] if len(parts) > 9 else "",
                        label)
                    _ = type_label
        except OSError:
            continue

    grid = {}
    for index, point in enumerate(points):
        grid.setdefault(_bucket(point["lat"], point["lon"]), []).append(index)

    return {"points": points, "grid": grid, "counts": counts,
            "dirs": dirs, "xplane": xplane, "cycle": _cycle(xplane),
            "builtAt": int(time.time() * 1000)}


def _freq_text(code, raw):
    """A frequency as the facility publishes it: kHz for an NDB, MHz otherwise."""
    if not raw:
        return ""
    if code == 2:
        return "%d kHz" % int(round(raw))
    return "%.2f MHz" % (raw / 100.0 if raw > 1000 else raw)


def index():
    """The parsed index, built on first use and kept for the process lifetime."""
    global _INDEX
    with _LOCK:
        if _INDEX is None:
            started = time.time()
            _INDEX = _build()
            stratos_log("Navigation index: %d fixes, %d navaids, %d airports in %.1fs" % (
                _INDEX["counts"].get("fix", 0), _INDEX["counts"].get("nav", 0),
                _INDEX["counts"].get("apt", 0), time.time() - started))
        return _INDEX


_LOGGER = None


def set_logger(logger):
    global _LOGGER
    _LOGGER = logger


def stratos_log(message):
    if _LOGGER:
        _LOGGER(message)


def near(lat, lon, nm=40.0, kinds=WANTED_KINDS, limit=400):
    """Real navigation points within ``nm`` great-circle of a position.

    The one-degree grid narrows the candidate list; every candidate is then
    measured with the haversine formula, so the radius is a real distance and
    not a number of cells or pixels. Points are returned nearest first.
    """
    try:
        lat = float(lat)
        lon = float(lon)
        nm = float(nm)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "bad-request", "error": "A latitude, a longitude and a radius are required."}
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0) or not (0.0 < nm <= 600.0):
        return {"ok": False, "reason": "bad-request",
                "error": "That position or radius is outside the range this map covers."}

    data = index()
    wanted = tuple(kinds) if kinds else WANTED_KINDS
    # A degree of latitude is 60 nm, so this many cells covers the radius at any
    # longitude; the true distance filter below removes the corners.
    span = int(math.ceil(nm / 60.0)) + 1
    rows = []
    points = data["points"]
    for dlat in range(-span, span + 1):
        cell_lat = int(math.floor(lat)) + dlat
        if cell_lat < -90 or cell_lat > 90:
            continue
        for dlon in range(-span, span + 1):
            cell_lon = ((int(math.floor(lon)) + dlon + 180) % 360) - 180
            for position in data["grid"].get((cell_lat, cell_lon), ()):
                point = points[position]
                if point["kind"] not in wanted:
                    continue
                distance = _haversine_nm(lat, lon, point["lat"], point["lon"])
                if distance <= nm:
                    rows.append((distance, point))
    rows.sort(key=lambda row: row[0])
    total = len(rows)
    shown = rows[:limit]
    return {
        "ok": True,
        "center": {"lat": round(lat, 6), "lon": round(lon, 6)},
        "radiusNm": nm,
        "count": total,
        "truncated": total > len(shown),
        "points": [dict(point, distanceNm=round(distance, 3)) for distance, point in shown],
        "coverage": coverage(data),
    }


def nearest(lat, lon, nm=10.0):
    """The single closest real point, for naming a click on the chart."""
    answer = near(lat, lon, nm=nm, limit=1)
    if not answer.get("ok"):
        return answer
    point = answer["points"][0] if answer["points"] else None
    answer["point"] = point
    answer.pop("points", None)
    return answer


def coverage(data=None):
    """What this index actually holds, so the page can state its coverage."""
    data = data or index()
    installed = bool(data["dirs"])
    cycle = data.get("cycle") or {}
    return {
        "simulatorNavData": installed,
        "source": "X-Plane 12 CIFP" if installed else "",
        "cycle": cycle.get("cycle", ""),
        "cycleSource": cycle.get("source", ""),
        "fixes": data["counts"].get("fix", 0),
        "navaids": data["counts"].get("nav", 0),
        # earth_aptmeta.dat is the simulator's own airport list; OurAirports is
        # the worldwide one the map draws, so this is reported separately.
        "simulatorAirports": data["counts"].get("apt", 0),
        "note": ("Fixes and radio navaids come from the simulator's own nav data "
                 "(Navigraph/Jeppesen, licensed to the pilot, read in place and never "
                 "bundled). Airports and the worldwide navaid fallback come from "
                 "OurAirports (CC0).") if installed else
                ("No simulator nav data is installed, so only published airports and "
                 "the OurAirports navaid set can be shown."),
    }


def status():
    """A cheap readiness probe, so the page can ask without building the index."""
    global _PROBE, _PROBE_AT
    now = time.time()
    if _PROBE is not None and now - _PROBE_AT < PROBE_SECONDS:
        return _PROBE
    if _INDEX is not None:
        _PROBE = coverage()
    else:
        dirs, xplane = _dirs()
        _PROBE = {
            "simulatorNavData": bool(dirs),
            "source": "X-Plane 12 CIFP" if dirs else "",
            "cycle": _cycle(xplane).get("cycle", ""),
            "cycleSource": _cycle(xplane).get("source", ""),
            "fixes": None, "navaids": None, "simulatorAirports": None,
            "note": ("The simulator's nav data is installed and is indexed on first use."
                     if dirs else
                     "No simulator nav data is installed, so only published airports and "
                     "the OurAirports navaid set can be shown."),
        }
    _PROBE_AT = now
    return _PROBE


def reset():
    """Drop the cached index. Used by the tests."""
    global _INDEX, _PROBE
    with _LOCK:
        _INDEX = None
        _PROBE = None


if __name__ == "__main__":  # a quick look without running the bridge
    import sys
    lat = float(sys.argv[1]) if len(sys.argv) > 1 else 47.449
    lon = float(sys.argv[2]) if len(sys.argv) > 2 else -122.309
    radius = float(sys.argv[3]) if len(sys.argv) > 3 else 40.0
    answer = near(lat, lon, radius, limit=25)
    print(json.dumps(answer, indent=1)[:4000])
