/* Phone live dashboard.
   Two supported sources:
     * opened from the bridge over the LAN (same origin) → SSE
     * hosted PWA → outbound snapshots via the paired relay
   The phone never connects to a simulator, and no command channel exists. */

import { initTheme, esc, fmtDate, fmtTime, num, setTheme, toast, tag } from './ui.js';
import { defaultBridgeBase, claimRelay, RelayClient, TelemetryClient, bridgeHealth, forgetThisPhone } from './bridge.js';
import {
  BRIDGE_STORAGE_KEY, blocksLocalBridge, bridgeCandidates, connectionHelp,
  connectStatus, findBridge, phoneConnectUrl,
} from './lib/connect.js';
import { mergeFlights, getFlights } from './lib/store.js';
import { detectResourceMode, formatAltitude, parseTelemetry } from './lib/telemetry.js';
import { findAirport } from './data/airports.js';
import { distanceNm } from './lib/geo.js';
import { VATSIM_FEED_URL, parsePilots } from './lib/vatsim.js';
import { MiniMap } from './minimap.js';

initTheme();
if (location.port === '8765') setTheme('night');

const STORAGE_KEY = 'stratos.phoneRelay';
const view = document.getElementById('live-view');
const statusEl = document.getElementById('live-status');

let relayConfig = readRelay();
let relayClient = null;
let telemetryClient = null;
let bridgeSource = false;
let lastState = null;
let map = null;
let mapTrack = [];
let mapKey = '';
let mapRouteKey = null;
let lastMapUpdate = 0;
let lastIngest = 0;
let knownFlightIds = new Set();
let liveTimer = null;
let flightStartedAt = null;
let flownNm = 0;
let lastPosition = null;
let lastFlightKey = '';
let busy = false;

/* Other aircraft near this flight, from the VATSIM feed this phone can read
   itself and from the traffic the bridge already holds (its ADS-B feed).
   Tapping one shows its recorded path: the bridge's own store where the page is
   served by the bridge, so it matches what the PC shows, plus what this phone
   has observed. Nothing is invented for the part nobody recorded. */
const TRAFFIC_RADIUS_NM = 180;
const TRAFFIC_MAX = 25;
let traffic = [];
let trafficAt = 0;
let trafficBusy = false;
let trafficSelected = null;
let trafficTrailCount = 0;
let trafficPostAt = 0;
const trafficSeen = new Map();
/* A phone paired through the relay has no bridge, so the relay carries the
   desktop's traffic list and the trail samples it has recorded. */
let relayTrafficList = [];
let relayTrafficAt = 0;

function trafficKeyOf(target) {
  return String((target && (target.key || target.id)) || '').toUpperCase();
}

/**
 * The traffic the bridge already polled (its ADS-B feed), shaped like the
 * VATSIM entries. The bridge is the authority on how fresh that list is — the
 * desktop map shows its last known positions too — so no second age gate is
 * applied here; a snapshot without a traffic timestamp carries no list.
 */
function bridgeTrafficList(raw) {
  const list = Array.isArray(raw && raw.tr) ? raw.tr : [];
  if (!Number(raw && raw.trt)) return [];
  const out = [];
  for (const item of list) {
    if (!item || !Number.isFinite(Number(item.lat)) || !Number.isFinite(Number(item.lon))) continue;
    const id = String(item.id || '').trim().toUpperCase();
    if (!id) continue;
    out.push({
      id, key: id, source: 'adsb',
      lat: Number(item.lat), lon: Number(item.lon),
      alt: Number.isFinite(Number(item.alt)) ? Number(item.alt) : null,
      gs: Number.isFinite(Number(item.gs)) ? Number(item.gs) : null,
      hdg: Number.isFinite(Number(item.hdg)) ? Number(item.hdg) : 0,
      aircraft: null, dep: null, arr: null,
    });
  }
  return out;
}

/** A position this phone saw, kept per aircraft for the duration of the trail. */
function recordTrafficPoint(target, when) {
  const key = trafficKeyOf(target);
  if (!key) return;
  const list = trafficSeen.get(key) || [];
  const last = list[list.length - 1];
  if (!last || Math.abs(last[0] - target.lat) + Math.abs(last[1] - target.lon) > 1e-4) {
    list.push([target.lat, target.lon, Number(target.alt) || 0, when]);
    if (list.length > 240) list.shift();
    trafficSeen.set(key, list);
  }
}

/**
 * The desktop's traffic list, carried through the relay for a paired phone.
 * Fetched at the same 15 s cadence as the feed; a failure keeps the last list.
 */
