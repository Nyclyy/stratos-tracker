#!/usr/bin/env python3
"""Stratos bridge for X-Plane 12 and MSFS 2020/2024 (Python 3, standard library only).

Receives X-Plane UDP "DATA" output and serves Stratos plus a live stream,
so your iPhone can open http://<PC-IP>:8765 in Safari.
Keep stratos.html in the same folder as this script.
"""
import csv, io, json, os, re, socket, struct, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UDP_PORT, HTTP_PORT = 49003, 8765
HERE = os.path.dirname(os.path.abspath(__file__))
state, lock = {}, threading.Lock()
METARS = {}  # ids -> (fetched_at, body); cached 5 minutes so refreshes stay polite


def udp_loop():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", UDP_PORT))
    prev = None
    while True:
        d, _ = s.recvfrom(4096)
        if d[:4] != b"DATA":
            continue
        for i in range(5, len(d) - 35, 36):
            idx = struct.unpack("<i", d[i:i + 4])[0]
            v = struct.unpack("<8f", d[i + 4:i + 36])
            with lock:
                if idx == 3:            # speeds: v[3] = ground speed (kt)
                    state["gs"] = v[3]
                elif idx == 17:         # pitch, roll, true heading, mag heading
                    state["hdg"] = v[2]
                elif idx == 20:         # lat, lon, alt MSL ft, alt AGL ft
                    now = time.time()
                    state.update(lat=v[0], lon=v[1], alt=v[2], agl=v[3], t=now, src="X-Plane")
                    if prev is None:
                        prev = (v[2], now)
                    elif now - prev[1] >= 0.5:
                        state["vs"] = (v[2] - prev[0]) / (now - prev[1]) * 60
                        prev = (v[2], now)


OA = "https://davidmegginson.github.io/ourairports-data/"
CACHE = os.path.join(HERE, "airports_cache3.json")
navaids = []
OSMDIR = os.path.join(HERE, "osm_cache")
airports = []


def load_airports():
    """Worldwide large/medium airports + runways from OurAirports (public domain)."""
    global airports, navaids
    try:
        c = json.load(open(CACHE))
        airports, navaids = c["a"], c["n"]
        return
    except Exception:
        pass
    try:
        def get(n):
            raw = urllib.request.urlopen(OA + n, timeout=90).read().decode("utf-8")
            return csv.DictReader(io.StringIO(raw))
        rw, rws = {}, {}
        for r in get("runways.csv"):
            m = re.match(r"\d+", r["le_ident"] or "")
            if r["closed"] == "1" or not m:
                continue
            n = int(m.group())
            lo = n if n <= 18 else n - 18
            if not 1 <= lo <= 18:
                continue
            d = rw.setdefault(r["airport_ident"], {})
            d[lo] = max(d.get(lo, 0), int(float(r["length_ft"] or 0)))
            try:
                rws.setdefault(r["airport_ident"], []).append([
                    r["le_ident"], r["he_ident"],
                    float(r["le_latitude_deg"]), float(r["le_longitude_deg"]),
                    float(r["he_latitude_deg"]), float(r["he_longitude_deg"]),
                    int(float(r["length_ft"] or 0)), int(float(r["width_ft"] or 0))])
            except ValueError:
                pass
        fq = {}
        for f in get("airport-frequencies.csv"):
            fq.setdefault(f["airport_ident"], {}).setdefault(f["type"], f["frequency_mhz"])
        out = []
        for a in get("airports.csv"):
            if a["type"] in ("large_airport", "medium_airport") and a["ident"] in rw:
                d = rw[a["ident"]]
                out.append([a["ident"], a["name"], float(a["latitude_deg"]),
                            float(a["longitude_deg"]), int(float(a["elevation_ft"] or 0)),
                            list(d.keys()), list(d.values()), rws.get(a["ident"], []), fq.get(a["ident"], {})])
        navs = []
        for n in get("navaids.csv"):
            t = n["type"]
            if not (t.startswith("VOR") or t.startswith("NDB")) or not n["frequency_khz"]:
                continue
            try:
                f = float(n["frequency_khz"])
                navs.append([n["ident"], n["name"], t, float(n["latitude_deg"]), float(n["longitude_deg"]),
                             ("%.2f MHz" % (f / 1000)) if t.startswith("VOR") else ("%d kHz" % f)])
            except ValueError:
                continue
        airports, navaids = out, navs
        json.dump({"a": out, "n": navs}, open(CACHE, "w"))
        print("Loaded %d airports worldwide" % len(out))
    except Exception as e:
        print("Airport download failed (bundled airports still work):", e)


