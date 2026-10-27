/* Stratos EFB — the flight-deck shell.
 *
 * One frame for the whole bag: a top bar that always states the flight and the
 * simulator connection, a section rail, and a single content region that the
 * selected section mounts into. The shell owns routing, preferences, the clock,
 * the flight summary and lazy loading; each section owns its own data and says
 * plainly when a source is unavailable.
 *
 * Nothing here invents data. The flight strip is built from the stored SimBrief
 * plan, the connection chip from the bridge's own status, and a section that
 * cannot reach its source renders its own empty state.
 */

import {
  esc, fmtFl, fmtFt, fmtKt, connectionText, loadPrefs, savePrefs, currentPlan,
  loadRoute, loadRouteMeta, onLive, onPlanChange, DEFAULT_PREFS, flightPhase,
} from './efb/common.js';
import { displayVersion } from './lib/version.js';
import { airlineText, applyAirline, resolveAirline } from './lib/airlines.js';

/* The rail, the router and the page titles all read this one list. */
export const APPS = [
  {
    id: 'navigator', group: 'Flight', name: 'Navigator', title: 'Navigator', subtitle: 'Moving map, planned route and live progress',
    icon: 'navigator', module: './efb/navigator.js',
  },
  {
    id: 'flightplan', group: 'Flight', name: 'Flight Planner', title: 'Flight Plan Builder', subtitle: 'Build the route, apply procedures, plan fuel and send it to the map',
    icon: 'flightplan', module: './efb/flightplan.js',
  },
  {
    id: 'briefing', group: 'Flight', name: 'OFP', title: 'Flight Plan & OFP', subtitle: 'Route, procedures and operational flight plan',
    icon: 'briefing', module: './efb/briefing.js',
  },
  {
    id: 'weather', group: 'Flight', name: 'Weather', title: 'Weather', subtitle: 'METAR, TAF and winds aloft',
    icon: 'weather', module: './efb/weather.js',
  },
  {
    id: 'charts', group: 'Flight', name: 'Charts', title: 'Charts', subtitle: 'Airport and procedure documents',
    icon: 'charts', module: './efb/charts.js',
  },
  {
    id: 'airport', group: 'Flight', name: 'Airports', title: 'Airport Information', subtitle: 'Runways, frequencies and services',
    icon: 'airport', module: './efb/airport.js',
  },
  {
    id: 'performance', group: 'Aircraft', name: 'Performance', title: 'Performance', subtitle: 'Takeoff and landing analysis',
    icon: 'performance', module: './efb/performance.js',
  },
  {
    id: 'weightbalance', group: 'Aircraft', name: 'Weight & Balance', title: 'Weight & Balance', subtitle: 'Loading, centre of gravity and limits',
    icon: 'weightbalance', module: './efb/weightbalance.js',
  },
  {
    id: 'fuel', group: 'Aircraft', name: 'Fuel', title: 'Fuel Planning', subtitle: 'Block fuel and reserves',
    icon: 'fuel', module: './efb/fuel.js',
  },
  {
    id: 'checklists', group: 'Aircraft', name: 'Checklists', title: 'Checklists', subtitle: 'Normal, abnormal and emergency procedures',
    icon: 'checklists', module: './efb/checklists.js',
  },
  {
    id: 'notepad', group: 'Tools', name: 'Notepad', title: 'Notepad', subtitle: 'Typed note, kept on this device',
    icon: 'notepad', module: './efb/notepad.js',
  },
  {
    id: 'logbook', group: 'Records', name: 'Logbook', title: 'Flight Log', subtitle: 'Recorded flights',
    icon: 'logbook', module: './efb/logbook.js',
  },
  {
    id: 'settings', group: 'Records', name: 'Settings', title: 'EFB Settings', subtitle: 'Preferences and connections',
    icon: 'settings', module: './efb/settings.js',
  },
];

