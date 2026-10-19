#!/usr/bin/env python3
"""Stratos simulator bridge for X-Plane 11/12 and Microsoft Flight Simulator.

What it does
  * Listens for X-Plane UDP data output (rows 3, 17 and 20) on port 49003.
  * Optionally connects to MSFS 2020/2024 through SimConnect (pip install SimConnect).
  * Serves the Stratos app, a live SSE telemetry stream, the logbook and airport data.
  * Records flights, a replayable track and measured landing data (see
    bridge_logbook_addon.py).
  * Pushes telemetry to an optional phone relay when paired.

Security
  * Requests from the machine itself (loopback) are trusted: that is the desktop app.
  * Anything arriving over the LAN needs the bridge access token. The token is
    generated on first run, stored with 0600 permissions and printed in the log;
    the desktop app shows it in Settings.
  * No wildcard CORS. State-changing requests must be same-origin or loopback.

Standard library only. Python 3.8+.
"""

import csv
import datetime
import hmac
import io
import json
import math
import os
import platform
import re
import secrets
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from bridge_logbook_addon import (
    VERSION,
    _handle_descent,
    _handle_logbook,
    finalize_active_flight,
    get_current_flight,
    get_flight_phase,
    get_stats,
    lb_load,
    process_telemetry_for_logbook,
    recent_flights,
    recover_inprogress,
)

UDP_PORT = int(os.environ.get("STRATOS_UDP_PORT", "49003"))
HTTP_PORT = int(os.environ.get("STRATOS_HTTP_PORT", "8765"))
HOST = os.environ.get("STRATOS_HOST", "127.0.0.1")
UDP_HOST = os.environ.get("STRATOS_UDP_HOST", "0.0.0.0")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("STRATOS_DATA_DIR", HERE)
os.makedirs(DATA_DIR, exist_ok=True)
APP_DIR = os.path.join(HERE, "app")
STATIC_DIR = APP_DIR if os.path.isdir(APP_DIR) else HERE
TOKEN_FILE = os.path.join(DATA_DIR, "bridge_token.txt")
RELAY_FILE = os.path.join(DATA_DIR, "relay.json")
AIRCRAFT_FILE = os.path.join(DATA_DIR, "aircraft.json")
LOG_FILE = os.path.join(DATA_DIR, "stratos_bridge.log")
STARTED_AT = time.time()

state = {}
state_lock = threading.Lock()
METARS = {}
METARS_LOCK = threading.Lock()
FAA = {}
FAA_LOCK = threading.Lock()
# Cycle, publication window and check time for the catalogue currently in FAA.
FAAMETA = {"cycle": "", "from": 0, "to": 0, "checkedAt": 0, "airports": 0}
CHART_CACHE_DIR = os.path.join(DATA_DIR, "charts")
CHART_FILE_RE = re.compile(r"^[A-Z0-9]{1,12}\.PDF$")
MAX_CHART_BYTES = 24 * 1024 * 1024
OSMDIR = os.path.join(DATA_DIR, "osm_cache")
airports = []
navaids = []
airports_loaded_at = 0
msfs_status = {"available": False, "connected": False, "error": ""}
udp_status = {"ready": False, "error": ""}
relay_status = {"configured": False, "url": "", "code": "", "expiresAt": 0,
                "lastPushAt": 0, "lastError": "", "pairedAt": 0}
relay_lock = threading.Lock()
unlock_attempts = {}
unlock_lock = threading.Lock()


# ── Logging ─────────────────────────────────────────────────────────
_log_lock = threading.Lock()


def log(message):
    line = "%s %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message)
    print(line, flush=True)
    try:
        with _log_lock:
            if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 2 * 1024 * 1024:
                os.replace(LOG_FILE, LOG_FILE + ".1")
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError:
        pass


# ── Token / auth ────────────────────────────────────────────────────
def load_token():
    env = os.environ.get("STRATOS_BRIDGE_TOKEN", "").strip()
    if env:
        return env
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            token = f.read().strip()
            if len(token) >= 20:
                return token
    except OSError:
        pass
    token = secrets.token_urlsafe(24)
    try:
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(token)
    except OSError as exc:
        log("Could not persist the access token: %s" % exc)
    return token


TOKEN = load_token()


