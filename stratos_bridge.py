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
import hashlib
import hmac
import io
import ipaddress
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

import stratos_cifp as nav_cifp

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
# The phone pairs over the local network, so the bridge listens on the LAN by
# default. Every non-loopback request still needs the access token: pairing is
# the only unauthenticated route and it only accepts a short-lived token.
HOST = os.environ.get("STRATOS_HOST", "0.0.0.0")
UDP_HOST = os.environ.get("STRATOS_UDP_HOST", "0.0.0.0")
# X-Plane answers UDP dataref requests on its own port; the bridge only reads
# the data-output port, so identity requests go to the simulator directly.
XPLANE_HOST = os.environ.get("STRATOS_XPLANE_HOST", "127.0.0.1")
XPLANE_UDP_PORT = int(os.environ.get("STRATOS_XPLANE_UDP_PORT", "49000"))
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("STRATOS_DATA_DIR", HERE)
os.makedirs(DATA_DIR, exist_ok=True)
APP_DIR = os.path.join(HERE, "app")
STATIC_DIR = APP_DIR if os.path.isdir(APP_DIR) else HERE
TOKEN_FILE = os.path.join(DATA_DIR, "bridge_token.txt")
PHONE_PAIRS_FILE = os.path.join(DATA_DIR, "phone_pairs.json")
RELAY_FILE = os.path.join(DATA_DIR, "relay.json")
AIRCRAFT_FILE = os.path.join(DATA_DIR, "aircraft.json")
LOG_FILE = os.path.join(DATA_DIR, "stratos_bridge.log")
STARTED_AT = time.time()

state = {}
state_lock = threading.Lock()
METARS = {}
METARS_LOCK = threading.Lock()
# Aircraft photos by registration: (fetched at, payload, ttl seconds). A found
# photo is kept for a day, a registration the source does not know for an hour,
# so a card that redraws at telemetry rate asks the service once.
# Terminal procedure geometry, from the simulator's CIFP data or the dataset
# Stratos ships. Built once: locating the install and reading the cycle is
# cheap, but each airport's first build scans the fix and navaid files, so the
# answers are cached.
NAV_DATA = None
NAV_DATA_LOCK = threading.Lock()


def nav_data():
    global NAV_DATA
    with NAV_DATA_LOCK:
        if NAV_DATA is None:
            NAV_DATA = nav_cifp.NavData(os.environ.get("STRATOS_XPLANE_DIR", "").strip())
        return NAV_DATA


PHOTOS = {}
PHOTO_LOCK = threading.Lock()
PHOTO_TTL = 24 * 60 * 60
PHOTO_MISS_TTL = 60 * 60
PHOTO_ENDPOINT = "https://api.planespotters.net/pub/photos/reg/"


def photo_registration(value):
    """A plausible registration, or an empty string. Never a callsign or a type."""
    reg = str(value or "").strip().upper()
    if not re.match(r"^[A-Z0-9][A-Z0-9-]{1,9}$", reg):
        return ""
    if re.match(r"^\d+$", reg) or re.match(r"^[A-Z]{1,4}\d{1,4}$", reg):
        return ""
    return reg
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
xplane_identity_status = {"available": False, "registration": "", "type": "", "error": "", "at": 0}
MDNS_GROUP = "224.0.0.251"
MDNS_PORT = 5353
MDNS_HOST = os.environ.get("STRATOS_MDNS_HOST", "stratos.local").strip().rstrip(".") or "stratos.local"
MDNS_SERVICE = "_stratos._tcp.local"
MDNS_INSTANCE = "Stratos Bridge." + MDNS_SERVICE
mdns_status = {"running": False, "name": MDNS_HOST, "address": "", "error": "", "answers": 0}
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
def write_token(token):
    try:
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(token)
    except OSError as exc:
        log("Could not persist the access token: %s" % exc)


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
    write_token(token)
    return token


TOKEN = load_token()
TOKEN_LOCK = threading.Lock()


def rotate_bridge_token():
    """Replace the shared access token.

    Phones paired after 2.1.14 hold their own random secret, but a phone paired
    with the older shared token must lose access when the user forgets every
    phone. Rotating the shared token does that; loopback requests and the
    desktop app are unaffected.
    """
    global TOKEN
    token = secrets.token_urlsafe(24)
    with TOKEN_LOCK:
        write_token(token)
        TOKEN = token
    return token


# ── Phone pairing ──────────────────────────────────────────────────
# A pairing token lives for two minutes, is single use, and is exchanged for the
# bridge access cookie. It is never written to the log or the data folder.
PAIR_TTL_SECONDS = 120
PAIR_LOCK = threading.Lock()
PAIR_SESSIONS = {}
PAIR_ATTEMPTS = {}
# id -> {id, hash (sha256 of the phone secret), label, createdAt}. The secret
# itself is only ever returned to the phone that claimed it, in an HttpOnly
# cookie, and is never written to disk in usable form.
PAIR_CLIENTS = {}
PAIR_LAST = {"claimedAt": 0, "client": ""}


def _phone_client_public(record):
    return {
        "id": record.get("id", ""),
        "label": record.get("label") or "Phone",
        "pairedAt": int(record.get("createdAt") or 0),
    }


def save_phone_clients():
    """Persist hashes so a bridge restart does not unpair a phone."""
    with PAIR_LOCK:
        records = [dict(record) for record in PAIR_CLIENTS.values()]
    payload = json.dumps({"clients": records}, separators=(",", ":")).encode("utf-8")
    temporary = PHONE_PAIRS_FILE + ".tmp"
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(temporary, PHONE_PAIRS_FILE)
    except OSError as exc:
        log("Could not persist phone pairings: %s" % exc)


