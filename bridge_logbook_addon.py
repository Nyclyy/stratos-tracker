#!/usr/bin/env python3
"""Stratos logbook + landing analytics.

This module is imported by stratos_bridge.py. It turns simulator telemetry into
flight records, including a replayable track and measured landing data. It uses
only the Python standard library.

Design rules:
  * Records contain what the simulator actually reported. Derived values are
    labelled (`vsSource`, `estimated`) rather than presented as measurements.
  * Flight completion is idempotent and de-duplicated, so the bridge and the
    browser can both see the same flight without creating two entries.
  * An in-progress flight is snapshotted to disk, so closing the app or a crash
    does not lose the flight; it is kept and marked incomplete instead.
"""

import datetime
import json
import math
import os
import threading
import time
import uuid

VERSION = "2.1.20"

# ── Thresholds ──────────────────────────────────────────────────────
TAXI_SPEED_KT    = 2
AIRBORNE_AGL_FT  = 30
TAKEOFF_SPEED_KT = 40
LANDED_AGL_FT    = 20
LANDED_SPEED_KT  = 60
PARKED_SPEED_KT  = 2
PARKED_SECONDS   = 30
MIN_FLIGHT_SEC   = 60

# Descent gradient analysis. A flight teaches the app its real descent only
# when the measured values are plausible; anything outside these bounds is ignored.
DESC_LEVEL_TOL_FT = 50       # altitude noise still counted as level cruise
DESC_MIN_DROP_FT  = 2000     # shorter drops are pattern work, not a descent profile
DESC_MIN_NM       = 5.0      # too little distance to measure a gradient
DESC_MIN_FT_NM    = 40.0
DESC_MAX_FT_NM    = 600.0

# Landing rating guidelines (fpm). Display code in the web app can override
# these; they are recorded with each landing so a later threshold change does
# not rewrite history.
LANDING_THRESHOLDS = {
    "jet":        (-100, -180, -300, -600),
    "turboprop":  (-90, -160, -260, -500),
    "piston":     (-80, -140, -220, -400),
    "glider":     (-50, -90, -150, -250),
    "helicopter": (-60, -110, -200, -350),
    "unknown":    (-100, -180, -300, -600),
}
LANDING_GRADES = ("smooth", "good", "firm", "hard", "severe")

HERE     = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("STRATOS_DATA_DIR", HERE)
os.makedirs(DATA_DIR, exist_ok=True)
LOGBOOK_FILE    = os.path.join(DATA_DIR, "stratos_logbook.json")
INPROGRESS_FILE = os.path.join(DATA_DIR, "stratos_inprogress.json")

lb_lock = threading.Lock()

MAX_TRACK_POINTS = 12000
TRACK_MIN_SECONDS = 4
TRACK_MIN_NM = 0.2
MAX_POST_BYTES = 4 * 1024 * 1024