async function fetchRelayTraffic() {
  if (bridgeSource || !relayConfig) return;
  const now = Date.now();
  if (now - relayTrafficAt < 15000) return;
  relayTrafficAt = now;
  try {
    const response = await fetch(`${relayConfig.url}/api/traffic`, {
      headers: { Authorization: `Bearer ${relayConfig.token}` }, cache: 'no-store',
    });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload && Array.isArray(payload.list)) relayTrafficList = payload.list;
  } catch (_) { /* keep the last list; the page still shows VATSIM traffic */ }
}

/** The bridge's record plus what this phone saw, oldest first, one point per time. */
async function trafficHistory(key) {
  const byTime = new Map();
  (trafficSeen.get(key) || []).forEach(point => byTime.set(point[3], { lat: point[0], lon: point[1], alt: point[2], t: point[3] }));
  if (!bridgeSource && relayConfig) {
    try {
      const response = await fetch(`${relayConfig.url}/api/traffic?hex=${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${relayConfig.token}` }, cache: 'no-store',
      });
      if (response.ok) {
        const payload = await response.json();
        (payload && payload.points || []).forEach(point => {
          if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
          byTime.set(point[3], { lat: point[0], lon: point[1], alt: Number(point[2]) || 0, t: point[3] });
        });
      }
    } catch (_) { /* the phone's own record stands */ }
  }
  if (bridgeSource || location.port === '8765') {
    try {
      const response = await fetch(`${location.origin}/traffic/trail?hex=${encodeURIComponent(key)}`, { cache: 'no-store', credentials: 'include' });
      if (response.ok) {
        const payload = await response.json();
        (payload && payload.points || []).forEach(point => {
          if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
          byTime.set(point[3], { lat: point[0], lon: point[1], alt: Number(point[2]) || 0, t: point[3] });
        });
      }
    } catch (_) { /* a hosted page has no bridge; the phone's own record stands */ }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** What is actually known about a target, without placeholder values. */
function trafficSummary(target) {
  const parts = [];
  if (target.aircraft) parts.push(target.aircraft);
  if (target.dep && target.arr) parts.push(`${target.dep} → ${target.arr}`);
  parts.push(target.source === 'adsb' ? 'ADS-B' : 'VATSIM');
  return parts.join(' · ');
}

function clearTrafficSelection() {
  trafficSelected = null;
  trafficTrailCount = 0;
  map?.selectTraffic('');
  render();
}

async function selectTrafficIndex(index) {
  const target = traffic[index];
  if (!target) return;
  trafficSelected = target;
  map?.selectTraffic(trafficKeyOf(target));
  map?.setTrafficTrail([]);
  trafficTrailCount = 0;
  render();
  const points = await trafficHistory(trafficKeyOf(target));
  if (!trafficSelected || trafficKeyOf(trafficSelected) !== trafficKeyOf(target)) return;
  trafficTrailCount = points.length;
  map?.setTrafficTrail(points);
  render();
}

/**
 * One tap: aircraft are picked before the route, on the same map instance. The
 * index belongs to the map's own filtered array, so the aircraft is resolved by
 * its key before it is looked up in this page's list.
 */
function handleMapSelect(hit) {
  if (hit && hit.kind === 'traffic') {
    const target = map?.traffic?.[hit.index];
    const key = trafficKeyOf(target || traffic[hit.index]);
    const index = traffic.findIndex(item => trafficKeyOf(item) === key);
    if (index >= 0) selectTrafficIndex(index);
  } else if (trafficSelected) clearTrafficSelection();
}

/** Report what this phone sees, so the trail is shared with the desktop. */
function postTraffic() {
  if (!(bridgeSource || location.port === '8765')) return;
  const now = Date.now();
  if (now - trafficPostAt < 15000) return;
  trafficPostAt = now;
  const points = traffic.map(target => [trafficKeyOf(target), target.lat, target.lon, Number(target.alt) || 0, now]);
  if (!points.length) return;
  fetch(`${location.origin}/traffic/track`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  }).catch(() => {});
}