def load_phone_clients():
    try:
        with open(PHONE_PAIRS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return
    records = {}
    for record in data.get("clients", []) if isinstance(data, dict) else []:
        if not isinstance(record, dict):
            continue
        client_id = str(record.get("id", ""))
        digest = str(record.get("hash", ""))
        if not re.fullmatch(r"[0-9a-f]{12,32}", client_id) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            continue
        records[client_id] = {
            "id": client_id,
            "hash": digest,
            "label": str(record.get("label") or "Phone")[:48],
            "createdAt": int(record.get("createdAt") or 0),
        }
    with PAIR_LOCK:
        PAIR_CLIENTS.update(records)


def phone_digest(secret):
    return hashlib.sha256(str(secret or "").encode("utf-8")).hexdigest()


def pair_client(address=""):
    """Issue a per-phone secret. Returns (secret, public record)."""
    secret = secrets.token_urlsafe(32)
    digest = phone_digest(secret)
    now = int(time.time() * 1000)
    record = {
        "id": digest[:12],
        "hash": digest,
        "label": (address or "Phone")[:48],
        "createdAt": now,
    }
    with PAIR_LOCK:
        PAIR_CLIENTS[record["id"]] = record
        PAIR_LAST["claimedAt"] = now
        PAIR_LAST["client"] = address
    save_phone_clients()
    return secret, _phone_client_public(record)


def verify_phone_secret(secret):
    if not secret:
        return False
    digest = phone_digest(secret)
    with PAIR_LOCK:
        hashes = [record.get("hash", "") for record in PAIR_CLIENTS.values()]
    return any(hmac.compare_digest(digest, candidate) for candidate in hashes)


def phone_client_for_secret(secret):
    if not secret:
        return None
    digest = phone_digest(secret)
    with PAIR_LOCK:
        for client_id, record in PAIR_CLIENTS.items():
            if hmac.compare_digest(digest, record.get("hash", "")):
                return client_id
    return None


def revoke_phone_client(client_id):
    with PAIR_LOCK:
        removed = PAIR_CLIENTS.pop(str(client_id or ""), None)
    if removed:
        save_phone_clients()
    return bool(removed)


def revoke_phone_client_for_secret(secret):
    client_id = phone_client_for_secret(secret)
    return revoke_phone_client(client_id) if client_id else False


load_phone_clients()

def pair_clean(now=None):
    now = now or time.time()
    with PAIR_LOCK:
        for token in [key for key, session in PAIR_SESSIONS.items() if session["expires"] < now]:
            PAIR_SESSIONS.pop(token, None)
        for address in list(PAIR_ATTEMPTS):
            PAIR_ATTEMPTS[address] = [stamp for stamp in PAIR_ATTEMPTS[address] if now - stamp < 180]
            if not PAIR_ATTEMPTS[address]:
                PAIR_ATTEMPTS.pop(address, None)


def create_pair_session():
    pair_clean()
    token = secrets.token_urlsafe(32)
    code = "%06d" % secrets.randbelow(1000000)
    expires = time.time() + PAIR_TTL_SECONDS
    with PAIR_LOCK:
        PAIR_SESSIONS[token] = {"code": code, "expires": expires, "used": False}
    host = lan_ip()
    return {
        "token": token,
        "code": code,
        "expiresAt": int(expires * 1000),
        "ttlSeconds": PAIR_TTL_SECONDS,
        "url": "http://%s:%d/pair?t=%s" % (host, HTTP_PORT, token),
        "lanIp": host,
        "lanEnabled": HOST not in ("127.0.0.1", "localhost"),
        # The no-code route: the phone opens this and is enrolled on arrival.
        "connectUrl": "http://%s:%d/pair/connect" % (MDNS_HOST, HTTP_PORT),
        "hostName": MDNS_HOST,
        "autoPair": AUTO_PAIR_ENABLED and HOST not in ("127.0.0.1", "localhost"),
    }


def claim_pair(value):
    """Consume a pairing token or code. Returns True when it was valid."""
    pair_clean()
    value = (value or "").strip()
    if not value:
        return False
    now = time.time()
    with PAIR_LOCK:
        match = None
        for token, session in PAIR_SESSIONS.items():
            if session["expires"] < now or session["used"]:
                continue
            if hmac.compare_digest(value, token) or hmac.compare_digest(value, session["code"]):
                match = token
                break
        if not match:
            return False
        PAIR_SESSIONS[match]["used"] = True
        PAIR_LAST["claimedAt"] = int(now * 1000)
        return True


# ── One-tap phone connection ───────────────────────────────────────
# A browser cannot scan the local network, so the phone reaches the bridge by
# its multicast-DNS name (http://stratos.local:8765) and enrolls itself there.
# Enrollment is accepted only from private network addresses, is rate limited
# per address, and still yields a credential: the phone keeps its own secret in
# an HttpOnly cookie and every data route keeps requiring it. Turn it off with
# STRATOS_AUTO_PAIR=0; the six-digit code keeps working either way.
AUTO_PAIR_ENABLED = os.environ.get("STRATOS_AUTO_PAIR", "1").strip().lower() not in ("0", "false", "off", "no")
AUTO_PAIR_WINDOW = 60
AUTO_PAIR_LIMIT = 5
AUTO_PAIR_ATTEMPTS = {}


LAN_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "169.254.0.0/16", "fc00::/7", "fe80::/10",
))


def is_lan_address(address):
    """A private-network address a phone on the same network would use."""
    try:
        ip = ipaddress.ip_address(str(address or "").split("%")[0])
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    return any(ip in network for network in LAN_NETWORKS if network.version == ip.version)


def auto_pair_gate(address):
    """Why one-tap pairing cannot run for this request, or an empty string."""
    if not AUTO_PAIR_ENABLED:
        return "One-tap pairing is turned off on this PC (STRATOS_AUTO_PAIR=0). Show the code instead."
    if HOST in ("127.0.0.1", "localhost"):
        return "The bridge is reachable only on this PC. Start it on the network to pair a phone."
    if not is_lan_address(address):
        return "A phone can pair from the same local network only."
    return ""


def auto_pair_rate_limited(address):
    now = time.time()
    with PAIR_LOCK:
        attempts = [stamp for stamp in AUTO_PAIR_ATTEMPTS.get(address, []) if now - stamp < AUTO_PAIR_WINDOW]
        if len(attempts) >= AUTO_PAIR_LIMIT:
            AUTO_PAIR_ATTEMPTS[address] = attempts
            return True
        attempts.append(now)
        AUTO_PAIR_ATTEMPTS[address] = attempts
    return False


def auto_pair(address):
    """Enroll a LAN phone without a code. Returns (secret, record) or (None, reason)."""
    reason = auto_pair_gate(address)
    if reason:
        return None, reason
    if auto_pair_rate_limited(address):
        return None, "Too many connection attempts from this phone. Wait a minute and try again."
    secret, record = pair_client(address)
    log("Paired a phone from %s without a code (one-tap connection)" % (address or "?"))
    return secret, record


def phone_cookie(secret, max_age=2592000):
    cookie = SimpleCookie()
    cookie["stratos_phone"] = secret
    morsel = cookie["stratos_phone"]
    morsel["path"] = "/"
    morsel["httponly"] = True
    morsel["samesite"] = "Lax"
    morsel["max-age"] = max_age
    return cookie.output(header="").strip()


