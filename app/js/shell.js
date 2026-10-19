// Stratos application shell: the sidebar, the top bar and the home stat strip.
//
// The chrome is deliberately thin and reports real state only. The bridge's
// /health endpoint decides whether the simulator is live, so a disconnected
// simulator can never be shown as connected. The home totals come from the same
// logbook store and career maths the rest of the app uses, so a new pilot sees
// honest zeros rather than placeholder figures. The resource selector writes the
// existing preference (localStorage + the settings store) instead of introducing
// a second, competing setting.
//
// The sidebar's destinations belong to the page (the map page owns its own
// panel buttons), so the shell groups and iconises whatever `.tab` items the
// page declares rather than shipping a second navigation that could drift.

import { RESOURCE_MODES, detectResourceMode } from './lib/telemetry.js';

/** One consistent stroke set, so the sidebar reads as a single family. */
const SVG = (body, fill) => `<svg viewBox="0 0 24 24" ${fill
  ? 'fill="currentColor"'
  : 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true">${body}</svg>`;

const ICON = {
  // Brand + controls
  plane: SVG('<path d="M21 15.5v-1.8l-7.6-4.4V4.6a1.4 1.4 0 0 0-2.8 0v4.7L3 13.7v1.8l7.6-2.3v4.2l-2.2 1.5v1.4l3.6-1 3.6 1v-1.4l-2.2-1.5v-4.2z"/>', true),
  settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9.5 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4z"/>'),
  collapse: SVG('<path d="M14 6l-6 6 6 6"/>'),
  // Sidebar destinations
  home: SVG('<path d="M4 20v-7M10 20V5M16 20v-9M22 20H2"/>'),
  discover: SVG('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>'),
  live: SVG('<path d="M3 12h3l2.5-6 3.5 12 3-8 2 2h4"/>'),
  charts: SVG('<path d="M4 5h11v14H5a1 1 0 0 1-1-1z"/><path d="M15 5h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4"/><path d="M8 9h4M8 13h4"/>'),
  route: SVG('<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h6a4 4 0 0 1 0 8H9a4 4 0 0 0 0 4h8"/>'),
  weather: SVG('<path d="M7 16h9a3.5 3.5 0 0 0 .4-6.97A5 5 0 0 0 7.2 10.2A3.4 3.4 0 0 0 7 16z"/><path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2"/>'),
  data: SVG('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
  logbook: SVG('<path d="M5 4h9a2 2 0 0 1 2 2v14H6a1 1 0 0 1-1-1z"/><path d="M16 6h3v14H6"/><path d="M8 8h4M8 12h4"/>'),
  airports: SVG('<path d="M4 20h16"/><path d="M12 20V9"/><path d="M12 13l5-2.5v-2L12 10 7 8.5v2z"/><path d="M10 20V6a2 2 0 0 1 4 0v14"/>'),
  stats: SVG('<path d="M4 19V5M4 19h16"/><rect x="7" y="11" width="3" height="5" rx="1"/><rect x="12.5" y="7" width="3" height="9" rx="1"/><rect x="18" y="13" width="0" height="0"/><path d="M18 16v-3"/>'),
  progress: SVG('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3"/>'),
};

/** Sidebar icon for a destination, keyed by its id or its link. */
function iconFor(item) {
  if (item.id === 'bMap') return ICON.home;
  if (item.id === 'bLive') return ICON.live;
  if (item.id === 'bCh') return ICON.charts;
  if (item.id === 'bRoute') return ICON.route;
  if (item.id === 'bWx') return ICON.weather;
  if (item.id === 'bData') return ICON.data;
  const href = item.getAttribute('href') || '';
  if (href.startsWith('discover')) return ICON.discover;
  if (href.startsWith('logbook')) return ICON.logbook;
  if (href.includes('#airports')) return ICON.airports;
  if (href.includes('#career')) return ICON.stats;
  if (href.includes('#settings')) return ICON.settings;
  return ICON.progress;
}

const PAGE_TITLE = {
  home: 'Flight Deck',
  discover: 'Route Discovery',
  logbook: 'Flight Logbook',
  weather: 'Weather',
  live: 'Live Tracking',
  stats: 'Pilot Dashboard',
};

const S = {
  root: null,
  page: 'home',
  health: null,
  timer: null,
  statsEl: null,
  live: null,
};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function readMode() {
  try {
    const saved = localStorage.getItem('stratos.resourceMode');
    if (saved && RESOURCE_MODES[saved]) return saved;
  } catch (_) { /* private mode */ }
  try { return detectResourceMode(); } catch (_) { return 'normal'; }
}

/** Simulator state from the bridge, never from optimism. */
function simulatorState() {
  const health = S.health;
  if (!health) return { cls: 'is-off', text: 'Simulator offline', title: 'No bridge answered on this address' };
  const sim = health.simulator || {};
  if (sim.connected) {
    return { cls: 'is-live', text: 'Simulator live', title: `Receiving telemetry${sim.source ? ` from ${sim.source}` : ''}` };
  }
  return {
    cls: 'is-wait',
    text: 'Waiting for simulator',
    title: sim.source ? `Bridge ${health.version || ''} sees ${sim.source} but no telemetry yet` : 'Bridge ready, no telemetry yet',
  };
}

function liveState() {
  const health = S.health;
  const live = S.live === true || (health && health.simulator && health.simulator.connected);
  return live
    ? { cls: 'is-live', text: 'Live tracking', title: 'Live position data is arriving' }
    : { cls: 'is-off', text: 'No live data', title: 'Open Stratos from the bridge or start the simulator for live tracking' };
}

function renderStatus() {
  const sim = S.root?.querySelector('[data-status="sim"]');
  const live = S.root?.querySelector('[data-status="live"]');
  if (sim) {
    const state = simulatorState();
    sim.className = `status ${state.cls}`;
    sim.title = state.title;
    sim.innerHTML = `<i></i><span>${esc(state.text)}</span>`;
  }
  if (live) {
    const state = liveState();
    live.className = `status ${state.cls}`;
    live.title = state.title;
    live.innerHTML = `<i></i><span>${esc(state.text)}</span>`;
  }
}

/**
 * Group and iconise the page's sidebar. The page owns the destinations; the
 * shell owns how they look, so every page keeps one navigation language.
 */
function decorateRail(rail) {
  if (!rail || rail.dataset.decorated === '1') return;
  rail.dataset.decorated = '1';
  const items = [...rail.querySelectorAll('.tab')].filter(item => !item.classList.contains('rail-toggle'));
  // The collapse control belongs to the same icon family as the destinations.
  const toggle = rail.querySelector('.rail-toggle b');
  if (toggle) toggle.innerHTML = ICON.collapse;
  let lastGroup = null;
  for (const item of items) {
    const label = item.dataset.group || 'Flight Operations';
    if (label !== lastGroup) {
      lastGroup = label;
      const heading = document.createElement('div');
      heading.className = 'rail-group';
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = label;
      rail.insertBefore(heading, item);
    }
    const glyph = item.querySelector('b');
    if (glyph) glyph.innerHTML = iconFor(item);
    const name = item.dataset.label || item.textContent.trim();
    item.dataset.label = name;
    item.title = name;
    if (!item.hasAttribute('aria-label')) item.setAttribute('aria-label', name);
  }
}

function buildBar(bar, { theme = false, rail = false } = {}) {
  const mode = readMode();
  const title = bar.dataset.title || PAGE_TITLE[S.page] || 'Stratos';
  const context = bar.dataset.context || '';
  bar.innerHTML = `
    <a class="tb-brand" href="index.html" title="Stratos home">
      <span class="tb-mark">${ICON.plane}</span>
      <span>STRATOS<small>FLIGHT DECK</small></span>
    </a>
    <div class="tb-title">
      <b id="tb-page-title">${esc(title)}</b>
      ${context ? `<span class="tb-crumb">${esc(context)}</span>` : ''}
    </div>
    <span class="tb-gap"></span>
    ${rail ? "" : `<nav class="tb-nav" aria-label="Pages">
      <a href="index.html" data-page="home">Flight Deck</a>
      <a href="discover.html" data-page="discover">Discover</a>
      <a href="logbook.html" data-page="logbook">Logbook</a>
      <a href="weather.html" data-page="weather">Weather</a>
      <a href="live.html" data-page="live">Live</a>
    </nav>`}
    <div class="tb-stats">
      <div class="status is-off" data-status="sim" title="Simulator status"><i></i><span>Simulator offline</span></div>
      <div class="status is-off" data-status="live" title="Live tracking status"><i></i><span>No live data</span></div>
      <label class="tb-perf-wrap" title="Resource profile: ${esc((RESOURCE_MODES[mode] || {}).description || '')}">
        <select class="tb-perf" aria-label="Resource profile">
          ${Object.values(RESOURCE_MODES).map(profile => `<option value="${esc(profile.key)}"${profile.key === mode ? ' selected' : ''}>${esc(profile.name)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="tb-actions">
      ${theme ? '<button class="tb-btn" id="shell-theme" type="button">Night mode</button>' : ''}
      <a class="tb-btn" href="pilot.html#settings" title="Settings" aria-label="Settings">${ICON.settings}</a>
      <a class="tb-btn" href="logbook.html#profile" title="Pilot profile" aria-label="Pilot profile"><span class="tb-avatar">PF</span></a>
    </div>`;

  bar.querySelectorAll('.tb-nav a').forEach(link => {
    if (link.dataset.page === S.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  bar.querySelector('.tb-perf')?.addEventListener('change', async event => {
    const next = event.target.value;
    if (!RESOURCE_MODES[next]) return;
    try { localStorage.setItem('stratos.resourceMode', next); } catch (_) { /* private mode */ }
    try {
      const store = await import('./lib/store.js');
      await store.setSetting('resourceMode', next);
    } catch (_) { /* storage unavailable, the preference still applies next load */ }
    try { window.StratosPilot?.setResourceMode?.(next); } catch (_) { /* not the pilot page */ }
    bar.querySelector('.tb-perf-wrap').title = `Resource profile: ${RESOURCE_MODES[next].description || ''}`;
    // The map page reads its profile once at start-up; tell the user when the
    // change takes effect there instead of silently doing nothing.
    if (S.page === 'home' && !window.StratosPilot) {
      const note = bar.querySelector('[data-perf-note]') || document.createElement('span');
      note.dataset.perfNote = '1';
      note.className = 'status is-wait';
      note.textContent = `${RESOURCE_MODES[next].name} applies on reload`;
      note.style.marginLeft = '6px';
      bar.querySelector('.tb-stats').append(note);
      setTimeout(() => note.remove(), 4000);
    }
  });
  renderStatus();
}

async function loadStats() {
  if (!S.statsEl) return;
  let career = null;
  try {
    const [{ getFlights }, { computeCareer }] = await Promise.all([
      import('./lib/store.js'),
      import('./lib/stats.js'),
    ]);
    career = computeCareer(await getFlights());
  } catch (_) { /* no logbook on this origin yet: zeros are the honest answer */ }

  const hours = career ? career.hours : 0;
  const distance = career ? career.distanceNm : 0;
  const flights = career ? career.flights : 0;
  const airports = career ? career.airportsVisited : 0;
  const cards = [
    { label: 'Total flight time', value: hours ? `${hours.toFixed(1)} h` : '0.0 h', empty: !hours },
    { label: 'Total distance', value: distance ? `${Math.round(distance).toLocaleString()} nm` : '0 nm', empty: !distance },
    { label: 'Flights completed', value: String(flights), empty: !flights },
    { label: 'Airports visited', value: String(airports), empty: !airports },
  ];
  S.statsEl.innerHTML = cards.map(card => `
    <div class="stat-card${card.empty ? ' is-empty' : ''}">
      <b>${esc(card.value)}</b>
      <span>${esc(card.label)}</span>
    </div>`).join('');
  // Pages under the shell (the map especially) measure their own box once at
  // start-up. Re-measure now that the strip has real content.
  try { window.dispatchEvent(new Event('resize')); } catch (_) { /* not a browser */ }
}

async function pollHealth() {
  try {
    const response = await fetch('/health', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    S.health = await response.json();
  } catch (_) {
    S.health = null;
  }
  renderStatus();
}

/**
 * Mount the shared chrome. Pages provide an empty `<header id="appbar">` and,
 * for the home dashboard, an empty `<section id="homestats">`.
 */
export function mountShell({ page = 'home', stats = false, theme = false } = {}) {
  S.page = page;
  S.root = document.querySelector('.app-shell') || document.body;
  S.statsEl = document.getElementById('homestats');

  const bar = document.getElementById('appbar');
  if (bar) buildBar(bar, { theme, rail: Boolean(S.root.querySelector('#tabs')) });

  const shell = S.root;
  const rail = shell.querySelector('#tabs');
  if (rail) decorateRail(rail);

  // Pages that use the shared theme switch keep it available from the bar.
  if (theme && bar) {
    import('./ui.js').then(({ initTheme, bindThemeToggle }) => {
      initTheme();
      const button = bar.querySelector('#shell-theme');
      if (button) bindThemeToggle(button);
    }).catch(() => { /* theme stays as the page set it */ });
  }

  if (shell.classList.contains('app-shell')) {
    try {
      if (localStorage.getItem('stratos.rail') === 'collapsed') shell.dataset.collapsed = '1';
      else if (localStorage.getItem('stratos.rail') === 'rail') shell.dataset.mode = 'rail';
    } catch (_) { /* private mode */ }
    const toggle = shell.querySelector('[data-rail-toggle]');
    toggle?.addEventListener('click', () => {
      const collapsed = shell.dataset.collapsed === '1';
      if (collapsed) delete shell.dataset.collapsed;
      else shell.dataset.collapsed = '1';
      try { localStorage.setItem('stratos.rail', collapsed ? 'open' : 'collapsed'); } catch (_) { /* private mode */ }
    });
  }

  pollHealth();
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) pollHealth(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollHealth(); });

  if (stats) loadStats();

  window.StratosShell = {
    refresh: () => { pollHealth(); if (stats) loadStats(); },
    setLive: value => { S.live = Boolean(value); renderStatus(); },
    health: () => S.health,
    destroy: () => { if (S.timer) clearInterval(S.timer); S.timer = null; },
  };
  return window.StratosShell;
}

export default mountShell;
