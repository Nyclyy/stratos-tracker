/* Phone live dashboard.
   Two supported sources:
     * opened from the bridge over the LAN (same origin) → SSE
     * hosted PWA → outbound snapshots via the paired relay
   The phone never connects to a simulator, and no command channel exists. */

import { initTheme, esc, fmtDate, fmtTime, num, setTheme, toast, tag } from './ui.js';
import { defaultBridgeBase, claimRelay, RelayClient, TelemetryClient, bridgeHealth, forgetThisPhone } from './bridge.js';
import { mergeFlights, getFlights } from './lib/store.js';
import { detectResourceMode, formatAltitude, parseTelemetry } from './lib/telemetry.js';
import { findAirport } from './data/airports.js';
import { distanceNm } from './lib/geo.js';
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

function readRelay() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (parsed && parsed.url && parsed.token) return parsed;
  } catch (_) {}
  return null;
}

function setStatus(state, text) {
  statusEl.innerHTML = `<i class="dot dot-${esc(state)}"></i><span>${esc(text)}</span>`;
}

function pairingScreen(message = '') {
  const query = new URLSearchParams(location.search);
  const suggestedUrl = query.get('relay') || (relayConfig && relayConfig.url) || 'https://';
  const suggestedCode = query.get('code') || '';
  const hosted = location.protocol === 'https:';
  view.innerHTML = `
    <div class="card pair-card">
      <div class="card-head"><h1 style="font-size:22px">Connect to your PC</h1></div>
      <p class="muted small" style="margin-bottom:14px">Stratos shows live telemetry from the simulator running on your PC. Pair once with a short code generated in <b>Pilot → Settings → Phone access</b>.</p>
      ${message ? `<div class="notice bad" style="margin-bottom:12px">${esc(message)}</div>` : ''}
      <div class="field"><label for="pair-url">Relay URL</label>
        <input class="input" id="pair-url" value="${esc(suggestedUrl)}" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://your-relay.example.com"></div>
      <div class="field" style="margin-top:10px"><label for="pair-code">Pairing code</label>
        <input class="input" id="pair-code" value="${esc(suggestedCode)}" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="8-character code" style="font-family:var(--mono);letter-spacing:.16em;font-size:20px"></div>
      <button class="btn primary" id="pair-connect" style="width:100%;margin-top:14px;min-height:46px">Connect</button>
      <p class="help" style="margin-top:12px">The relay only receives telemetry pushed by your PC. It cannot send commands to your PC. Tokens are stored on this phone only; use “Disconnect” to revoke this phone.</p>
      ${hosted ? `<div class="notice" style="margin-top:12px"><div><strong>On the same Wi-Fi?</strong><br>You can also open the bridge address directly (<code>http://PC-IP:8765</code>) and enter the bridge token once. That keeps telemetry on your local network.</div>
        <a class="btn small" href="${esc(defaultBridgeBase())}">Open local bridge</a></div>` : ''}
    </div>`;
  document.getElementById('pair-connect').addEventListener('click', connectWithCode);
  setStatus('disconnected', 'Not connected');
  document.title = 'Live · Stratos';
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
        waiting: ['waiting', 'Waiting for telemetry'],
        stale: ['stale', 'Desktop idle'],
        unpaired: ['unpaired', 'Pairing revoked'],
        offline: ['offline', 'No network'],
        error: ['error', 'Connection problem'],
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

async function startBridge() {
  relayClient?.stop();
  relayClient = null;
  bridgeSource = true;
  const base = defaultBridgeBase();
  try {
    const health = await bridgeHealth(base);
    if (health.simulator && health.simulator.connected) setStatus('connected', 'Simulator live');
    else setStatus('waiting', 'Bridge connected');
  } catch (error) {
    pairingScreen(error.name === 'BridgeAuthError'
      ? 'The bridge needs its access token. Open the bridge address in this browser and unlock it, then return here.'
      : `Bridge not reachable at ${base}. ${error.message}`);
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
    map = new MiniMap(canvas, { padding: 22 });
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
    mapTrack = [];
    flownNm = 0;
    lastPosition = null;
    flightStartedAt = flight && flight.takeoffTime ? flight.takeoffTime : null;
  }
  if (telemetry) {
    if (lastPosition) flownNm += distanceNm(lastPosition, telemetry);
    lastPosition = { lat: telemetry.lat, lon: telemetry.lon };
    mapTrack.push({ lat: telemetry.lat, lon: telemetry.lon, alt: telemetry.alt, t: Date.now() });
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

(async function boot() {
  const query = new URLSearchParams(location.search);
  const saved = relayConfig;
  const flights = await getFlights().catch(() => []);
  flights.forEach(f => knownFlightIds.add(f.id));

  if (location.port === '8765') {
    await startBridge();
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
