// Stratos application shell: the shared top bar and the home statistics strip.
//
// The chrome is deliberately thin and reports real state only. The bridge's
// /health endpoint decides whether the simulator is live, so a disconnected
// simulator can never be shown as connected. The four home totals come from the
// same logbook store and career maths the rest of the app uses, so a new pilot
// sees honest zeros rather than placeholder figures. The resource selector
// writes the existing preference (localStorage + the settings store) instead of
// introducing a second, competing setting.

import { RESOURCE_MODES, detectResourceMode } from './lib/telemetry.js';

const ICON = {
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9.5 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4z"/></svg>',
  plane: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 15.5v-1.8l-7.6-4.4V4.6a1.4 1.4 0 0 0-2.8 0v4.7L3 13.7v1.8l7.6-2.3v4.2l-2.2 1.5v1.4l3.6-1 3.6 1v-1.4l-2.2-1.5v-4.2z"/></svg>',
};

const S = {
  root: null,
  page: 'home',
  health: null,
  timer: null,
  statsEl: null,
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

function buildBar(bar) {
  const mode = readMode();
  const modeName = (RESOURCE_MODES[mode] || RESOURCE_MODES.normal).name;
  bar.innerHTML = `
    <a class="tb-brand" href="index.html" title="Stratos home">
      <span class="tb-mark">${ICON.plane}</span>
      <span>STRATOS<small>FLIGHT DECK</small></span>
    </a>
    <span class="tb-gap"></span>
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
      <a class="tb-btn" href="pilot.html#settings" title="Settings" aria-label="Settings">${ICON.settings}</a>
      <a class="tb-btn" href="logbook.html#profile" title="Pilot profile" aria-label="Pilot profile"><span class="tb-avatar">PF</span></a>
    </div>`;

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
export function mountShell({ page = 'home', stats = false } = {}) {
  S.page = page;
  S.root = document.querySelector('.shell') || document.body;
  S.statsEl = document.getElementById('homestats');

  const bar = document.getElementById('appbar');
  if (bar) buildBar(bar);

  S.root.querySelectorAll('[data-nav]').forEach(item => {
    const active = item.dataset.nav === page;
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  const shell = S.root;
  if (shell.classList.contains('shell')) {
    try {
      if (localStorage.getItem('stratos.rail') === 'collapsed') shell.dataset.collapsed = '1';
    } catch (_) { /* private mode */ }
    shell.querySelector('[data-rail-toggle]')?.addEventListener('click', () => {
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