def osm_airfield(ident, lat, lon):
    """Real runways/taxiways/aprons/terminals from OpenStreetMap (ODbL), cached per airport."""
    import urllib.parse
    f = os.path.join(OSMDIR, re.sub(r"\W", "", ident) + ".json")
    try:
        return open(f).read()
    except OSError:
        pass
    q = ('[out:json][timeout:30];(way["aeroway"~"^(runway|taxiway|taxilane|apron|terminal)$"]'
         '(around:5000,%f,%f););out geom;' % (lat, lon))
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "stratos"})
    data = json.load(urllib.request.urlopen(req, timeout=60))
    out = [[e["tags"]["aeroway"], e["tags"].get("ref", ""), [[p["lat"], p["lon"]] for p in e["geometry"]]]
           for e in data.get("elements", []) if e.get("type") == "way" and e.get("geometry")]
    s = json.dumps(out)
    os.makedirs(OSMDIR, exist_ok=True)
    open(f, "w").write(s)
    return s


import datetime
import sys
import xml.etree.ElementTree as ET

FAA = {}  # ICAO -> {"cycle": "2610", "c": [[code, name, pdf], ...]}


def faa_cycle(back=0):
    """FAA d-TPP 28-day cycle: 2601 took effect 2026-01-22."""
    n = (datetime.date.today() - datetime.date(2026, 1, 22)).days // 28 - back
    return "26%02d" % (1 + n)


def load_faa():
    """Official FAA airport diagrams + ILS approach charts (public domain d-TPP)."""
    for back in (0, 1):
        cyc = faa_cycle(back)
        url = "https://aeronav.faa.gov/d-tpp/%s/xml_data/d-TPP_Metafile.xml" % cyc
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "stratos"})
            with urllib.request.urlopen(req, timeout=180) as r:
                for _, el in ET.iterparse(r):
                    if el.tag != "airport_name":
                        continue
                    icao = el.get("icao_ident") or ("K" + (el.get("apt_ident") or ""))
                    c = []
                    for rec in el.findall("record"):
                        code = (rec.findtext("chart_code") or "").strip()
                        name = (rec.findtext("chart_name") or "").strip()
                        pdf = (rec.findtext("pdf_name") or "").strip()
                        if pdf and (code == "APD" or (code == "IAP" and "ILS" in name)):
                            c.append([code, name, pdf])
                    if c:
                        FAA[icao] = {"cycle": cyc, "c": c}
                    el.clear()
            print("Loaded FAA d-TPP cycle %s (%d airports)" % (cyc, len(FAA)))
            return
        except Exception as e:
            print("FAA d-TPP cycle %s unavailable: %s" % (cyc, e))


DEFAULT_PACK = ("KSFO KOAK KSJC KSAC KRNO KLAX KSAN KLAS KPHX KSEA KPDX KBOI KSLC KDEN KABQ KDFW KAUS KIAH "
                "KMSP KORD KATL KMIA KJFK KBOS KDCA KCLT KLGA KEWR KPHL KMCO KTPA KMDW KHOU KSNA "
                "CYYZ CYVR CYUL CYYC CYEG CYOW CYWG CYHZ CYQB CYYJ "
                "EGLL EGKK EGCC EGPH EIDW LFPG LFPO EHAM EDDF EDDM EDDB LEMD LEBL LIRF LIMC LSZH LOWW EKCH "
                "ESSA ENGM EFHK EPWA LKPR LHBP LGAV LTFM LPPT BIKF").split()