const GROUP_ORDER = ['Flight', 'Aircraft', 'Tools', 'Records'];
const HOME_ROUTE = 'home';
const DEFAULT_ROUTE = HOME_ROUTE;

/* The map used to be called Live, and Map after that. A bookmarked or installed
   link still lands on Navigator instead of the deck. */
const LEGACY_ROUTES = { live: 'navigator', map: 'navigator' };

/* The dock: the five apps a pilot reaches for without thinking. Everything else
   is one tap away on the deck, and Settings also sits in the header. */
const DOCK = ['navigator', 'flightplan', 'briefing', 'charts', 'checklists'];

/* One solid tone for every tile, so the deck reads as an operating system
   rather than a colour-coded list. The glyph is what identifies the app.
   Line icons only, one stroke weight, on a 24-unit grid — the same set the rest
   of the bag draws with, so no page mixes styles. */
const ICONS = {
  // Navigator: a compass rose over a planned track, not a generic pin.
  navigator: '<circle cx="12" cy="12" r="8.6"/><path d="M12 6.6v2.2M12 15.2v2.2M6.6 12h2.2M15.2 12h2.2"/><path d="m14.9 9.1-1.6 4.2-4.2 1.6 1.6-4.2z"/>',
  briefing: '<path d="M7 4.5h7.5L19 9v10.5H7z"/><path d="M14.3 4.6V9H19"/><path d="M9.6 12.4h6M9.6 15.2h6M9.6 17.6h3.8"/><path d="M4.2 7.2v12.3h10.4"/>',
  // A planned track between two fixes, with the turns a route makes.
  flightplan: '<circle cx="5.6" cy="18.4" r="2"/><circle cx="18.4" cy="5.6" r="2"/><path d="M7.1 17.1 10 13.7l3.2 1.4 3.7-6.6"/>',
  weather: '<path d="M7.6 10.4a3.4 3.4 0 0 1 6.6-.9 3 3 0 0 1 4 2.9 3 3 0 0 1-3 3H8.6a2.6 2.6 0 0 1-1-5z"/><path d="M3.5 5.5h4.2M2.5 9h3.4M16.6 5h4.2"/>',
  charts: '<path d="M4 6.3 9.3 4l5.4 2.3L20 4v13.7L14.7 20l-5.4-2.3L4 20z"/><path d="M9.3 4v13.7M14.7 6.3V20"/>',
  airport: '<path d="M7 20V8.4l5-2.4 5 2.4V20"/><path d="M4.5 20h15"/><path d="M9.6 11.2h4.8M9.6 14.4h4.8M9.6 17.6h4.8"/><path d="M12 3v3"/>',
  performance: '<path d="M3.6 17a8.4 8.4 0 1 1 16.8 0"/><path d="M12 17 16 9.6"/><circle cx="12" cy="17" r="1.5"/><path d="M3.6 17h2.2M18.2 17h2.2"/>',
  weightbalance: '<path d="M12 4v16"/><path d="M5 7h14"/><path d="M9 7 6.4 12.4a2.7 2.7 0 0 0 5.2 0z"/><path d="M15 7l-2.6 5.4a2.7 2.7 0 0 0 5.2 0z"/><path d="M8 20h8"/>',
  fuel: '<path d="M6 20V5.5h7V20"/><path d="M6 9.2h7"/><path d="M13 12h2.4a1.8 1.8 0 0 1 1.8 1.8v3.4a1.2 1.2 0 0 0 2.4 0V9.6l-2.2-2.2"/><path d="M4.6 20h9.8"/>',
  checklists: '<path d="M9 4.8h6v2.4H9z"/><path d="M15 6h2.4A1.6 1.6 0 0 1 19 7.6v11.8H5V7.6A1.6 1.6 0 0 1 6.6 6H9"/><path d="m8.6 12.4 1.9 1.9 4-4.1"/><path d="M8.6 17.2h6.8"/>',
  notepad: '<path d="M4.8 19.2h4.4L19 9.4l-4.4-4.4L4.8 14.8z"/><path d="m13.4 6.2 4.4 4.4"/><path d="M4.8 19.2 8 18.6"/>',
  home: '<path d="M4.2 10.6 12 4.2l7.8 6.4V20H4.2z"/><path d="M9.6 20v-5.6h4.8V20"/>',
  logbook: '<path d="M6 4.5h11.4A1.6 1.6 0 0 1 19 6.1v13.4H7.6A2.1 2.1 0 0 1 5.5 17.4V6a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M9 8h6.4M9 11.2h4.4"/><path d="M5.6 17.2h13.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1"/>',
  external: '<path d="M13 5h6v6"/><path d="m11.6 12.4 7.1-7.1"/><path d="M17 14v4.4H5.6V7H10"/>',
};