def load_aircraft_identity():
    try:
        with open(AIRCRAFT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {
            "aircraft": str(data.get("aircraft", ""))[:48],
            "registration": str(data.get("registration", ""))[:24],
            "callsign": str(data.get("callsign", ""))[:24],
        }
    except (OSError, ValueError):
        return {}


def save_aircraft_identity(data):
    try:
        with open(AIRCRAFT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError:
        pass


# ── Relay configuration ────────────────────────────────────────────
def load_relay():
    try:
        with open(RELAY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not data.get("url") or not data.get("token"):
            return None
        url = str(data["url"]).rstrip("/")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("https", "http"):
            return None
        if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            log("Relay URL is not HTTPS; refusing to send a token over plain HTTP.")
            return None
        return {"url": url, "token": str(data["token"]),
                "code": str(data.get("code", "")), "expiresAt": data.get("expiresAt", 0),
                "pairedAt": data.get("pairedAt", 0)}
    except (OSError, ValueError):
        return None


def save_relay(data):
    if data is None:
        try:
            os.remove(RELAY_FILE)
        except OSError:
            pass
        return
    fd = os.open(RELAY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)


def revoke_relay_session():
    """Tell the relay to delete this bridge's session, then forget it locally."""
    config = load_relay()
    if not config:
        return
    request = urllib.request.Request(
        config["url"] + "/api/session", method="DELETE",
        headers={"Authorization": "Bearer " + config["token"],
                 "User-Agent": "Stratos-Bridge/%s" % VERSION})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            response.read(128)
    except Exception as exc:
        log("Could not revoke the relay session (it will expire anyway): %s" % exc)


def relay_snapshot():
    with state_lock:
        telemetry = dict(state)
    telemetry.pop("tr", None)
    telemetry.pop("trt", None)
    if telemetry.get("t"):
        telemetry["age"] = round(max(0.0, time.time() - telemetry["t"]), 2)
        telemetry["t"] = round(float(telemetry["t"]), 3)
    flight = get_current_flight()
    history = []
    for index, record in enumerate(recent_flights(8)):
        entry = {
            "id": record.get("id"),
            "depAirport": record.get("depAirport"),
            "arrAirport": record.get("arrAirport"),
            "aircraft": record.get("aircraft"),
            "startTime": record.get("startTime"),
            "takeoffTime": record.get("takeoffTime"),
            "landingTime": record.get("landingTime"),
            "distanceNm": record.get("distanceNm"),
            "landingVS": record.get("landingVS"),
            "landing": record.get("landing"),
            "incomplete": record.get("incomplete", False),
        }
        # Enough recorded track for mobile replay, without shipping the whole flight.
        if index < 3 and isinstance(record.get("track"), list) and len(record["track"]) > 1:
            track = record["track"]
            step = max(1, int(math.ceil(len(track) / 600.0)))
            entry["track"] = track[::step] + ([track[-1]] if track[-1] not in track[::step] else [])
        history.append(entry)
    return {
        "ts": int(time.time() * 1000),
        "bridgeVersion": VERSION,
        "phase": get_flight_phase(),
        "telemetry": telemetry,
        "flight": flight,
        "recent": history,
        "stats": get_stats(),
    }


def relay_loop():
    last_config_read = 0.0
    cached = None
    while True:
        now = time.time()
        if now - last_config_read > 5:
            cached = load_relay()
            last_config_read = now
            with relay_lock:
                relay_status["configured"] = bool(cached)
                relay_status["url"] = cached["url"] if cached else ""
        if not cached:
            time.sleep(3)
            continue
        body = json.dumps(relay_snapshot(), separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            cached["url"] + "/api/ingest", data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + cached["token"],
                     "User-Agent": "Stratos-Bridge/%s" % VERSION})
        telemetry_age = 999
        with state_lock:
            telemetry_age = time.time() - state.get("t", 0) if state.get("t") else 999
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read(256)
            with relay_lock:
                relay_status.update(lastPushAt=int(time.time() * 1000), lastError="")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read(200).decode("utf-8", "replace")
            except Exception:
                pass
            with relay_lock:
                relay_status["lastError"] = "Relay HTTP %s %s" % (exc.code, detail[:160])
            if exc.code in (401, 403, 404):
                # A revoked/unknown token must not be retried forever. Forget it
                # and make the UI ask for a fresh pairing instead of spamming.
                log("Relay rejected this bridge (%s). Re-pair from Settings." % exc.code)
                save_relay(None)
                cached = None
                with relay_lock:
                    relay_status.update(configured=False, url="", code="", expiresAt=0,
                                        lastError="Pairing was rejected or revoked. Generate a new code in Settings.")
        except Exception as exc:
            with relay_lock:
                relay_status["lastError"] = str(exc)[:200]
        time.sleep(2 if telemetry_age < 5 else 5)


# ── X-Plane UDP ─────────────────────────────────────────────────────
def udp_loop():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind((UDP_HOST, UDP_PORT))
        sock.settimeout(2.0)
        udp_status["ready"] = True
        log("X-Plane UDP listening on port %d" % UDP_PORT)
    except OSError as exc:
        udp_status["error"] = str(exc)
        log("Could not listen for X-Plane UDP on port %d: %s" % (UDP_PORT, exc))
        return
    previous = None
    while True:
        try:
            data, _ = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError:
            return
        if data[:4] != b"DATA":
            continue
        new_sample = False
        identity = load_aircraft_identity()
        for offset in range(5, len(data) - 35, 36):
            try:
                index = struct.unpack("<i", data[offset:offset + 4])[0]
                values = struct.unpack("<8f", data[offset + 4:offset + 36])
            except struct.error:
                break
            with state_lock:
                if index == 3:                       # speeds
                    state["gs"] = float(values[3])
                elif index == 17:                    # pitch, roll, true/mag heading
                    state["hdg"] = float(values[2])
                elif index == 20:                    # lat, lon, alt MSL, alt AGL
                    now = time.time()
                    state.update(lat=float(values[0]), lon=float(values[1]),
                                 alt=float(values[2]), agl=float(values[3]),
                                 t=now, src="X-Plane")
                    if previous is None:
                        previous = (float(values[2]), now)
                    elif now - previous[1] >= 0.5:
                        state["vs"] = (float(values[2]) - previous[0]) / (now - previous[1]) * 60.0
                        previous = (float(values[2]), now)
                    new_sample = True
                for key, value in identity.items():
                    if value and not state.get(key):
                        state[key] = value
        if new_sample:
            with state_lock:
                snapshot = dict(state)
            try:
                process_telemetry_for_logbook(snapshot, airports)
            except Exception as exc:
                log("Logbook processing error: %s" % exc)


# ── OurAirports / FAA / OpenStreetMap ───────────────────────────────
OA = "https://davidmegginson.github.io/ourairports-data/"
CACHE = os.path.join(DATA_DIR, "airports_cache3.json")


def load_airports():
    global airports, navaids, airports_loaded_at
    try:
        with open(CACHE, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("a"):
            airports, navaids = cached["a"], cached.get("n", [])
            airports_loaded_at = time.time()
            return
    except (OSError, ValueError):
        pass
    try:
        def rows(name):
            raw = urllib.request.urlopen(OA + name, timeout=90).read().decode("utf-8")
            return csv.DictReader(io.StringIO(raw))

        runways, runway_rows = {}, {}
        for row in rows("runways.csv"):
            match = re.match(r"\d+", row["le_ident"] or "")
            if row["closed"] == "1" or not match:
                continue
            number = int(match.group())
            low = number if number <= 18 else number - 18
            if not 1 <= low <= 18:
                continue
            bucket = runways.setdefault(row["airport_ident"], {})
            bucket[low] = max(bucket.get(low, 0), int(float(row["length_ft"] or 0)))
            try:
                runway_rows.setdefault(row["airport_ident"], []).append([
                    row["le_ident"], row["he_ident"],
                    float(row["le_latitude_deg"]), float(row["le_longitude_deg"]),
                    float(row["he_latitude_deg"]), float(row["he_longitude_deg"]),
                    int(float(row["length_ft"] or 0)), int(float(row["width_ft"] or 0))])
            except ValueError:
                pass
        frequencies = {}
        for row in rows("airport-frequencies.csv"):
            frequencies.setdefault(row["airport_ident"], {}).setdefault(row["type"], row["frequency_mhz"])
        out = []
        for row in rows("airports.csv"):
            if row["type"] in ("large_airport", "medium_airport") and row["ident"] in runways:
                bucket = runways[row["ident"]]
                out.append([row["ident"], row["name"], float(row["latitude_deg"]),
                            float(row["longitude_deg"]), int(float(row["elevation_ft"] or 0)),
                            list(bucket.keys()), list(bucket.values()),
                            runway_rows.get(row["ident"], []), frequencies.get(row["ident"], {})])
        navs = []
        for row in rows("navaids.csv"):
            kind = row["type"]
            if not (kind.startswith("VOR") or kind.startswith("NDB")) or not row["frequency_khz"]:
                continue
            try:
                freq = float(row["frequency_khz"])
                navs.append([row["ident"], row["name"], kind,
                             float(row["latitude_deg"]), float(row["longitude_deg"]),
                             ("%.2f MHz" % (freq / 1000)) if kind.startswith("VOR") else ("%d kHz" % freq)])
            except ValueError:
                continue
        airports, navaids = out, navs
        airports_loaded_at = time.time()
        tmp = CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"a": out, "n": navs}, f)
        os.replace(tmp, CACHE)
        log("Loaded %d airports and %d navaids from OurAirports" % (len(out), len(navs)))
    except Exception as exc:
        log("Airport download failed (bundled airports still work): %s" % exc)


def osm_airfield(ident, lat, lon):
    """Runways/taxiways/aprons from OpenStreetMap (ODbL), cached on disk."""
    path = os.path.join(OSMDIR, re.sub(r"\W", "", ident) + ".json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        pass
    query = ('[out:json][timeout:30];(way["aeroway"~"^(runway|taxiway|taxilane|apron|terminal)$"]'
             '(around:5000,%f,%f););out geom;' % (lat, lon))
    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "Stratos-Bridge/%s" % VERSION})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    result = [[element["tags"]["aeroway"], element["tags"].get("ref", ""),
               [[point["lat"], point["lon"]] for point in element["geometry"]]]
              for element in payload.get("elements", [])
              if element.get("type") == "way" and element.get("geometry")]
    text = json.dumps(result)
    os.makedirs(OSMDIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def faa_cycle(back=0):
    """FAA d-TPP 28-day cycle; 2601 took effect 2026-01-22."""
    offset = (datetime.date.today() - datetime.date(2026, 1, 22)).days // 28 - back
    return "26%02d" % (1 + offset)


def faa_epoch(value):
    """FAA effective dates look like '0901Z  10/01/26'."""
    match = re.search(r"(\d{2})(\d{2})Z\s+(\d{2})/(\d{2})/(\d{2})", value or "")
    if not match:
        return 0
    hh, mm, month, day, year = (int(part) for part in match.groups())
    return int(datetime.datetime(2000 + year, month, day, hh, mm,
                                 tzinfo=datetime.timezone.utc).timestamp() * 1000)


def load_faa():
    """The complete FAA d-TPP catalogue: diagrams, approaches, SIDs, STARs and
    supplementary documents (U.S. Government work, public domain).

    The old loader kept only airport diagrams and ILS approaches; the chart
    viewer needs every published category, and it needs the publication window
    so an expired cycle is never presented as current.
    """
    for back in (0, 1):
        cycle = faa_cycle(back)
        url = "https://aeronav.faa.gov/d-tpp/%s/xml_data/d-TPP_Metafile.xml" % cycle
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Stratos-Bridge/%s" % VERSION})
            with urllib.request.urlopen(request, timeout=180) as response:
                for _, element in ET.iterparse(response):
                    if element.tag == "digital_tpp":
                        FAAMETA["cycle"] = element.get("cycle") or cycle
                        FAAMETA["from"] = faa_epoch(element.get("from_edate"))
                        FAAMETA["to"] = faa_epoch(element.get("to_edate"))
                        FAAMETA["checkedAt"] = int(time.time() * 1000)
                        continue
                    if element.tag != "airport_name":
                        continue
                    icao = element.get("icao_ident") or ("K" + (element.get("apt_ident") or ""))
                    charts = []
                    for record in element.findall("record"):
                        code = (record.findtext("chart_code") or "").strip()
                        name = (record.findtext("chart_name") or "").strip()
                        pdf = (record.findtext("pdf_name") or "").strip().upper()
                        amended = (record.findtext("amdtdate") or "").strip()
                        if not pdf or not CHART_FILE_RE.match(pdf):
                            continue
                        charts.append([code, name, pdf, amended or None])
                    if charts:
                        with FAA_LOCK:
                            FAA[icao] = {"cycle": cycle, "c": charts}
                    element.clear()
            with FAA_LOCK:
                FAAMETA["airports"] = len(FAA)
            log("Loaded FAA d-TPP cycle %s (%d airports)" % (cycle, len(FAA)))
            return
        except Exception as exc:
            log("FAA d-TPP cycle %s unavailable: %s" % (cycle, exc))


DEFAULT_PACK = ("KSFO KOAK KSJC KSAC KRNO KLAX KSAN KLAS KPHX KSEA KPDX KBOI KSLC KDEN KABQ "
                "KDFW KAUS KIAH KMSP KORD KATL KMIA KJFK KBOS KDCA KCLT KLGA KEWR KPHL KMCO "
                "KTPA KMDW KHOU KSNA CYYZ CYVR CYUL CYYC CYEG CYOW CYWG CYHZ CYQB CYYJ EGLL "
                "EGKK EGCC EGPH EIDW LFPG LFPO EHAM EDDF EDDM EDDB LEMD LEBL LIRF LIMC LSZH "
                "LOWW EKCH ESSA ENGM EFHK EPWA LKPR LHBP LGAV LTFM LPPT BIKF").split()


def build_pack(ids):
    load_airports()
    load_faa()
    pack = {"built": time.strftime("%Y-%m-%d"), "cycle": faa_cycle(), "airports": airports,
            "navaids": navaids, "osm": {}, "faa": {}}
    for ident in ids:
        airport = next((a for a in airports if a[0] == ident), None)
        if not airport:
            print("skip", ident, "(not in OurAirports list)")
            continue
        try:
            ways = json.loads(osm_airfield(ident, airport[2], airport[3]))
            pack["osm"][ident] = [[w[0], w[1], [[round(p[0], 5), round(p[1], 5)] for p in w[2]]]
                                  for w in ways]
            print("OSM layout", ident, len(ways), "ways")
        except Exception as exc:
            print("OSM failed for", ident, exc)
        if ident in FAA:
            pack["faa"][ident] = FAA[ident]
        time.sleep(2)
    with open(os.path.join(DATA_DIR, "stratos_pack.json"), "w", encoding="utf-8") as f:
        json.dump(pack, f, separators=(",", ":"))
    print("Wrote stratos_pack.json. Send it to your phone and import it in the app (Data tab).")


def tile(z, x, y):
    """Esri World Imagery, cached on disk. Imagery (c) Esri, Maxar, Earthstar Geographics."""
    path = os.path.join(DATA_DIR, "tiles", str(z), str(x), str(y) + ".jpg")
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        pass
    url = ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/"
           "MapServer/tile/%d/%d/%d" % (z, y, x))
    data = urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "Stratos-Bridge/%s" % VERSION}),
        timeout=15).read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return data


