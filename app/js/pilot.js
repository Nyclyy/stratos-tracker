import { initTheme, bindThemeToggle, toast, esc, fmtDateTime, $ } from './ui.js';
import { getFlights, getSetting, setSetting, deleteFlight } from './lib/store.js';
import { computeCareer } from './lib/stats.js';
import { summarizeLandings, loadThresholdOverrides } from './lib/landing.js';
import { defaultBridgeBase, bridgeHealth, syncLogbook, TelemetryClient, isHostedPage } from './bridge.js';
import { loadDirectory, bundledDirectory } from './pilot/common.js';
import { getResourceProfile, detectResourceMode } from './lib/telemetry.js';

const SECTIONS = {
  career: { label: 'Career', module: './pilot/career.js' },
  landings: { label: 'Landings', module: './pilot/landings.js' },
  replay: { label: 'Replay', module: './pilot/replay.js' },
  briefing: { label: 'Briefing', module: './pilot/briefing.js' },
  routes: { label: 'Routes', module: './pilot/routes.js' },
  checklists: { label: 'Checklists', module: './pilot/checklists.js' },
  airports: { label: 'Airports', module: './pilot/airports.js' },
  charts: { label: 'Charts', module: './pilot/charts.js' },
  settings: { label: 'Settings', module: './pilot/settings.js' },
};

const state = {
  route: 'career',
  params: new URLSearchParams(),
  flights: [],
  career: null,
  landings: null,
  thresholds: {},
  directory: [],
  bridgeBase: defaultBridgeBase(),
  health: null,
  bridgeError: '',
  bridgeStatus: 'disconnected',
  live: null,
  mode: 'normal',
  loaded: false,
};

let cleanup = null;
let telemetryClient = null;
let healthTimer = null;

initTheme();
bindThemeToggle($('#theme-toggle'));

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [route, query] = raw.split('?');
  return {
    route: SECTIONS[route] ? route : 'career',
    params: new URLSearchParams(query || ''),
  };
}

