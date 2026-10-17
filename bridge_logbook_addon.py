#!/usr/bin/env python3
"""
stratos_bridge_logbook_addon.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS:
  Append or merge this code into stratos_bridge.py.
  It adds three capabilities:
    1. Automatic flight detection state machine (PARKED→TAXI→AIRBORNE→LANDED→COMPLETE)
    2. REST endpoint /logbook.json  (GET all flights, POST save flight)
    3. Enriched /stream output with flight state and airport identification
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Add these imports to the top of stratos_bridge.py (if not already present):
  import datetime, math, uuid
"""

import datetime, json, math, os, threading, time, uuid

# ── Thresholds ──────────────────────────────────────────────────────
TAXI_SPEED_KT    =  2      # GS above this → TAXI
AIRBORNE_AGL_FT  = 30      # AGL above this + fast → AIRBORNE
TAKEOFF_SPEED_KT = 40      # GS needed to confirm takeoff
LANDED_AGL_FT    = 20      # AGL below this → possible landing
LANDED_SPEED_KT  = 60      # GS below this → confirmed landing
PARKED_SPEED_KT  =  2      # GS below this on ground → PARKED
PARKED_SECONDS   = 30      # seconds parked after landing → COMPLETE
MIN_FLIGHT_SEC   = 60      # seconds airborne to count as real flight

# ── Logbook file ─────────────────────────────────────────────────────
HERE         = os.path.dirname(os.path.abspath(__file__))
DATA_DIR     = os.environ.get('STRATOS_DATA_DIR', HERE)
os.makedirs(DATA_DIR, exist_ok=True)
LOGBOOK_FILE = os.path.join(DATA_DIR, 'stratos_logbook.json')
lb_lock      = threading.Lock()

def lb_load():
    try:
        with open(LOGBOOK_FILE) as f:
            return json.load(f)
    except Exception:
        return []

def lb_save(flights):
    with lb_lock:
        with open(LOGBOOK_FILE, 'w') as f:
            json.dump(flights, f, separators=(',', ':'))

def lb_add(flight):
    """Append a completed flight. Idempotent by flight id."""
    flights = lb_load()
    if any(x['id'] == flight['id'] for x in flights):
        return  # already saved
    flights.append(flight)
    lb_save(flights)

# ── Nearest airport lookup ────────────────────────────────────────────
def _haversine_nm(lat1, lon1, lat2, lon2):
    R = 3440.065
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(max(0, min(1, a))))

def nearest_airport(lat, lon, airports_list, max_nm=5):
    """Return ICAO of nearest airport within max_nm nm, or None."""
    best_id, best_d = None, max_nm
    for a in airports_list:
        try:
            d = _haversine_nm(lat, lon, a[2], a[3])
            if d < best_d:
                best_d, best_id = d, a[0]
        except Exception:
            pass
    return best_id

# ── Flight state machine ──────────────────────────────────────────────
_flight_state = {
    'phase': 'PARKED',   # PARKED | TAXI | AIRBORNE | LANDED | COMPLETE
    'flight': None,      # current in-progress flight dict
    'parked_since': None,
}
_fs_lock = threading.Lock()

def _new_flight(data):
    return {
        'id': 'flt_' + uuid.uuid4().hex[:12],
        'phase': 'PARKED',
        'startTime': int(time.time() * 1000),
        'takeoffTime': None,
        'landingTime': None,
        'endTime': None,
        'depAirport': None,
        'arrAirport': None,
        'aircraft': data.get('aircraft', ''),
        'registration': data.get('registration', ''),
        'callsign': data.get('callsign', ''),
        'sim': data.get('src', 'Simulator'),
        'maxAlt': 0,
        'distanceNm': 0,
        'landingVS': None,
        'fuelDep': data.get('fuel'),
        'fuelArr': None,
        'track': [],
        'complete': False,
        'incomplete': False,
    }

def _track_add(flight, data):
    track = flight['track']
    pt = {'lat': data['lat'], 'lon': data['lon'], 'alt': data.get('alt', 0), 't': int(time.time()*1000)}
    if not track:
        track.append(pt)
        return
    last = track[-1]
    # Add every 10 s or if moved > 0.3 nm
    age = (pt['t'] - last['t']) / 1000
    dist = _haversine_nm(last['lat'], last['lon'], pt['lat'], pt['lon'])
    if age >= 10 or dist >= 0.3:
        track.append(pt)
        if len(track) > 5000:
            flight['track'] = track[-5000:]

def _track_distance(track):
    d = 0
    for i in range(1, len(track)):
        d += _haversine_nm(track[i-1]['lat'], track[i-1]['lon'], track[i]['lat'], track[i]['lon'])
    return round(d, 1)

