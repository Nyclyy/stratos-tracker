// Stratos application shell: the sidebar rail, the top bar and the UTC clock.
//
// The chrome is deliberately thin and reports real state only. The bridge's
// /health endpoint decides whether the simulator is live, so a disconnected
// simulator can never be shown as connected. On the Flight Deck the page owns
// the connection line and the search box (it knows about the traffic feed and
// the airport database), so the shell moves those nodes into the bar instead of
// duplicating them: one search, one status line, one place to look.
//
// The rail is the page's own navigation, group-and-iconised here so every page
// keeps one language. The Flight Deck opens as an icon rail; the choice to
// expand it is remembered per browser, and the tooltips carry the names.

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
  expand: SVG('<path d="M10 6l6 6-6 6"/>'),
  heart: SVG('<path d="M12 20.5l-1.2-1.1C6.4 15.6 3.5 13 3.5 9.8A4.3 4.3 0 0 1 8 5.5c1.5 0 2.9.7 4 1.9a5.3 5.3 0 0 1 4-1.9 4.3 4.3 0 0 1 4.5 4.3c0 3.2-2.9 5.8-7.3 9.6z"/>', true),
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

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const S = {
  root: null,
  page: 'home',
  health: null,
  timer: null,
  clock: null,
  live: null,
  pageStatus: null,
  utc: true,
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
    return { cls: 'is-live', text: sim.source ? `Live from ${sim.source}` : 'Simulator live', title: `Receiving telemetry${sim.source ? ` from ${sim.source}` : ''}` };
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

/**
 * Paint the status: the pills on pages that show them, and the line under the
 * brand either way. The page's own status node wins when it has one — the map
 * knows about the traffic feed, which /health cannot see.
 */
function renderStatus() {
  const sim = S.root?.querySelector('[data-status="sim"]');
  const live = S.root?.querySelector('[data-status="live"]');
  const state = simulatorState();
  const liveS = liveState();
  if (sim) {
    sim.className = `status ${state.cls}`;
    sim.title = state.title;
    sim.innerHTML = `<i></i><span>${esc(state.text)}</span>`;
  }
  if (live) {
    live.className = `status ${liveS.cls}`;
    live.title = liveS.title;
    live.innerHTML = `<i></i><span>${esc(liveS.text)}</span>`;
  }
  const brand = S.root?.querySelector('[data-brand-state]');
  if (!brand) return;
  brand.title = `${state.title}. ${liveS.title}`;
  brand.dataset.state = state.cls.replace(/^is-/, '');
  const page = S.pageStatus;
  if (!page) {
    brand.textContent = state.text;
    return;
  }
  // The page writes its own text every frame; only fill an empty line so the
  // bar never shows a blank state before the first frame lands.
  if (!page.textContent.trim()) page.textContent = state.text;
}

/** HHMMZ over the date, in UTC or in the pilot's own zone. Text only. */
function stamp(utc) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const hh = utc ? d.getUTCHours() : d.getHours();
  const mm = utc ? d.getUTCMinutes() : d.getMinutes();
  const day = utc ? d.getUTCDate() : d.getDate();
  const mon = MONTHS[(utc ? d.getUTCMonth() : d.getMonth())] || '';
  return { time: `${pad(hh)}${pad(mm)}${utc ? 'Z' : ''}`, date: `${day} ${mon}` };
}

function paintClock() {
  const el = S.root?.querySelector('[data-clock]');
  if (!el) return;
  const now = stamp(S.utc);
  const time = el.querySelector('b');
  const date = el.querySelector('small');
  if (time && time.textContent !== now.time) time.textContent = now.time;
  if (date && date.textContent !== now.date) date.textContent = now.date;
  el.title = S.utc ? 'UTC — click for local time' : 'Local time — click for UTC';
}

/** The support page is the project's own link; nothing is sold from the app. */
function supportUrl() {
  try {
    return String(window.STRATOS_SUPPORT_URL || localStorage.getItem('stratos.supportUrl') || '').trim();
  } catch (_) {
    try { return String(window.STRATOS_SUPPORT_URL || '').trim(); } catch (_) { return ''; }
  }
}

