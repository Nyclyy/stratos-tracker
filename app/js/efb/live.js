/* EFB · Flight Progress.
 *
 * The live simulator feed the tracker already owns, shown as an EFB page: the
 * aircraft on a map with the planned route, the flown track from the bridge's
 * recording, the next waypoint, distance and time remaining, and the raw
 * telemetry a pilot glances at.
 *
 * It works without a flight plan — the aircraft is still drawn — and it says
 * "offline" rather than leaving the last position on screen pretending to be
 * live. The map is created once and updated in place; no re-render per frame.
 */

import {
  connectionText, currentPlan, esc, fmtFl, fmtFt, fmtKt, fmtMinutes, fmtNum,
  loadRoute, onLive, plannedRouteFromOfp, ensureLive,
} from './common.js';
import { MiniMap } from '../minimap.js';
import { bearingDeg, distanceNm } from '../lib/geo.js';
import { trailContinues } from '../lib/trailpath.js';
import { routeProgress } from '../lib/planner.js';

const PHASE_LABEL = {
  PARKED: 'Parked', TAXI: 'Taxiing', AIRBORNE: 'Airborne', LANDED: 'Landed', COMPLETE: 'Complete',
};

function trackObjects(track) {
  return (Array.isArray(track) ? track : [])
    .map(point => Array.isArray(point)
      ? { lat: Number(point[0]), lon: Number(point[1]), alt: Number(point[2]), t: Number(point[3]), agl: Number.isFinite(Number(point[4])) ? Number(point[4]) : null }
      : point)
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
}