def pair_status():
    pair_clean()
    with PAIR_LOCK:
        active = [session for session in PAIR_SESSIONS.values() if not session["used"]]
        devices = sorted((_phone_client_public(record) for record in PAIR_CLIENTS.values()),
                         key=lambda item: item["pairedAt"], reverse=True)
        return {
            "lanEnabled": HOST not in ("127.0.0.1", "localhost"),
            "lanIp": lan_ip(),
            "activeCodes": len(active),
            "claimedAt": PAIR_LAST["claimedAt"],
            "clients": len(PAIR_CLIENTS),
            "autoPair": AUTO_PAIR_ENABLED and HOST not in ("127.0.0.1", "localhost"),
            "hostName": MDNS_HOST,
            "connectUrl": "http://%s:%d/pair/connect" % (MDNS_HOST, HTTP_PORT),
            "localUrl": "http://%s:%d/pair/connect" % (lan_ip(), HTTP_PORT),
            "discovery": dict(mdns_status),
            # Addresses and timestamps only: never a secret or its hash.
            "devices": devices,
        }


def revoke_pairs():
    with PAIR_LOCK:
        PAIR_SESSIONS.clear()
        PAIR_CLIENTS.clear()
        PAIR_LAST["claimedAt"] = 0
        PAIR_LAST["client"] = ""
    save_phone_clients()
    # Invalidates phones that paired before per-phone secrets existed.
    rotate_bridge_token()


# ── Checklist state shared with the paired phone ───────────────────
# Kept in memory: a checklist belongs to the flight in progress, not a database.
CHECKLIST_LOCK = threading.RLock()
CHECKLIST_STATE = {}


def checklist_snapshot():
    with CHECKLIST_LOCK:
        if not CHECKLIST_STATE:
            return None
        state = dict(CHECKLIST_STATE)
        state["checks"] = dict(state.get("checks") or {})
        return state


def save_checklist(payload):
    """Store a checklist state after validation. Older revisions are ignored."""
    if not isinstance(payload, dict):
        return None
    checks = payload.get("checks")
    clean = {}
    if isinstance(checks, dict):
        for key, value in list(checks.items())[:4000]:
            if isinstance(key, str) and len(key) <= 80 and value is True:
                clean[key] = True
    try:
        revision = int(payload.get("revision") or 0)
    except (TypeError, ValueError):
        revision = 0
    try:
        updated = int(payload.get("updatedAt") or 0)
    except (TypeError, ValueError):
        updated = 0
    state = {
        "profileKey": str(payload.get("profileKey") or "")[:60] or None,
        "flightKey": str(payload.get("flightKey") or "")[:120] or None,
        "activeSection": str(payload.get("activeSection") or "")[:60] or None,
        "checks": clean,
        "revision": max(0, revision),
        "updatedAt": updated or int(time.time() * 1000),
    }
    with CHECKLIST_LOCK:
        current = CHECKLIST_STATE
        if current and current.get("flightKey") == state["flightKey"]:
            if state["revision"] < int(current.get("revision") or 0):
                return checklist_snapshot()
        CHECKLIST_STATE.update(state)
        return checklist_snapshot()


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


# ── Traffic trails ─────────────────────────────────────────────────
# The public traffic feeds publish one position per aircraft, so a trail is what
# this bridge has observed. The page posts the positions it sees; they are kept
# per hex, written to disk and served back, so a clicked aircraft's path survives
# a page reload and a bridge restart, and is the same on the PC and on a paired
# phone. Nothing here is fetched from a source that does not exist: a trail
# starts at the first observation.
TRAFFIC_FILE = os.path.join(DATA_DIR, "traffic_trails.json")
TRAFFIC_RETENTION_S = int(os.environ.get("STRATOS_TRAFFIC_RETENTION", "2700"))
TRAFFIC_MAX_POINTS = 360
TRAFFIC_MAX_AIRCRAFT = 400
TRAFFIC_SAVE_EVERY_S = 8.0
TRAFFIC = {}
TRAFFIC_LOCK = threading.Lock()
TRAFFIC_SAVE = {"at": 0.0, "dirty": False}


def traffic_key(value):
    """An aircraft key: a hex address or a callsign, reduced to a safe token."""
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())[:12]