# ── MSFS ────────────────────────────────────────────────────────────
def msfs_loop():
    try:
        from SimConnect import AircraftRequests, SimConnect
        msfs_status["available"] = True
    except Exception:
        if sys.platform == "win32":
            log("MSFS support not installed. Run:  pip install SimConnect")
        return
    import math
    requests, previous, warned = None, None, False
    while True:
        try:
            if requests is None:
                sim = SimConnect()
                requests = AircraftRequests(sim, _time=200)
                msfs_status.update(connected=True, error="")
                log("Connected to MSFS")
                warned = False
            lat = requests.get("PLANE_LATITUDE")
            lon = requests.get("PLANE_LONGITUDE")
            alt = requests.get("PLANE_ALTITUDE")
            if lat is None or lon is None or alt is None:
                time.sleep(0.5)
                continue
            heading = requests.get("PLANE_HEADING_DEGREES_TRUE")
            heading = math.degrees(heading) if heading is not None else 0.0
            gs = requests.get("GROUND_VELOCITY") or 0
            agl = requests.get("PLANE_ALT_ABOVE_GROUND") or 0
            def safe_get(name):
                try:
                    return requests.get(name)
                except Exception:
                    return None

            fuel = safe_get("FUEL_TOTAL_QUANTITY")
            title = safe_get("TITLE") or ""
            tail = safe_get("ATC_ID") or ""
            call = safe_get("ATC CALLSIGN") or ""
            now = time.time()
            with state_lock:
                state.update(lat=float(lat), lon=float(lon), alt=float(alt), agl=float(agl),
                             hdg=float(heading) % 360, gs=float(gs), t=now, src="MSFS",
                             aircraft=str(title)[:48], registration=str(tail)[:24],
                             callsign=str(call)[:24])
                if fuel is not None:
                    state["fuel"] = float(fuel)
                if previous is None:
                    previous = (float(alt), now)
                elif now - previous[1] >= 0.5:
                    state["vs"] = (float(alt) - previous[0]) / (now - previous[1]) * 60.0
                    previous = (float(alt), now)
                snapshot = dict(state)
            try:
                process_telemetry_for_logbook(snapshot, airports)
            except Exception as exc:
                log("Logbook processing error: %s" % exc)
            time.sleep(0.25)
        except Exception as exc:
            requests = None
            msfs_status["connected"] = False
            if not warned:
                log("Waiting for MSFS: %s" % exc)
                warned = True
            time.sleep(5)