async function pollTraffic(telemetry) {
  if (!telemetry || trafficBusy || document.hidden) return;
  // A hidden traffic layer costs nothing: no feed request, no redraw.
  if (map && map.layers.traffic === false) return;
  const now = Date.now();
  if (now - trafficAt < 15000) return;
  trafficAt = now;
  trafficBusy = true;
  try {
    let pilots = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(VATSIM_FEED_URL, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (response.ok) pilots = parsePilots(await response.json());
    } catch (_) { /* the bridge's own traffic can still fill the map */ }
    const here = { lat: telemetry.lat, lon: telemetry.lon };
    const byKey = new Map();
    const add = target => {
      const key = trafficKeyOf(target);
      if (!key || byKey.has(key)) return;
      const fromYouNm = distanceNm(here, target);
      if (!Number.isFinite(fromYouNm) || fromYouNm > TRAFFIC_RADIUS_NM) return;
      byKey.set(key, { ...target, key, fromYouNm });
    };
    // VATSIM first: it carries the filed route and level, which the ADS-B feed
    // does not. An aircraft seen by both keeps the richer entry.
    pilots.forEach(pilot => add({ ...pilot, key: pilot.id }));
    if (bridgeSource) bridgeTrafficList(lastState?.snapshot?.telemetry).forEach(add);
    else {
      await fetchRelayTraffic();
      relayTrafficList.forEach(target => add({ ...target, key: target.id, source: 'adsb' }));
    }
    const near = [...byKey.values()]
      .sort((a, b) => a.fromYouNm - b.fromYouNm)
      .slice(0, TRAFFIC_MAX);
    near.forEach(target => recordTrafficPoint(target, now));
    traffic = near;
    // Forget aircraft that have not been seen for a while so a long session does
    // not accumulate every flight it ever met.
    const cutoff = now - 45 * 60 * 1000;
    for (const [key, points] of trafficSeen) {
      if (!points.length || points[points.length - 1][3] < cutoff) trafficSeen.delete(key);
    }
    map?.setTraffic(near);
    if (trafficSelected) {
      const fresh = near.find(target => trafficKeyOf(target) === trafficKeyOf(trafficSelected));
      if (fresh) {
        trafficSelected = fresh;
        const points = await trafficHistory(trafficKeyOf(fresh));
        trafficTrailCount = points.length;
        map?.setTrafficTrail(points);
      } else {
        trafficSelected = null;
        trafficTrailCount = 0;
        map?.selectTraffic('');
      }
    }
    if (near.length) postTraffic();
  } finally {
    trafficBusy = false;
  }
}

function readRelay() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (parsed && parsed.url && parsed.token) return parsed;
  } catch (_) {}
  return null;
}

function setStatus(state, text) {
  const label = connectStatus(state);
  statusEl.innerHTML = `<i class="dot dot-${esc(label.dot)}"></i><span>${esc(text || label.text)}</span>`;
}

async function servedByBridge() {
  try {
    const response = await fetch(`${location.origin}/health`, { cache: 'no-store', credentials: 'include' });
    if (!response.ok) return false;
    return /^StratosBridge\//.test(response.headers.get('server') || '');
  } catch (_) { return false; }
}

function readBridgeBase() {
  try { return localStorage.getItem(BRIDGE_STORAGE_KEY) || ''; } catch (_) { return ''; }
}

function rememberBridge(base) {
  try { if (base) localStorage.setItem(BRIDGE_STORAGE_KEY, base); } catch (_) {}
}

/* One button, no code, no URL. On a page served over HTTPS the browser will
   not let us call an HTTP bridge, so the button opens the bridge's own page;
   the bridge enrolls this phone on arrival. On an HTTP page we probe the known
   addresses first, so the phone lands on the one that actually answered. */
function pairingScreen(message = '', hint = '') {
  const query = new URLSearchParams(location.search);
  const suggestedUrl = query.get('relay') || (relayConfig && relayConfig.url) || 'https://';
  const suggestedCode = query.get('code') || '';
  const saved = readBridgeBase();
  const hosted = blocksLocalBridge(location);
  const candidates = bridgeCandidates({ protocol: location.protocol, hostname: location.hostname, port: location.port, saved });
  view.innerHTML = `
    <div class="card pair-card">
      <div class="card-head"><h1 style="font-size:22px">Connect to your simulator</h1></div>
      <p class="muted small" style="margin-bottom:14px">Open Stratos on the PC, keep the simulator running, then tap the button. This phone finds the PC on your network and pairs itself — no code, no URL, no QR.</p>
      ${message ? `<div class="notice bad" style="margin-bottom:12px">${esc(message)}</div>` : ''}
      <button class="btn primary" id="pair-connect" style="width:100%;min-height:48px">Connect to Simulator</button>
      <p class="help" id="pair-progress" style="margin-top:10px">${esc(hint || (hosted ? 'Opens the page your PC serves, and pairs on arrival.' : `Looking for Stratos near ${candidates[0] || 'this network'}.`))}</p>
      <div class="notice" style="margin-top:12px"><div><strong>If it cannot find the PC</strong><br>Both devices must be on the same Wi-Fi — guest networks and VPNs keep them apart. Allow Stratos through the firewall on private networks. The bridge listens on port 8765.</div></div>
      ${saved ? `<div class="row" style="margin-top:10px"><span class="muted small">Last connected to <code>${esc(saved)}</code></span><span class="spacer"></span><button class="btn small ghost" id="pair-forget">Forget</button></div>` : ''}
      <details style="margin-top:14px"><summary class="small muted">Not on the same network? Use the relay</summary>
        <p class="help" style="margin-top:10px">The relay receives snapshots pushed by your PC and serves them here with a read-only token. It never accepts commands for your PC.</p>
        <div class="field"><label for="pair-url">Relay URL</label>
          <input class="input" id="pair-url" value="${esc(suggestedUrl)}" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://your-relay.example.com"></div>
        <div class="field" style="margin-top:10px"><label for="pair-code">Pairing code</label>
          <input class="input" id="pair-code" value="${esc(suggestedCode)}" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="8-character code" style="font-family:var(--mono);letter-spacing:.16em;font-size:20px"></div>
        <button class="btn" id="pair-code-connect" style="width:100%;margin-top:12px;min-height:44px">Connect through the relay</button>
      </details>
    </div>`;
  document.getElementById('pair-connect').addEventListener('click', connectLocal);
  document.getElementById('pair-code-connect')?.addEventListener('click', connectWithCode);
  document.getElementById('pair-forget')?.addEventListener('click', () => {
    try { localStorage.removeItem(BRIDGE_STORAGE_KEY); } catch (_) {}
    pairingScreen('', 'The saved address was forgotten. Tap Connect to find this PC again.');
  });
  setStatus('disconnected', 'Not connected');
  document.title = 'Live · Stratos';
}