export async function mount(root, ctx) {
  let destroyed = false;
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const route = loadRoute().length ? loadRoute() : plannedRouteFromOfp(ofp);
  let map = null;
  let follow = true;
  let lastTrackStamp = '';
  let lastTrackFlight = '';
  // The path as drawn. A landing ends the bridge's flight record and the rollout
  // starts a new one, so the drawn path is kept and the new recording appended.
  let drawnTrack = [];
  let status = { status: 'offline', detail: '' };

  root.innerHTML = `
    <div id="live-status"></div>
    <div class="e-grid" style="grid-template-columns:minmax(0,1fr) minmax(0,320px);align-items:start" id="live-layout">
      <div>
        <div class="e-card" style="padding:8px">
          <div class="e-map" id="live-map" style="height:min(52vh,460px)">
            <canvas id="live-canvas" aria-label="Live aircraft position and planned route"></canvas>
          </div>
          <div class="e-row" style="margin-top:8px">
            <span class="e-badge" id="live-phase">No telemetry</span>
            <span class="e-small e-faint" id="live-aircraft"></span>
            <span class="e-spacer"></span>
            <button class="e-btn small" type="button" data-follow aria-pressed="true">Follow</button>
            <button class="e-btn small" type="button" data-zoom="in" aria-label="Zoom in">+</button>
            <button class="e-btn small" type="button" data-zoom="out" aria-label="Zoom out">−</button>
          </div>
        </div>
        <div class="e-card" id="live-route-card" style="margin-top:12px"></div>
      </div>
      <div>
        <div class="e-card" id="live-readouts"></div>
        <div class="e-card" style="margin-top:12px">
          <h3>Connection</h3>
          <div id="live-connection" class="e-small e-muted"></div>
          <div class="e-row" style="margin-top:8px">
            <button class="e-btn small" type="button" data-reconnect>Reconnect</button>
            <button class="e-btn small ghost" type="button" data-tracker>Open Flight Deck</button>
          </div>
          <div class="e-small e-faint" style="margin-top:8px">Live telemetry comes from the bridge on the PC running the simulator, the same stream the map uses. A hosted HTTPS page cannot reach a LAN bridge directly; use the Flight Deck or the phone relay for that.</div>
        </div>
      </div>
    </div>
    <div id="live-empty"></div>`;

  const statusEl = root.querySelector('#live-status');
  const readoutsEl = root.querySelector('#live-readouts');
  const routeCard = root.querySelector('#live-route-card');
  const phaseEl = root.querySelector('#live-phase');
  const aircraftEl = root.querySelector('#live-aircraft');
  const connectionEl = root.querySelector('#live-connection');

  const canvas = root.querySelector('#live-canvas');
  try {
    map = new MiniMap(canvas, { layers: { tiles: true, route: route.length > 0, track: true, traffic: false } });
    if (route.length) map.setRoute(route.map(point => ({ lat: point.lat, lon: point.lon, id: point.id })));
    map.setFollow(true);
  } catch (error) {
    root.querySelector('#live-map').innerHTML = `<div class="e-notice bad" style="margin:12px">The map could not start: ${esc(error.message)}</div>`;
    map = null;
  }

  function renderBanner() {
    if (status.status === 'live') {
      statusEl.innerHTML = '';
      return;
    }
    const message = status.status === 'connecting'
      ? 'Connecting to the simulator…'
      : status.status === 'waiting'
        ? 'The bridge is running but no simulator telemetry has arrived yet.'
        : 'The simulator is offline. The last position is cleared rather than shown as live.';
    statusEl.innerHTML = `<div class="e-notice ${status.status === 'offline' ? 'warn' : ''}" style="margin-bottom:12px">
      <div><b>${esc(connectionText(status.status))}</b> — ${esc(status.detail || message)}</div>
      <button class="e-btn small" type="button" data-retry>Retry</button>
    </div>`;
    statusEl.querySelector('[data-retry]')?.addEventListener('click', () => { ensureLive(); });
  }

  function readout(label, value, sub = '') {
    return `<div style="padding:9px 0;border-bottom:1px solid rgba(148,163,184,.08)">
      <div class="e-label">${esc(label)}</div>
      <div class="e-value" style="font-size:18px" data-readout="${esc(label)}">${esc(value)}</div>
      ${sub ? `<div class="e-small e-faint">${esc(sub)}</div>` : ''}</div>`;
  }

  function renderReadouts(message) {
    const t = message && message.telemetry;
    if (!t) {
      readoutsEl.innerHTML = `<h3>Telemetry</h3><div class="e-small e-muted">No telemetry. Start the simulator and the bridge; the page reconnects on its own.</div>`;
      return;
    }
    const flight = (message && message.currentFlight) || null;
    const progress = route.length > 1 ? routeProgress(route, t) : null;
    let next = null;
    let nextNm = null;
    if (progress && progress.legIndex >= 0 && progress.legIndex < route.length) {
      next = route[progress.legIndex];
      if (next) nextNm = distanceNm(t, next);
    }
    const remaining = progress ? progress.remainingNm : (route.length > 1 ? distanceNm(t, route[route.length - 1]) : null);
    const etaMin = remaining != null && t.gs > 30 ? (remaining / t.gs) * 60 : null;
    const fuel = Number(t.fuel);
    readoutsEl.innerHTML = `<h3>Telemetry <em>${esc(t.src || 'simulator')}</em></h3>
      ${readout('Altitude', fmtFl(t.alt), t.agl != null ? `${fmtFt(t.agl)} AGL` : '')}
      ${readout('Ground speed', fmtKt(t.gs), flight && flight.phase ? PHASE_LABEL[flight.phase] || flight.phase : '')}
      ${readout('Heading', `${String(Math.round(t.hdg)).padStart(3, '0')}°`, `Vertical speed ${Math.round(t.vs / 10) * 10} fpm`)}
      ${readout('Next waypoint', next ? next.id : '—', nextNm != null ? `${fmtNum(nextNm, 1)} nm ahead` : 'No route loaded')}
      ${readout('Distance remaining', remaining != null ? `${fmtNum(remaining, 0)} nm` : '—', progress ? `${Math.round((progress.flownNm / (progress.totalNm || 1)) * 100)}% flown${progress.onRoute ? '' : ' · off route'}` : '')}
      ${readout('Time remaining', etaMin != null ? fmtMinutes(etaMin) : '—', etaMin != null && Number.isFinite(t.gs) ? `at ${Math.round(t.gs)} kt ground speed` : '')}
      ${readout('Fuel on board', Number.isFinite(fuel) && fuel > 0 ? `${fmtNum(fuel)}` : '—', Number.isFinite(fuel) && fuel > 0 ? 'as reported by the simulator' : 'not reported')}
      ${progress ? `<div class="e-bar" style="margin-top:12px"><b style="width:${Math.min(100, (progress.flownNm / (progress.totalNm || 1)) * 100).toFixed(1)}%"></b></div>` : ''}`;
  }

  function renderRouteCard(message) {
    if (!route.length) {
      routeCard.innerHTML = `<h3>Planned route</h3><div class="e-small e-muted">No route is loaded. The aircraft is still tracked on the map; load a plan in Briefing or Flight Planning to see progress against it.</div>`;
      return;
    }
    const t = message && message.telemetry;
    const progress = t ? routeProgress(route, t) : null;
    const nextId = progress && route[progress.legIndex] ? route[progress.legIndex].id : '';
    routeCard.innerHTML = `<h3>Planned route <em>${route.length} points</em></h3>
      <div class="e-row" style="gap:5px;max-height:104px;overflow:auto">${route.map(point => `<span class="e-badge ${point.id === nextId ? 'accent' : ''}">${esc(point.id)}</span>`).join('')}</div>
      <div class="e-small e-faint" style="margin-top:8px">${nextId ? `Next: <b>${esc(nextId)}</b> · ${esc(bearingDeg(t, route[progress.legIndex]).toFixed(0))}°` : 'Waiting for a position to work out the next waypoint.'}</div>`;
  }

  function updateConnection() {
    connectionEl.innerHTML = `<div><b>${esc(connectionText(status.status))}</b>${status.detail ? ` — ${esc(status.detail)}` : ''}</div>
      ${status.health ? `<div class="e-small e-faint" style="margin-top:4px">Bridge ${esc(status.health.version || '')} · ${esc(status.health.simulator && status.health.simulator.source ? status.health.simulator.source : 'no simulator detected')}</div>` : ''}`;
  }

  function update(message) {
    if (destroyed) return;
    renderReadouts(message);
    renderRouteCard(message);
    updateConnection();
    const flight = message && (message.currentFlight || message.flight);
    const t = message && message.telemetry;
    phaseEl.textContent = flight && flight.phase ? (PHASE_LABEL[flight.phase] || flight.phase) : t ? 'Tracking' : 'No telemetry';
    phaseEl.className = `e-badge ${t ? 'good' : ''}`;
    aircraftEl.textContent = t ? [t.callsign, t.aircraft, t.registration].filter(Boolean).join(' · ') : '';
    if (!map) return;
    const track = trackObjects(flight && flight.track);
    const flightId = String((flight && flight.id) || '');
    if (flightId && flightId !== lastTrackFlight) {
      drawnTrack = track.length > 1 && drawnTrack.length > 0 &&
        trailContinues(drawnTrack[drawnTrack.length - 1], track[0]) ? drawnTrack : [];
      lastTrackFlight = flightId;
      lastTrackStamp = '';
    }
    const stamp = `${track.length}:${track.length ? track[track.length - 1].t : ''}`;
    if (track.length > 1 && stamp !== lastTrackStamp) {
      lastTrackStamp = stamp;
      if (drawnTrack.length) {
        for (const point of track) {
          const tail = drawnTrack[drawnTrack.length - 1];
          if (tail && Math.abs(tail.lat - point.lat) + Math.abs(tail.lon - point.lon) < 1e-5) continue;
          drawnTrack.push(point);
        }
        if (drawnTrack.length > 6000) drawnTrack.splice(0, drawnTrack.length - 6000);
        map.setTrack(drawnTrack);
      } else {
        drawnTrack = track.slice();
        map.setTrack(drawnTrack);
      }
    }
    if (t) {
      map.setPosition({ lat: t.lat, lon: t.lon, alt: t.alt }, t.hdg);
    }
  }

  const off = onLive(next => {
    status = next;
    renderBanner();
    updateConnection();
    if (next.status === 'live' && next.snapshot) update(next.snapshot);
    if (next.status !== 'live') {
      if (map) map.setPosition(null);
    }
  });

  root.querySelector('[data-follow]')?.addEventListener('click', event => {
    follow = !follow;
    event.currentTarget.setAttribute('aria-pressed', follow ? 'true' : 'false');
    map?.setFollow(follow);
  });
  root.querySelectorAll('[data-zoom]').forEach(button => {
    button.addEventListener('click', () => map?.zoomBy(button.dataset.zoom === 'in' ? 1 : -1));
  });
  root.querySelector('[data-reconnect]')?.addEventListener('click', () => ensureLive());
  root.querySelector('[data-tracker]')?.addEventListener('click', () => { window.location.href = 'index.html'; });

  renderReadouts(null);
  renderRouteCard(null);
  renderBanner();
  updateConnection();

  return {
    destroy() {
      destroyed = true;
      off();
      if (map) { try { map.destroy(); } catch (_) { /* gone */ } map = null; }
    },
  };
}
