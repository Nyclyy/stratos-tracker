/* Stratos EFB — the tablet shell.
 *
 * A home screen of apps, a dock, a status bar and one view that an app mounts
 * into. The shell owns navigation, preferences, the clock, the connection
 * indicator and lazy loading; each app owns its own layout and data. Nothing is
 * a placeholder: every icon opens a module that reads a real source (the stored
 * SimBrief plan, the bridge, NOAA, the FAA chart catalogue, the logbook) and
 * says plainly when that source is unavailable.
 */

import {
  DEFAULT_PREFS, esc, fmtFl, loadPrefs, loadRoute, savePrefs,
  connectionText, currentPlan, onLive, onPlanChange,
} from './efb/common.js';

/* One list, so the home grid, the dock and the router cannot disagree. */
export const APPS = [
  {
    id: 'briefing', name: 'Briefing', title: 'Flight Briefing', subtitle: 'OFP and flight plan',
    icon: 'briefing', module: './efb/briefing.js', dock: true,
    tile: ['#1b3a6b', '#0b1730'],
  },
  {
    id: 'charts', name: 'Charts', title: 'Charts', subtitle: 'Airport and procedure documents',
    icon: 'charts', module: './efb/charts.js', dock: true,
    tile: ['#135a52', '#08221f'],
  },
  {
    id: 'weather', name: 'Weather', title: 'Weather', subtitle: 'METAR, TAF and winds aloft',
    icon: 'weather', module: './efb/weather.js', dock: true,
    tile: ['#1e4b6e', '#0a1c2b'],
  },
  {
    id: 'performance', name: 'Performance', title: 'Performance', subtitle: 'Takeoff and landing analysis',
    icon: 'performance', module: './efb/performance.js', dock: true,
    tile: ['#5a2a1e', '#2a100c'],
  },
  {
    id: 'weightbalance', name: 'Weight & Balance', title: 'Weight & Balance', subtitle: 'Loading and limits',
    icon: 'weightbalance', module: './efb/weightbalance.js', dock: true,
    tile: ['#40306b', '#161029'],
  },
  {
    id: 'fuel', name: 'Fuel', title: 'Fuel Planning', subtitle: 'Block fuel and reserves',
    icon: 'fuel', module: './efb/fuel.js', dock: false,
    tile: ['#3b4321', '#161a0c'],
  },
  {
    id: 'documents', name: 'Documents', title: 'Documents & Checklists', subtitle: 'Procedures and reference',
    icon: 'documents', module: './efb/documents.js', dock: false,
    tile: ['#2a3a52', '#0d1520'],
  },
  {
    id: 'airport', name: 'Airports', title: 'Airport Information', subtitle: 'Runways, frequencies, NOTAMs',
    icon: 'airport', module: './efb/airport.js', dock: false,
    tile: ['#4a3350', '#1b0f20'],
  },
  {
    id: 'live', name: 'Live Flight', title: 'Flight Progress', subtitle: 'Live simulator tracking',
    icon: 'live', module: './efb/live.js', dock: false,
    tile: ['#17452f', '#081a12'],
  },
  {
    id: 'logbook', name: 'Logbook', title: 'Flight Log', subtitle: 'Recorded flights',
    icon: 'logbook', module: './efb/logbook.js', dock: false,
    tile: ['#3a3a44', '#141419'],
  },
  {
    id: 'settings', name: 'Settings', title: 'EFB Settings', subtitle: 'Preferences and connections',
    icon: 'settings', module: './efb/settings.js', dock: false,
    tile: ['#26303c', '#0d1117'],
  },
];

const DOCK_ORDER = ['live', 'briefing', 'charts', 'weather', 'performance'];