def build_pack(ids):
    """Offline data pack: import stratos_pack.json in the app's Data panel."""
    load_airports()
    load_faa()
    pack = {"built": time.strftime("%Y-%m-%d"), "cycle": faa_cycle(), "airports": airports,
            "navaids": navaids, "osm": {}, "faa": {}}
    for i in ids:
        a = next((x for x in airports if x[0] == i), None)
        if not a:
            print("skip", i, "(not in OurAirports list)")
            continue
        try:
            ways = json.loads(osm_airfield(i, a[2], a[3]))
            pack["osm"][i] = [[w[0], w[1], [[round(p[0], 5), round(p[1], 5)] for p in w[2]]] for w in ways]
            print("OSM layout", i, len(ways), "ways")
        except Exception as e:
            print("OSM failed for", i, e)
        if i in FAA:
            pack["faa"][i] = FAA[i]
        time.sleep(2)
    json.dump(pack, open(os.path.join(HERE, "stratos_pack.json"), "w"), separators=(",", ":"))
    print("Wrote stratos_pack.json. Send it to your iPhone and import it in the app (Data button).")


def tile(z, x, y):
    """Satellite tiles (Esri World Imagery), cached on disk so viewed areas work offline.
    Imagery (c) Esri, Maxar, Earthstar Geographics. Check Esri's terms for your use."""
    f = os.path.join(HERE, "tiles", str(z), str(x), str(y) + ".jpg")
    try:
        return open(f, "rb").read()
    except OSError:
        pass
    url = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%d/%d/%d" % (z, y, x)
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "stratos"}), timeout=15).read()
    os.makedirs(os.path.dirname(f), exist_ok=True)
    open(f, "wb").write(data)
    return data


def msfs_loop():
    """Microsoft Flight Simulator 2020/2024 via SimConnect.
    Windows only, run on the same PC as the sim:  pip install SimConnect"""
    try:
        from SimConnect import SimConnect, AircraftRequests
    except Exception:
        if sys.platform == "win32":
            print("MSFS support: run  pip install SimConnect  to enable it")
        return
    import math
    ar, prev, warned = None, None, False
    while True:
        try:
            if ar is None:
                sm = SimConnect()
                ar = AircraftRequests(sm, _time=200)
                print("Connected to MSFS")
                warned = False
            lat, lon = ar.get("PLANE_LATITUDE"), ar.get("PLANE_LONGITUDE")
            alt = ar.get("PLANE_ALTITUDE")
            if lat is None or lon is None or alt is None:
                time.sleep(0.5)
                continue
            h = ar.get("PLANE_HEADING_DEGREES_TRUE")  # SimConnect default unit: radians
            h = math.degrees(h) if h is not None else 0.0
            gs = ar.get("GROUND_VELOCITY") or 0       # knots
            agl = ar.get("PLANE_ALT_ABOVE_GROUND") or 0
            now = time.time()
            with lock:
                state.update(lat=lat, lon=lon, alt=alt, agl=agl, hdg=h % 360, gs=gs, t=now, src="MSFS")
                if prev is None:
                    prev = (alt, now)
                elif now - prev[1] >= 0.5:
                    state["vs"] = (alt - prev[0]) / (now - prev[1]) * 60
                    prev = (alt, now)
            time.sleep(0.2)
        except Exception:
            ar = None
            if not warned:
                print("Waiting for MSFS (start a flight)...")
                warned = True
            time.sleep(5)