def process_telemetry_for_logbook(data, airports_list=None):
    """
    Call this from udp_loop / msfs_loop each time new telemetry arrives.
    data dict keys: lat, lon, alt, agl, gs, hdg, vs, src, fuel, aircraft, registration, callsign
    Returns the current phase string for inclusion in /stream output.
    """
    if not data or data.get('lat') is None:
        return 'NO_DATA'

    lat = data['lat']; lon = data['lon']
    alt = data.get('alt', 0)
    agl = data.get('agl', 0)
    gs  = data.get('gs', 0)
    vs  = data.get('vs', 0)
    now_ms = int(time.time() * 1000)
    on_ground = agl < LANDED_AGL_FT

    with _fs_lock:
        fs = _flight_state
        phase = fs['phase']

        if fs['flight'] is None:
            fs['flight'] = _new_flight(data)

        f = fs['flight']

        # Update max alt
        if alt > (f['maxAlt'] or 0):
            f['maxAlt'] = alt

        # Track recording
        _track_add(f, data)

        # ── State transitions ──────────────────────────────────────
        if phase == 'PARKED':
            if gs > TAXI_SPEED_KT:
                f['phase'] = fs['phase'] = 'TAXI'
                if airports_list:
                    f['depAirport'] = nearest_airport(lat, lon, airports_list)
                    f['fuelDep'] = data.get('fuel')

        elif phase == 'TAXI':
            if agl > AIRBORNE_AGL_FT and gs > TAKEOFF_SPEED_KT:
                f['phase'] = fs['phase'] = 'AIRBORNE'
                f['takeoffTime'] = now_ms
            elif gs < PARKED_SPEED_KT and on_ground:
                f['phase'] = fs['phase'] = 'PARKED'

        elif phase == 'AIRBORNE':
            if on_ground and gs < LANDED_SPEED_KT:
                f['phase'] = fs['phase'] = 'LANDED'
                f['landingTime'] = now_ms
                if airports_list:
                    f['arrAirport'] = nearest_airport(lat, lon, airports_list)
                f['fuelArr'] = data.get('fuel')
                if vs is not None:
                    f['landingVS'] = round(vs)
                fs['parked_since'] = time.time()

        elif phase == 'LANDED':
            # Touch-and-go check
            if agl > AIRBORNE_AGL_FT and gs > TAKEOFF_SPEED_KT:
                f['phase'] = fs['phase'] = 'AIRBORNE'
                f['landingTime'] = None
                f['arrAirport'] = None
                f['landingVS'] = None
                fs['parked_since'] = None
            elif fs['parked_since'] and (time.time() - fs['parked_since']) >= PARKED_SECONDS:
                # Complete the flight
                _complete_flight(f, data, airports_list)
                fs['phase'] = 'PARKED'
                fs['flight'] = None
                fs['parked_since'] = None
                return 'PARKED'

        return fs['phase']


def _complete_flight(f, data, airports_list):
    f['complete'] = True
    f['phase'] = 'COMPLETE'
    f['endTime'] = int(time.time() * 1000)
    f['distanceNm'] = _track_distance(f['track'])

    # Mark incomplete if too short
    if f['takeoffTime'] and f['landingTime']:
        airborne_sec = (f['landingTime'] - f['takeoffTime']) / 1000
        if airborne_sec < MIN_FLIGHT_SEC:
            f['incomplete'] = True
    else:
        f['incomplete'] = True

    # Confirm arrival airport if not set
    if not f['arrAirport'] and data.get('lat') and airports_list:
        f['arrAirport'] = nearest_airport(data['lat'], data['lon'], airports_list)

    # Save to JSON logbook
    lb_add(f)
    print(f"[Logbook] Flight logged: {f.get('depAirport','?')} → {f.get('arrAirport','?')} "
          f"{'(incomplete)' if f['incomplete'] else ''} id={f['id']}")


def get_flight_phase():
    with _fs_lock:
        return _flight_state['phase']

def get_current_flight():
    with _fs_lock:
        return dict(_flight_state['flight']) if _flight_state['flight'] else None


# ── HTTP handler additions ────────────────────────────────────────────
# Add these routes inside the H.do_GET method of stratos_bridge.py:
#
#   if self.path.startswith('/logbook.json'):
#       _handle_logbook(self)
#       return
#
# And add this function at module level:

def _handle_logbook(handler):
    """Serve GET /logbook.json and POST /logbook.json (save a flight from browser)."""
    if handler.command == 'GET':
        flights = lb_load()
        body = json.dumps(flights).encode()
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Access-Control-Allow-Origin', '*')
        handler.send_header('Content-Length', str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    elif handler.command == 'POST':
        length = int(handler.headers.get('Content-Length', 0))
        body_in = handler.rfile.read(length)
        try:
            flight = json.loads(body_in)
            if isinstance(flight, dict) and flight.get('id'):
                lb_add(flight)
                resp = b'{"ok":true}'
            else:
                resp = b'{"ok":false,"error":"Invalid flight object"}'
        except Exception as e:
            resp = json.dumps({'ok': False, 'error': str(e)}).encode()
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Access-Control-Allow-Origin', '*')
        handler.send_header('Content-Length', str(len(resp)))
        handler.end_headers()
        handler.wfile.write(resp)


# ── Stream enrichment ─────────────────────────────────────────────────
# In stratos_bridge.py, inside the /stream SSE loop, add these fields
# to the dict 's' before serialising:
#
#   s['flightPhase'] = get_flight_phase()
#   cf = get_current_flight()
#   if cf:
#       s['currentFlight'] = {
#           'id': cf['id'],
#           'depAirport': cf['depAirport'],
#           'takeoffTime': cf['takeoffTime'],
#       }
#
# The logbook.html page reads flightPhase from the stream to show the
# live status bar (PARKED / TAXI / AIRBORNE / LANDED).


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# INTEGRATION CHECKLIST for stratos_bridge.py
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. Import this file at the top of stratos_bridge.py:
#       from bridge_logbook_addon import process_telemetry_for_logbook, _handle_logbook, get_flight_phase, get_current_flight
#
# 2. In udp_loop(), after updating `state`, call:
#       process_telemetry_for_logbook(state, airports)
#
# 3. In msfs_loop(), after updating `state`, call:
#       process_telemetry_for_logbook(state, airports)
#
# 4. In H.do_GET, add:
#       if self.path.startswith('/logbook.json'):
#           _handle_logbook(self)
#           return
#
# 5. In the /stream SSE loop, add flightPhase to the dict:
#       s['flightPhase'] = get_flight_phase()
#
# 6. Place logbook.html and weather.html in the same folder as stratos.html.
#    The bridge already serves all .html files from that folder.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