function renderNav() {
  document.querySelectorAll('[data-section]').forEach(button => {
    const active = button.dataset.section === state.route;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function bindNav() {
  document.querySelectorAll('[data-section]').forEach(button => {
    button.addEventListener('click', () => buildContext().go(button.dataset.section));
  });
}

function setBridgePill() {
  const el = document.getElementById('bridge-pill');
  if (!el) return;
  const stateName = state.bridgeStatus === 'connected' ? 'connected'
    : state.bridgeStatus === 'connecting' || state.bridgeStatus === 'reconnecting' ? 'connecting'
      : state.health && state.health.simulator && state.health.simulator.connected ? 'waiting'
        : 'disconnected';
  const label = stateName === 'connected' ? 'Simulator live'
    : stateName === 'connecting' ? 'Connecting'
      : stateName === 'waiting' ? 'Waiting for simulator'
        : state.bridgeError ? 'Bridge needs attention' : 'Bridge offline';
  el.innerHTML = `<i class="dot dot-${stateName}"></i><span>${esc(label)}</span>`;
  el.title = state.health
    ? `Bridge ${state.health.version} · ${state.health.simulator.source || 'no simulator'} · ${state.health.simulator.connected ? 'receiving telemetry' : 'no telemetry'}`
    : state.bridgeError || 'Desktop bridge not reachable';
}

async function refreshBridge({ sync = false, quiet = true } = {}) {
  state.bridgeBase = defaultBridgeBase();
  try {
    state.health = await bridgeHealth(state.bridgeBase);
    state.bridgeError = '';
    setBridgePill();
    if (sync) {
      try {
        const result = await syncLogbook(state.bridgeBase);
        if (result.added > 0) {
          await reloadFlights();
          if (!quiet) toast(`${result.added} flight${result.added === 1 ? '' : 's'} imported from the bridge.`, 'good');
        }
      } catch (error) {
        if (error.name === 'BridgeAuthError') {
          state.bridgeError = 'The bridge is protected by an access token. Open the bridge address in this browser and enter the token from Stratos Settings.';
        } else {
          state.bridgeError = error.message;
        }
      }
    }
  } catch (error) {
    state.health = null;
    state.bridgeError = error.name === 'BridgeAuthError'
      ? 'The bridge needs its access token. Open the bridge URL and unlock it once in this browser.'
      : isHostedPage()
        ? 'This HTTPS page cannot reach a bridge on your PC directly. Use the phone relay for live data, or open Stratos from the bridge address on your LAN.'
        : error.message;
    setBridgePill();
  }
  return state.health;
}

async function reloadFlights() {
  state.flights = await getFlights();
  state.career = computeCareer(state.flights);
  state.landings = summarizeLandings(state.flights, { thresholds: state.thresholds });
}

async function boot() {
  state.mode = detectResourceMode();
  state.thresholds = loadThresholdOverrides();
  const savedMode = await getSetting('resourceMode', null).catch(() => null);
  if (savedMode && getResourceProfile(savedMode)) state.mode = savedMode;

  const params = new URLSearchParams(location.search);
  if (params.get('mode') && getResourceProfile(params.get('mode'))) state.mode = params.get('mode');

  // Honour deep links such as pilot.html#/replay?flight=ID from the logbook.
  const initial = parseHash();
  state.route = initial.route;
  state.params = initial.params;
  bindNav();
  renderNav();
  showSkeleton();
  await Promise.all([
    reloadFlights(),
    loadDirectory(state.bridgeBase).then(directory => { state.directory = directory; }),
  ]);
  state.loaded = true;
  await refreshBridge({ sync: true, quiet: false });
  state.directory = state.directory.length ? state.directory : bundledDirectory();
  await route();

  telemetryClient = new TelemetryClient({
    base: state.bridgeBase,
    mode: state.mode,
    onTelemetry: message => {
      state.live = message;
      state.bridgeStatus = 'connected';
      setBridgePill();
      window.dispatchEvent(new CustomEvent('stratos:telemetry', { detail: message }));
    },
    onStatus: status => {
      state.bridgeStatus = status.state;
      setBridgePill();
      window.dispatchEvent(new CustomEvent('stratos:bridge-status', { detail: status }));
    },
  });
  telemetryClient.connect();

  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (document.hidden) return;
    const previous = state.health ? state.health.simulator && state.health.simulator.connected : false;
    await refreshBridge({ sync: true, quiet: true });
    const now = state.health ? state.health.simulator && state.health.simulator.connected : false;
    if (now && !previous) {
      await reloadFlights();
      window.dispatchEvent(new CustomEvent('stratos:data'));
    }
  }, 45000);

  window.addEventListener('online', () => {
    refreshBridge({ sync: true });
    telemetryClient?.connect();
  });
  window.addEventListener('hashchange', () => {
    state.route = parseHash().route;
    state.params = parseHash().params;
    renderNav();
    route();
  });
}

function showSkeleton() {
  document.getElementById('view').innerHTML = `
    <div class="grid grid-4" aria-hidden="true">
      ${Array.from({ length: 4 }, () => '<div class="stat"><span class="stat-label">Loading</span><b class="stat-value">—</b></div>').join('')}
    </div>
    <div class="card" style="margin-top:12px;min-height:180px"><div class="muted small">Loading your recorded flights…</div></div>`;
}

async function route() {
  const view = document.getElementById('view');
  const section = SECTIONS[state.route] || SECTIONS.career;
  if (cleanup) { try { cleanup(); } catch (_) {} cleanup = null; }
  const heading = document.getElementById('page-route');
  if (heading) heading.textContent = section.label;
  view.innerHTML = `<div class="card"><div class="muted small">Loading ${esc(section.label)}…</div></div>`;
  try {
    const module = await import(section.module);
    if (!state.loaded) await reloadFlights();
    const ctx = buildContext();
    const result = await module.mount(view, ctx);
    cleanup = result && typeof result.destroy === 'function' ? result.destroy : null;
    document.title = `${section.label} · Stratos`;
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="notice bad"><div><strong>${esc(section.label)} could not load.</strong><br>${esc(error.message)}</div>
      <span class="spacer"></span><button class="btn small" id="section-retry">Retry</button></div>`;
    document.getElementById('section-retry')?.addEventListener('click', () => route());
  }
}

function buildContext() {
  return {
    get flights() { return state.flights; },
    get career() { return state.career; },
    get landings() { return state.landings; },
    get thresholds() { return state.thresholds; },
    get directory() { return state.directory; },
    get health() { return state.health; },
    get bridgeError() { return state.bridgeError; },
    get bridgeBase() { return state.bridgeBase; },
    get live() { return state.live; },
    get mode() { return state.mode; },
    get params() { return state.params; },
    async reload() {
      await reloadFlights();
      await route();
    },
    async refresh({ sync = true } = {}) {
      await refreshBridge({ sync, quiet: false });
      await reloadFlights();
      window.dispatchEvent(new CustomEvent('stratos:data'));
    },
    async setThresholds(next) {
      state.thresholds = next || {};
      state.landings = summarizeLandings(state.flights, { thresholds: state.thresholds });
    },
    go(section, params = {}) {
      const query = new URLSearchParams(params).toString();
      location.hash = `#/${section}${query ? `?${query}` : ''}`;
    },
    async openFlight(id) {
      const flight = state.flights.find(f => f.id === id);
      if (!flight) { toast('That flight is no longer in the logbook.'); return; }
      showFlightDialog(flight);
    },
    async deleteFlight(id) {
      await deleteFlight(id);
      await reloadFlights();
      toast('Flight removed from the local logbook.');
      await route();
    },
    toast,
  };
}

