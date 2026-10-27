/* EFB · Navigator.
 *
 * A flight-bag moving map, not a dashboard card: the chart fills the display and
 * the plan, the aircraft and the numbers sit on top of it.
 *
 * The route is drawn with chart conventions — an airport ring, a navaid hexagon,
 * a fix triangle, a bright plan line with leg distances, and the flown part
 * dimmed behind the aircraft. A waypoint or a leg can be tapped for its
 * identifier, position, planned level and leg geometry, and the list on the
 * right is the same plan in textual order so a leg can be found by reading
 * rather than hunting on the chart.
 *
 * Telemetry is the bridge stream the tracker already uses — the same connection,
 * not a second one. The aircraft is drawn with or without a flight plan. When
 * the feed stops the last position is cleared rather than left on the map as if
 * it were current.
 */

import {
  connectionText, currentPlan, ensureLive, esc, flightPhase, fmtFl, fmtFt, fmtKt, fmtMinutes,
  fmtNum, loadRoute, loadRouteMeta, onLive, onPlanChange, plannedRouteFromOfp,
} from './common.js';
import { MiniMap } from '../minimap.js';
import { bearingDeg, distanceNm } from '../lib/geo.js';
import { trailContinues } from '../lib/trailpath.js';
import { routeProgress } from '../lib/planner.js';

const TREND = vs => (vs > 200 ? 'climbing' : vs < -200 ? 'descending' : 'level');

const ICON = {
  follow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.2"/><path d="M12 2.6v2.4M12 19v2.4M2.6 12H5M19 12h2.4"/></svg>',
  fit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4.6h4.4M20 9V4.6h-4.4M4 15v4.4h4.4M20 15v4.4h-4.4"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/></svg>',
  panel: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.4h16M4 12h16M4 17.6h10"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};

/* The map records positions as arrays in the bridge stream and as objects after
   a page has round-tripped them; both shapes are accepted here. */
function trackObjects(track) {
  return (Array.isArray(track) ? track : [])
    .map(point => Array.isArray(point)
      ? { lat: Number(point[0]), lon: Number(point[1]), alt: Number(point[2]), t: Number(point[3]), agl: Number.isFinite(Number(point[4])) ? Number(point[4]) : null }
      : point)
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
}

function clockAfter(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const at = new Date(Date.now() + minutes * 60000);
  return `${at.toISOString().slice(11, 16)}Z`;
}

/** Decimal degrees the way a chart prints a position: 45.470°N 073.741°W. */
export function formatCoords(lat, lon) {
  const n = Number(lat);
  const e = Number(lon);
  if (!Number.isFinite(n) || !Number.isFinite(e)) return '—';
  const ns = `${Math.abs(n).toFixed(3)}°${n >= 0 ? 'N' : 'S'}`;
  const ew = `${Math.abs(e).toFixed(3)}°${e >= 0 ? 'E' : 'W'}`;
  return `${ns} ${ew}`;
}

/** Distance and initial track attached to each point, for the map's leg labels. */
export function withLegs(points) {
  const list = (Array.isArray(points) ? points : []).filter(point => point
    && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)));
  return list.map((point, index) => {
    const next = list[index + 1];
    if (!next) return { ...point, legNm: null, legTrack: null };
    return { ...point, legNm: distanceNm(point, next), legTrack: bearingDeg(point, next) };
  });
}

const KIND_LABEL = { apt: 'Airport', nav: 'Navaid', fix: 'Fix' };

export function kindLabel(kind) {
  return KIND_LABEL[kind] || 'Waypoint';
}