async function connectLocal() {
  if (busy) return;
  busy = true;
  const button = document.getElementById('pair-connect');
  const progress = document.getElementById('pair-progress');
  const say = text => { if (progress) progress.textContent = text; };
  if (button) { button.disabled = true; button.textContent = 'Looking for your PC…'; }
  setStatus('connecting', 'Looking for your PC…');
  try {
    if (blocksLocalBridge(location)) {
      say('Opening the page your PC serves…');
      location.href = phoneConnectUrl();
      return;
    }
    const candidates = bridgeCandidates({
      protocol: location.protocol, hostname: location.hostname,
      port: location.port, saved: readBridgeBase(),
    });
    const found = await findBridge(candidates);
    if (found.ok || found.reason === 'unauthorized') {
      rememberBridge(found.base);
      say(`Found ${found.base}. Pairing this phone…`);
      location.href = `${found.base}/pair/connect`;
      return;
    }
    const tried = found.tried.map(entry => entry.base).filter(Boolean).join(', ');
    pairingScreen(connectionHelp(found.reason), tried ? `Tried ${tried}.` : '');
  } finally {
    busy = false;
  }
}

async function connectWithCode() {
  if (busy) return;
  const url = document.getElementById('pair-url').value.trim().replace(/\/+$/, '');
  const code = document.getElementById('pair-code').value.trim().toUpperCase();
  if (!/^https?:\/\//.test(url)) { toast('Enter the relay URL (https://…).', 'bad'); return; }
  if (code.length < 6) { toast('Enter the 8-character pairing code.', 'bad'); return; }
  busy = true;
  const button = document.getElementById('pair-connect');
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    const result = await claimRelay(url, code, 'iPhone');
    relayConfig = { url, token: result.readToken, name: result.name, expiresAt: result.expiresAt };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(relayConfig));
    toast('Phone paired.', 'good');
    startRelay();
  } catch (error) {
    pairingScreen(error.message);
  } finally {
    busy = false;
  }
}

function disconnect(revoke = true) {
  relayClient?.stop();
  relayClient = null;
  if (revoke && relayConfig) {
    fetch(relayConfig.url + '/api/revoke', {
      method: 'POST', headers: { Authorization: `Bearer ${relayConfig.token}` },
    }).catch(() => {});
  }
  localStorage.removeItem(STORAGE_KEY);
  relayConfig = null;
  pairingScreen('This phone has been disconnected.');
}

function startRelay() {
  if (!relayConfig) { pairingScreen(); return; }
  stopBridge();
  bridgeSource = false;
  relayClient?.stop();
  relayClient = new RelayClient({
    url: relayConfig.url,
    token: relayConfig.token,
    intervalMs: 3000,
    onState: state => {
      lastState = state;
      render();
    },
    onStatus: status => {
      const labels = {
        connecting: ['connecting', 'Connecting…'],
        connected: ['connected', 'Live'],
        reconnecting: ['connecting', 'Reconnecting…'],
        waiting: ['waiting', 'Waiting for telemetry'],
        stale: ['stale', 'Desktop idle'],
        unpaired: ['unpaired', 'Pairing revoked'],
        offline: ['offline', 'No network'],
        error: ['reconnecting', 'Reconnecting…'],
      };
      const [dot, text] = labels[status.state] || ['disconnected', 'Not connected'];
      setStatus(dot, text);
      const statusBox = document.getElementById('connection-note');
      if (statusBox) statusBox.textContent = status.detail || '';
      if (status.state === 'unpaired') {
        localStorage.removeItem(STORAGE_KEY);
        relayConfig = null;
        pairingScreen('This phone was disconnected from the PC. Pair again with a new code.');
      }
    },
  });
  relayClient.start();
  startTimer();
  render();
}