function openSupport() {
  const url = supportUrl();
  const dialog = document.createElement('dialog');
  dialog.className = 'shell-dialog';
  dialog.setAttribute('aria-label', 'Support Stratos');
  dialog.innerHTML = `
    <h2>Support Stratos</h2>
    <p>Stratos is free and complete: every map layer, chart link, logbook and phone feature in this build is unlocked. The name on this button is a promise, not a product.</p>
    ${url
      ? `<p><a class="shell-dialog-cta" href="${esc(url)}" target="_blank" rel="noopener">${ICON.heart}<span>Open the support page</span></a></p>`
      : '<p class="shell-dialog-note">No support page is configured in this build yet, so there is nowhere for this button to send you. Set one and it opens here.</p>'}
    <div class="shell-dialog-row"><button type="button" data-close class="shell-dialog-close">Close</button></div>`;
  document.body.appendChild(dialog);

  const close = () => {
    try { dialog.close?.(); } catch (_) { /* already closed */ }
    dialog.remove();
  };
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', close);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  dialog.querySelector('[data-close]')?.focus?.();
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

/**
 * The icon rail hides its labels, so the name has to follow the pointer and the
 * keyboard focus. A native title never appears for keyboard users, so this is
 * one small tooltip that serves both and stays out of the layout.
 */
function bindRailTips(shell, rail) {
  if (!rail) return null;
  const tip = document.createElement('div');
  tip.className = 'rail-tip';
  tip.setAttribute('aria-hidden', 'true');
  tip.hidden = true;
  document.body.appendChild(tip);

  const collapsed = () => shell.dataset.collapsed === '1';
  let timer = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const hide = () => { clear(); tip.hidden = true; };
  const itemAt = event => event.target?.closest?.('.tab') || null;
  const show = item => {
    clear();
    if (!collapsed() || !item) return hide();
    const name = item.dataset.label || item.getAttribute('aria-label') || '';
    if (!name) return hide();
    tip.textContent = name;
    tip.hidden = false;
    const box = item.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    tip.style.left = `${Math.round(railBox.right + 8)}px`;
    tip.style.top = `${Math.round(box.top + box.height / 2)}px`;
  };
  // A pointer crossing the rail shows only the icon it settles on; a name that
  // is already up moves straight to the next row instead of flashing off.
  const showSoon = item => {
    clear();
    if (!collapsed() || !item) return hide();
    if (!tip.hidden) return show(item);
    timer = setTimeout(() => { timer = null; show(item); }, 140);
  };
  const onOver = event => showSoon(itemAt(event));
  const onFocus = event => show(itemAt(event));
  const onKey = event => { if (event.key === 'Escape') hide(); };

  rail.addEventListener('pointerover', onOver);
  rail.addEventListener('pointerleave', hide);
  rail.addEventListener('focusin', onFocus);
  rail.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', onKey);

  return {
    hide,
    tip,
    destroy: () => {
      clear();
      rail.removeEventListener('pointerover', onOver);
      rail.removeEventListener('pointerleave', hide);
      rail.removeEventListener('focusin', onFocus);
      rail.removeEventListener('focusout', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      document.removeEventListener('keydown', onKey);
      tip.remove();
    },
  };
}

function buildBar(bar, { theme = false, rail = false, search = null, status = null } = {}) {
  const mode = readMode();
  const title = bar.dataset.title || PAGE_TITLE[S.page] || 'Stratos';
  const context = bar.dataset.context || '';
  bar.innerHTML = `
    <a class="tb-brand" href="index.html" title="Stratos home">
      <span class="tb-mark">${ICON.plane}</span>
      <span class="tb-name">STRATOS<small class="tb-state" data-brand-state>${status ? '' : esc(context ? `${title} · ${context}` : title)}</small></span>
    </a>
    <div class="tb-search" data-search-slot></div>
    ${rail ? "" : `<nav class="tb-nav" aria-label="Pages">
      <a href="index.html" data-page="home">Flight Deck</a>
      <a href="discover.html" data-page="discover">Discover</a>
      <a href="logbook.html" data-page="logbook">Logbook</a>
      <a href="weather.html" data-page="weather">Weather</a>
      <a href="live.html" data-page="live">Live</a>
    </nav>`}
    <span class="tb-gap"></span>
    ${status ? '' : `<div class="tb-status" data-status-host>
      <div class="status is-off" data-status="sim" title="Simulator status"><i></i><span>No connection</span></div>
      <div class="status is-off" data-status="live" title="Live tracking status"><i></i><span>No live data</span></div>
    </div>`}
    <button class="tb-support" data-support type="button" title="Support Stratos — the app is complete without it">
      <span>Support Us</span><b>${ICON.heart}Go Premium</b>
    </button>
    <button class="tb-clock" data-clock type="button" title="UTC">
      <b>--:--Z</b><small>--</small>
    </button>
    <div class="tb-actions">
      ${theme ? '<button class="tb-btn" id="shell-theme" type="button">Night mode</button>' : ''}
      <label class="tb-perf-wrap" title="Resource profile: ${esc((RESOURCE_MODES[mode] || {}).description || '')}">
        <select class="tb-perf" aria-label="Resource profile">
          ${Object.values(RESOURCE_MODES).map(profile => `<option value="${esc(profile.key)}"${profile.key === mode ? ' selected' : ''}>${esc(profile.name)}</option>`).join('')}
        </select>
      </label>
      <a class="tb-btn" href="pilot.html#settings" title="Settings" aria-label="Settings">${ICON.settings}</a>
      <a class="tb-btn" href="logbook.html#profile" title="Pilot profile" aria-label="Pilot profile"><span class="tb-avatar">PF</span></a>
    </div>`;

  // Only the rail pages have room to centre the search on the bar itself;
  // the others carry a nav next to the brand and keep the flex layout.
  bar.classList.toggle('tb--rail', Boolean(rail));

  // The Flight Deck's own search box and connection line move into the bar, so
  // there is one of each and their listeners come along with the nodes.
  const slot = bar.querySelector('[data-search-slot]');
  if (slot && search) slot.appendChild(search);
  const state = bar.querySelector('[data-brand-state]');
  if (state && status) state.appendChild(status);

  bar.querySelectorAll('.tb-nav a').forEach(link => {
    if (link.dataset.page === S.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  bar.querySelector('[data-support]')?.addEventListener('click', openSupport);
  bar.querySelector('[data-clock]')?.addEventListener('click', () => {
    S.utc = !S.utc;
    try { localStorage.setItem('stratos.clock', S.utc ? 'utc' : 'local'); } catch (_) { /* private mode */ }
    paintClock();
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
      const host = bar.querySelector('[data-status-host]') || bar.querySelector('.tb-actions');
      if (host) {
        const note = bar.querySelector('[data-perf-note]') || document.createElement('span');
        note.dataset.perfNote = '1';
        note.className = 'status is-wait';
        note.textContent = `${RESOURCE_MODES[next].name} applies on reload`;
        host.appendChild(note);
        setTimeout(() => note.remove(), 4000);
      }
    }
  });
  paintClock();
  renderStatus();
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
 * Mount the shared chrome. Pages provide an empty `<header id="appbar">` and
 * may mark the nodes the shell should adopt: `[data-shell-search]` moves into
 * the centred search slot and `[data-shell-status]` becomes the line under the
 * brand. The shell owns neither of them, so the page keeps writing to them.
 */
export function mountShell({ page = 'home', theme = false } = {}) {
  S.page = page;
  S.root = document.querySelector('.app-shell') || document.body;

  const bar = document.getElementById('appbar');
  const search = document.querySelector('[data-shell-search]');
  const status = document.querySelector('[data-shell-status]');
  S.pageStatus = status;
  if (bar) buildBar(bar, { theme, rail: Boolean(S.root.querySelector('#tabs')), search, status });

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

  let railTips = null;
  if (shell.classList.contains('app-shell')) {
    try {
      const saved = localStorage.getItem('stratos.rail');
      // The Flight Deck opens as an icon rail; only an explicit choice expands it.
      if (saved === 'open') delete shell.dataset.collapsed;
      else shell.dataset.collapsed = '1';
    } catch (_) {
      shell.dataset.collapsed = '1';
    }
    const toggle = shell.querySelector('[data-rail-toggle]');
    const tips = railTips = bindRailTips(shell, rail);
    const label = () => {
      const collapsed = shell.dataset.collapsed === '1';
      tips?.hide();
      // Expanded rows show their own label, so the native title is their tip;
      // icon rows use the focus-aware tooltip instead of a duplicate title.
      for (const item of rail ? rail.querySelectorAll('.tab') : []) {
        if (collapsed) item.removeAttribute('title');
        else if (item.dataset.label) item.setAttribute('title', item.dataset.label);
      }
      if (!toggle) return;
      const text = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      if (collapsed) toggle.removeAttribute('title');
      else toggle.title = text;
      toggle.setAttribute('aria-label', text);
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      const span = toggle.querySelector('span');
      if (span) span.textContent = collapsed ? 'Expand' : 'Collapse';
      const glyph = toggle.querySelector('b');
      if (glyph) glyph.innerHTML = collapsed ? ICON.expand : ICON.collapse;
    };
    label();
    toggle?.addEventListener('click', () => {
      const collapsed = shell.dataset.collapsed === '1';
      if (collapsed) delete shell.dataset.collapsed;
      else shell.dataset.collapsed = '1';
      try { localStorage.setItem('stratos.rail', collapsed ? 'open' : 'collapsed'); } catch (_) { /* private mode */ }
      label();
    });
  }

  try {
    if (localStorage.getItem('stratos.clock') === 'local') S.utc = false;
  } catch (_) { /* private mode */ }

  pollHealth();
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) pollHealth(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollHealth(); });
  // A minute-resolution clock: the timer only writes when the text changes.
  if (S.clock) clearInterval(S.clock);
  S.clock = setInterval(paintClock, 1000);
  paintClock();

  window.StratosShell = {
    refresh: () => pollHealth(),
    setLive: value => { S.live = Boolean(value); renderStatus(); },
    health: () => S.health,
    clock: () => stamp(S.utc),
    destroy: () => {
      if (S.timer) clearInterval(S.timer);
      if (S.clock) clearInterval(S.clock);
      S.timer = null;
      S.clock = null;
      railTips?.destroy();
      railTips = null;
    },
  };
  return window.StratosShell;
}

export default mountShell;