def load_traffic_trails():
    try:
        with open(TRAFFIC_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return
    trails = data.get("trails") if isinstance(data, dict) else None
    if not isinstance(trails, dict):
        return
    with TRAFFIC_LOCK:
        for key, points in trails.items():
            if not isinstance(points, list):
                continue
            clean = []
            for point in points:
                if not isinstance(point, list) or len(point) < 4:
                    continue
                try:
                    clean.append([float(point[0]), float(point[1]), float(point[2]), int(point[3])])
                except (TypeError, ValueError):
                    continue
            if clean:
                TRAFFIC[traffic_key(key)] = clean
        _prune_traffic(time.time() * 1000, save=False)


def _prune_traffic(now_ms, save=True):
    """Drop samples past the retention window and keep the per-aircraft cap."""
    cutoff = now_ms - TRAFFIC_RETENTION_S * 1000
    removed = False
    for key in list(TRAFFIC):
        trail = [point for point in TRAFFIC[key] if point[3] >= cutoff]
        if len(trail) > TRAFFIC_MAX_POINTS:
            trail = trail[-TRAFFIC_MAX_POINTS:]
        if trail:
            TRAFFIC[key] = trail
        else:
            TRAFFIC.pop(key, None)
            removed = True
    if len(TRAFFIC) > TRAFFIC_MAX_AIRCRAFT:
        keep = sorted(TRAFFIC.items(), key=lambda item: item[1][-1][3], reverse=True)[:TRAFFIC_MAX_AIRCRAFT]
        TRAFFIC.clear()
        TRAFFIC.update(dict(keep))
        removed = True
    if save and removed:
        TRAFFIC_SAVE["dirty"] = True
    return removed


def record_traffic(points):
    """Merge posted positions: [[key, lat, lon, alt, t_ms], ...]. Returns the count added."""
    now_ms = time.time() * 1000
    added = 0
    with TRAFFIC_LOCK:
        for raw in points if isinstance(points, list) else []:
            if not isinstance(raw, (list, tuple)) or len(raw) < 4:
                continue
            key = traffic_key(raw[0])
            if not key:
                continue
            try:
                lat, lon = float(raw[1]), float(raw[2])
                alt = float(raw[3] or 0)
            except (TypeError, ValueError):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            # (0, 0) is what a feed sends when it has no position at all.
            if abs(lat) < 1e-6 and abs(lon) < 1e-6:
                continue
            try:
                stamp = float(raw[4]) if len(raw) > 4 and raw[4] else now_ms
            except (TypeError, ValueError):
                stamp = now_ms
            # A clock ahead of ours would push later samples out of order.
            stamp = min(stamp, now_ms)
            trail = TRAFFIC.setdefault(key, [])
            if trail:
                last = trail[-1]
                if abs(last[0] - lat) < 1e-5 and abs(last[1] - lon) < 1e-5:
                    continue
                # A sample older than the last one would draw a path that runs
                # backwards; the trail stays chronological.
                if stamp < last[3]:
                    continue
                if stamp <= last[3]:
                    stamp = last[3] + 1
            trail.append([round(lat, 6), round(lon, 6), round(alt, 1), int(stamp)])
            added += 1
        _prune_traffic(now_ms)
        if added:
            TRAFFIC_SAVE["dirty"] = True
    save_traffic_trails()
    return added


def traffic_trail(key, since=0):
    with TRAFFIC_LOCK:
        trail = list(TRAFFIC.get(traffic_key(key), []))
    return [point for point in trail if point[3] >= since]


def save_traffic_trails(force=False):
    """Write at most every few seconds: traffic arrives faster than a disk needs it."""
    now = time.time()
    with TRAFFIC_LOCK:
        if not TRAFFIC_SAVE["dirty"] or (not force and now - TRAFFIC_SAVE["at"] < TRAFFIC_SAVE_EVERY_S):
            return False
        payload = json.dumps({"trails": TRAFFIC}, separators=(",", ":")).encode("utf-8")
        TRAFFIC_SAVE["at"] = now
        TRAFFIC_SAVE["dirty"] = False
    temporary = TRAFFIC_FILE + ".tmp"
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(temporary, TRAFFIC_FILE)
        return True
    except OSError as exc:
        log("Could not persist traffic trails: %s" % exc)
        return False


load_traffic_trails()


def _handle_traffic_track(handler):
    """The page reports the positions it has seen; the bridge remembers them."""
    data, error = handler.read_json(512 * 1024)
    if error:
        handler.send_json({"ok": False, "error": error}, 400)
        return
    points = data.get("points") if isinstance(data, dict) else None
    if not isinstance(points, list) or len(points) > 2000:
        handler.send_json({"ok": False, "error": "Expected a points list of at most 2000 entries"}, 400)
        return
    handler.send_json({"ok": True, "added": record_traffic(points)})


def _handle_traffic_trail(handler, parsed):
    """One aircraft's recorded path, oldest first, for the map to draw."""
    query = urllib.parse.parse_qs(parsed.query)
    key = traffic_key((query.get("hex") or [""])[0])
    if not key:
        handler.send_json({"ok": False, "error": "A hex address or callsign is required."}, 400)
        return
    try:
        since = int(float((query.get("since") or ["0"])[0]))
    except (TypeError, ValueError):
        since = 0
    points = traffic_trail(key, since)
    handler.send_json({"ok": True, "hex": key, "points": points,
                       "retentionSeconds": TRAFFIC_RETENTION_S})


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


# Traffic pushed to the relay for a paired phone that is not on this network.
# Only the list and the samples the relay has not seen yet are sent, so a push
# costs one position per aircraft rather than the whole trail.
TRAFFIC_RELAY_EVERY_S = 15.0
TRAFFIC_RELAY_MAX_POINTS = 400
TRAFFIC_RELAY_MAX_AIRCRAFT = 25
TRAFFIC_RELAY_FRESH_PER_KEY = 6


def relay_traffic_batch(cursor):
    """The current list and the samples newer than ``cursor`` (key -> last ms).

    The list is the bridge's own ADS-B traffic; the samples are the trails it has
    recorded, most recently updated first, so a relayed phone gets the same paths
    the PC has without shipping the whole store every 15 seconds.
    """
    with state_lock:
        raw = list(state.get("tr") or [])
    listed = []
    for item in raw[:60]:
        try:
            entry = {"id": str(item.get("id") or "")[:12],
                     "lat": float(item.get("lat")),
                     "lon": float(item.get("lon"))}
        except (AttributeError, TypeError, ValueError):
            continue
        if not entry["id"]:
            continue
        for field in ("alt", "gs", "hdg"):
            value = item.get(field)
            try:
                entry[field] = round(float(value), 1) if value is not None else None
            except (TypeError, ValueError):
                entry[field] = None
        listed.append(entry)
    points = []
    with TRAFFIC_LOCK:
        recent = sorted(TRAFFIC, key=lambda name: TRAFFIC[name][-1][3], reverse=True)
        for key in recent[:TRAFFIC_RELAY_MAX_AIRCRAFT]:
            since = cursor.get(key, 0)
            fresh = [point for point in TRAFFIC[key] if point[3] > since]
            for point in fresh[-TRAFFIC_RELAY_FRESH_PER_KEY:]:
                points.append([key, point[0], point[1], point[2], point[3]])
    return {"list": listed, "points": points[-TRAFFIC_RELAY_MAX_POINTS:]}


def relay_post_json(url, token, path, payload, timeout=10):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url + path, data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + token,
                 "User-Agent": "Stratos-Bridge/%s" % VERSION})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        response.read(256)


def relay_loop():
    last_config_read = 0.0
    cached = None
    traffic_cursor = {}
    last_traffic_push = 0.0
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
        telemetry_age = 999
        with state_lock:
            telemetry_age = time.time() - state.get("t", 0) if state.get("t") else 999
        try:
            relay_post_json(cached["url"], cached["token"], "/api/ingest", relay_snapshot())
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
        # The traffic list and its new trail samples go on their own, slower
        # cadence: the phone polls them every 15 s, so nothing is gained by
        # sending them with every telemetry snapshot.
        if cached and telemetry_age < 60 and time.time() - last_traffic_push >= TRAFFIC_RELAY_EVERY_S:
            last_traffic_push = time.time()
            try:
                batch = relay_traffic_batch(traffic_cursor)
                if batch["list"] or batch["points"]:
                    relay_post_json(cached["url"], cached["token"], "/api/traffic", batch)
                    for key, _lat, _lon, _alt, stamp in batch["points"]:
                        traffic_cursor[key] = max(traffic_cursor.get(key, 0), stamp)
                    cutoff = time.time() * 1000 - 600 * 1000
                    for key in [k for k, stamp in traffic_cursor.items() if stamp < cutoff]:
                        traffic_cursor.pop(key, None)
            except Exception as exc:
                # A relay that cannot take traffic still gets telemetry; the
                # cursor is unchanged, so the next push includes these samples.
                with relay_lock:
                    relay_status["lastError"] = ("Traffic relay: %s" % str(exc))[:200]
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