function showFlightDialog(flight) {
  const duration = flight.takeoffTime && flight.landingTime
    ? (flight.landingTime - flight.takeoffTime) / 1000 : null;
  const landing = flight.landing;
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  backdrop.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="Flight details">
    <div class="row" style="margin-bottom:14px"><h2>${esc(flight.depAirport || '????')} → ${esc(flight.arrAirport || '????')}</h2><span class="spacer"></span>
      <button class="btn small" data-close>Close</button></div>
    <dl class="kv">
      <dt>Date</dt><dd>${esc(fmtDateTime(flight.startTime))}</dd>
      <dt>Duration</dt><dd>${duration ? `${Math.floor(duration / 3600)}h ${Math.round((duration % 3600) / 60)}m` : 'not recorded'}</dd>
      <dt>Distance</dt><dd>${flight.distanceNm != null ? `${Math.round(flight.distanceNm)} nm` : 'not recorded'}</dd>
      <dt>Aircraft</dt><dd>${esc(flight.aircraft || 'Unknown')}${flight.registration ? ` · ${esc(flight.registration)}` : ''}</dd>
      <dt>Simulator</dt><dd>${esc(flight.sim || 'Unknown')}</dd>
      <dt>Max altitude</dt><dd>${flight.maxAlt ? `${Math.round(flight.maxAlt).toLocaleString()} ft` : '—'}</dd>
      <dt>Track</dt><dd>${Array.isArray(flight.track) ? `${flight.track.length} recorded samples` : 'no recorded track'}</dd>
      <dt>Landing</dt><dd>${landing && landing.vsFpm != null ? `${landing.vsFpm} fpm${landing.runway ? ` · runway ${esc(landing.runway.id)}` : ''}` : (flight.landingVS != null ? `${flight.landingVS} fpm` : 'no recorded landing data')}</dd>
      <dt>Record source</dt><dd>${esc(flight.recordedBy || 'browser')}${flight.recovered ? ' · recovered after an interrupted session' : ''}</dd>
    </dl>
    ${flight.incomplete ? '<div class="notice warn" style="margin-top:12px">This flight was not completed normally. It is kept for reference and excluded from career totals.</div>' : ''}
    <div class="btn-row" style="margin-top:16px">
      ${Array.isArray(flight.track) && flight.track.length > 1 ? `<a class="btn primary" href="#/replay?flight=${encodeURIComponent(flight.id)}">Replay flight</a>` : ''}
      <button class="btn danger" data-delete>Delete from this device</button>
    </div>
    <p class="help" style="margin-top:12px">Deleting removes this record from this browser only. Bridge records are kept in your bridge data folder.</p>
  </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  backdrop.querySelector('[data-close]').addEventListener('click', close);
  backdrop.querySelector('[data-delete]').addEventListener('click', async () => {
    if (!confirm('Delete this flight from the local logbook?')) return;
    await deleteFlight(flight.id);
    close();
    await reloadFlights();
    await route();
    toast('Flight removed.');
  });
  backdrop.querySelector('.dialog').focus?.();
  document.addEventListener('keydown', function onKey(event) {
    if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

boot().catch(error => {
  console.error(error);
  document.getElementById('view').innerHTML = `<div class="notice bad"><div><strong>Stratos could not start.</strong><br>${esc(error.message)}</div></div>`;
});

window.StratosPilot = {
  state,
  refresh: () => refreshBridge({ sync: true, quiet: false }),
  reload: reloadFlights,
  setResourceMode(mode) {
    if (!getResourceProfile(mode)) return;
    state.mode = mode;
    telemetryClient?.setMode(mode);
  },
};