# ── Logbook file ─────────────────────────────────────────────────────
def lb_load():
    try:
        with open(LOGBOOK_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def lb_save(flights):
    with lb_lock:
        tmp = LOGBOOK_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(flights, f, separators=(",", ":"))
        os.replace(tmp, LOGBOOK_FILE)


def _fingerprint(flight):
    takeoff = flight.get("takeoffTime") or flight.get("startTime") or 0
    return (
        int(takeoff) // 180000,
        flight.get("depAirport") or "",
        flight.get("arrAirport") or "",
    )


def lb_add(flight):
    """Append a flight. Idempotent by id *and* by takeoff/route fingerprint."""
    if not isinstance(flight, dict) or not flight.get("id"):
        return False
    with lb_lock:
        try:
            with open(LOGBOOK_FILE, "r", encoding="utf-8") as f:
                flights = json.load(f)
            if not isinstance(flights, list):
                flights = []
        except (OSError, ValueError):
            flights = []
        for index, existing in enumerate(flights):
            if existing.get("id") == flight.get("id"):
                # A richer / completed version replaces a partial record.
                if flight.get("complete") and not existing.get("complete"):
                    flights[index] = flight
                    _write_flights(flights)
                    return True
                return False
            if _fingerprint(existing) == _fingerprint(flight) and flight.get("takeoffTime"):
                if flight.get("complete") and not existing.get("complete"):
                    flight["id"] = existing.get("id", flight["id"])
                    flights[index] = flight
                    _write_flights(flights)
                    return True
                return False
        flights.append(flight)
        _write_flights(flights)
        return True


def _write_flights(flights):
    tmp = LOGBOOK_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(flights, f, separators=(",", ":"))
    os.replace(tmp, LOGBOOK_FILE)


def recent_flights(limit=20):
    flights = lb_load()
    flights.sort(key=lambda f: f.get("startTime") or 0, reverse=True)
    return flights[:max(0, int(limit))]


# ── Geometry ─────────────────────────────────────────────────────────
def _haversine_nm(lat1, lon1, lat2, lon2):
    radius = 3440.065
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return radius * 2 * math.asin(math.sqrt(max(0.0, min(1.0, a))))


def nearest_airport(lat, lon, airports_list, max_nm=8):
    best_id, best_d = None, max_nm
    for airport in airports_list or []:
        try:
            d = _haversine_nm(lat, lon, float(airport[2]), float(airport[3]))
            if d < best_d:
                best_d, best_id = d, airport[0]
        except (TypeError, ValueError, IndexError):
            continue
    return best_id


def _aircraft_class(aircraft):
    name = str(aircraft or "").upper()
    if not name.strip():
        return "unknown"
    if any(token in name for token in ("HELI", "H125", "H135", "H145", "R22", "R44", "R66", "AW139", "EC135")):
        return "helicopter"
    if any(token in name for token in ("GLIDER", "ASK21", "DG-1000", "LS8", "VENTUS")):
        return "glider"
    if any(token in name for token in ("TBM", "PC-12", "PC-24", "C208", "CARAVAN", "ATR", "Q400", "DASH 8", "KING AIR", "C90", "B200", "BE20", "METRO", "SAAB 340", "SF50")):
        return "turboprop"
    if any(token in name for token in ("B7", "A3", "A2", "B78", "MD-11", "MD-8", "CRJ", "E1", "E2", "CITATION", "GLEX", "GLF", "CL30", "CL60", "FALCON", "LEARJET", "PHENOM")):
        return "jet"
    if any(token in name for token in ("C1", "C2", "PA-2", "PA-3", "PA-4", "SR2", "DA4", "DA62", "M20", "BE3", "BE5", "BONANZA", "BARON", "CIRRUS")):
        return "piston"
    return "unknown"


def classify_landing(vs_fpm, aircraft):
    """Return a transparent rating based on the aircraft class."""
    if vs_fpm is None:
        return {"key": "unclassified", "classKey": _aircraft_class(aircraft)}
    try:
        rate = abs(float(vs_fpm))
    except (TypeError, ValueError):
        return {"key": "unclassified", "classKey": _aircraft_class(aircraft)}
    if rate > 6000:
        return {"key": "unclassified", "classKey": _aircraft_class(aircraft)}
    class_key = _aircraft_class(aircraft)
    smooth, good, firm, hard = LANDING_THRESHOLDS.get(class_key, LANDING_THRESHOLDS["unknown"])
    if rate <= abs(smooth):
        key = "smooth"
    elif rate <= abs(good):
        key = "good"
    elif rate <= abs(firm):
        key = "firm"
    elif rate <= abs(hard):
        key = "hard"
    else:
        key = "severe"
    return {"key": key, "classKey": class_key}


def match_runway(airports_list, lat, lon, heading):
    """Match a runway from real threshold coordinates.

    Returns an estimated match with the distance from the threshold. The record
    is explicitly flagged as estimated because it is inferred from a position
    sample, not read from the simulator's navigation system.
    """
    best = None
    for airport in airports_list or []:
        try:
            ap_lat, ap_lon = float(airport[2]), float(airport[3])
        except (TypeError, ValueError, IndexError):
            continue
        if _haversine_nm(lat, lon, ap_lat, ap_lon) > 8:
            continue
        for rw in airport[7] or []:
            if not isinstance(rw, list) or len(rw) < 6:
                continue
            try:
                a = (float(rw[2]), float(rw[3]))
                b = (float(rw[4]), float(rw[5]))
                length_ft = float(rw[6]) if rw[6] else _haversine_nm(a[0], a[1], b[0], b[1]) * 6076.12
            except (TypeError, ValueError):
                continue
            for index, (threshold, far) in enumerate(((a, b), (b, a))):
                # Local planar projection in nautical miles.
                lat_ref = math.radians((threshold[0] + far[0]) / 2)
                bx = (far[1] - threshold[1]) * math.cos(lat_ref) * 60
                by = (far[0] - threshold[0]) * 60
                px = (lon - threshold[1]) * math.cos(lat_ref) * 60
                py = (lat - threshold[0]) * 60
                length2 = bx * bx + by * by or 1e-12
                t = max(0.0, min(1.0, (px * bx + py * by) / length2))
                distance = math.hypot(px - bx * t, py - by * t)
                if distance > 0.35:  # ~650 m from the centreline
                    continue
                rw_heading = (math.degrees(math.atan2(bx, by)) + 360) % 360
                delta = 180.0 if heading is None else abs(((heading - rw_heading + 540) % 360) - 180)
                score = distance * 10 + t * 0.2 + (0 if index == 0 else 0.05)
                if best is None or score < best["score"]:
                    le_name = str(rw[0] if index == 0 else rw[1])
                    he_name = str(rw[1] if index == 0 else rw[0])
                    best = {
                        "score": score,
                        "airport": airport[0],
                        "airportName": airport[1],
                        "id": "%s/%s" % (le_name, he_name),
                        "threshold": le_name,
                        "farEnd": he_name,
                        "lengthFt": int(round(length_ft)),
                        "widthFt": int(rw[7]) if len(rw) > 7 and rw[7] else None,
                        "distanceFromThresholdFt": int(round(t * length_ft)),
                        "remainingFt": int(round((1 - t) * length_ft)),
                        "offsetFt": int(round(distance * 6076.12)),
                        "runwayHeading": int(round(rw_heading)),
                        "headingError": None if heading is None else int(round(delta)),
                        "headingAligned": None if heading is None else delta <= 35,
                        "estimated": True,
                    }
    if best:
        best.pop("score", None)
    return best


# ── Flight state machine ─────────────────────────────────────────────
_flight_state = {
    "phase": "PARKED",
    "flight": None,
    "parked_since": None,
    "recent": [],
    "touchdown_t": None,
}
_fs_lock = threading.Lock()
_last_snapshot = 0.0


def _now_ms():
    return int(time.time() * 1000)


def _new_flight(data):
    return {
        "id": "flt_" + uuid.uuid4().hex[:12],
        "phase": "PARKED",
        "startTime": _now_ms(),
        "takeoffTime": None,
        "landingTime": None,
        "endTime": None,
        "depAirport": None,
        "arrAirport": None,
        "aircraft": data.get("aircraft", "") or "",
        "registration": data.get("registration", "") or "",
        "callsign": data.get("callsign", "") or "",
        "sim": data.get("src", "Simulator"),
        "maxAlt": 0,
        "distanceNm": 0,
        "landingVS": None,
        "landing": None,
        "fuelDep": data.get("fuel"),
        "fuelArr": None,
        "track": [],
        "complete": False,
        "incomplete": False,
        "recordedBy": "bridge",
        "schema": 2,
    }


def _track_add(flight, data):
    track = flight["track"]
    sample = {
        "lat": round(float(data["lat"]), 6),
        "lon": round(float(data["lon"]), 6),
        "alt": round(float(data.get("alt") or 0), 1),
        "t": _now_ms(),
    }
    for key in ("gs", "hdg", "vs", "agl"):
        value = data.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value):
            sample[key] = round(float(value), 2)
    if not track:
        track.append(sample)
        return
    last = track[-1]
    age = (sample["t"] - last["t"]) / 1000.0
    moved = _haversine_nm(last["lat"], last["lon"], sample["lat"], sample["lon"])
    if age >= TRACK_MIN_SECONDS or moved >= TRACK_MIN_NM:
        track.append(sample)
        if len(track) > MAX_TRACK_POINTS:
            # Halve the older half instead of dropping the start of the flight.
            keep = track[:MAX_TRACK_POINTS // 2][::2] + track[MAX_TRACK_POINTS // 2:]
            flight["track"] = keep


def _track_distance(track):
    distance = 0.0
    for index in range(1, len(track)):
        distance += _haversine_nm(track[index - 1]["lat"], track[index - 1]["lon"],
                                  track[index]["lat"], track[index]["lon"])
    return round(distance, 1)


def _regression_fpm(samples):
    """Least-squares vertical speed (fpm) over the touchdown window."""
    points = [s for s in samples if isinstance(s.get("alt"), (int, float)) and s.get("t")]
    if len(points) < 3:
        return None
    points = points[-10:]
    first_t = points[0]["t"]
    xs = [(p["t"] - first_t) / 1000.0 for p in points]
    ys = [float(p["alt"]) for p in points]
    if xs[-1] - xs[0] < 0.8 or xs[-1] - xs[0] > 12:
        return None
    n = len(points)
    sx = sum(xs); sy = sum(ys); sxx = sum(x * x for x in xs); sxy = sum(x * y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    if not denom:
        return None
    return (n * sxy - sx * sy) / denom * 60.0


def _analyse_descent(track):
    """Measure the real descent gradient of a completed flight.

    The descent starts where the level segment at the highest recorded altitude
    ends. The gradient is the altitude lost divided by the distance flown from
    that point to touchdown, in feet per nautical mile. Nothing is invented: an
    unusable track returns None.
    """
    points = [p for p in (track or [])
              if isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lon"), (int, float))
              and isinstance(p.get("alt"), (int, float))]
    if len(points) < 4:
        return None
    peak = max(points, key=lambda p: p["alt"])
    if peak["alt"] - points[-1]["alt"] < DESC_MIN_DROP_FT:
        return None
    # The descent starts where the level segment ends: walk forward while the
    # aircraft is still at cruise altitude (allowing tiny altitude noise).
    index = points.index(peak)
    while index + 1 < len(points) and points[index + 1]["alt"] >= peak["alt"] - DESC_LEVEL_TOL_FT:
        index += 1
    start = points[index]
    distance = 0.0
    for i in range(index + 1, len(points)):
        distance += _haversine_nm(points[i - 1]["lat"], points[i - 1]["lon"],
                                  points[i]["lat"], points[i]["lon"])
    drop = start["alt"] - points[-1]["alt"]
    if distance < DESC_MIN_NM:
        return None
    ft_per_nm = drop / distance
    if not (DESC_MIN_FT_NM <= ft_per_nm <= DESC_MAX_FT_NM):
        return None
    return {
        "ftPerNm": round(ft_per_nm, 1),
        "startAltFt": round(start["alt"]),
        "sinkNm": round(distance, 1),
        "source": "measured from the recorded track",
    }


def _analyse_landing(data, airports_list, recent=None, touchdown_t=None):
    if recent is None:
        with _fs_lock:
            recent = list(_flight_state["recent"])
    else:
        recent = list(recent)
    if touchdown_t is not None:
        # Only samples up to first wheel contact: the ground roll is flat and would dilute the descent rate.
        recent = [s for s in recent if s.get("t") and s["t"] <= touchdown_t]
    vs = _regression_fpm(recent[-12:])
    vs_source = "derived from recorded altitude"
    if vs is None or vs >= 0:
        reported = data.get("vs")
        if isinstance(reported, (int, float)) and reported < 0:
            vs = float(reported)
            vs_source = "last reported vertical speed"
        else:
            vs = None
            vs_source = "unavailable"
    gs = data.get("gs")
    heading = data.get("hdg")
    runway = match_runway(airports_list, float(data["lat"]), float(data["lon"]), heading)
    warnings = []
    if runway is None:
        warnings.append("Runway could not be matched from the recorded position.")
    if vs_source != "derived from recorded altitude":
        warnings.append("Vertical speed is not a dedicated touchdown measurement.")
    result = {
        "available": vs is not None,
        "vsFpm": int(round(vs)) if vs is not None else None,
        "vsSource": vs_source,
        "gsKt": int(round(float(gs))) if isinstance(gs, (int, float)) else None,
        "lat": round(float(data["lat"]), 6),
        "lon": round(float(data["lon"]), 6),
        "heading": round(float(heading), 1) if isinstance(heading, (int, float)) else None,
        "at": _now_ms(),
        "runway": runway,
        "classification": classify_landing(vs, data.get("aircraft")),
        "sampleCount": len(recent),
        "warnings": warnings,
        "estimated": {"vs": vs_source != "derived from recorded altitude", "runway": runway is not None, "touchdownPoint": True},
    }
    return result


def process_telemetry_for_logbook(data, airports_list=None):
    """Process one telemetry sample. Safe to call at 4-5 Hz."""
    global _last_snapshot
    if not data or data.get("lat") is None:
        return "NO_DATA"
    lat, lon = data["lat"], data["lon"]
    alt = data.get("alt", 0) or 0
    agl = data.get("agl", 0) or 0
    gs = data.get("gs", 0) or 0
    now_ms = _now_ms()
    on_ground = agl < LANDED_AGL_FT

    with _fs_lock:
        state = _flight_state
        if state["flight"] is None:
            state["flight"] = _new_flight(data)
        flight = state["flight"]
        phase = state["phase"]

        # Keep a short raw window for touchdown analysis.
        state["recent"].append({"lat": lat, "lon": lon, "alt": alt, "agl": agl,
                                "gs": gs, "hdg": data.get("hdg"), "vs": data.get("vs"), "t": now_ms})
        if len(state["recent"]) > 40:
            state["recent"] = state["recent"][-40:]

        if alt > (flight["maxAlt"] or 0):
            flight["maxAlt"] = alt
        for key, target in (("aircraft", "aircraft"), ("registration", "registration"), ("callsign", "callsign")):
            if data.get(key) and not flight.get(target):
                flight[target] = data[key]
        _track_add(flight, data)

        if phase == "PARKED":
            if gs > TAXI_SPEED_KT:
                flight["phase"] = state["phase"] = "TAXI"
                if airports_list:
                    flight["depAirport"] = nearest_airport(lat, lon, airports_list)
                flight["fuelDep"] = data.get("fuel")

        elif phase == "TAXI":
            if agl > AIRBORNE_AGL_FT and gs > TAKEOFF_SPEED_KT:
                flight["phase"] = state["phase"] = "AIRBORNE"
                state["touchdown_t"] = None
                flight["takeoffTime"] = now_ms
            elif gs < PARKED_SPEED_KT and on_ground:
                flight["phase"] = state["phase"] = "PARKED"

        elif phase == "AIRBORNE":
            if on_ground and state["touchdown_t"] is None:
                state["touchdown_t"] = now_ms  # first wheel contact, anchors the landing-rate window
            if on_ground and gs < LANDED_SPEED_KT:
                flight["phase"] = state["phase"] = "LANDED"
                flight["landingTime"] = now_ms
                flight["fuelArr"] = data.get("fuel")
                if airports_list:
                    flight["arrAirport"] = nearest_airport(lat, lon, airports_list)
                landing = _analyse_landing(data, airports_list, state["recent"], state["touchdown_t"])
                flight["landing"] = landing
                flight["landingVS"] = landing.get("vsFpm")
                state["parked_since"] = time.time()

        elif phase == "LANDED":
            if agl > AIRBORNE_AGL_FT and gs > TAKEOFF_SPEED_KT:
                flight["phase"] = state["phase"] = "AIRBORNE"
                flight["landingTime"] = None
                flight["arrAirport"] = None
                state["touchdown_t"] = None
                flight["landingVS"] = None
                flight["landing"] = None
                state["parked_since"] = None
            elif state["parked_since"] and (time.time() - state["parked_since"]) >= PARKED_SECONDS:
                _complete_flight(flight, airports_list)
                state["phase"] = "PARKED"
                state["flight"] = None
                state["parked_since"] = None
                state["recent"] = []
                _remove_inprogress()
                return "PARKED"

        phase = state["phase"]
        if time.time() - _last_snapshot > 20 and phase in ("TAXI", "AIRBORNE", "LANDED"):
            _last_snapshot = time.time()
            _save_inprogress(flight)
        return phase


def _complete_flight(flight, airports_list=None):
    flight["complete"] = True
    flight["phase"] = "COMPLETE"
    flight["endTime"] = _now_ms()
    flight["distanceNm"] = _track_distance(flight["track"])
    descent = _analyse_descent(flight["track"])
    if descent:
        flight["descent"] = descent
    if flight.get("takeoffTime") and flight.get("landingTime"):
        airborne = (flight["landingTime"] - flight["takeoffTime"]) / 1000.0
        if airborne < MIN_FLIGHT_SEC:
            flight["incomplete"] = True
    else:
        flight["incomplete"] = True
    if not flight.get("arrAirport") and flight.get("track"):
        last = flight["track"][-1]
        if airports_list:
            flight["arrAirport"] = nearest_airport(last["lat"], last["lon"], airports_list)
    if not flight.get("depAirport") and flight.get("track"):
        first = flight["track"][0]
        if airports_list:
            flight["depAirport"] = nearest_airport(first["lat"], first["lon"], airports_list)
    saved = lb_add(flight)
    print("[Logbook] %s flight %s -> %s (%d nm)%s" % (
        "saved" if saved else "duplicate ignored",
        flight.get("depAirport") or "?", flight.get("arrAirport") or "?",
        int(flight.get("distanceNm") or 0),
        " (incomplete)" if flight.get("incomplete") else ""))
    return saved


def _save_inprogress(flight):
    try:
        tmp = INPROGRESS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(flight, f, separators=(",", ":"))
        os.replace(tmp, INPROGRESS_FILE)
    except OSError:
        pass


def _remove_inprogress():
    try:
        os.remove(INPROGRESS_FILE)
    except OSError:
        pass


def recover_inprogress():
    """Recover a flight left behind by a crash or forced shutdown."""
    try:
        with open(INPROGRESS_FILE, "r", encoding="utf-8") as f:
            flight = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(flight, dict) or not flight.get("id"):
        return None
    if flight.get("complete"):
        _remove_inprogress()
        return None
    flight.setdefault("incomplete", True)
    flight["incomplete"] = True
    flight["complete"] = True
    flight["phase"] = "COMPLETE"
    flight["endTime"] = flight.get("endTime") or _now_ms()
    flight["distanceNm"] = _track_distance(flight.get("track") or [])
    flight["recovered"] = True
    flight["recoveryNote"] = "Recovered after Stratos closed before the flight was finalised."
    if lb_add(flight):
        print("[Logbook] recovered interrupted flight %s -> %s" % (
            flight.get("depAirport") or "?", flight.get("arrAirport") or "?"))
    _remove_inprogress()
    return flight


def finalize_active_flight(note="Stratos closed before the flight was finalised."):
    """Persist an in-progress flight on shutdown; never silently discard it."""
    with _fs_lock:
        flight = _flight_state.get("flight")
        if not flight or flight.get("complete"):
            return None
        if not flight.get("track"):
            _flight_state["flight"] = None
            return None
        flight["incomplete"] = True
        flight["complete"] = True
        flight["phase"] = "COMPLETE"
        flight["endTime"] = _now_ms()
        flight["distanceNm"] = _track_distance(flight["track"])
        descent = _analyse_descent(flight["track"])
        if descent:
            flight["descent"] = descent
        flight["recoveryNote"] = note
        saved = lb_add(flight)
        _flight_state["flight"] = None
        _flight_state["phase"] = "PARKED"
        _remove_inprogress()
        return flight if saved else None


def get_flight_phase():
    with _fs_lock:
        return _flight_state["phase"]


# The live stream carries the path recorded so far, so a page opened halfway
# through a flight still draws from the gate instead of starting a contrail at
# the moment it was opened. The logbook keeps every point; the stream gets an
# even sample, capped, with the first and last points always included.
TRACK_STREAM_POINTS = 400
_TRACK_STREAM_CACHE = {"key": None, "points": []}


def stream_track(track):
    track = track or []
    if len(track) < 2:
        return []
    # A new flight can happen to share the previous one's sample count and end
    # time, so the cache key includes the first sample too; otherwise its points
    # would be served for a different flight.
    key = (len(track), track[0].get("t"), track[-1].get("t"))
    if _TRACK_STREAM_CACHE["key"] == key:
        return _TRACK_STREAM_CACHE["points"]
    step = max(1, int(math.ceil(len(track) / float(TRACK_STREAM_POINTS))))
    sampled = track[::step]
    if sampled[-1] is not track[-1]:
        sampled = sampled + [track[-1]]
    # The fifth value is height above ground: the map colours the flown path by
    # how high the aircraft was, and only AGL makes the ground band read as the
    # ground at an airport that sits well above sea level.
    points = [[point.get("lat"), point.get("lon"), point.get("alt"), point.get("t"),
               point.get("agl") if isinstance(point.get("agl"), (int, float)) else None]
              for point in sampled
              if isinstance(point.get("lat"), (int, float)) and isinstance(point.get("lon"), (int, float))]
    _TRACK_STREAM_CACHE.update(key=key, points=points)
    return points


def get_current_flight():
    with _fs_lock:
        flight = _flight_state["flight"]
        if not flight:
            return None
        return {
            "id": flight.get("id"),
            "phase": flight.get("phase"),
            "startTime": flight.get("startTime"),
            "takeoffTime": flight.get("takeoffTime"),
            "depAirport": flight.get("depAirport"),
            "arrAirport": flight.get("arrAirport"),
            "aircraft": flight.get("aircraft"),
            "callsign": flight.get("callsign"),
            "maxAlt": flight.get("maxAlt"),
            "distanceNm": _track_distance(flight.get("track") or []),
            "trackPoints": len(flight.get("track") or []),
            "track": stream_track(flight.get("track")),
            "landingVS": flight.get("landingVS"),
            "descent": flight.get("descent"),
        }


def get_stats():
    flights = lb_load()
    complete = [f for f in flights if f.get("complete") and not f.get("incomplete")]
    seconds = 0
    for flight in complete:
        takeoff = flight.get("takeoffTime") or 0
        landing = flight.get("landingTime") or 0
        if landing and landing >= takeoff:
            seconds += (landing - takeoff) / 1000.0
    return {
        "flights": len(complete),
        "incomplete": len(flights) - len(complete),
        "hours": round(seconds / 3600.0, 2),
        "distanceNm": round(sum(float(f.get("distanceNm") or 0) for f in complete), 1),
        "landings": sum(1 for f in complete if f.get("landing") or f.get("landingVS") is not None),
    }


def get_descent_profile():
    """The descent gradient the app should plan with, learned from real flights.

    The newest measured flight is used, because it reflects the aircraft being
    flown now. Nothing is returned until the bridge has measured a usable
    descent, so the app keeps its own default until then.
    """
    flights = lb_load()
    measured = []
    for flight in flights:
        descent = flight.get("descent")
        if isinstance(descent, dict):
            value = descent.get("ftPerNm")
            if isinstance(value, (int, float)) and math.isfinite(value) \
                    and DESC_MIN_FT_NM <= value <= DESC_MAX_FT_NM:
                measured.append((flight.get("endTime") or 0, value, flight))
    if not measured:
        return {"available": False, "flights": 0,
                "note": "No completed flight has a measured descent yet."}
    measured.sort(key=lambda item: item[0])
    newest_time, newest_value, newest = measured[-1]
    values = sorted(value for _, value, _ in measured)
    middle = len(values) // 2
    median = values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2.0
    return {
        "available": True,
        "ftPerNm": round(newest_value, 1),
        "medianFtPerNm": round(median, 1),
        "flights": len(measured),
        "lastFlightAt": newest_time,
        "aircraft": newest.get("aircraft") or "",
        "source": "measured from the recorded track",
    }


def _handle_descent(handler):
    if getattr(handler, "command", "GET") != "GET":
        _json_response(handler, {"ok": False, "error": "Method not allowed."}, 405)
        return
    _json_response(handler, get_descent_profile())


# ── HTTP handler additions (auth handled by stratos_bridge.py) ───────
def _json_response(handler, payload, status=200, headers=None, cors=False):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    if cors:
        handler.send_header("Access-Control-Allow-Origin", "*")
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _handle_logbook(handler):
    """GET /logbook.json (read) and POST /logbook.json (import a flight)."""
    if handler.command == "GET":
        _json_response(handler, lb_load())
        return
    if handler.command != "POST":
        handler.send_error(405, "Use GET or POST")
        return
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0 or length > MAX_POST_BYTES:
        _json_response(handler, {"ok": False, "error": "Request body is empty or too large."}, 413)
        return
    try:
        incoming = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        _json_response(handler, {"ok": False, "error": "Invalid JSON."}, 400)
        return
    flights = incoming if isinstance(incoming, list) else [incoming]
    accepted = 0
    rejected = 0
    for flight in flights:
        if not isinstance(flight, dict) or not flight.get("id") or len(flights) > 2000:
            rejected += 1
            continue
        if lb_add(flight):
            accepted += 1
        else:
            rejected += 1
    _json_response(handler, {"ok": True, "accepted": accepted, "rejected": rejected})