const ICONS = {
  briefing: '<path d="M7 4.5h7.5L19 9v10.5H7z"/><path d="M14.3 4.6V9H19"/><path d="M9.6 12.4h6M9.6 15.2h6M9.6 17.6h3.8"/><path d="M4.2 7.2v12.3h10.4"/>',
  charts: '<path d="M4 6.3 9.3 4l5.4 2.3L20 4v13.7L14.7 20l-5.4-2.3L4 20z"/><path d="M9.3 4v13.7M14.7 6.3V20"/>',
  weather: '<path d="M7.6 10.4a3.4 3.4 0 0 1 6.6-.9 3 3 0 0 1 4 2.9 3 3 0 0 1-3 3H8.6a2.6 2.6 0 0 1-1-5z"/><path d="M3.5 5.5h4.2M2.5 9h3.4M16.6 5h4.2"/>',
  performance: '<path d="M3.6 17a8.4 8.4 0 1 1 16.8 0"/><path d="M12 17 16 9.6"/><circle cx="12" cy="17" r="1.5"/><path d="M3.6 17h2.2M18.2 17h2.2"/>',
  weightbalance: '<path d="M12 4v16"/><path d="M5 7h14"/><path d="M9 7 6.4 12.4a2.7 2.7 0 0 0 5.2 0z"/><path d="M15 7l-2.6 5.4a2.7 2.7 0 0 0 5.2 0z"/><path d="M8 20h8"/>',
  fuel: '<path d="M6 20V5.5h7V20"/><path d="M6 9.2h7"/><path d="M13 12h2.4a1.8 1.8 0 0 1 1.8 1.8v3.4a1.2 1.2 0 0 0 2.4 0V9.6l-2.2-2.2"/><path d="M4.6 20h9.8"/>',
  documents: '<path d="M12 6.4c-1.7-1.5-4-2-7-1.9v12.2c3-.1 5.3.4 7 1.9 1.7-1.5 4-2 7-1.9V4.5c-3-.1-5.3.4-7 1.9z"/><path d="M12 6.4v12.2"/><path d="M7.6 9.4h2.2M7.6 12.2h2.2"/>',
  airport: '<path d="M7 20V8.4l5-2.4 5 2.4V20"/><path d="M4.5 20h15"/><path d="M9.6 11.2h4.8M9.6 14.4h4.8M9.6 17.6h4.8"/><path d="M12 3v3"/>',
  live: '<path d="M3 17.4 8.8 12l3.4 2.2L20.4 6"/><path d="M15.4 6h5v5"/><circle cx="6.2" cy="19" r="1.6"/><path d="M6.2 19h5.4"/>',
  logbook: '<path d="M6 4.5h11.4A1.6 1.6 0 0 1 19 6.1v13.4H7.6A2.1 2.1 0 0 1 5.5 17.4V6a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M9 8h6.4M9 11.2h4.4"/><path d="M5.6 17.2h13.3"/>',
  settings: '<circle cx="12" cy="12" r="2.9"/><path d="M12 3.4v2.2M12 18.4v2.2M4.9 7.9l1.9 1.1M17.2 15l1.9 1.1M4.9 16.1l1.9-1.1M17.2 9l1.9-1.1"/>',
  home: '<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10.4V19h11v-8.6"/>',
  back: '<path d="M14.5 6 8.5 12l6 6"/>',
  search: '<circle cx="10.8" cy="10.8" r="5.6"/><path d="m15 15 4.4 4.4"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.2-5.1"/><path d="M19.4 4.6v4.2h-4.2"/>',
  external: '<path d="M13 5h6v6"/><path d="m11.6 12.4 7.1-7.1"/><path d="M17 14v4.4H5.6V7H10"/>',
};

export function icon(name, size = 24) {
  const body = ICONS[name] || ICONS.settings;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const RECENT_KEY = 'stratos.efb.recent';

function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(id => APPS.some(app => app.id === id)).slice(0, 4) : [];
  } catch (_) { return []; }
}

function pushRecent(id) {
  const next = [id, ...loadRecent().filter(item => item !== id)].slice(0, 4);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
  return next;
}

/* ── shell state ─────────────────────────────────────────────────────── */

const state = {
  prefs: loadPrefs(),
  app: null,
  cleanup: null,
  plan: null,
  route: [],
  clockTimer: null,
  unsubLive: null,
};

const dom = {};

function applyPreferences() {
  const screen = document.getElementById('efb-screen');
  if (screen) screen.dataset.wall = state.prefs.wallpaper || DEFAULT_PREFS.wallpaper;
  document.documentElement.dataset.efbMotion = state.prefs.motion === 'reduced' ? 'reduced' : 'full';
}

function appTile(app) {
  return `style="--tile-a:${app.tile[0]};--tile-b:${app.tile[1]}"`;
}

function appButton(app, { dock = false } = {}) {
  return `<button class="app-icon" type="button" data-app="${esc(app.id)}" ${appTile(app)} title="${esc(app.name)}" aria-label="Open ${esc(app.title)}">
    <span class="ai">${icon(app.icon)}</span><span>${esc(app.name)}</span>
  </button>`;
}

export function renderHome() {
  if (!dom.grid) return;
  dom.grid.innerHTML = APPS.map(app => appButton(app)).join('');
  dom.dockApps.innerHTML = DOCK_ORDER
    .map(id => APPS.find(app => app.id === id))
    .filter(Boolean)
    .map(app => appButton(app, { dock: true }))
    .join('');
  renderHomeFlight();
}