def traffic_loop():
    """Real ADS-B traffic around the simulator position (OpenSky, rate limited)."""
    while True:
        time.sleep(15)
        with state_lock:
            lat, lon, stamp = state.get("lat"), state.get("lon"), state.get("t", 0)
        if lat is None or time.time() - stamp > 5:
            continue
        url = ("https://opensky-network.org/api/states/all?lamin=%f&lamax=%f&lomin=%f&lomax=%f"
               % (lat - 1.2, lat + 1.2, lon - 1.8, lon + 1.8))
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Stratos-Bridge/%s" % VERSION})
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.load(response)
            traffic = []
            for item in payload.get("states") or []:
                if item[6] is None or item[5] is None or item[8] or item[10] is None:
                    continue
                traffic.append(dict(id=(item[1] or item[0]).strip(), lat=item[6], lon=item[5],
                                    alt=round((item[7] or 0) * 3.281), gs=round((item[9] or 0) * 1.944),
                                    hdg=item[10], vs=round((item[11] or 0) * 196.85), cc=item[2]))
            with state_lock:
                state["tr"], state["trt"] = traffic[:80], time.time()
        except Exception:
            pass


# ── HTTP server ─────────────────────────────────────────────────────
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".pdf": "application/pdf",
}

UNLOCK_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Stratos bridge — unlock</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#08151d;color:#e7f0f2;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:24px}
.card{max-width:420px;width:100%;background:#142b36;border:1px solid #294754;border-radius:18px;padding:26px}
h1{font-size:20px;margin:0 0 6px}p{color:#91a8b1;margin:0 0 16px;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid #294754;
background:#0b1b24;color:#e7f0f2;font:inherit;font-size:16px;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:12px;background:#79c9bb;color:#04212b;font:inherit;font-weight:700;font-size:15px}
.err{color:#f17b89;font-size:13px;margin:0 0 12px}.hint{font-size:12px;color:#6f858e;margin-top:14px}
</style></head><body><form class="card" method="post" action="/unlock">
<h1>Stratos bridge</h1>
<p>This bridge is on your local network. Enter the access token shown in Stratos → Settings → Simulator bridge.</p>
%s
<input name="token" type="password" autocomplete="current-password" placeholder="Bridge access token" required autofocus>
<button type="submit">Unlock</button>
<p class="hint">The token is stored on the PC running the bridge, in <code>bridge_token.txt</code>. It is never sent anywhere else.</p>
</form></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "StratosBridge/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # ── auth helpers ────────────────────────────────────────────────
    def is_loopback(self):
        address = self.client_address[0] if self.client_address else ""
        return address in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def remote_token(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        supplied = (query.get("k", [""])[0] or
                    self.headers.get("X-Stratos-Token", ""))
        if not supplied:
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
                supplied = cookie.get("stratos_token").value if cookie.get("stratos_token") else ""
            except Exception:
                supplied = ""
        return supplied

    def authorized(self):
        if self.is_loopback():
            return True
        supplied = self.remote_token()
        return bool(supplied) and hmac.compare_digest(supplied, TOKEN)

    def same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            parts = urllib.parse.urlparse(origin)
            return parts.netloc == self.headers.get("Host", "")
        except ValueError:
            return False

    def unlock_denied(self, message=""):
        body = (UNLOCK_HTML % ('<p class="err">%s</p>' % message if message else "")).encode("utf-8")
        self.send_response(401)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def rate_limited(self):
        address = self.client_address[0] if self.client_address else "?"
        now = time.time()
        with unlock_lock:
            attempts = [t for t in unlock_attempts.get(address, []) if now - t < 60]
            unlock_attempts[address] = attempts
            if len(attempts) >= 10:
                return True
            attempts.append(now)
        return False

    def read_json(self, limit=1024 * 1024):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, "Invalid Content-Length"
        if length <= 0:
            return None, "Empty body"
        if length > limit:
            return None, "Body too large"
        try:
            return json.loads(self.rfile.read(length).decode("utf-8")), None
        except (ValueError, UnicodeDecodeError):
            return None, "Invalid JSON"

    def send_json(self, payload, status=200):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── routing ─────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        allowed = os.environ.get("STRATOS_ALLOWED_ORIGIN", "")
        origin = self.headers.get("Origin", "")
        if allowed and origin and origin == allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Stratos-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/unlock":
            self.handle_unlock()
            return
        if not self.authorized():
            self.send_json({"ok": False, "error": "Unauthorized"}, 401)
            return
        if not self.same_origin():
            self.send_json({"ok": False, "error": "Cross-origin request refused"}, 403)
            return
        if path == "/logbook.json":
            _handle_logbook(self)
            return
        if path == "/descent.json":
            _handle_descent(self)
            return
        if path == "/config":
            data, error = self.read_json(64 * 1024)
            if error:
                self.send_json({"ok": False, "error": error}, 400)
                return
            identity = {
                "aircraft": str(data.get("aircraft", ""))[:48],
                "registration": str(data.get("registration", ""))[:24],
                "callsign": str(data.get("callsign", ""))[:24],
            }
            save_aircraft_identity(identity)
            with state_lock:
                for key, value in identity.items():
                    if value:
                        state[key] = value
            self.send_json({"ok": True, "identity": identity})
            return
        if path == "/relay/pair":
            self.handle_relay_pair()
            return
        if path == "/relay/revoke":
            revoke_relay_session()
            save_relay(None)
            with relay_lock:
                relay_status.update(configured=False, url="", code="", expiresAt=0,
                                    lastError="", pairedAt=0)
            self.send_json({"ok": True})
            return
        if path == "/relay/devices/revoke":
            self.handle_relay_device_revoke()
            return
        self.send_json({"ok": False, "error": "Not found"}, 404)

    def do_DELETE(self):
        if not self.authorized():
            self.send_json({"ok": False, "error": "Unauthorized"}, 401)
            return
        if not self.same_origin():
            self.send_json({"ok": False, "error": "Cross-origin request refused"}, 403)
            return
        if urllib.parse.urlparse(self.path).path == "/relay":
            revoke_relay_session()
            save_relay(None)
            with relay_lock:
                relay_status.update(configured=False, url="", code="", expiresAt=0,
                                    lastError="", pairedAt=0)
            self.send_json({"ok": True})
            return
        self.send_json({"ok": False, "error": "Not found"}, 404)

    def handle_unlock(self):
        if self.rate_limited():
            self.unlock_denied("Too many attempts. Try again in a minute.")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 4096:
            self.unlock_denied("Invalid request.")
            return
        form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        supplied = form.get("token", [""])[0].strip()
        if supplied and hmac.compare_digest(supplied, TOKEN):
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", "stratos_token=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000" % TOKEN)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.unlock_denied("That token does not match this bridge.")

    def handle_relay_devices(self):
        config = load_relay()
        if not config:
            self.send_json({"ok": False, "error": "No relay is paired.", "devices": []}, 200)
            return
        request = urllib.request.Request(
            config["url"] + "/api/devices",
            headers={"Authorization": "Bearer " + config["token"],
                     "User-Agent": "Stratos-Bridge/%s" % VERSION})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.load(response)
            self.send_json(payload)
        except Exception as exc:
            self.send_json({"ok": False, "error": "Could not reach the relay: %s" % exc, "devices": []}, 200)

    def handle_relay_device_revoke(self):
        config = load_relay()
        if not config:
            self.send_json({"ok": False, "error": "No relay is paired."}, 400)
            return
        data, error = self.read_json(4096)
        if error:
            self.send_json({"ok": False, "error": error}, 400)
            return
        body = json.dumps({"id": str(data.get("id", ""))}).encode("utf-8")
        request = urllib.request.Request(
            config["url"] + "/api/devices/revoke", data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + config["token"],
                     "User-Agent": "Stratos-Bridge/%s" % VERSION})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.load(response)
            self.send_json(payload)
        except Exception as exc:
            self.send_json({"ok": False, "error": "Could not reach the relay: %s" % exc}, 502)

    def handle_relay_pair(self):
        if not self.is_loopback():
            self.send_json({"ok": False, "error": "Pairing must be started from the PC running the bridge."}, 403)
            return
        data, error = self.read_json(16 * 1024)
        if error:
            self.send_json({"ok": False, "error": error}, 400)
            return
        url = str(data.get("url", "")).rstrip("/")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("https", "http") or not parsed.hostname:
            self.send_json({"ok": False, "error": "Enter a valid relay URL."}, 400)
            return
        if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            self.send_json({"ok": False, "error": "Relay must use HTTPS (except localhost testing)."}, 400)
            return
        body = json.dumps({"name": data.get("name") or socket.gethostname()}).encode("utf-8")
        request = urllib.request.Request(url + "/api/pair", data=body, method="POST",
                                         headers={"Content-Type": "application/json",
                                                  "User-Agent": "Stratos-Bridge/%s" % VERSION})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.load(response)
        except Exception as exc:
            self.send_json({"ok": False, "error": "Could not reach the relay: %s" % exc}, 502)
            return
        if not payload.get("code") or not payload.get("desktopToken"):
            self.send_json({"ok": False, "error": "The relay returned an unexpected response."}, 502)
            return
        record = {"url": url, "token": payload["desktopToken"], "code": payload["code"],
                  "expiresAt": int(payload.get("expiresAt") or 0), "pairedAt": int(time.time() * 1000)}
        save_relay(record)
        with relay_lock:
            relay_status.update(configured=True, url=url, code=payload["code"],
                                expiresAt=int(payload.get("expiresAt") or 0),
                                pairedAt=record["pairedAt"], lastError="")
        self.send_json({"ok": True, "code": payload["code"],
                        "expiresAt": payload.get("expiresAt"), "url": url})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not self.authorized():
            self.unlock_denied()
            return
        if path == "/health":
            self.handle_health()
            return
        if path == "/logbook.json":
            _handle_logbook(self)
            return
        if path == "/descent.json":
            _handle_descent(self)
            return
        if path == "/stream":
            self.handle_stream(parsed)
            return
        if path == "/relay/status":
            with relay_lock:
                payload = dict(relay_status)
            payload["tokenFile"] = TOKEN_FILE
            self.send_json(payload)
            return
        if path == "/relay/devices":
            self.handle_relay_devices()
            return
        if path == "/osm":
            self.handle_osm(parsed)
            return
        match = re.match(r"^/tile/(\d+)/(\d+)/(\d+)", path)
        if match:
            self.handle_tile(*map(int, match.groups()))
            return
        if path == "/charts":
            self.handle_charts(parsed)
            return
        if path == "/chart":
            self.handle_chart(parsed)
            return
        if path == "/faa":
            ident = re.sub(r"\W", "", (urllib.parse.parse_qs(parsed.query).get("id", [""])[0])).upper()
            with FAA_LOCK:
                self.send_json(FAA.get(ident, {}))
            return
        if path == "/navaids.json":
            self.send_json(navaids)
            return
        if path == "/airports.json":
            self.send_json(airports)
            return
        if path == "/metar":
            self.handle_metar(parsed)
            return
        if path == "/weather":
            self.handle_weather(parsed)
            return
        self.serve_static(path)

    def handle_health(self):
        now = time.time()
        with state_lock:
            age = now - state.get("t", 0) if state.get("t") else None
            source = state.get("src", "")
        payload = {
            "ok": True,
            "version": VERSION,
            "uptimeSeconds": int(now - STARTED_AT),
            "platform": platform.platform(),
            "python": platform.python_version(),
            "ports": {"http": HTTP_PORT, "udp": UDP_PORT},
            "host": HOST,
            "simulator": {
                "connected": bool(age is not None and age < 5),
                "source": source,
                "ageSeconds": round(age, 2) if age is not None else None,
            },
            "xplane": udp_status,
            "msfs": msfs_status,
            "airports": len(airports),
            "navaids": len(navaids),
            "airportsLoadedAt": int(airports_loaded_at * 1000) if airports_loaded_at else 0,
            "faaCharts": len(FAA),
            "logbook": get_stats(),
            "relay": {key: value for key, value in relay_status.items() if key != "token"},
            "lanIp": lan_ip(),
            "auth": {"remoteTokenRequired": True},
            "identity": load_aircraft_identity(),
            "dataDir": DATA_DIR,
        }
        self.send_json(payload)

    def handle_stream(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        try:
            hz = float(query.get("hz", ["4"])[0])
        except ValueError:
            hz = 4.0
        interval = 1.0 / max(1.0, min(10.0, hz))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last_payload = None
        heartbeat = time.time()
        try:
            while True:
                with state_lock:
                    snapshot = dict(state)
                snapshot["age"] = round(time.time() - snapshot.get("t", 0), 2) if snapshot.get("t") else None
                snapshot["flightPhase"] = get_flight_phase()
                current = get_current_flight()
                if current:
                    snapshot["currentFlight"] = current
                text = json.dumps(snapshot, separators=(",", ":"))
                now = time.time()
                if text != last_payload or now - heartbeat > 5:
                    self.wfile.write(("data: " + text + "\n\n").encode("utf-8"))
                    self.wfile.flush()
                    last_payload = text
                    heartbeat = now
                time.sleep(interval)
        except Exception:
            return

    def handle_osm(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        try:
            body = osm_airfield(query["id"][0], float(query["lat"][0]), float(query["lon"][0])).encode("utf-8")
        except Exception:
            body = b"[]"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "max-age=86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_charts(self, parsed):
        """Catalogue for one airport, with the cycle and its publication window."""
        query = urllib.parse.parse_qs(parsed.query)
        icao = re.sub(r"\W", "", (query.get("icao", [""])[0])).upper()
        if not re.fullmatch(r"[A-Z0-9]{3,5}", icao or ""):
            self.send_json({"error": "A 3-5 character airport identifier is required."}, 400)
            return
        with FAA_LOCK:
            meta = dict(FAAMETA)
            entry = FAA.get(icao)
            charts = [{"code": c[0], "title": c[1], "pdf": c[2], "amended": c[3]}
                      for c in (entry or {}).get("c", [])]
        if not meta.get("cycle"):
            # The metafile is still downloading: this is not "no charts".
            self.send_json({"error": "source-unavailable",
                            "message": "The FAA catalogue is still loading on the bridge.",
                            "retry": True}, 503)
            return
        payload = {
            "source": "faa-dtpp",
            "sourceName": "FAA Digital Terminal Procedures",
            "license": "U.S. Government work - public domain",
            "icao": icao,
            "cycle": entry.get("cycle") if entry else meta.get("cycle"),
            "effective": meta.get("from"),
            "expires": meta.get("to"),
            "checkedAt": meta.get("checkedAt"),
            "charts": charts,
        }
        if not charts:
            payload["unsupported"] = True
            payload["message"] = ("No FAA d-TPP charts are published for %s. Current coverage is the FAA "
                                  "publication (United States and territories); other authorities are not mirrored." % icao)
            self.send_json(payload, 404)
            return
        self.send_json(payload)

    def handle_chart(self, parsed):
        """One official FAA PDF, cached on disk and served only for the current cycle."""
        query = urllib.parse.parse_qs(parsed.query)
        cycle = (query.get("cycle", [""])[0] or "").strip()
        name = (query.get("file", [""])[0] or "").strip().upper()
        if not re.fullmatch(r"\d{4}", cycle) or not CHART_FILE_RE.match(name):
            self.send_json({"error": "Invalid chart request."}, 400)
            return
        with FAA_LOCK:
            current = FAAMETA.get("cycle") or ""
        if current and cycle != current:
            self.send_json({"error": "cycle-mismatch",
                            "message": "Only the current FAA cycle is served; refresh the catalogue."}, 409)
            return
        path = os.path.join(CHART_CACHE_DIR, cycle, name)
        body = None
        if os.path.isfile(path):
            try:
                with open(path, "rb") as handle:
                    body = handle.read()
            except OSError:
                body = None
        if body is None:
            url = "https://aeronav.faa.gov/d-tpp/%s/%s" % (cycle, name)
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "Stratos-Bridge/%s" % VERSION})
                with urllib.request.urlopen(request, timeout=60) as response:
                    body = response.read(MAX_CHART_BYTES + 1)
            except Exception as exc:
                self.send_json({"error": "upstream",
                                "message": "The FAA document could not be downloaded: %s" % exc}, 502)
                return
            if len(body) > MAX_CHART_BYTES:
                self.send_json({"error": "too-large", "message": "The document is larger than Stratos will serve."}, 502)
                return
            if not body.startswith(b"%PDF"):
                self.send_json({"error": "not-a-pdf", "message": "The source did not return a PDF document."}, 502)
                return
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                temporary = path + ".part"
                with open(temporary, "wb") as handle:
                    handle.write(body)
                os.replace(temporary, path)
            except OSError:
                pass
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "max-age=31536000, immutable")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_tile(self, z, x, y):
        try:
            body = tile(z, x, y)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "max-age=604800")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            self.send_error(404)

    def handle_weather(self, parsed):
        """METAR + TAF as JSON, straight from NOAA Aviation Weather (public domain)."""
        icao = re.sub(r"[^A-Za-z0-9]", "", urllib.parse.parse_qs(parsed.query).get("icao", [""])[0]).upper()[:8]
        if len(icao) < 3:
            self.send_json({"error": "Missing or invalid icao parameter"}, 400)
            return
        cache_key = "json:" + icao
        with METARS_LOCK:
            cached = METARS.get(cache_key)
        if cached and time.time() - cached[0] < 300:
            self.send_json(cached[1])
            return
        now = int(time.time() * 1000)
        result = {"icao": icao, "metar": None, "taf": None, "decoded": None,
                  "fetchedAt": now, "source": "NOAA Aviation Weather Center"}
        try:
            metar_url = "https://aviationweather.gov/api/data/metar?ids=%s&format=json&hours=2" % icao
            taf_url = "https://aviationweather.gov/api/data/taf?ids=%s&format=json&time=valid" % icao
            headers = {"User-Agent": "Stratos-Bridge/%s" % VERSION, "Accept": "application/json"}
            metar_data, taf_data = [], []
            try:
                with urllib.request.urlopen(urllib.request.Request(metar_url, headers=headers), timeout=12) as response:
                    metar_data = json.load(response)
            except Exception:
                metar_data = []
            try:
                with urllib.request.urlopen(urllib.request.Request(taf_url, headers=headers), timeout=12) as response:
                    taf_data = json.load(response)
            except Exception:
                taf_data = []
            metar = metar_data[0] if isinstance(metar_data, list) and metar_data else None
            taf = taf_data[0] if isinstance(taf_data, list) and taf_data else None
            if metar:
                result["metar"] = metar.get("rawOb")
                result["decoded"] = {
                    "temp_c": metar.get("temp"), "dewpoint_c": metar.get("dewp"),
                    "wind_dir": metar.get("wdir"), "wind_speed_kt": metar.get("wspd"),
                    "wind_gust_kt": metar.get("wgst"), "visibility_sm": metar.get("visib"),
                    "altimeter": metar.get("altim"), "flight_category": metar.get("fltcat"),
                    "sky_conditions": metar.get("clouds"), "obs_time": metar.get("obsTime"),
                }
            if taf:
                result["taf"] = taf.get("rawTAF")
                result["tafIssueTime"] = taf.get("issueTime")
            result["fetchedAt"] = int(time.time() * 1000)
            with METARS_LOCK:
                METARS[cache_key] = (time.time(), result)
        except Exception as exc:
            result["error"] = str(exc)[:200]
        self.send_json(result)

    def handle_metar(self, parsed):
        ident = re.sub(r"[^A-Za-z0-9,]", "", urllib.parse.parse_qs(parsed.query).get("ids", [""])[0])[:40]
        if not ident:
            self.send_json({"error": "Missing ids parameter"}, 400)
            return
        with METARS_LOCK:
            cached = METARS.get(ident)
        if cached and time.time() - cached[0] < 120:
            body = cached[1]
        else:
            try:
                request = urllib.request.Request(
                    "https://aviationweather.gov/api/data/metar?format=raw&ids=" + ident,
                    headers={"User-Agent": "Stratos-Bridge/%s" % VERSION})
                body = urllib.request.urlopen(request, timeout=10).read()
                if body:
                    with METARS_LOCK:
                        METARS[ident] = (time.time(), body)
            except Exception:
                body = cached[1] if cached else b""
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "max-age=120")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, path):
        if path in ("/", "/index.html"):
            relative = "index.html"
        elif path == "/logbook.html":
            relative = "logbook.html"
        elif path == "/weather.html":
            relative = "weather.html"
        else:
            relative = path.lstrip("/")
        if relative.startswith("app/"):
            relative = relative[4:]
        if not relative or relative.endswith("/"):
            relative += "index.html"
        # Prevent traversal and serving hidden files.
        parts = [part for part in relative.split("/") if part not in ("", ".", "..")]
        if any(part.startswith(".") and part not in (".well-known",) for part in parts):
            self.send_error(404)
            return
        base = STATIC_DIR
        target = os.path.realpath(os.path.join(base, *parts)) if parts else os.path.realpath(base)
        if os.path.commonpath([os.path.realpath(base), target]) != os.path.realpath(base):
            self.send_error(403)
            return
        if not os.path.isfile(target):
            # Legacy fallback: a standalone copy next to the bridge script.
            legacy = os.path.realpath(os.path.join(HERE, *parts)) if parts else ""
            if legacy and os.path.commonpath([os.path.realpath(HERE), legacy]) == os.path.realpath(HERE) \
                    and os.path.isfile(legacy):
                target = legacy
            else:
                self.send_error(404, "File not found")
                return
        try:
            with open(target, "rb") as f:
                body = f.read()
        except OSError:
            self.send_error(500)
            return
        extension = os.path.splitext(target)[1].lower()
        content_type = CONTENT_TYPES.get(extension, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        if extension in (".html", ".js", ".mjs", ".css", ".webmanifest"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "max-age=86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def lan_ip():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def startup_recovery():
    try:
        recover_inprogress()
    except Exception as exc:
        log("Could not recover an interrupted flight: %s" % exc)
    if load_relay():
        with relay_lock:
            relay_status["configured"] = True


def shutdown(*_args):
    log("Shutting down; finalising any active flight")
    try:
        finalize_active_flight()
    except Exception as exc:
        log("Finalise error: %s" % exc)
    os._exit(0)


def main():
    if "--pack" in sys.argv:
        extra = [item.upper() for item in sys.argv[sys.argv.index("--pack") + 1:]]
        build_pack(extra or DEFAULT_PACK)
        return

    log("Stratos bridge %s starting (data dir: %s)" % (VERSION, DATA_DIR))
    startup_recovery()
    threading.Thread(target=load_airports, daemon=True).start()
    threading.Thread(target=load_faa, daemon=True).start()
    threading.Thread(target=udp_loop, daemon=True).start()
    threading.Thread(target=msfs_loop, daemon=True).start()
    threading.Thread(target=traffic_loop, daemon=True).start()
    threading.Thread(target=relay_loop, daemon=True).start()

    try:
        server = ThreadingHTTPServer((HOST, HTTP_PORT), Handler)
    except OSError as exc:
        log("Could not start the bridge on port %d: %s" % (HTTP_PORT, exc))
        log("Another Stratos bridge may already be running. Close it, or set STRATOS_HTTP_PORT.")
        sys.exit(2)
    server.daemon_threads = True
    print("")
    print("  Stratos bridge is running")
    print("  On this PC:   http://127.0.0.1:%d" % HTTP_PORT)
    print("  On your LAN:  http://%s:%d  (set STRATOS_HOST=0.0.0.0 to enable; token required)" % (lan_ip(), HTTP_PORT))
    print("  Access token: %s" % TOKEN)
    print("  X-Plane: Settings > Data Output, enable rows 3, 17 and 20 to UDP %s:%d" % (lan_ip(), UDP_PORT))
    print("  MSFS: start a flight (install the connector once with  pip install SimConnect )")
    print("  Token file:   %s" % TOKEN_FILE)
    print("")
    try:
        import signal
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
    except (ImportError, ValueError):
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