async function startBridge(base = defaultBridgeBase()) {
  relayClient?.stop();
  relayClient = null;
  bridgeSource = true;
  try {
    const health = await bridgeHealth(base);
    if (health.simulator && health.simulator.connected) setStatus('connected', 'Simulator live');
    else setStatus('waiting', 'Bridge connected');
    rememberBridge(base);
  } catch (error) {
    pairingScreen(error.name === 'BridgeAuthError'
      ? connectionHelp('unauthorized')
      : connectionHelp('bridge-offline'), `The bridge at ${base} did not answer.`);
    return;
  }
  telemetryClient = new TelemetryClient({
    base,
    mode: 'minimal',
    onTelemetry: message => {
      const raw = message.raw || {};
      lastState = {
        name: 'Local bridge',
        updatedAt: Date.now(),
        stale: false,
        snapshot: {
          ts: Date.now(),
          phase: raw.flightPhase,
          telemetry: raw,
          flight: raw.currentFlight || null,
          recent: lastState?.snapshot?.recent || [],
          stats: lastState?.snapshot?.stats || null,
        },
      };
      render();
    },
    onStatus: status => {
      if (status.state === 'connected') setStatus('connected', 'Simulator live');
      else if (status.state === 'reconnecting' || status.state === 'connecting') setStatus('connecting', 'Connecting…');
      else setStatus('disconnected', status.state === 'paused' ? 'Paused' : 'Not connected');
    },
  });
  telemetryClient.connect();
  loadBridgeLogbook(base);
  startTimer();
  render();
}

async function loadBridgeLogbook(base) {
  try {
    const response = await fetch(base + '/logbook.json', { credentials: location.protocol === 'file:' ? 'omit' : 'include', cache: 'no-store' });
    if (!response.ok) return;
    const flights = await response.json();
    if (Array.isArray(flights)) {
      const recent = flights.sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, 5);
      if (!lastState) lastState = { name: 'Local bridge', stale: false, snapshot: {} };
      lastState.snapshot.recent = recent;
      await mergeFlights(recent);
      render();
    }
  } catch (_) {}
}