function renderHomeFlight() {
  const strip = dom.homeFlight;
  if (!strip) return;
  const plan = state.plan;
  const ofp = plan && plan.ofp;
  if (!ofp) {
    strip.classList.remove('show');
    strip.innerHTML = '';
    return;
  }
  const origin = (ofp.origin && ofp.origin.icao) || '????';
  const destination = (ofp.destination && ofp.destination.icao) || '????';
  const parts = [];
  if (ofp.flight && ofp.flight.callsign) parts.push(ofp.flight.callsign);
  if (ofp.aircraft && ofp.aircraft.icao) parts.push(ofp.aircraft.icao);
  if (ofp.flight && ofp.flight.cruiseFt) parts.push(`cruise ${fmtFl(ofp.flight.cruiseFt)}`);
  if (ofp.distanceNm) parts.push(`${Math.round(ofp.distanceNm)} nm`);
  strip.classList.add('show');
  strip.innerHTML = `<div>
      <div class="hf-route">${esc(origin)} <s>→</s> ${esc(destination)}</div>
      <div class="hf-meta">${esc(parts.join(' · ') || 'SimBrief plan')}</div>
    </div>
    <button class="e-btn small primary" type="button" data-app="briefing">Open briefing</button>`;
}

function updateStatusBar() {
  const clock = document.getElementById('esb-clock');
  if (clock) {
    const now = new Date();
    clock.innerHTML = `${now.toISOString().slice(11, 16)}<small>Z</small>`;
  }
  const flight = document.getElementById('esb-flight');
  if (flight) {
    const ofp = state.plan && state.plan.ofp;
    if (ofp && (ofp.flight || ofp.origin)) {
      const origin = (ofp.origin && ofp.origin.icao) || '????';
      const destination = (ofp.destination && ofp.destination.icao) || '????';
      flight.textContent = `${(ofp.flight && ofp.flight.callsign) ? `${ofp.flight.callsign} · ` : ''}${origin} → ${destination}`;
    } else {
      flight.textContent = 'No flight plan';
    }
  }
}

function setConnection(status) {
  const el = document.getElementById('esb-conn');
  if (!el) return;
  el.dataset.state = status.status === 'live' ? 'live' : status.status === 'offline' ? 'offline' : 'connecting';
  el.querySelector('span').textContent = connectionText(status.status);
  el.title = status.detail || (status.health ? `Bridge ${status.health.version || ''}` : '');
}

async function initBattery() {
  const wrap = document.getElementById('esb-battery');
  if (!wrap) return;
  try {
    if (!navigator.getBattery) { wrap.hidden = true; return; }
    const battery = await navigator.getBattery();
    const paint = () => {
      const percent = Math.round(battery.level * 100);
      const fill = wrap.querySelector('b');
      fill.style.width = `${Math.max(4, percent)}%`;
      wrap.querySelector('em').textContent = `${percent}%`;
      wrap.dataset.low = percent <= 10 ? '2' : percent <= 20 ? '1' : '0';
    };
    paint();
    battery.addEventListener('levelchange', paint);
  } catch (_) {
    wrap.hidden = true;
  }
}

/* ── routing ─────────────────────────────────────────────────────────── */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [id, query] = raw.split('?');
  return { id: id || '', params: new URLSearchParams(query || '') };
}

export function closeApp({ toHome = true } = {}) {
  if (state.cleanup) {
    try { state.cleanup(); } catch (_) { /* an app must not block the shell */ }
    state.cleanup = null;
  }
  state.app = null;
  if (dom.app) {
    dom.app.hidden = true;
    dom.app.innerHTML = '';
  }
  if (dom.home) dom.home.hidden = false;
  if (dom.dock) dom.dock.hidden = false;
  if (toHome) document.title = 'Stratos EFB';
  renderHomeFlight();
}

function chrome(app) {
  return `<header class="app-chrome">
    <button class="ac-back" type="button" data-home>${icon('back', 13)}<span>Home</span></button>
    <div class="ac-title"><b>${esc(app.title)}</b><span>${esc(app.subtitle)}</span></div>
    <div class="ac-actions" id="efb-actions"></div>
  </header>
  <div class="app-body" id="efb-body"></div>`;
}