export function icon(name, size = 16) {
  const body = ICONS[name] || ICONS.settings;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* ── shell state ─────────────────────────────────────────────────────── */

const state = {
  prefs: loadPrefs(),
  app: null,
  cleanup: null,
  plan: null,
  route: [],
  live: null,
  liveCallsign: '',
  airline: null,
  clockTimer: null,
  unsubLive: null,
};

const dom = {};

function applyPreferences() {
  state.prefs = state.prefs || loadPrefs();
  document.body.dataset.wall = state.prefs.wallpaper || DEFAULT_PREFS.wallpaper;
  document.documentElement.dataset.efbMotion = state.prefs.motion === 'reduced' ? 'reduced' : 'full';
  applyAirlineState();
}

/*
 * Branding is resolved, not stored as colours: the preference says whether the
 * airline comes from the plan or from a manual choice, and this turns that into
 * the accent tokens the whole bag reads, the mark in the header and the wordmark
 * on the deck. A resolved airline is always a record from the airline table, or
 * none at all — never a name invented from a three-letter string.
 */
function applyAirlineState() {
  const resolved = resolveAirline(state.prefs, state.plan, state.liveCallsign);
  state.airline = resolved;
  applyAirline(resolved.airline);
  renderAirlineMark(resolved);
  window.dispatchEvent(new CustomEvent('stratos:efb-airline', { detail: resolved }));
}

function renderAirlineMark(resolved) {
  const air = resolved && resolved.airline;
  const detected = resolved && resolved.source === 'manual' ? 'Selected airline' : 'Detected airline';
  if (dom.airline) {
    dom.airline.hidden = !air;
    dom.airline.innerHTML = air
      ? `${air.logo
          ? `<img class="et-logo" src="${esc(air.logo)}" alt="" width="84" height="16">`
          : `<b>${esc(airlineText(air))}</b>`}<span>${esc(air.name)}</span>`
      : '';
    dom.airline.title = air
      ? `${detected}: ${air.name} (${air.icao})${resolved.detected && resolved.detected.callsign ? ` · callsign ${resolved.detected.callsign}` : ''}`
      : '';
  }
  if (dom.homeAirline) {
    dom.homeAirline.hidden = !air;
    dom.homeAirline.innerHTML = air
      ? `<b>${esc(air.name)}</b><span>${esc(air.icao)}${air.iata ? ` · ${esc(air.iata)}` : ''}</span>`
      : '';
  }
  renderBrandMark(air);
}

/*
 * The operator's mark sits behind the deck, the way a crew tablet's wallpaper
 * carries the airline. When the app ships a licensed file for that operator the
 * real mark is drawn, masked into the airline's accent and faded into the
 * wallpaper; without one, the airline's own code is set in a roundel. Nothing
 * here draws an imitation of a logo, and the house theme gets no mark at all.
 */
function renderBrandMark(air) {
  if (!dom.brand) return;
  const on = Boolean(air && !air.house);
  dom.brand.classList.toggle('is-on', on);
  if (!on) { dom.brand.innerHTML = ''; return; }
  dom.brand.innerHTML = air.logo
    ? `<span class="hb-mark hb-logo" style="--brand-logo:url('${esc(air.logo)}')"></span>`
    : `<span class="hb-mark hb-roundel"><span class="hb-code">${esc(airlineText(air))}</span></span>`;
}

/* ── navigation ──────────────────────────────────────────────────────── */

function renderNav() {
  if (!dom.nav) return;
  const groups = GROUP_ORDER
    .map(group => ({ group, apps: APPS.filter(app => app.group === group) }))
    .filter(entry => entry.apps.length);
  dom.nav.innerHTML = `
    <a class="en-home" href="#/${HOME_ROUTE}" data-home title="EFB home screen">
      <span class="en-icon">${icon('home', 15)}</span><span class="en-label">Home</span>
    </a>
    ${groups.map(entry => `
    <div class="en-group">
      <div class="en-group-head">${esc(entry.group)}</div>
      ${entry.apps.map(app => `
        <a class="en-item" href="#/${esc(app.id)}" data-app="${esc(app.id)}" title="${esc(app.title)}">
          <span class="en-icon">${icon(app.icon, 15)}</span>
          <span class="en-label">${esc(app.name)}</span>
        </a>`).join('')}
    </div>`).join('')}
    <div class="en-foot">
      <span>Stratos EFB <b>${esc(displayVersion())}</b></span>
      <span class="en-foot-note">Simulator use only · not for real-world navigation</span>
    </div>`;
}

/* The rail is a horizontal scroller on a tablet. Without an edge hint the last
   sections look absent rather than off-screen, so the fade follows the scroll
   position instead of always fading the final item. */
function syncNavFade() {
  if (!dom.nav) return;
  const more = dom.nav.scrollLeft + dom.nav.clientWidth < dom.nav.scrollWidth - 4;
  const back = dom.nav.scrollLeft > 4;
  dom.nav.classList.toggle('is-more', more);
  dom.nav.classList.toggle('is-back', back);
}

function markActive(id) {
  if (!dom.nav) return;
  for (const item of dom.nav.querySelectorAll('[data-app]')) {
    const active = item.dataset.app === id;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  const home = dom.nav.querySelector('[data-home]');
  if (home) {
    const active = id === HOME_ROUTE;
    home.classList.toggle('is-active', active);
    if (active) home.setAttribute('aria-current', 'page');
    else home.removeAttribute('aria-current');
  }
}

/* ── home screen ─────────────────────────────────────────────────────── */

function tileMarkup(app, size = 30) {
  return `<a class="hi" href="#/${esc(app.id)}" data-open="${esc(app.id)}">
    <span class="hi-tile">${icon(app.icon, size)}</span>
    <span class="hi-label">${esc(app.name)}</span>
  </a>`;
}

function renderHome() {
  if (!dom.homeGrid) return;
  dom.homeGrid.innerHTML = APPS.map(app => tileMarkup(app)).join('');
  const dockApps = DOCK.map(id => APPS.find(app => app.id === id)).filter(Boolean);
  if (dom.homeDock) dom.homeDock.innerHTML = dockApps.map(app => tileMarkup(app, 26)).join('');
}

/* The deck widget: route from the stored plan, numbers from the same bridge
   stream the Map app reads. Nothing is held on screen after the feed stops. */
function syncHomeWidget(status = state.live) {
  if (!dom.homeWidget) return;
  const parts = flightParts(state.plan);
  const snapshot = status && status.status === 'live' ? status.snapshot : null;
  const t = snapshot && snapshot.telemetry;

  if (dom.hwRoute) {
    dom.hwRoute.innerHTML = parts && (parts.origin || parts.destination)
      ? `${esc(parts.origin || '????')}<s>→</s>${esc(parts.destination || '????')}`
      : 'No flight plan loaded';
    dom.hwRoute.classList.toggle('is-empty', !(parts && (parts.origin || parts.destination)));
  }
  if (dom.hwMeta) {
    const meta = parts
      ? [parts.callsign, parts.aircraft, parts.cruise ? `CRZ ${parts.cruise}` : ''].filter(Boolean)
      : [];
    dom.hwMeta.textContent = meta.length
      ? meta.join(' · ')
      : 'Import a SimBrief plan to show the route here';
  }
  if (dom.hwPhase) {
    // Phase comes from the recorded flight when the bridge has one, otherwise
    // from the position itself; the title says which, so a derived phase is
    // never mistaken for something the aircraft reported.
    const phase = t ? flightPhase(snapshot) : null;
    dom.hwPhase.hidden = !phase;
    dom.hwPhase.textContent = phase ? phase.label : '';
    dom.hwPhase.dataset.phase = phase ? phase.code : '';
    dom.hwPhase.title = phase
      ? (phase.derived ? 'Phase read from the current position' : 'Phase reported by the bridge')
      : '';
  }
  if (dom.hwState) {
    const name = !status ? 'offline' : status.status === 'live' ? 'live' : status.status === 'offline' ? 'offline' : 'connecting';
    dom.hwState.dataset.state = name;
    const label = dom.hwState.querySelector('span');
    if (label) label.textContent = !status ? 'Offline' : status.status === 'live' ? 'Connected' : status.status === 'offline' ? 'Offline' : 'Waiting';
  }
  if (!dom.hwTele) return;
  if (t) {
    const vs = Number(t.vs);
    const vsText = Number.isFinite(vs) ? `${vs > 0 ? '+' : vs < 0 ? '−' : ''}${Math.abs(Math.round(vs / 10) * 10)}` : '—';
    const trend = Number.isFinite(vs) && vs > 200 ? 'climb' : Number.isFinite(vs) && vs < -200 ? 'descent' : 'level';
    dom.hwTele.innerHTML = `
      <span class="hw-cell"><em>Altitude</em><b>${esc(fmtFl(t.alt))}</b>${t.agl != null ? `<small>${esc(fmtFt(t.agl))} AGL</small>` : ''}</span>
      <span class="hw-cell"><em>Ground speed</em><b>${esc(fmtKt(t.gs))}</b>${Number.isFinite(Number(t.hdg)) ? `<small>hdg ${String(Math.round(t.hdg)).padStart(3, '0')}°</small>` : ''}</span>
      <span class="hw-cell"><em>Vertical speed</em><b>${esc(vsText)}<small class="hw-unit"> fpm</small></b><small>${esc(trend)}</small></span>`;
    return;
  }
  const reason = status && status.status === 'offline'
    ? 'The simulator is offline. Open the map for the connection details.'
    : status && status.status === 'waiting'
      ? 'The bridge is up; no simulator telemetry is arriving yet.'
      : 'Waiting for the simulator. Open the map to connect.';
  dom.hwTele.innerHTML = `<span class="hw-hint">${esc(reason)}</span>`;
}

function syncHomeBar() {
  if (dom.homeFlight) {
    const parts = flightParts(state.plan);
    dom.homeFlight.innerHTML = parts
      ? `${parts.callsign ? `<b>${esc(parts.callsign)}</b>` : ''}${parts.origin || parts.destination ? `<span>${esc(parts.origin || '????')} → ${esc(parts.destination || '????')}</span>` : ''}${parts.aircraft ? `<span>${esc(parts.aircraft)}</span>` : ''}`
      : '<span class="e-faint">No flight plan loaded</span>';
  }
  if (dom.homeDate) {
    dom.homeDate.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
  }
  if (dom.homeConn) {
    const live = dom.conn ? dom.conn.dataset.state : 'offline';
    dom.homeConn.dataset.state = live;
    const label = dom.homeConn.querySelector('span');
    if (label) label.textContent = live === 'live' ? 'Connected' : live === 'connecting' ? 'Waiting' : 'Offline';
  }
}

function showHome() {
  closeApp();
  state.app = HOME_ROUTE;
  document.body.classList.add('view-home');
  if (dom.home) dom.home.hidden = false;
  markActive(HOME_ROUTE);
  document.title = 'Stratos EFB';
  syncHomeBar();
}

/* ── top bar ─────────────────────────────────────────────────────────── */

/* The flight this bag is showing. A route built in the Flight Plan app carries
   the plan it came from in the shared record, so it names its own airports and
   cruise. The SimBrief plan supplies the callsign and the aircraft, and only
   while that plan is this route's own city pair: a plan left loaded from an
   earlier flight is never read as if it were the route on the chart. */
function flightParts(plan) {
  const ofp = plan && plan.ofp;
  const meta = loadRouteMeta();
  const own = meta.plan || null;
  if (!own) {
    if (!ofp) return null;
    const origin = (ofp.origin && ofp.origin.icao) || '';
    const destination = (ofp.destination && ofp.destination.icao) || '';
    if (!origin && !destination && !(ofp.flight && ofp.flight.callsign)) return null;
    return {
      callsign: (ofp.flight && ofp.flight.callsign) || '',
      origin,
      destination,
      aircraft: (ofp.aircraft && (ofp.aircraft.icao || ofp.aircraft.type)) || '',
      cruise: ofp.flight && ofp.flight.cruiseFt ? fmtFl(ofp.flight.cruiseFt) : '',
      alternate: (ofp.alternate && ofp.alternate.icao) || '',
    };
  }
  const origin = (own.origin && own.origin.id) || '';
  const destination = (own.destination && own.destination.id) || '';
  if (!origin && !destination) return null;
  const sameFlight = Boolean(ofp && origin && destination
    && ((ofp.origin && ofp.origin.icao) || '') === origin
    && ((ofp.destination && ofp.destination.icao) || '') === destination);
  return {
    callsign: sameFlight ? (ofp.flight && ofp.flight.callsign) || '' : '',
    origin,
    destination,
    aircraft: sameFlight ? (ofp.aircraft && (ofp.aircraft.icao || ofp.aircraft.type)) || '' : '',
    cruise: meta.cruiseAlt ? fmtFl(meta.cruiseAlt) : (sameFlight && ofp.flight && ofp.flight.cruiseFt ? fmtFl(ofp.flight.cruiseFt) : ''),
    alternate: (own.alternate && own.alternate.id) || (sameFlight && ofp.alternate ? ofp.alternate.icao : '') || '',
  };
}

function renderFlightStrip() {
  if (!dom.flight) return;
  const parts = flightParts(state.plan);
  if (!parts) {
    dom.flight.innerHTML = '<span class="et-flight-empty">No flight plan loaded</span>';
    return;
  }
  const meta = [parts.aircraft, parts.cruise ? `CRZ ${parts.cruise}` : '', parts.alternate ? `ALTN ${parts.alternate}` : '']
    .filter(Boolean).join(' · ');
  dom.flight.innerHTML = `
    ${parts.callsign ? `<b class="etf-callsign">${esc(parts.callsign)}</b>` : ''}
    ${parts.origin || parts.destination
      ? `<span class="etf-route">${esc(parts.origin || '????')}<s>→</s>${esc(parts.destination || '????')}</span>`
      : ''}
    ${meta ? `<span class="etf-meta">${esc(meta)}</span>` : ''}`;
}

function setConnection(status) {
  const el = dom.conn;
  if (!el) return;
  const stateName = status.status === 'live' ? 'live' : status.status === 'offline' ? 'offline' : 'connecting';
  el.dataset.state = stateName;
  const label = el.querySelector('span');
  if (label) label.textContent = connectionText(status.status);
  el.title = status.detail || (status.health ? `Bridge ${status.health.version || ''}` : 'Simulator connection');
}

function updateClock() {
  const time = new Date().toISOString().slice(11, 16);
  if (dom.clock) dom.clock.innerHTML = `${time}<small>Z</small>`;
  const home = document.getElementById('home-clock');
  if (home) home.textContent = time;
}

/* ── routing ─────────────────────────────────────────────────────────── */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [id, query] = raw.split('?');
  return { id: id || '', params: new URLSearchParams(query || '') };
}

function setPageHead(app) {
  if (dom.pageTitle) dom.pageTitle.textContent = app.title;
  if (dom.pageSub) dom.pageSub.textContent = app.subtitle || '';
  if (dom.actions) dom.actions.innerHTML = '';
}

export function closeApp() {
  if (state.cleanup) {
    try { state.cleanup(); } catch (_) { /* a section must not block the shell */ }
    state.cleanup = null;
  }
  state.app = null;
  if (dom.body) dom.body.innerHTML = '';
  if (dom.actions) dom.actions.innerHTML = '';
}

async function openApp(id, params = new URLSearchParams()) {
  const app = APPS.find(item => item.id === id) || APPS[0];
  if (state.app === app.id) return;
  closeApp();
  document.body.classList.remove('view-home');
  if (dom.home) dom.home.hidden = true;
  state.app = app.id;
  markActive(app.id);
  setPageHead(app);
  document.title = `${app.title} · Stratos EFB`;
  if (dom.body) dom.body.scrollTop = 0;

  const ctx = {
    params,
    prefs: () => loadPrefs(),
    setPrefs(patch) { state.prefs = savePrefs(patch); applyPreferences(); },
    go(destination, query = {}) {
      const next = new URLSearchParams(query);
      const suffix = next.toString();
      location.hash = `#/${destination}${suffix ? `?${suffix}` : ''}`;
    },
    home: () => { location.hash = `#/${DEFAULT_ROUTE}`; },
    setActions(html) { if (dom.actions) dom.actions.innerHTML = html || ''; },
    setSubtitle(text) { if (dom.pageSub) dom.pageSub.textContent = text || ''; },
    plan: () => state.plan,
    route: () => state.route,
    refreshPlan: async id2 => {
      const { refreshPlan } = await import('./efb/common.js');
      return refreshPlan(id2);
    },
    notify(message, tone = '') {
      if (!dom.body) return;
      const notice = document.createElement('div');
      notice.className = `e-notice ${tone}`.trim();
      notice.textContent = message;
      dom.body.prepend(notice);
      setTimeout(() => notice.remove(), 6000);
    },
  };

  try {
    const module = await import(app.module);
    const result = await module.mount(dom.body, ctx);
    if (result && typeof result.destroy === 'function') state.cleanup = result.destroy;
    if (result && result.actions && dom.actions) dom.actions.innerHTML = result.actions;
  } catch (error) {
    console.error(error);
    dom.body.innerHTML = `<div class="e-notice bad"><div><b>${esc(app.title)} could not start.</b><br>${esc(error.message)}</div></div>
      <div class="e-row" style="margin-top:12px"><button class="e-btn" type="button" data-retry>Retry</button></div>`;
    dom.body.querySelector('[data-retry]')?.addEventListener('click', () => {
      state.app = null;
      closeApp();
      location.hash = `#/${app.id}`;
    });
  }
}

function route() {
  const { id, params } = parseRoute();
  if (!id) {
    history.replaceState(null, '', `#/${HOME_ROUTE}`);
    showHome();
    return;
  }
  if (id === HOME_ROUTE) {
    showHome();
    return;
  }
  if (LEGACY_ROUTES[id]) {
    // Rewrite the address rather than only opening the app, so a reload or a
    // shared link lands on the current name.
    const suffix = params.toString();
    history.replaceState(null, '', `#/${LEGACY_ROUTES[id]}${suffix ? `?${suffix}` : ''}`);
    openApp(LEGACY_ROUTES[id], params);
    return;
  }
  if (!APPS.some(app => app.id === id)) {
    history.replaceState(null, '', `#/${HOME_ROUTE}`);
    showHome();
    return;
  }
  openApp(id, params);
}

/* ── boot ────────────────────────────────────────────────────────────── */

function bindEvents() {
  document.addEventListener('click', event => {
    const open = event.target.closest('[data-app]');
    if (open) {
      // One path for every section: the URL describes the page, and the router
      // mounts it. Selecting the section already on screen changes nothing.
      event.preventDefault();
      const id = open.dataset.app;
      if (state.app !== id) location.hash = `#/${id}`;
    }
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { syncNavFade(); syncHomeBar(); });
  dom.nav?.addEventListener('scroll', syncNavFade, { passive: true });
  document.addEventListener('keydown', event => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (event.key !== 'Escape') return;
    if (typing) { target.blur(); return; }
    // Escape is the keyboard equivalent of the home gesture, except at home.
    if (state.app && state.app !== HOME_ROUTE) location.hash = `#/${HOME_ROUTE}`;
  });
}

export async function boot() {
  dom.nav = document.getElementById('efb-nav');
  dom.body = document.getElementById('efb-body');
  dom.actions = document.getElementById('efb-actions');
  dom.pageTitle = document.getElementById('efb-page-title');
  dom.pageSub = document.getElementById('efb-page-sub');
  dom.flight = document.getElementById('et-flight');
  dom.conn = document.getElementById('esb-conn');
  dom.clock = document.getElementById('esb-clock');
  dom.home = document.getElementById('efb-home');
  dom.homeGrid = document.getElementById('home-grid');
  dom.homeDock = document.getElementById('home-dock');
  dom.homeFlight = document.getElementById('home-flight');
  dom.homeDate = document.getElementById('home-date');
  dom.homeConn = document.getElementById('home-conn');
  dom.homeWidget = document.getElementById('home-widget');
  dom.hwRoute = document.getElementById('hw-route');
  dom.hwMeta = document.getElementById('hw-meta');
  dom.hwState = document.getElementById('hw-state');
  dom.hwPhase = document.getElementById('hw-phase');
  dom.hwTele = document.getElementById('hw-tele');
  dom.airline = document.getElementById('et-airline');
  dom.homeAirline = document.getElementById('home-airline');
  dom.brand = document.getElementById('home-brand');

  state.plan = currentPlan();
  state.route = loadRoute();
  applyPreferences();
  renderNav();
  renderHome();
  renderFlightStrip();
  updateClock();
  syncHomeWidget();
  syncHomeBar();
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = setInterval(updateClock, 15000);

  onPlanChange(plan => {
    state.plan = plan;
    renderFlightStrip();
    syncHomeWidget();
    syncHomeBar();
    // A new plan can mean a new callsign, and so a different airline.
    applyAirlineState();
  });

  state.unsubLive = onLive(status => {
    state.live = status;
    setConnection(status);
    syncHomeWidget(status);
    syncHomeBar();
    // Detection falls back to the callsign the simulator (or the bridge's
    // recorded flight) reports, and only re-resolves when it actually changes.
    const flight = status.snapshot && (status.snapshot.currentFlight || status.snapshot.flight);
    const callsign = String((flight && flight.callsign) || '').trim().toUpperCase();
    if (callsign !== state.liveCallsign) {
      state.liveCallsign = callsign;
      applyAirlineState();
    }
    if (state.app === 'navigator' || state.app === 'briefing') {
      window.dispatchEvent(new CustomEvent('stratos:efb-live', { detail: status }));
    }
  });

  bindEvents();
  syncNavFade();
  route();
}

if (typeof document !== 'undefined' && document.getElementById('efb-nav')) {
  boot().catch(error => {
    console.error(error);
    const body = document.getElementById('efb-body');
    if (body) {
      body.innerHTML = `<div class="e-notice bad"><div><b>Stratos EFB could not start.</b><br>${esc(error.message)}</div></div>`;
    }
  });
}

if (typeof window !== 'undefined') {
  window.StratosEFB = {
    apps: APPS,
    open: id => { location.hash = `#/${id}`; },
    home: () => { location.hash = `#/${DEFAULT_ROUTE}`; },
    prefs: () => loadPrefs(),
  };
}