function startTimer() {
  clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (document.hidden) return;
    const el = document.getElementById('live-flight-time');
    if (el && flightStartedAt) {
      const seconds = Math.max(0, Math.floor((Date.now() - flightStartedAt) / 1000));
      el.textContent = `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }
  }, 1000);
}

function stopBridge() {
  telemetryClient?.disconnect();
  telemetryClient = null;
}

/** Departure and arrival airports of the active flight, as map waypoints. */
function routeAirports(flight) {
  if (!flight) return [];
  const points = [];
  const dep = flight.depAirport ? findAirport(flight.depAirport) : null;
  const arr = flight.arrAirport ? findAirport(flight.arrAirport) : null;
  if (dep) points.push({ lat: dep.lat, lon: dep.lon, id: flight.depAirport });
  if (arr) points.push({ lat: arr.lat, lon: arr.lon, id: flight.arrAirport });
  return points;
}

/** One map for the page's lifetime: each render moves its canvas, keeping tiles and view state. */
function ensureMap() {
  const host = document.getElementById('live-map-host');
  if (!host) return null;
  if (!map) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', 'Aircraft position');
    map = new MiniMap(canvas, { padding: 22, onSelect: handleMapSelect });
    map.setTrack(mapTrack.length ? mapTrack : [{ lat: 0, lon: 0 }]);
  }
  map.attach(host);
  return map;
}

async function ingestFlights(recent) {
  if (!Array.isArray(recent) || !recent.length) return;
  const now = Date.now();
  if (now - lastIngest < 30000) return;
  const newOnes = recent.filter(f => f && f.id && !knownFlightIds.has(f.id));
  if (!newOnes.length) return;
  lastIngest = now;
  try {
    await mergeFlights(newOnes);
    newOnes.forEach(f => knownFlightIds.add(f.id));
  } catch (_) {}
}

function progress(flight, telemetry) {
  if (!flight || !flight.depAirport || !flight.arrAirport || !telemetry) return null;
  const dep = findAirport(flight.depAirport);
  const arr = findAirport(flight.arrAirport);
  if (!dep || !arr) return null;
  const direct = distanceNm(dep, arr);
  if (!(direct > 1)) return null;
  const remaining = distanceNm(telemetry, arr);
  const value = Math.max(0, Math.min(1, (direct - remaining) / direct));
  return { value, remainingNm: remaining, directNm: direct };
}

function render() {
  const snapshot = lastState?.snapshot;
  if (!snapshot) {
    if (bridgeSource) {
      view.innerHTML = `<div class="card"><div class="card-head"><h1 style="font-size:20px">Waiting for telemetry</h1></div>
        <p class="muted small">The bridge is connected but the simulator has not sent a position yet. Start a flight in X-Plane or MSFS.</p></div>`;
    }
    return;
  }
  const telemetry = parseTelemetry(snapshot.telemetry);
  const flight = snapshot.flight;
  const phase = snapshot.phase || (flight && flight.phase) || 'UNKNOWN';
  const stats = snapshot.stats || {};
  const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
  const stale = lastState.stale || !telemetry || snapshot.ts < Date.now() - 15000;
  const routeKey = `${flight?.id || ''}:${flight?.depAirport || ''}:${flight?.arrAirport || ''}`;
  if (routeKey !== lastFlightKey) {
    lastFlightKey = routeKey;
    // The bridge keeps the flight's recorded path, so a phone opened halfway
    // through starts from the real first point instead of an empty trail.
    mapTrack = Array.isArray(flight?.track)
      ? flight.track
        .filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
        .map(point => ({
          lat: point[0], lon: point[1], alt: Number(point[2]) || 0, t: Number(point[3]) || 0,
          // The fifth value is height above ground, which the map colours by.
          agl: Number.isFinite(point[4]) ? point[4] : null,
        }))
      : [];
    flownNm = 0;
    lastPosition = null;
    flightStartedAt = flight && flight.takeoffTime ? flight.takeoffTime : null;
  }
  if (telemetry) {
    if (lastPosition) flownNm += distanceNm(lastPosition, telemetry);
    lastPosition = { lat: telemetry.lat, lon: telemetry.lon };
    const lastPoint = mapTrack[mapTrack.length - 1];
    const moved = !lastPoint || Math.abs(lastPoint.lat - telemetry.lat) + Math.abs(lastPoint.lon - telemetry.lon) > 1e-5;
    if (moved) mapTrack.push({ lat: telemetry.lat, lon: telemetry.lon, alt: telemetry.alt, t: Date.now(), agl: Number.isFinite(telemetry.agl) ? telemetry.agl : null });
    if (mapTrack.length > 900) mapTrack.splice(0, mapTrack.length - 900);
  }
  ingestFlights(recent);

  const prog = progress(flight, telemetry);
  const latestLanding = recent.find(item => item && item.landing && item.landing.vsFpm != null);
  const statusText = stale ? 'Telemetry is stale — the PC may be paused or offline.' : telemetry ? 'Receiving live telemetry' : 'Waiting for the simulator';

  view.innerHTML = `
    <section class="live-hero" aria-label="Current flight">
      <div class="row">
        <span class="status-inline"><i class="dot ${stale ? 'dot-stale' : 'dot-connected'}"></i>${esc(statusText)}</span>
        <span class="spacer"></span>
        ${tag(phase, phase === 'AIRBORNE' ? 'good' : 'muted')}
      </div>
      <div class="live-route">${esc(flight?.depAirport || '????')} <span class="route-arrow">→</span> ${esc(flight?.arrAirport || '????')}</div>
      <div class="muted small">${esc(flight?.aircraft || telemetry?.aircraft || 'Aircraft not reported')}${flight?.callsign ? ` · ${esc(flight.callsign)}` : ''}</div>
      <div class="row"><span class="muted small">Flight time</span><span class="spacer"></span><b id="live-flight-time" class="mono">0:00:00</b></div>
      ${prog ? `<div class="progress" style="margin-top:8px"><span style="width:${Math.round(prog.value * 100)}%"></span></div>
        <div class="row small muted"><span>${Math.round(prog.value * 100)}% along the direct route</span><span class="spacer"></span><span>${num(prog.remainingNm)} nm to ${esc(flight.arrAirport)}</span></div>` : '<p class="help">Progress needs known departure and destination airports.</p>'}
      <div class="muted small" style="margin-top:4px">Updated ${esc(fmtTime(lastState.updatedAt || snapshot.ts))} · ${lastState.stale ? 'stale' : 'live'}${bridgeSource ? ' · local bridge' : ' · relay'}</div>
    </section>

    <div class="telemetry" style="margin-top:12px">
      <div class="stat"><span class="stat-label">Altitude</span><b class="stat-value">${esc(telemetry ? formatAltitude(telemetry.alt) : '—')}</b></div>
      <div class="stat"><span class="stat-label">Ground speed</span><b class="stat-value">${telemetry ? Math.round(telemetry.gs) : '—'}<small class="muted" style="font-size:12px"> kt</small></b></div>
      <div class="stat"><span class="stat-label">Heading</span><b class="stat-value">${telemetry ? String(Math.round(telemetry.hdg) % 360).padStart(3, '0') + '°' : '—'}</b></div>
      <div class="stat"><span class="stat-label">Vertical speed</span><b class="stat-value">${telemetry ? Math.round(telemetry.vs) : '—'}<small class="muted" style="font-size:12px"> fpm</small></b></div>
    </div>

    <div class="map-wrap live-map" id="live-map-host" style="margin-top:12px"></div>
    <div class="row map-controls" role="toolbar" aria-label="Map controls">
      <button type="button" class="btn small" data-map-action="follow" aria-pressed="${map?.follow ? 'true' : 'false'}">Follow aircraft</button>
      <button type="button" class="btn small" data-map-action="zoom-in" aria-label="Zoom in">+</button>
      <button type="button" class="btn small" data-map-action="zoom-out" aria-label="Zoom out">−</button>
      <button type="button" class="btn small" data-map-action="fit">Fit route</button>
      <button type="button" class="btn small" data-map-action="route" aria-pressed="${map?.layers?.route !== false ? 'true' : 'false'}">Route</button>
      <button type="button" class="btn small" data-map-action="track" aria-pressed="${map?.layers?.track !== false ? 'true' : 'false'}">Track</button>
      <button type="button" class="btn small" data-map-action="traffic" aria-pressed="${map?.layers?.traffic !== false ? 'true' : 'false'}">Traffic</button>
    </div>

    <div class="card" id="live-traffic" style="margin-top:12px">
      <div class="card-head"><h2>${trafficSelected ? esc(trafficKeyOf(trafficSelected)) : 'Nearby traffic'}</h2><span class="spacer"></span>${trafficSelected ? '<button type="button" class="btn small ghost" id="traffic-clear">Clear</button>' : `<span class="muted small">${traffic.length} within ${TRAFFIC_RADIUS_NM} nm</span>`}</div>
      ${trafficSelected ? `
      <div class="muted small">${esc(trafficSummary(trafficSelected))}</div>
      <div class="telemetry" style="margin-top:10px">
        <div class="stat"><span class="stat-label">Altitude</span><b class="stat-value">${Number.isFinite(Number(trafficSelected.alt)) ? esc(formatAltitude(trafficSelected.alt)) : '—'}</b></div>
        <div class="stat"><span class="stat-label">Ground speed</span><b class="stat-value">${Number.isFinite(Number(trafficSelected.gs)) ? Math.round(Number(trafficSelected.gs)) : '—'}<small class="muted" style="font-size:12px"> kt</small></b></div>
        <div class="stat"><span class="stat-label">Heading</span><b class="stat-value">${Number.isFinite(Number(trafficSelected.hdg)) ? `${String(Math.round(Number(trafficSelected.hdg)) % 360).padStart(3, '0')}°` : '—'}</b></div>
        <div class="stat"><span class="stat-label">From you</span><b class="stat-value">${Math.round(Number(trafficSelected.fromYouNm) || 0)}<small class="muted" style="font-size:12px"> nm</small></b></div>
      </div>
      <p class="help" style="margin-top:8px">${trafficTrailCount > 1 ? `${trafficTrailCount} recorded positions in its trail${bridgeSource ? '' : (relayConfig ? ' from the relay' : ' on this phone')}.` : 'Trail recording starts now — the line grows as positions arrive.'}</p>
      ` : `<p class="help">${traffic.length ? 'Tap an aircraft on the map to see its track and details.' : 'No traffic within range yet. Aircraft appear as they are seen by the bridge or on VATSIM.'}</p>`}
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-head"><h2>Recent flights</h2><span class="spacer"></span><a class="small" href="logbook.html">Logbook</a></div>
      ${recent.length ? `<div class="list">${recent.slice(0, 5).map(item => `<div class="list-item">
        <div class="main"><div class="title"><span class="route-id">${esc(item.depAirport || '????')}</span> <span class="route-arrow">→</span> ${esc(item.arrAirport || '????')}</div>
        <div class="sub">${esc(fmtDate(item.startTime))} · ${esc(item.aircraft || 'unknown aircraft')}${item.landing && item.landing.vsFpm != null ? ` · ${item.landing.vsFpm} fpm` : ''}</div></div>
        ${Array.isArray(item.track) && item.track.length > 1 ? `<a class="btn small ghost" href="pilot.html#/replay?flight=${encodeURIComponent(item.id)}">Replay</a>` : ''}
      </div>`).join('')}</div>` : '<p class="muted small">No completed flights have been synced to this phone yet.</p>'}
    </div>

    <div class="grid grid-2" style="margin-top:12px">
      <div class="stat"><span class="stat-label">Flights logged</span><b class="stat-value">${num(stats.flights || recent.length)}</b><span class="stat-hint">on the PC</span></div>
      <div class="stat"><span class="stat-label">Last landing</span><b class="stat-value">${latestLanding ? `${latestLanding.landing.vsFpm}` : '—'}</b><span class="stat-hint">${latestLanding ? `fpm${latestLanding.landing.runway ? ` · ${esc(latestLanding.landing.runway.id)}` : ''}` : 'no landing data'}</span></div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-head"><h2>Connection</h2></div>
      <p class="muted small" id="connection-note">${esc(bridgeSource ? 'Direct connection to the bridge on your network.' : lastState.name ? `Paired with ${lastState.name}.` : '')}</p>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn small" id="live-refresh">Refresh</button>
        ${bridgeSource ? '<button class="btn small danger" id="live-forget">Forget this PC</button>' : '<button class="btn small danger" id="live-disconnect">Disconnect phone</button>'}
        <a class="btn small ghost" href="pilot.html#/settings">Settings</a>
      </div>
      <p class="help" style="margin-top:10px">iOS may suspend this web app in the background. Live data resumes when you reopen it. Stratos does not claim background tracking or guaranteed notifications.</p>
    </div>
  `;

  document.getElementById('live-refresh').addEventListener('click', () => {
    if (bridgeSource) loadBridgeLogbook(defaultBridgeBase());
    else relayClient?.poll();
    toast('Refreshing…');
  });
  document.getElementById('live-disconnect')?.addEventListener('click', () => {
    if (confirm('Disconnect this phone? It will lose access until paired again.')) disconnect(true);
  });
  document.getElementById('traffic-clear')?.addEventListener('click', clearTrafficSelection);
  document.getElementById('live-forget')?.addEventListener('click', async () => {
    if (!confirm('Forget this PC on this phone? You will need to scan a new QR code to reconnect.')) return;
    try { await forgetThisPhone(defaultBridgeBase()); } catch (_) { /* already unpaired */ }
    location.href = '/pair';
  });

  const liveMap = ensureMap();
  if (liveMap && mapRouteKey !== routeKey) {
    mapRouteKey = routeKey;
    liveMap.setRoute(routeAirports(flight));
  }
  if (liveMap && telemetry) {
    const now = performance.now();
    if (now - lastMapUpdate > 900) {
      lastMapUpdate = now;
      liveMap.setTrack(mapTrack);
      liveMap.setPosition({ lat: telemetry.lat, lon: telemetry.lon }, telemetry.hdg);
    }
  }
  pollTraffic(telemetry);
  document.title = flight?.arrAirport ? `Live · ${flight.depAirport || '????'} → ${flight.arrAirport}` : 'Live · Stratos';
}

// Map controls live in the re-rendered view, so one delegated listener serves every render.
view.addEventListener('click', event => {
  const button = event.target.closest?.('[data-map-action]');
  if (!button || !map) return;
  switch (button.dataset.mapAction) {
    case 'follow': map.setFollow(!map.follow); break;
    case 'zoom-in': map.zoomBy(1); break;
    case 'zoom-out': map.zoomBy(-1); break;
    case 'fit': map.setFollow(false); map.resetZoom(); break;
    case 'route': map.setLayers({ route: !map.layers.route }); break;
    case 'track': map.setLayers({ track: !map.layers.track }); break;
    case 'traffic':
      map.setLayers({ traffic: !map.layers.traffic });
      // Switching the layer back on fetches at the next telemetry frame instead
      // of waiting out the poll interval.
      if (map.layers.traffic) trafficAt = 0;
      break;
    default: return;
  }
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    relayClient && relayClient.stop();
    telemetryClient && telemetryClient.pause();
  } else if (bridgeSource) {
    telemetryClient?.resume();
  } else if (relayConfig && !relayClient) {
    startRelay();
  } else if (relayClient) {
    relayClient.closed = false;
    relayClient.start();
  }
});

// A Wi-Fi change or a tunnel is the common way a phone drops the stream. Retry
// at once when the network returns instead of waiting out the backoff.
window.addEventListener('online', () => {
  if (bridgeSource && telemetryClient) {
    telemetryClient.open();
  } else if (relayConfig) {
    if (!relayClient) startRelay();
    else if (relayClient.closed) relayClient.start();
  }
});
window.addEventListener('offline', () => setStatus('offline'));

(async function boot() {
  const query = new URLSearchParams(location.search);
  const saved = relayConfig;
  const flights = await getFlights().catch(() => []);
  flights.forEach(f => knownFlightIds.add(f.id));

  if (location.port === '8765') {
    await startBridge();
    return;
  }
  // The bridge can be told to listen on another port. The page it serves is
  // still a bridge page, so ask its own origin before falling back to pairing.
  if (location.protocol === 'http:' && await servedByBridge()) {
    await startBridge(location.origin);
    return;
  }
  if (saved) { startRelay(); return; }
  if (query.get('code')) {
    const url = query.get('relay') || 'https://';
    if (/^https?:\/\//.test(url) && url !== 'https://') {
      const code = query.get('code');
      try {
        const result = await claimRelay(url, code, 'iPhone');
        relayConfig = { url, token: result.readToken, name: result.name, expiresAt: result.expiresAt };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(relayConfig));
        startRelay();
        return;
      } catch (error) {
        pairingScreen(error.message);
        return;
      }
    }
  }
  pairingScreen();
})();