async function openApp(id, params = new URLSearchParams()) {
  const app = APPS.find(item => item.id === id);
  if (!app) { closeApp(); return; }
  if (state.app === id) return;
  closeApp({ toHome: false });
  state.app = id;
  state.prefs = loadPrefs();
  if (dom.home) dom.home.hidden = true;
  if (dom.dock) dom.dock.hidden = true;
  dom.app.hidden = false;
  dom.app.innerHTML = chrome(app);
  dom.app.scrollTop = 0;
  document.title = `${app.name} · Stratos EFB`;
  pushRecent(id);
  renderHomeFlight();

  const body = document.getElementById('efb-body');
  const actions = document.getElementById('efb-actions');
  const ctx = {
    params,
    prefs: () => loadPrefs(),
    setPrefs(patch) { state.prefs = savePrefs(patch); applyPreferences(); },
    go(destination, query = {}) {
      const next = new URLSearchParams(query);
      const suffix = next.toString();
      location.hash = `#/${destination}${suffix ? `?${suffix}` : ''}`;
    },
    home: () => { location.hash = ''; closeApp(); },
    setActions(html) { if (actions) actions.innerHTML = html || ''; },
    setSubtitle(text) {
      const el = dom.app.querySelector('.ac-title span');
      if (el) el.textContent = text || '';
    },
    plan: () => state.plan,
    route: () => state.route,
    refreshPlan: async id2 => {
      const { refreshPlan } = await import('./efb/common.js');
      return refreshPlan(id2);
    },
    notify(message, tone = '') {
      const body2 = document.getElementById('efb-body');
      if (!body2) return;
      const notice = document.createElement('div');
      notice.className = `e-notice ${tone}`.trim();
      notice.textContent = message;
      body2.prepend(notice);
      setTimeout(() => notice.remove(), 6000);
    },
  };

  try {
    const module = await import(app.module);
    const result = await module.mount(body, ctx);
    if (result && typeof result.destroy === 'function') state.cleanup = result.destroy;
    if (result && result.actions && actions) actions.innerHTML = result.actions;
  } catch (error) {
    console.error(error);
    body.innerHTML = `<div class="e-notice bad"><div><b>${esc(app.title)} could not start.</b><br>${esc(error.message)}</div></div>
      <div class="e-row" style="margin-top:12px"><button class="e-btn" type="button" data-retry>Retry</button>
      <button class="e-btn ghost" type="button" data-home>Back to home</button></div>`;
    body.querySelector('[data-retry]')?.addEventListener('click', () => {
      state.app = null;
      closeApp();
      location.hash = `#/${app.id}`;
    });
  }
}

function route() {
  const { id, params } = parseRoute();
  if (!id) { closeApp(); return; }
  openApp(id, params);
}

/* ── boot ────────────────────────────────────────────────────────────── */

function bindEvents() {
  document.addEventListener('click', event => {
    const open = event.target.closest('[data-app]');
    if (open) {
      event.preventDefault();
      location.hash = `#/${open.dataset.app}`;
      return;
    }
    if (event.target.closest('[data-home]')) {
      event.preventDefault();
      if (location.hash) location.hash = '';
      else closeApp();
    }
  });
  document.getElementById('home-btn')?.addEventListener('click', () => {
    if (location.hash) location.hash = '';
    else closeApp();
  });
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.app) {
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (typing) { target.blur(); return; }
      location.hash = '';
      closeApp();
    }
  });
}

export async function boot() {
  dom.home = document.getElementById('home');
  dom.app = document.getElementById('app-view');
  dom.grid = document.getElementById('app-grid');
  dom.dock = document.getElementById('dock');
  dom.dockApps = document.getElementById('dock-apps');
  dom.homeFlight = document.getElementById('home-flight');
  applyPreferences();
  state.plan = currentPlan();
  state.route = loadRoute();
  renderHome();
  updateStatusBar();
  state.clockTimer = setInterval(updateStatusBar, 15000);
  initBattery();

  onPlanChange(plan => {
    state.plan = plan;
    updateStatusBar();
    renderHomeFlight();
  });

  state.unsubLive = onLive(status => {
    setConnection(status);
    if (state.app === 'live' || state.app === 'briefing') {
      window.dispatchEvent(new CustomEvent('stratos:efb-live', { detail: status }));
    }
  });

  bindEvents();
  route();
}

if (typeof document !== 'undefined' && document.getElementById('efb-screen')) {
  boot().catch(error => {
    console.error(error);
    const home = document.getElementById('home');
    if (home) {
      home.innerHTML = `<div class="e-notice bad" style="margin:24px"><div><b>Stratos EFB could not start.</b><br>${esc(error.message)}</div></div>`;
    }
  });
}

if (typeof window !== 'undefined') {
  window.StratosEFB = {
    apps: APPS,
    open: id => { location.hash = `#/${id}`; },
    home: () => { location.hash = ''; },
    prefs: () => loadPrefs(),
  };
}