export async function mount(root, ctx) {
  let destroyed = false;
  // The page owns the whole content region: a chart, not a card on a page.
  document.body.classList.add('view-map', 'view-nav');

  let plan = currentPlan();
  let route = withLegs(loadRoute().length ? loadRoute() : plannedRouteFromOfp(plan && plan.ofp));
  let map = null;
  let follow = route.length < 2;
  let panelOpen = !window.matchMedia('(max-width: 900px)').matches;
  let selection = null;
  let lastTrackStamp = '';
  let lastTrackFlight = '';
  // The path as drawn. A landing ends the bridge's flight record and the rollout
  // starts a new one, so the drawn path is kept and the new recording appended.
  let drawnTrack = [];
  let status = { status: 'offline', detail: '' };
  let chartTheme = ctx.prefs().chartTheme === 'day' ? 'day' : 'night';
  // The last progress the page worked out, and the last message it drew, so a
  // list can be updated once per change instead of on every telemetry frame.
  let stateNow = null;
  let lastMessage = null;
  let listKey = '';

  root.innerHTML = `
    <div class="nav-shell map-shell">
      <div class="nav-view map-view">
        <canvas id="nav-canvas" aria-label="Aircraft position and planned route"></canvas>

        <div class="map-hud">
          <div class="map-flight">
            <div class="map-route" id="nav-route"></div>
            <div class="map-sub" id="nav-sub"></div>
          </div>
          <div class="map-hud-right">
            <span class="map-chip" id="nav-phase">No telemetry</span>
            <span class="map-chip map-conn" id="nav-conn" data-state="offline">Offline</span>
          </div>
        </div>

        <div class="map-banner" id="nav-banner"></div>

        <div class="nav-tools" role="group" aria-label="Map controls">
          <button class="nav-tool" type="button" data-follow aria-pressed="${follow}" title="Follow the aircraft" aria-label="Follow the aircraft">${ICON.follow}</button>
          <span class="nav-tool-gap" aria-hidden="true"></span>
          <button class="nav-tool" type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
          <button class="nav-tool" type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>
          <button class="nav-tool" type="button" data-fit title="Fit the route" aria-label="Fit the route">${ICON.fit}</button>
          <span class="nav-tool-gap" aria-hidden="true"></span>
          <button class="nav-tool" type="button" data-chart title="Day or night chart" aria-label="Day or night chart">${ICON.chart}</button>
          <button class="nav-tool" type="button" data-panel aria-pressed="${panelOpen}" title="Route panel" aria-label="Route panel">${ICON.panel}</button>
        </div>

        <div class="map-tele" id="nav-tele" aria-label="Live telemetry"></div>

        <aside class="nav-panel" id="nav-panel" aria-label="Planned route" ${panelOpen ? '' : 'hidden'}>
          <header class="nav-panel-head">
            <b>Route</b>
            <span id="nav-count" class="nav-panel-count"></span>
            <button class="nav-panel-close" type="button" data-panel-close aria-label="Hide the route panel">${ICON.close}</button>
          </header>
          <div class="nav-summary" id="nav-summary"></div>
          <div class="nav-detail" id="nav-detail" hidden></div>
          <ol class="nav-list" id="nav-list"></ol>
        </aside>
      </div>
      <!-- The progress bar is a bar under the chart, not an overlay: the chart's
           own attribution stays visible at the bottom of the canvas. -->
      <div class="map-foot">
        <div class="map-strip" id="nav-strip"></div>
        <p class="map-credit">© Esri, HERE, Garmin · © OpenStreetMap contributors · route geometry from the loaded plan</p>
      </div>
    </div>`;

  const el = {
    route: root.querySelector('#nav-route'),
    sub: root.querySelector('#nav-sub'),
    phase: root.querySelector('#nav-phase'),
    conn: root.querySelector('#nav-conn'),
    banner: root.querySelector('#nav-banner'),
    tele: root.querySelector('#nav-tele'),
    panel: root.querySelector('#nav-panel'),
    count: root.querySelector('#nav-count'),
    summary: root.querySelector('#nav-summary'),
    detail: root.querySelector('#nav-detail'),
    list: root.querySelector('#nav-list'),
    strip: root.querySelector('#nav-strip'),
    canvas: root.querySelector('#nav-canvas'),
  };

  const accentNow = () => getComputedStyle(document.documentElement).getPropertyValue('--efb-accent').trim() || '#22d3ee';

  try {
    map = new MiniMap(el.canvas, {
      layers: { tiles: true, route: route.length > 1, track: true, traffic: false },
      // Chart conventions for this page only: the tracker's own maps keep the
      // compact marker and a plain plan line.
      routeStyle: 'nav',
      accent: accentNow(),
      // Night chart by default, because the bag is a dark interface; the chart
      // control switches to the published light canvas.
      chartTheme,
      tint: chartTheme === 'night' ? 'rgba(6, 10, 18, .42)' : null,
      ownSymbol: 'aircraft',
      pannable: true,
      // The credit is permanent in the footer under the chart, so the canvas
      // does not draw a second, overlapping copy of it.
      attribution: false,
      onSelect: hit => {
        if (!hit) { select(null); return; }
        if (hit.kind === 'waypoint') select({ type: 'wp', index: hit.index });
        else if (hit.kind === 'segment') select({ type: 'leg', index: hit.index });
      },
      onViewChange: view => {
        if (view && (view.pan || view.center || view.zoom)) setFollow(false);
      },
    });
    if (route.length) map.setRoute(route.map(point => ({ ...point })));
    map.setFollow(follow);
  } catch (error) {
    root.querySelector('.nav-view').insertAdjacentHTML('beforeend',
      `<div class="map-banner bad">The map could not start: ${esc(error.message)}</div>`);
    map = null;
  }

  /* ── header, chips and messages ───────────────────────────────────────── */

  /**
   * What the chart is drawing. A route built in the Flight Plan app carries the
   * plan it came from in the shared record, so the route describes itself — its
   * airports, its procedures, its cruise. The SimBrief plan supplies the callsign
   * and the aircraft, and only while that plan is this route's own city pair: a
   * plan left loaded from an earlier flight is never mixed into this one's
   * summary, and the chart is never labelled with the wrong airports.
   */
  function flightParts() {
    const ofp = plan && plan.ofp;
    const meta = loadRouteMeta();
    const own = meta.plan || null;

    if (!own) {
      if (!ofp) return null;
      return {
        origin: (ofp.origin && ofp.origin.icao) || '',
        destination: (ofp.destination && ofp.destination.icao) || '',
        alternate: (ofp.alternate && ofp.alternate.icao) || '',
        callsign: (ofp.flight && ofp.flight.callsign) || '',
        aircraft: (ofp.aircraft && (ofp.aircraft.icao || ofp.aircraft.type)) || '',
        cruise: ofp.flight && ofp.flight.cruiseFt ? fmtFl(ofp.flight.cruiseFt) : '',
        plannedNm: Number.isFinite(Number(ofp.distanceNm)) ? Math.round(Number(ofp.distanceNm)) : null,
        sid: (ofp.origin && ofp.origin.sid) || '',
        star: (ofp.destination && ofp.destination.star) || '',
      };
    }

    const origin = (own.origin && own.origin.id) || '';
    const destination = (own.destination && own.destination.id) || '';
    const sameFlight = Boolean(ofp && origin && destination
      && ((ofp.origin && ofp.origin.icao) || '') === origin
      && ((ofp.destination && ofp.destination.icao) || '') === destination);
    const procedureLabel = entry => (entry && (entry.label || entry.id)) || '';
    return {
      origin,
      destination,
      alternate: (own.alternate && own.alternate.id) || (sameFlight && ofp.alternate ? ofp.alternate.icao : '') || '',
      callsign: sameFlight ? (ofp.flight && ofp.flight.callsign) || '' : '',
      aircraft: sameFlight ? (ofp.aircraft && (ofp.aircraft.icao || ofp.aircraft.type)) || '' : '',
      cruise: meta.cruiseAlt ? fmtFl(meta.cruiseAlt) : (sameFlight && ofp.flight && ofp.flight.cruiseFt ? fmtFl(ofp.flight.cruiseFt) : ''),
      plannedNm: sameFlight && Number.isFinite(Number(ofp.distanceNm)) ? Math.round(Number(ofp.distanceNm)) : null,
      sid: procedureLabel(own.sid),
      star: procedureLabel(own.star),
    };
  }

  function renderHeader() {
    const parts = flightParts();
    el.route.innerHTML = parts && (parts.origin || parts.destination)
      ? `${esc(parts.origin || '????')}<s>→</s>${esc(parts.destination || '????')}`
      : '<span class="map-route-empty">No flight plan</span>';
    const sub = parts
      ? [parts.callsign, parts.aircraft, parts.cruise ? `CRZ ${parts.cruise}` : '', parts.alternate ? `ALTN ${parts.alternate}` : '']
        .filter(Boolean)
      : [];
    el.sub.textContent = sub.length
      ? sub.join(' · ')
      : (route.length > 1 ? 'Route loaded without a SimBrief plan' : 'Load a SimBrief plan for the route; the aircraft is tracked without one');
  }

  function renderBanner() {
    if (status.status === 'live') {
      el.banner.innerHTML = '';
      el.banner.hidden = true;
      return;
    }
    el.banner.hidden = false;
    const message = status.status === 'connecting'
      ? 'Connecting to the simulator…'
      : status.status === 'waiting'
        ? 'The bridge is running but no simulator telemetry has arrived yet.'
        : 'The simulator is offline. The last position is cleared rather than shown as live.';
    el.banner.innerHTML = `<div class="map-banner-card ${status.status === 'offline' ? 'warn' : ''}">
      <span class="map-banner-text"><b>${esc(connectionText(status.status))}</b> — ${esc(status.detail || message)}</span>
      <button class="map-banner-btn" type="button" data-retry>Retry</button>
    </div>`;
    el.banner.querySelector('[data-retry]')?.addEventListener('click', () => ensureLive());
  }

  function renderConnection() {
    const state = status.status === 'live' ? 'live' : status.status === 'offline' ? 'offline' : 'connecting';
    el.conn.dataset.state = state;
    el.conn.textContent = status.status === 'live' ? 'Connected' : status.status === 'offline' ? 'Offline' : 'Waiting';
  }

  /* ── numbers ─────────────────────────────────────────────────────────── */

  function numbers(message) {
    const t = message && message.telemetry;
    if (!t) return null;
    const progress = route.length > 1 ? routeProgress(route, t) : null;
    let next = null;
    let nextNm = null;
    if (progress && progress.legIndex > 0 && progress.legIndex < route.length) {
      next = route[progress.legIndex];
      if (next) nextNm = distanceNm(t, next);
    }
    const remaining = progress ? progress.remainingNm : (route.length > 1 ? distanceNm(t, route[route.length - 1]) : null);
    const eteMin = remaining != null && t.gs > 30 ? (remaining / t.gs) * 60 : null;
    return { t, progress, next, nextNm, remaining, eteMin };
  }

  /** Which waypoint the aircraft has crossed, and which one it is heading for. */
  function routeStateFor(message) {
    const n = numbers(message);
    if (!n || !n.progress) return null;
    const legIndex = Number(n.progress.legIndex);
    if (!Number.isFinite(legIndex) || legIndex < 1) return null;
    return { passedIndex: legIndex - 1, nextIndex: legIndex };
  }

  function block(label, value, unit, sub) {
    return `<div class="map-block">
      <em>${esc(label)}</em>
      <b>${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</b>
      ${sub ? `<span>${esc(sub)}</span>` : ''}
    </div>`;
  }

  function renderTelemetry(message) {
    const n = numbers(message);
    if (!n) {
      el.tele.classList.add('is-empty');
      el.tele.innerHTML = `<div class="map-empty">
        <b>No telemetry</b>
        <span>Altitude, speed and vertical speed appear here as soon as the bridge reports a position.</span>
      </div>`;
      return;
    }
    el.tele.classList.remove('is-empty');
    const { t } = n;
    const fuel = Number(t.fuel);
    el.tele.innerHTML = [
      block('Altitude', fmtFl(t.alt), '', t.agl != null ? `${fmtFt(t.agl)} AGL` : 'barometric'),
      block('Ground speed', fmtKt(t.gs), '', Number.isFinite(Number(t.hdg)) ? `hdg ${String(Math.round(t.hdg)).padStart(3, '0')}°` : 'simulator'),
      block('Vertical speed', `${t.vs > 0 ? '+' : t.vs < 0 ? '−' : ''}${Math.abs(Math.round(t.vs / 10) * 10)}`, 'fpm', TREND(t.vs)),
      block('Fuel on board', Number.isFinite(fuel) && fuel > 0 ? fmtNum(fuel) : '—', '', Number.isFinite(fuel) && fuel > 0 ? 'reported' : 'not reported'),
    ].join('');
  }

  function renderStrip(message) {
    const n = numbers(message);
    const hasRoute = route.length > 1;
    if (!n || !n.progress) {
      el.strip.innerHTML = `<div class="map-strip-row">
        <span class="map-strip-note">${hasRoute
          ? `${route.length} route points loaded — progress appears with a position.`
          : 'No route loaded. The aircraft is still tracked on the map.'}</span>
        <span class="map-strip-actions">
          <button class="map-strip-btn" type="button" data-go="briefing">${plan && plan.ofp ? 'Flight plan' : 'Import plan'}</button>
        </span>
      </div>`;
      wireStrip();
      return;
    }
    const { progress, remaining, eteMin, next, nextNm } = n;
    const percent = Math.max(0, Math.min(100, (progress.flownNm / (progress.totalNm || 1)) * 100));
    el.strip.innerHTML = `<div class="map-progress"><b style="width:${percent.toFixed(1)}%"></b></div>
      <div class="map-strip-row">
        <span class="map-strip-facts">
          <span><em>Next</em><b>${next ? esc(next.id) : '—'}</b>${nextNm != null ? `<i>${fmtNum(nextNm, 1)} nm</i>` : ''}</span>
          <span><em>Remaining</em><b>${remaining != null ? `${fmtNum(remaining, 0)} nm` : '—'}</b></span>
          <span><em>ETA</em><b>${eteMin != null ? esc(clockAfter(eteMin)) : '—'}</b>${eteMin != null ? `<i>${fmtMinutes(eteMin)}</i>` : ''}</span>
          <span><em>Flown</em><b>${percent.toFixed(0)}%</b><i>${progress.onRoute ? 'on route' : 'off route'}</i></span>
        </span>
        <span class="map-strip-actions">
          <button class="map-strip-btn" type="button" data-go="briefing">OFP</button>
        </span>
      </div>`;
    wireStrip();
  }

  function wireStrip() {
    el.strip.querySelectorAll('[data-go]').forEach(button => {
      button.addEventListener('click', () => ctx.go(button.dataset.go));
    });
  }

  /* ── the route panel ─────────────────────────────────────────────────── */

  function renderSummary() {
    const parts = flightParts();
    const totalNm = route.length > 1
      ? route.reduce((sum, point) => sum + (Number(point.legNm) || 0), 0)
      : null;
    const rows = [];
    if (parts) {
      if (parts.origin || parts.destination) rows.push(['Airports', `${parts.origin || '????'} → ${parts.destination || '????'}`]);
      if (parts.sid || parts.star) rows.push(['Procedures', [parts.sid, parts.star].filter(Boolean).join(' · ')]);
      if (parts.cruise) rows.push(['Cruise', parts.cruise]);
      if (parts.aircraft) rows.push(['Aircraft', parts.aircraft]);
      if (parts.plannedNm) rows.push(['Planned', `${fmtNum(parts.plannedNm, 0)} nm`]);
    }
    if (totalNm != null) rows.push(['Route', `${fmtNum(totalNm, 0)} nm · ${route.length} points`]);
    if (!rows.length) {
      el.summary.innerHTML = `<p class="nav-empty">No route yet. Import a SimBrief plan, or build one in the Flight Deck, and the waypoints appear here.</p>
        <button class="e-btn small" type="button" data-go="briefing">Open Flight Plan</button>`;
    } else {
      el.summary.innerHTML = `<dl class="nav-facts">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
    }
    el.summary.querySelectorAll('[data-go]').forEach(button => {
      button.addEventListener('click', () => ctx.go(button.dataset.go));
    });
  }

  function selectionInfo() {
    if (!selection) return null;
    if (selection.type === 'wp') {
      const point = route[selection.index];
      if (!point) return null;
      return { type: 'wp', point, index: selection.index };
    }
    const from = route[selection.index];
    const to = route[selection.index + 1];
    if (!from || !to) return null;
    return { type: 'leg', from, to, index: selection.index };
  }

  function renderDetail(message) {
    const info = selectionInfo();
    el.detail.hidden = !info;
    if (!info) return;
    const n = numbers(message);
    const state = stateNow;
    if (info.type === 'wp') {
      const { point } = info;
      const flown = state && info.index < state.passedIndex;
      const next = state && info.index === state.nextIndex;
      const rows = [
        ['Type', kindLabel(point.kind)],
        ['Position', formatCoords(point.lat, point.lon)],
        ['Planned level', Number.isFinite(Number(point.altFt)) && Number(point.altFt) > 0 ? fmtFl(point.altFt) : 'not in the plan'],
      ];
      if (Number.isFinite(Number(point.legNm))) {
        rows.push(['To next', `${fmtNum(point.legNm, 0)} nm · ${String(Math.round(point.legTrack)).padStart(3, '0')}°`]);
      }
      if (state) rows.push(['Progress', next ? 'Next waypoint' : flown ? 'Passed' : 'Upcoming']);
      if (n && info.index === route.length - 1) rows.push(['To run', `${fmtNum(distanceNm(n.t, point), 0)} nm`]);
      el.detail.innerHTML = `<div class="nav-detail-head">
          <b>${info.index + 1}. ${esc(point.id)}</b>
          <span>${esc(point.name && point.name !== point.id ? point.name : kindLabel(point.kind))}</span>
        </div>
        <dl class="nav-facts">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
        <button class="e-btn small ghost" type="button" data-centre>Centre on chart</button>`;
      el.detail.querySelector('[data-centre]').addEventListener('click', () => map?.centerOn(point.lat, point.lon, 8));
      return;
    }
    const { from, to } = info;
    const nm = distanceNm(from, to);
    const track = bearingDeg(from, to);
    const rows = [
      ['From', `${from.id} · ${formatCoords(from.lat, from.lon)}`],
      ['To', `${to.id} · ${formatCoords(to.lat, to.lon)}`],
      ['Distance', `${fmtNum(nm, 1)} nm`],
      ['Initial track', `${String(Math.round(track)).padStart(3, '0')}° true`],
    ];
    if (Number.isFinite(Number(to.altFt)) && Number(to.altFt) > 0) rows.push([`Plan level at ${to.id}`, fmtFl(to.altFt)]);
    if (state) rows.push(['Progress', info.index < state.passedIndex ? 'Flown' : info.index === state.passedIndex ? 'Flying now' : 'Upcoming']);
    el.detail.innerHTML = `<div class="nav-detail-head">
        <b>Leg ${info.index + 1}</b>
        <span>${esc(from.id)} → ${esc(to.id)}</span>
      </div>
      <dl class="nav-facts">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
      <button class="e-btn small ghost" type="button" data-centre>Centre on chart</button>`;
    el.detail.querySelector('[data-centre]').addEventListener('click', () => {
      map?.centerOn((from.lat + to.lat) / 2, (from.lon + to.lon) / 2, 7);
    });
  }

  function renderList(message, force = false) {
    stateNow = routeStateFor(message);
    const selected = selection ? `${selection.type}${selection.index}` : '';
    const key = `${route.length}:${stateNow ? stateNow.nextIndex : -1}:${selected}`;
    // Rebuilding a list of a hundred waypoints once a second would also reset
    // the pilot's scroll position, so it is rebuilt only when it changes.
    if (!force && key === listKey) return;
    listKey = key;
    el.count.textContent = route.length ? `${route.length} points` : '';
    if (!route.length) {
      el.list.innerHTML = '';
      el.detail.hidden = true;
      return;
    }
    const selectedWp = selection && selection.type === 'wp' ? selection.index : null;
    const selectedLeg = selection && selection.type === 'leg' ? selection.index : null;
    const rows = [];
    route.forEach((point, index) => {
      const isNext = stateNow && stateNow.nextIndex === index;
      const isPassed = stateNow && index < stateNow.passedIndex;
      const classes = ['nav-wp'];
      if (index === selectedWp) classes.push('is-selected');
      if (isNext) classes.push('is-next');
      if (isPassed) classes.push('is-passed');
      const alt = Number.isFinite(Number(point.altFt)) && Number(point.altFt) > 0 ? fmtFl(point.altFt) : '—';
      rows.push(`<li class="${classes.join(' ')}" data-wp="${index}">
        <span class="nav-seq">${String(index + 1).padStart(2, '0')}</span>
        <i class="nav-sym" data-kind="${esc(point.kind === 'apt' ? 'apt' : point.kind === 'nav' ? 'nav' : 'fix')}" aria-hidden="true"></i>
        <span class="nav-ident">${esc(point.id)}</span>
        <span class="nav-alt">${esc(alt)}</span>
      </li>`);
      if (Number.isFinite(Number(point.legNm)) && index < route.length - 1) {
        rows.push(`<li class="nav-leg ${index === selectedLeg ? 'is-selected' : ''}" data-leg="${index}">
          <span class="nav-leg-nm">${fmtNum(point.legNm, 0)} nm</span>
          <span class="nav-leg-hdg">${String(Math.round(point.legTrack)).padStart(3, '0')}°</span>
        </li>`);
      }
    });
    el.list.innerHTML = rows.join('');
    el.list.querySelectorAll('[data-wp]').forEach(row => {
      row.addEventListener('click', () => {
        select({ type: 'wp', index: Number(row.dataset.wp) }, { centre: true });
      });
    });
    el.list.querySelectorAll('[data-leg]').forEach(row => {
      row.addEventListener('click', () => {
        select({ type: 'leg', index: Number(row.dataset.leg) }, { centre: true });
      });
    });
  }

  function select(next, options = {}) {
    const same = (selection && next && selection.type === next.type && selection.index === next.index)
      || (!selection && !next);
    selection = next;
    if (map) {
      if (!next) map.setSelection({});
      else if (next.type === 'wp') map.setSelection({ waypointIndex: next.index });
      else map.setSelection({ segmentIndex: next.index });
    }
    // A row already on screen updates in place; the map gets the highlight and
    // only a fresh selection re-renders the panel.
    if (!same) {
      renderList(lastMessage, true);
      renderDetail(lastMessage);
    }
    if (next && options.centre) {
      const point = route[next.index];
      const to = next.type === 'leg' ? route[next.index + 1] : null;
      if (point) map?.centerOn((point.lat + (to ? to.lat : point.lat)) / 2, (point.lon + (to ? to.lon : point.lon)) / 2, next.type === 'leg' ? 7 : 8);
    }
  }

  /* ── view controls ───────────────────────────────────────────────────── */

  function setFollow(on) {
    follow = Boolean(on);
    root.querySelector('[data-follow]')?.setAttribute('aria-pressed', follow ? 'true' : 'false');
    map?.setFollow(follow);
  }

  /* While the route panel is open beside the chart, the route is framed in the
     space the panel leaves rather than behind it. On a phone the panel is a
     sheet over the bottom, so the chart keeps its width. */
  function syncMapInsets() {
    if (!map) return;
    // Only a wide chart is split with the panel: on a tablet the panel would
    // eat most of the width and the route would be fitted to a keyhole.
    const beside = panelOpen && !el.panel.hidden && window.matchMedia('(min-width: 1000px)').matches;
    const clear = beside ? el.panel.getBoundingClientRect().width + 56 : 0;
    map.options.paddingRight = 34 + clear;
    map.draw();
  }

  function setPanel(open) {
    panelOpen = Boolean(open);
    el.panel.hidden = !panelOpen;
    root.querySelector('[data-panel]')?.setAttribute('aria-pressed', panelOpen ? 'true' : 'false');
    if (panelOpen) {
      renderList(lastMessage);
      renderDetail(lastMessage);
    }
    syncMapInsets();
  }

  function setChartTheme(theme) {
    chartTheme = theme === 'day' ? 'day' : 'night';
    ctx.setPrefs({ chartTheme });
    if (map) {
      map.options.chartTheme = chartTheme;
      map.options.tint = chartTheme === 'night' ? 'rgba(6, 10, 18, .42)' : null;
      map.draw();
    }
    root.querySelector('[data-chart]')?.setAttribute('aria-pressed', chartTheme === 'day' ? 'true' : 'false');
  }

  root.querySelector('[data-follow]')?.addEventListener('click', () => setFollow(!follow));
  root.querySelectorAll('[data-zoom]').forEach(button => {
    button.addEventListener('click', () => map?.zoomBy(button.dataset.zoom === 'in' ? 1 : -1));
  });
  root.querySelector('[data-fit]')?.addEventListener('click', () => {
    setFollow(false);
    map?.fitRoute();
  });
  root.querySelector('[data-panel]')?.addEventListener('click', () => setPanel(!panelOpen));
  root.querySelector('[data-panel-close]')?.addEventListener('click', () => setPanel(false));
  root.querySelector('[data-chart]')?.addEventListener('click', () => setChartTheme(chartTheme === 'night' ? 'day' : 'night'));
  const onResize = () => syncMapInsets();
  window.addEventListener('resize', onResize);

  /* ── live data ───────────────────────────────────────────────────────── */

  function update(message) {
    if (destroyed) return;
    lastMessage = message;
    const t = message && message.telemetry;
    const flight = message && (message.currentFlight || message.flight);
    const phase = t ? flightPhase(message) : null;
    el.phase.textContent = phase ? phase.label : 'No telemetry';
    el.phase.dataset.phase = phase ? phase.code : '';
    el.phase.title = phase && phase.derived ? 'Phase read from the current position' : 'Phase reported by the bridge';
    el.phase.className = `map-chip ${t ? 'is-live' : ''}`.trim();

    renderTelemetry(message);
    renderStrip(message);
    renderList(message);
    renderDetail(message);

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
      const lastDrawn = drawnTrack.length ? drawnTrack[drawnTrack.length - 1] : null;
      const lastStamp = Number(lastDrawn && lastDrawn.t);
      if (drawnTrack.length && Number.isFinite(lastStamp)) {
        // Only points recorded after the last one drawn are appended. The
        // bridge repeats its whole track in every snapshot, so appending the
        // snapshot would stack thousands of copies of the same path on the map.
        let cursor = lastDrawn;
        let cursorStamp = lastStamp;
        for (const point of track) {
          const stampT = Number(point.t);
          if (Number.isFinite(stampT) && stampT <= cursorStamp) continue;
          if (cursor && Math.abs(cursor.lat - point.lat) + Math.abs(cursor.lon - point.lon) < 1e-5) continue;
          drawnTrack.push(point);
          cursor = point;
          if (Number.isFinite(stampT)) cursorStamp = stampT;
        }
        if (drawnTrack.length > 6000) drawnTrack.splice(0, drawnTrack.length - 6000);
        map.setTrack(drawnTrack);
      } else {
        // No timestamps to compare: the snapshot is the authority.
        drawnTrack = track.slice();
        map.setTrack(drawnTrack);
      }
    }
    if (t) {
      map.options.ownLabel = `${fmtFl(t.alt)} ${TREND(t.vs) === 'climbing' ? '▲' : TREND(t.vs) === 'descending' ? '▼' : ''}`.trim();
      map.setPosition({ lat: t.lat, lon: t.lon, alt: t.alt }, t.hdg);
      map.setRouteState(stateNow);
    }
  }

  const off = onLive(next => {
    status = next;
    renderBanner();
    renderConnection();
    if (next.status === 'live' && next.snapshot) update(next.snapshot);
    if (next.status !== 'live') {
      lastMessage = null;
      stateNow = null;
      map?.setPosition(null);
      map?.setRouteState(null);
      renderTelemetry(null);
      renderStrip(null);
      renderList(null);
      renderDetail(null);
      el.phase.textContent = 'No telemetry';
      el.phase.className = 'map-chip';
      el.phase.dataset.phase = '';
    }
  });

  /* A plan imported while the chart is open replaces the route it is drawing. */
  const offPlan = onPlanChange(next => {
    plan = next;
    const stored = loadRoute();
    const points = stored.length ? stored : plannedRouteFromOfp(plan && plan.ofp);
    if (!points.length) { renderHeader(); renderSummary(); return; }
    route = withLegs(points);
    selection = null;
    stateNow = null;
    map?.setSelection({});
    map?.setRoute(route.map(point => ({ ...point })));
    map?.setLayers({ route: route.length > 1 });
    renderHeader();
    renderSummary();
    renderList(lastMessage);
    renderDetail(lastMessage);
  });

  // The route may arrive from another app while this page is mounted; the
  // accent follows an airline change without a reload.
  const onAirline = () => {
    if (map) { map.options.accent = accentNow(); map.draw(); }
  };
  window.addEventListener('stratos:efb-airline', onAirline);

  renderHeader();
  renderSummary();
  renderList(null);
  renderDetail(null);
  renderBanner();
  renderConnection();
  renderTelemetry(null);
  renderStrip(null);
  root.querySelector('[data-chart]')?.setAttribute('aria-pressed', chartTheme === 'day' ? 'true' : 'false');
  syncMapInsets();

  return {
    destroy() {
      destroyed = true;
      document.body.classList.remove('view-map', 'view-nav');
      off();
      offPlan();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('stratos:efb-airline', onAirline);
      if (map) { try { map.destroy(); } catch (_) { /* gone */ } map = null; }
    },
  };
}