def traffic_loop():
    """Real ADS-B traffic near your X-Plane position, from OpenSky (free, rate-limited)."""
    import urllib.request
    while True:
        time.sleep(12)
        with lock:
            lat, lon, t = state.get("lat"), state.get("lon"), state.get("t", 0)
        if lat is None or time.time() - t > 5:
            continue
        url = ("https://opensky-network.org/api/states/all?lamin=%f&lamax=%f&lomin=%f&lomax=%f"
               % (lat - 1.2, lat + 1.2, lon - 1.8, lon + 1.8))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "stratos"})
            data = json.load(urllib.request.urlopen(req, timeout=10))
            tr = []
            for s in data.get("states") or []:
                if s[6] is None or s[5] is None or s[8] or s[10] is None:
                    continue
                tr.append(dict(id=(s[1] or s[0]).strip(), lat=s[6], lon=s[5],
                               alt=round((s[7] or 0) * 3.281), gs=round((s[9] or 0) * 1.944),
                               hdg=s[10], vs=round((s[11] or 0) * 196.85), cc=s[2]))
            with lock:
                state["tr"], state["trt"] = tr[:80], time.time()
        except Exception:
            pass


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                while True:
                    with lock:
                        s = dict(state)
                    s["age"] = time.time() - s.get("t", 0)
                    self.wfile.write(("data: " + json.dumps(s) + "\n\n").encode())
                    self.wfile.flush()
                    time.sleep(0.2)
            except Exception:
                return
        if self.path.startswith("/osm"):
            import urllib.parse
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                body = osm_airfield(qs["id"][0], float(qs["lat"][0]), float(qs["lon"][0])).encode()
            except Exception:
                body = b"[]"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        m = re.match(r"/tile/(\d+)/(\d+)/(\d+)", self.path)
        if m:
            try:
                body = tile(*map(int, m.groups()))
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "max-age=604800")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_error(404)
            return
        if self.path.startswith("/faa"):
            ident = re.sub(r"\W", "", self.path.split("id=")[-1].split("&")[0]).upper()
            body = json.dumps(FAA.get(ident, {})).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/navaids.json"):
            body = json.dumps(navaids).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/airports.json") or self.path.startswith("/metar"):
            if self.path.startswith("/metar"):
                ids = re.sub(r"[^A-Za-z0-9,]", "", self.path.split("ids=")[-1].split("&")[0])[:40]
                hit = METARS.get(ids)
                if hit and time.time() - hit[0] < 120:
                    body = hit[1]
                else:
                    try:
                        req = urllib.request.Request(
                            "https://aviationweather.gov/api/data/metar?format=raw&ids=" + ids,
                            headers={"User-Agent": "stratos"})
                        body = urllib.request.urlopen(req, timeout=10).read()
                        if body:
                            METARS[ids] = (time.time(), body)
                    except Exception:
                        body = hit[1] if hit else b""
                ctype = "text/plain"
            else:
                body, ctype = json.dumps(airports).encode(), "application/json"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            body = open(os.path.join(HERE, "stratos.html"), "rb").read()
        except OSError:
            self.send_error(404, "stratos.html not found next to this script")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    

if __name__ == "__main__":
    if "--pack" in sys.argv:
        extra = [x.upper() for x in sys.argv[sys.argv.index("--pack") + 1:]]
        build_pack(extra or DEFAULT_PACK)
        sys.exit(0)
    threading.Thread(target=load_faa, daemon=True).start()
    threading.Thread(target=msfs_loop, daemon=True).start()
    threading.Thread(target=udp_loop, daemon=True).start()
    threading.Thread(target=traffic_loop, daemon=True).start()
    threading.Thread(target=load_airports, daemon=True).start()
    print(f"Stratos bridge running.\n  On your iPhone open: http://{lan_ip()}:{HTTP_PORT}")
    print(f"  X-Plane: send data output to {lan_ip()} port {UDP_PORT} (rows 3, 17, 20)")
    print("  MSFS 2020/2024: start a flight; install the connector once with  pip install SimConnect")
    ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), H).serve_forever()