# ── X-Plane aircraft identity ──────────────────────────────────────
# The data-output rows carry position and speed, not the airframe.
# X-Plane's standard UDP dataref interface can be asked for its string
# datarefs one element at a time, so the registration, ICAO type and
# description are read without a plugin. Values only fill fields the user has
# not set by hand, so a deliberate identity in Settings always wins.
XPLANE_STRING_DATAREFS = (
    ("tail", "sim/aircraft/view/acf_tailnum", 10),
    ("icao", "sim/aircraft/view/acf_ICAO", 8),
    ("desc", "sim/aircraft/view/acf_descrip", 48),
)
RREF_INDEX_BASE = 9000
RREF_SLOTS = {}
RREF_REQUESTS = []
_XPLANE_CHARS = {"tail": {}, "icao": {}, "desc": {}}


def build_rref_requests():
    """One subscription per character, each with its own response index."""
    RREF_SLOTS.clear()
    RREF_REQUESTS.clear()
    index = RREF_INDEX_BASE
    for key, path, length in XPLANE_STRING_DATAREFS:
        for position in range(length):
            RREF_SLOTS[index] = (key, position)
            RREF_REQUESTS.append((index, "%s[%d]" % (path, position)))
            index += 1


def rref_request(index, dataref, freq=1):
    """One RREF subscription: header, rate in Hz, response index, 400-byte path."""
    return struct.pack("<4sxii400s", b"RREF", int(freq), int(index),
                       str(dataref).encode("utf-8")[:399])


def rref_values(packet):
    """(index, value) pairs from an RREF packet; several may share a datagram."""
    if packet[:4] != b"RREF":
        return []
    values = []
    body = packet[5:]
    for offset in range(0, len(body) - 7, 8):
        try:
            index, value = struct.unpack("<if", body[offset:offset + 8])
        except struct.error:
            break
        values.append((int(index), float(value)))
    return values


def rref_text(chars):
    """Assemble per-character values into text, stopping at the first NUL or gap."""
    data = bytearray()
    for position in range(len(chars)):
        if position not in chars:
            break
        value = chars[position]
        if not math.isfinite(value) or value <= 0:
            break
        data.append(int(value) & 0xFF)
    return data.decode("utf-8", "replace").strip()


# Multi-letter prefixes that begin a type designator rather than a country mark
# (MD-82, CRJ-900). A single letter is a country mark, as in B-1234.
TYPE_PREFIXES = {"MD", "CRJ", "ERJ", "AT", "DH", "PA", "BAE"}
TYPE_CODE = re.compile(r"^[A-Z][A-Z0-9]?\d[A-Z0-9]{0,2}$")


def plausible_registration(text):
    """A tail number, not a placeholder, a callsign or a type code."""
    value = str(text or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9-]{1,9}", value):
        return ""
    if value in ("NONE", "N/A", "NA", "NULL", "DEFAULT", "UNKNOWN"):
        return ""
    if not re.search(r"\d", value) and "-" not in value:
        return ""                     # a callsign or a name, not a tail number
    # Type designators such as B738, A320 or E190 sit in the same field when a
    # livery leaves the tail empty; they are not registrations.
    if "-" not in value and TYPE_CODE.match(value):
        return ""
    if "-" in value:
        prefix, suffix = value.split("-", 1)
        if prefix in TYPE_PREFIXES or (len(prefix) > 1 and suffix.isdigit()):
            return ""
    return value


def apply_xplane_identity():
    """Publish what X-Plane reported, without overwriting a chosen identity."""
    tail = plausible_registration(rref_text(_XPLANE_CHARS["tail"]))
    icao = rref_text(_XPLANE_CHARS["icao"])[:12].strip().upper()
    desc = rref_text(_XPLANE_CHARS["desc"])[:48].strip()
    if not (tail or icao or desc):
        return
    xplane_identity_status.update(available=True, registration=tail, type=icao,
                                  error="", at=int(time.time() * 1000))
    identity = load_aircraft_identity()
    with state_lock:
        if desc and not identity.get("aircraft") and not state.get("aircraft"):
            state["aircraft"] = desc
        if icao and not state.get("aircraftType"):
            state["aircraftType"] = icao
        if tail and not identity.get("registration") and not state.get("registration"):
            state["registration"] = tail


def xplane_identity_loop():
    """Ask X-Plane for the loaded airframe's names, gently: 1 Hz, no polling loop."""
    if not RREF_REQUESTS:
        return
    target = (XPLANE_HOST, XPLANE_UDP_PORT)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind(("", 0))
        sock.settimeout(1.0)
    except OSError as exc:
        xplane_identity_status["error"] = str(exc)
        try:
            sock.close()
        except OSError:
            pass
        return
    sent_at = 0.0
    while True:
        now = time.time()
        # Re-subscribing is harmless and recovers after X-Plane restarts.
        if now - sent_at > 10:
            sent_at = now
            for index, dataref in RREF_REQUESTS:
                try:
                    sock.sendto(rref_request(index, dataref, 1), target)
                except OSError as exc:
                    xplane_identity_status["error"] = str(exc)
                    break
        try:
            data, _source = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError:
            return
        changed = False
        for index, value in rref_values(data):
            slot = RREF_SLOTS.get(index)
            if not slot:
                continue
            chars = _XPLANE_CHARS[slot[0]]
            if chars.get(slot[1]) != value:
                chars[slot[1]] = value
                changed = True
        if changed:
            apply_xplane_identity()


build_rref_requests()


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
.card{box-sizing:border-box;max-width:420px;width:100%;background:#142b36;border:1px solid #294754;border-radius:18px;padding:26px}
h1{font-size:20px;margin:0 0 6px}p{color:#91a8b1;margin:0 0 16px;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid #294754;
background:#0b1b24;color:#e7f0f2;font:inherit;font-size:16px;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:12px;background:#79c9bb;color:#04212b;font:inherit;font-weight:700;font-size:15px}
.err{color:#f17b89;font-size:13px;margin:0 0 12px}.hint{font-size:12px;color:#6f858e;margin-top:14px}
</style></head><body><form class="card" method="post" action="/unlock">
<h1>Stratos bridge</h1>
<p>This bridge is on your local network. Enter the access token shown in Stratos → Settings → Simulator bridge.</p>
{{ERROR}}<input name="token" type="password" autocomplete="current-password" placeholder="Bridge access token" required autofocus>
<button type="submit">Unlock</button>
<p class="hint">The token is stored on the PC running the bridge, in <code>bridge_token.txt</code>. It is never sent anywhere else.</p>
</form></body></html>"""

PAIR_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Stratos — pair this phone</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#08151d;color:#e7f0f2;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:24px}
.card{box-sizing:border-box;max-width:420px;width:100%;background:#142b36;border:1px solid #294754;border-radius:18px;padding:26px}
h1{font-size:20px;margin:0 0 6px}p{color:#91a8b1;margin:0 0 16px;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid #294754;
background:#0b1b24;color:#e7f0f2;font:inherit;font-size:20px;letter-spacing:.3em;text-align:center;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:12px;background:#79c9bb;color:#04212b;font:inherit;font-weight:700;font-size:15px}
.err{color:#f17b89;font-size:13px;margin:0 0 12px}.hint{font-size:12px;color:#6f858e;margin-top:14px}
</style></head><body><form class="card" method="get" action="/pair">
<h1>Pair this phone</h1>
<p>Scan the QR code shown in Stratos on the PC, or type the six-digit code from that screen.</p>
{{ERROR}}
<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" autofocus>
<button type="submit">Pair</button>
<p class="hint">The code expires after two minutes and works once. The phone and the PC must be on the same local network.</p>
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

    def cookie_value(self, name):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        return cookie.get(name).value if cookie.get(name) else ""

    def token_candidates(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        values = [query.get("k", [""])[0],
                  self.headers.get("X-Stratos-Token", ""),
                  self.cookie_value("stratos_phone"),
                  self.cookie_value("stratos_token")]
        seen = []
        for value in values:
            if value and value not in seen:
                seen.append(value)
        return seen

    def authorized(self):
        if self.is_loopback():
            return True
        # The shared token still works for a phone unlocked by hand, while a
        # paired phone presents its own secret in an HttpOnly cookie. Accept
        # either when a browser happens to hold both cookies.
        for supplied in self.token_candidates():
            if hmac.compare_digest(supplied, TOKEN) or verify_phone_secret(supplied):
                return True
        return False

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
        # A phone that was unpaired still carries a phone cookie. Send it back
        # to pairing instead of asking for a token it has never been shown.
        if self.cookie_value("stratos_phone"):
            self.send_pair_error(message or "This phone is no longer paired. Show a new code in Stratos on the PC.")
            return
        body = UNLOCK_HTML.replace("{{ERROR}}", '<p class="err">%s</p>' % message if message else "").encode("utf-8")
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
        # A phone has no credential yet; this is how it earns one. It is the
        # only unauthenticated POST besides unlocking, and it is LAN-only.
        if path == "/pair/auto":
            self.handle_pair_auto()
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
        if path == "/traffic/track":
            _handle_traffic_track(self)
            return
        if path == "/checklist":
            data, error = self.read_json(64 * 1024)
            if error:
                self.send_json({"ok": False, "error": error}, 400)
                return
            saved = save_checklist(data)
            if not saved:
                self.send_json({"ok": False, "error": "Invalid checklist state"}, 400)
                return
            self.send_json(saved)
            return
        if path == "/pair/revoke":
            if not self.is_loopback():
                self.send_json({"ok": False, "error": "Pairing must be managed on the PC"}, 403)
                return
            revoke_pairs()
            self.send_json({"ok": True})
            return
        if path == "/pair/forget-client":
            if not self.is_loopback():
                self.send_json({"ok": False, "error": "Pairing must be managed on the PC"}, 403)
                return
            data, error = self.read_json(4096)
            if error:
                self.send_json({"ok": False, "error": error}, 400)
                return
            removed = revoke_phone_client(str(data.get("id", "")))
            self.send_json({"ok": removed, "id": str(data.get("id", ""))})
            return
        if path == "/pair/self-revoke":
            # A paired phone may forget its own PC. The current cookie is gone
            # afterwards, so a cached tab cannot keep reading telemetry.
            removed = revoke_phone_client_for_secret(self.cookie_value("stratos_phone"))
            body = json.dumps({"ok": True, "removed": removed}, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Set-Cookie", "stratos_phone=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            self.send_header("Set-Cookie", "stratos_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
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

    def handle_pair_auto(self):
        if not self.same_origin():
            self.send_json({"ok": False, "error": "Cross-origin request refused"}, 403)
            return
        if self.authorized():
            self.send_json({"ok": True, "paired": True, "already": True})
            return
        address = self.client_address[0] if self.client_address else "?"
        secret, detail = auto_pair(address)
        if not secret:
            self.send_json({"ok": False, "error": detail}, 403)
            return
        body = json.dumps({"ok": True, "paired": True, "auto": True}, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Set-Cookie", phone_cookie(secret))
        # A phone must never keep the shared token from an earlier unlock.
        self.send_header("Set-Cookie", "stratos_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def pair_landing(self):
        """Where a paired phone lands: its own page, never another origin.

        The phone's own map can be asked for with ?next=/index.html; anything that
        is not a path on this bridge is ignored, so the parameter cannot send a
        phone anywhere else.
        """
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        wanted = (query.get("next", [""])[0] or "").strip()
        if re.match(r"^/[A-Za-z0-9._~%/\-]*$", wanted) and ".." not in wanted and not wanted.startswith("//"):
            return wanted
        return "/live.html"

    def handle_pair_connect(self):
        address = self.client_address[0] if self.client_address else "?"
        if self.authorized():
            self.send_response(303)
            self.send_header("Location", self.pair_landing())
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        secret, detail = auto_pair(address)
        if secret:
            self.send_response(303)
            self.send_header("Location", self.pair_landing())
            self.send_header("Set-Cookie", phone_cookie(secret))
            self.send_header("Set-Cookie", "stratos_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = PAIR_HTML.replace("{{ERROR}}", '<p class="err">%s</p>' % detail if detail else "").encode("utf-8")
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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

    def send_pair_error(self, message):
        body = PAIR_HTML.replace("{{ERROR}}", '<p class="err">%s</p>' % message if message else "").encode("utf-8")
        self.send_response(401)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_pair_page(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        supplied = (query.get("t", [""])[0] or query.get("code", [""])[0]).strip()
        address = self.client_address[0] if self.client_address else "?"
        now = time.time()
        with PAIR_LOCK:
            attempts = [stamp for stamp in PAIR_ATTEMPTS.get(address, []) if now - stamp < 180]
            PAIR_ATTEMPTS[address] = attempts
            limited = len(attempts) >= 10
        if limited:
            self.send_pair_error("Too many pairing attempts from this device. Wait a few minutes and show a new code on the PC.")
            return
        if supplied and claim_pair(supplied):
            secret, _record = pair_client(address)
            cookie = SimpleCookie()
            cookie["stratos_phone"] = secret
            morsel = cookie["stratos_phone"]
            morsel["path"] = "/"
            morsel["httponly"] = True
            morsel["samesite"] = "Lax"
            morsel["max-age"] = 2592000
            self.send_response(303)
            self.send_header("Location", "/pilot.html#checklists")
            self.send_header("Set-Cookie", cookie.output(header="").strip())
            # A phone must never keep the shared token from an earlier unlock.
            self.send_header("Set-Cookie", "stratos_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if supplied:
            with PAIR_LOCK:
                PAIR_ATTEMPTS.setdefault(address, []).append(now)
            self.send_pair_error("That pairing code has expired or was already used. Show a new code in Stratos on the PC.")
            return
        body = PAIR_HTML.replace("{{ERROR}}", "").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        # The pairing page carries a single-use token and is the only route a
        # phone may reach before it holds the access cookie.
        if path == "/pair":
            self.handle_pair_page(parsed)
            return
        # Top-level navigation from the phone: enroll if allowed, then go to
        # the live dashboard. No code, no URL typing, no QR.
        if path == "/pair/connect":
            self.handle_pair_connect()
            return
        if not self.authorized():
            self.unlock_denied()
            return
        if path == "/pair/new":
            if not self.is_loopback():
                self.send_json({"ok": False, "error": "Pairing must be started on the PC"}, 403)
                return
            self.send_json(create_pair_session())
            return
        if path == "/pair/status":
            self.send_json(pair_status())
            return
        if path == "/checklist":
            self.send_json(checklist_snapshot() or {"empty": True})
            return
        if path == "/health":
            self.handle_health()
            return
        if path == "/logbook.json":
            _handle_logbook(self)
            return
        if path == "/traffic/trail":
            _handle_traffic_trail(self, parsed)
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
        if path == "/api/photo":
            self.handle_photo(parsed)
            return
        if path == "/procedures.json":
            self.handle_procedures(parsed)
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
            "pairing": pair_status(),
            "lanIp": lan_ip(),
            "lanAddress": "http://%s:%d" % (lan_ip(), HTTP_PORT),
            "discovery": dict(mdns_status),
            "xplaneIdentity": dict(xplane_identity_status),
            "navdata": nav_data().summary(),
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
        last_auth = time.time()
        try:
            while True:
                # A revoked phone may still hold an open stream. Re-check the
                # credential periodically so forgetting a phone stops telemetry
                # within a few seconds, not only on its next reconnect.
                if time.time() - last_auth > 5:
                    last_auth = time.time()
                    if not self.authorized():
                        # A plain return would keep the HTTP/1.1 socket open and
                        # the phone would keep reading a stream it may no longer see.
                        self.close_connection = True
                        return
                with state_lock:
                    snapshot = dict(state)
                snapshot["age"] = round(time.time() - snapshot.get("t", 0), 2) if snapshot.get("t") else None
                snapshot["flightPhase"] = get_flight_phase()
                current = get_current_flight()
                if current:
                    snapshot["currentFlight"] = current
                # A paired phone reads and writes the checklist through this
                # stream and POST /checklist, so there is no second poll loop.
                checklist = checklist_snapshot()
                if checklist:
                    snapshot["checklist"] = checklist
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

    def handle_procedures(self, parsed):
        """Published SID, STAR and approach legs from real navigation data.

        Read-only: first the PC's own X-Plane CIFP files, then the dataset
        Stratos ships in ``navdata/cifp`` (FAA CIFP, United States). No procedure
        is invented and nothing is downloaded at request time. Without either
        source the answer says so, and the map draws the plan's own fixes as
        before.
        """
        query = urllib.parse.parse_qs(parsed.query)
        airport = (query.get("airport", [""])[0] or "").strip()
        kind = (query.get("kind", [""])[0] or "").strip().lower()
        ident = (query.get("id", [""])[0] or "").strip().upper()
        try:
            payload = nav_data().procedures(airport, kind, ident)
        except Exception as exc:
            self.send_json({"ok": False, "reason": "read-error",
                            "error": "Could not read the simulator's procedures: %s" % exc}, 502)
            return
        status = 200
        if not payload.get("ok"):
            status = 503 if payload.get("reason") == "no-navdata" else 404
        self.send_json(payload, status)

    def handle_photo(self, parsed):
        """One aircraft photo by registration, for a page the bridge serves.

        The Planespotters API refuses a browser User-Agent, so the lookup runs
        here with the app's own. Results are cached per registration: a photo
        for a day, a miss for an hour. An unknown registration is an empty list,
        not an error; an unreachable source is a 502 the card reports as such.
        """
        reg = photo_registration(urllib.parse.parse_qs(parsed.query).get("reg", [""])[0])
        if not reg:
            self.send_json({"error": "Unsupported registration"}, 400)
            return
        now = time.time()
        with PHOTO_LOCK:
            cached = PHOTOS.get(reg)
        if cached and now - cached[0] < cached[2]:
            self.send_json(cached[1])
            return
        request = urllib.request.Request(
            PHOTO_ENDPOINT + urllib.parse.quote(reg),
            headers={"Accept": "application/json",
                     "User-Agent": "Stratos/2 (+https://github.com/Nyclyy/stratos-tracker)"})
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                payload = {"photos": []}
                with PHOTO_LOCK:
                    PHOTOS[reg] = (now, payload, PHOTO_MISS_TTL)
                self.send_json(payload)
                return
            self.send_json({"error": "Photo source returned %d" % exc.code}, 502)
            return
        except Exception:
            self.send_json({"error": "Photo source is temporarily unreachable"}, 502)
            return
        if not isinstance(payload, dict):
            self.send_json({"error": "The photo source returned an unexpected response"}, 502)
            return
        with PHOTO_LOCK:
            PHOTOS[reg] = (now, payload, PHOTO_TTL)
        self.send_json(payload)

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
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


# ── Multicast DNS ──────────────────────────────────────────────────
# "http://stratos.local:8765" is the phone's way in with nothing to type. The
# bridge answers the one name it owns and advertises the live page as a
# service; iOS and Android both resolve .local names through the system
# responder, so no app is needed. Best effort: if port 5353 is unavailable the
# bridge keeps running and Settings shows the LAN address instead.


def dns_encode_name(name):
    out = bytearray()
    for label in str(name).strip(".").split("."):
        data = label.encode("utf-8")[:63]
        out.append(len(data))
        out += data
    out.append(0)
    return bytes(out)


def dns_read_name(packet, offset):
    """Decode a possibly compressed DNS name. Returns (name, next offset)."""
    labels, jumped, end, hops = [], False, offset, 0
    while 0 <= offset < len(packet):
        length = packet[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(packet):
                break
            pointer = ((length & 0x3F) << 8) | packet[offset + 1]
            if not jumped:
                end = offset + 2
                jumped = True
            offset = pointer
            hops += 1
            if hops > 8:
                break
            continue
        offset += 1
        labels.append(packet[offset:offset + length].decode("utf-8", "replace"))
        offset += length
    return ".".join(labels), (end if jumped else offset)


def dns_questions(packet):
    """(name, qtype) for each question in a DNS query."""
    if len(packet) < 12:
        return []
    count = struct.unpack(">H", packet[4:6])[0]
    offset, questions = 12, []
    for _ in range(min(int(count), 16)):
        name, offset = dns_read_name(packet, offset)
        if offset + 4 > len(packet):
            break
        qtype, _qclass = struct.unpack(">HH", packet[offset:offset + 4])
        offset += 4
        if name:
            questions.append((name.lower(), qtype))
    return questions


def dns_record(name, rtype, ttl, rdata):
    # 0x8001: class IN with the cache-flush bit set, as mDNS requires.
    return dns_encode_name(name) + struct.pack(">HHIH", rtype, 0x8001, ttl, len(rdata)) + rdata


def mdns_txt():
    """TXT keys name the page a phone lands on; no secret is ever advertised."""
    fields = [b"path=/live", b"version=" + VERSION.encode("ascii", "replace")]
    return b"".join(bytes([min(255, len(field))]) + field for field in fields)


def mdns_answers(address):
    """Every record this bridge owns: the host name and the service instance."""
    ip = socket.inet_aton(address)
    host = MDNS_HOST
    srv = struct.pack(">HHH", 0, 0, HTTP_PORT) + dns_encode_name(host)
    return [
        dns_record(host, 1, 120, ip),
        dns_record(MDNS_SERVICE, 12, 4500, dns_encode_name(MDNS_INSTANCE)),
        dns_record(MDNS_INSTANCE, 33, 120, srv),
        dns_record(MDNS_INSTANCE, 16, 4500, mdns_txt()),
    ]


def mdns_response(packet, address):
    """An answer packet for the questions we own, or None when nothing matches."""
    if len(packet) < 12 or packet[2] & 0x80:
        return None
    answers = []
    for name, qtype in dns_questions(packet):
        if name == MDNS_HOST and qtype in (1, 255):
            answers.append(dns_record(MDNS_HOST, 1, 120, socket.inet_aton(address)))
        elif name == MDNS_SERVICE and qtype in (12, 255):
            answers.append(dns_record(MDNS_SERVICE, 12, 4500, dns_encode_name(MDNS_INSTANCE)))
        elif name == MDNS_INSTANCE and qtype in (33, 16, 255):
            srv = struct.pack(">HHH", 0, 0, HTTP_PORT) + dns_encode_name(MDNS_HOST)
            answers.append(dns_record(MDNS_INSTANCE, 33, 120, srv))
            answers.append(dns_record(MDNS_INSTANCE, 16, 4500, mdns_txt()))
    if not answers:
        return None
    header = struct.pack(">HHHHHH", 0, 0x8400, 0, len(answers), 0, 0)
    return header + b"".join(answers)


def mdns_loop():
    address = lan_ip()
    if HOST in ("127.0.0.1", "localhost") or address == "127.0.0.1":
        mdns_status.update(error="The bridge is reachable only on this PC", address=address)
        return
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass
        sock.bind(("", MDNS_PORT))
        group = socket.inet_aton(MDNS_GROUP)
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                            group + socket.inet_aton(address))
        except OSError:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                            group + socket.inet_aton("0.0.0.0"))
        sock.settimeout(1.0)
    except OSError as exc:
        mdns_status.update(error=str(exc), address=address)
        log("mDNS discovery unavailable (%s). The phone can still use http://%s:%d."
            % (exc, address, HTTP_PORT))
        try:
            sock.close()
        except OSError:
            pass
        return
    mdns_status.update(running=True, address=address, error="")
    log("Answering %s on %s (http://%s:%d)" % (MDNS_HOST, address, MDNS_HOST, HTTP_PORT))
    announced = 0.0
    while True:
        now = time.time()
        if now - announced > 60:
            announced = now
            try:
                records = b"".join(mdns_answers(address))
                sock.sendto(struct.pack(">HHHHHH", 0, 0x8400, 0, 4, 0, 0) + records,
                            (MDNS_GROUP, MDNS_PORT))
            except OSError:
                pass
        try:
            data, source = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError:
            return
        # Our own multicast announcement comes back when the interface loops it.
        if source[0] == address:
            continue
        reply = mdns_response(data, address)
        if not reply:
            continue
        try:
            sock.sendto(reply, (MDNS_GROUP, MDNS_PORT))
            mdns_status["answers"] += 1
        except OSError:
            pass


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


class BridgeHTTPServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR lets a second process bind the same port, which
    # leaves two bridges fighting over port 8765 and one of them serving stale
    # code. Refuse reuse there; keep it on POSIX so a restart is not blocked by
    # a socket in TIME_WAIT.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


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
    threading.Thread(target=xplane_identity_loop, daemon=True).start()
    threading.Thread(target=mdns_loop, daemon=True).start()
    threading.Thread(target=msfs_loop, daemon=True).start()
    threading.Thread(target=traffic_loop, daemon=True).start()
    threading.Thread(target=relay_loop, daemon=True).start()

    try:
        server = BridgeHTTPServer((HOST, HTTP_PORT), Handler)
    except OSError as exc:
        log("Could not start the bridge on port %d: %s" % (HTTP_PORT, exc))
        log("Another Stratos bridge may already be running. Close it, or set STRATOS_HTTP_PORT.")
        sys.exit(2)
    print("")
    print("  Stratos bridge is running")
    print("  On this PC:   http://127.0.0.1:%d" % HTTP_PORT)
    print("  On your LAN:  http://%s:%d  (token required; pair a phone from Stratos Settings)" % (lan_ip(), HTTP_PORT))
    print("  Phone:        http://%s:%d on the phone, or Stratos > Settings > Phone access"
          % (MDNS_HOST, HTTP_PORT))
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
