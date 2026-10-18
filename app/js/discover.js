// Route Discovery page controller.
//
// Reuses the app's own airport directory, route planner and map component: the
// engine only picks and describes airports, the planner owns the route, and a
// single MiniMap instance is redrawn when the selected recommendation changes.

import { mountShell } from './shell.js';
import { loadDirectory, directoryLabel } from './pilot/common.js';
import { defaultBridgeBase } from './bridge.js';
import { CATEGORIES, DURATIONS, AIRCRAFT, categoryById, durationById } from './discover/catalog.js';
import { REGIONS } from './discover/regions.js';
import { discoverRoutes, toWaypoints } from './discover/engine.js';
import { difficultyText, extractIcao, hoursText, nmText, routeLabel, stopsText } from './discover/format.js';
import { MiniMap } from './minimap.js';
import { esc, toast } from './ui.js';
import { getSavedRoutes, saveRoutes } from './lib/store.js';
import { createSavedRoute } from './lib/planner.js';

const PREFS_KEY = 'stratos.discover.prefs';
const RECENT_KEY = 'stratos.discover.recent';
const RECENT_LIMIT = 40;

const state = {
  category: 'scenic',
  duration: 'medium',
  aircraft: 'any',
  departure: '',
  regionId: '',
  difficulty: 'any',
  airports: [],
  result: null,
  selected: 0,
  map: null,
  seed: 1,
};

function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (CATEGORIES.some(c => c.id === saved.category)) state.category = saved.category;
      if (DURATIONS.some(d => d.id === saved.duration)) state.duration = saved.duration;
      if (AIRCRAFT.some(a => a.id === saved.aircraft)) state.aircraft = saved.aircraft;
      if (['any', 'easier', 'harder'].includes(saved.difficulty)) state.difficulty = saved.difficulty;
      if (typeof saved.departure === 'string') state.departure = saved.departure;
      if (REGIONS.some(r => r.id === saved.regionId)) state.regionId = saved.regionId;
    }
  } catch (_) { /* private mode: defaults are fine */ }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      category: state.category, duration: state.duration, aircraft: state.aircraft,
      difficulty: state.difficulty, departure: state.departure, regionId: state.regionId,
    }));
  } catch (_) { /* private mode */ }
}

function readRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(saved) ? saved.slice(-RECENT_LIMIT) : [];
  } catch (_) { return []; }
}

function rememberRecent(result) {
  try {
    const keys = (result.recommendations || []).map(reco => `${reco.stops[0].id}-${reco.stops[reco.stops.length - 1].id}`);
    const merged = [...readRecent(), ...keys].slice(-RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(merged));
  } catch (_) { /* private mode */ }
}

/* ── Rendering ───────────────────────────────────────────────────── */

function renderCategories() {
  const host = document.getElementById('categories');
  if (!host) return;
  host.innerHTML = CATEGORIES.map(category => `
    <button class="cat" type="button" data-category="${esc(category.id)}"
      aria-pressed="${category.id === state.category}" style="--acc:${esc(category.accent)}">
      <span class="cat-icon"><svg viewBox="0 0 24 24">${category.icon}</svg></span>
      <b>${esc(category.label)}</b>
      <small>${esc(category.blurb)}</small>
    </button>`).join('');
}

function renderDurations() {
  const host = document.getElementById('durations');
  if (!host) return;
  host.innerHTML = DURATIONS.map(band => `
    <button class="chip" type="button" data-duration="${esc(band.id)}"
      aria-pressed="${band.id === state.duration}">${esc(band.label)}</button>`).join('');
}

function renderDifficulty() {
  const host = document.getElementById('difficulty');
  if (!host) return;
  const options = [
    { id: 'any', label: 'Any' },
    { id: 'easier', label: 'Easier' },
    { id: 'harder', label: 'More challenging' },
  ];
  host.innerHTML = options.map(option => `
    <button class="chip" type="button" data-difficulty="${option.id}"
      aria-pressed="${option.id === state.difficulty}">${esc(option.label)}</button>`).join('');
}

function renderSelectors() {
  const aircraft = document.getElementById('aircraft');
  if (aircraft) {
    aircraft.innerHTML = AIRCRAFT.map(type => `<option value="${esc(type.id)}"${type.id === state.aircraft ? ' selected' : ''}>${esc(type.label)}</option>`).join('');
  }
  const region = document.getElementById('region');
  if (region) {
    region.innerHTML = '<option value="">Anywhere</option>' + REGIONS
      .map(entry => `<option value="${esc(entry.id)}"${entry.id === state.regionId ? ' selected' : ''}>${esc(entry.name)}</option>`)
      .join('');
  }
  const departure = document.getElementById('departure');
  if (departure) departure.value = state.departure;
}

function renderAirportList() {
  const list = document.getElementById('airport-list');
  if (!list) return;
  const rows = state.airports.slice(0, 600);
  list.innerHTML = rows.map(airport => `<option value="${esc(airport.id)}">${esc(airport.name)}</option>`).join('');
}

function cardHtml(reco, index) {
  const category = categoryById(reco.categoryId);
  const stops = reco.stops.map((stop, i) => `
    ${i ? '<span class="arrow">→</span>' : ''}
    <span class="icao">${esc(stop.id)}</span><span class="name">${esc(stop.name)}</span>`).join('');
  const highlights = (reco.highlights || []).map(item => `<span>${esc(item)}</span>`).join('');
  const band = durationById(state.duration);
  const outside = reco.withinWindow === false
    ? `<span class="pill warn" title="The closest match available in this airport database">Outside ${esc(band.label)}</span>`
    : '';
  return `
  <article class="route-card" data-index="${index}" aria-selected="${index === state.selected}" tabindex="0">
    <div class="route-head">
      <h3>${esc(reco.name)}</h3>
      ${outside}
      <span class="pill">${esc(category.label)}</span>
    </div>
    <div class="route-track">${stops}</div>
    <div class="route-metrics">
      <div><b>${esc(hoursText(reco.hours))}</b><span>estimated</span></div>
      <div><b>${esc(nmText(reco.nm))}</b><span>distance</span></div>
      <div><b>${esc(reco.aircraft.label)}</b><span>aircraft</span></div>
      <div><b>${esc(difficultyText(reco.difficulty))}</b><span>difficulty</span></div>
    </div>
    <p class="route-why">${esc(reco.explanation)}</p>
    ${highlights ? `<div class="route-highlights">${highlights}</div>` : ''}
    <div class="route-actions">
      <button class="btn" type="button" data-act="view" data-index="${index}">View Route</button>
      <button class="btn" type="button" data-act="fly" data-index="${index}">Fly This Route</button>
      <button class="btn" type="button" data-act="save" data-index="${index}">Save Route</button>
    </div>
  </article>`;
}

function renderResults() {
  const host = document.getElementById('results');
  if (!host) return;
  const result = state.result;
  if (!result) { host.innerHTML = ''; return; }

  if (!result.recommendations.length) {
    host.innerHTML = `
      <div class="empty notice bad">
        <div><strong>No routes to show.</strong><br>${esc(result.limitations[0] || 'The airport database did not answer.')}</div>
      </div>`;
    return;
  }

  const category = categoryById(result.recommendations[0].categoryId);
  const band = durationById(state.duration);
  const limitations = (result.limitations || []).length
    ? `<div class="notice" style="grid-column:1/-1;margin-bottom:4px"><div><strong>Data note</strong><ul>${
      result.limitations.map(line => `<li>${esc(line)}</li>`).join('')}</ul></div></div>`
    : '';

  host.innerHTML = `
    ${limitations}
    <div class="result-head">
      <h2>${esc(category.label)} · ${esc(band.label)}</h2>
      <span class="hint">Estimates assume ${esc(result.aircraft.note)}, no wind, and include ground time.</span>
      <span class="spacer"></span>
      <button class="btn ghost" type="button" id="again">Show me different ideas</button>
    </div>
    <div class="route-list">${result.recommendations.map(cardHtml).join('')}</div>
    <aside class="map-panel">
      <canvas class="map-canvas" id="discover-map" aria-label="Route preview map"></canvas>
      <div class="map-meta" id="map-meta"></div>
    </aside>`;

  bindResultEvents(host);
  initMap();
  selectRoute(state.selected, { scroll: false });
}

function updateMapMeta() {
  const result = state.result;
  const meta = document.getElementById('map-meta');
  if (!result || !meta) return;
  const reco = result.recommendations[state.selected];
  if (!reco) { meta.innerHTML = ''; return; }
  meta.innerHTML = `
    <b>${esc(reco.name)}</b>
    <span>${esc(routeLabel(reco))} · ${esc(nmText(reco.nm))} · ${esc(hoursText(reco.hours))} · ${esc(stopsText(reco.stops))}</span>
    <span>Estimated values; tiles © OpenStreetMap contributors, CARTO.</span>
    <span class="legend"><span><i></i>Route line</span><span><i style="background:#f6c453"></i>Airports</span></span>`;
}

function initMap() {
  const canvas = document.getElementById('discover-map');
  if (!canvas || state.map) return;
  if (typeof canvas.getContext !== 'function' || !canvas.getContext('2d')) return;
  try {
    state.map = new MiniMap(canvas, { padding: 40 });
  } catch (_) {
    state.map = null; // canvas unavailable: the text summary still works
  }
}

function selectRoute(index, { scroll = false } = {}) {
  const result = state.result;
  if (!result) return;
  const reco = result.recommendations[index];
  if (!reco) return;
  state.selected = index;
  document.querySelectorAll('.route-card').forEach(card => {
    card.setAttribute('aria-selected', String(Number(card.dataset.index) === index));
  });
  try {
    state.map?.setTrack(reco.stops.map(stop => ({ lat: stop.lat, lon: stop.lon })));
  } catch (_) { /* map is decorative */ }
  updateMapMeta();
  const panel = document.querySelector('.map-panel');
  if (scroll && panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveRoute(reco) {
  try {
    const saved = await getSavedRoutes();
    const points = toWaypoints(reco);
    const duplicate = saved.some(route => {
      const ids = (route.points || []).map(point => point.id);
      return ids[0] === points[0].id && ids[ids.length - 1] === points[points.length - 1].id && ids.length === points.length;
    });
    if (duplicate) {
      toast('That route is already in your saved routes.', '');
      return;
    }
    const route = createSavedRoute(reco.name, points);
    await saveRoutes([route, ...saved]);
    toast(`Saved “${reco.name}” to your routes.`, 'good');
  } catch (error) {
    toast(`Could not save the route: ${error.message}`, 'bad');
  }
}

function flyRoute(reco) {
  const points = toWaypoints(reco);
  try {
    localStorage.setItem('dl.route', JSON.stringify(points.map(point => ({
      id: point.id, name: point.name, lat: point.lat, lon: point.lon, elev: point.elev, k: 'apt',
    }))));
    localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: null, name: reco.name, points }));
    location.href = 'pilot.html#routes';
  } catch (_) {
    toast('This browser refused local storage, so the route could not be handed over.', 'bad');
  }
}

function bindResultEvents(host) {
  host.querySelectorAll('.route-card').forEach(card => {
    card.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      selectRoute(Number(card.dataset.index));
    });
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectRoute(Number(card.dataset.index));
      }
    });
  });
  host.querySelectorAll('[data-act]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const reco = state.result?.recommendations[Number(button.dataset.index)];
      if (!reco) return;
      const action = button.dataset.act;
      if (action === 'view') selectRoute(Number(button.dataset.index), { scroll: true });
      if (action === 'fly') flyRoute(reco);
      if (action === 'save') saveRoute(reco);
    });
  });
  host.querySelector('#again')?.addEventListener('click', () => generate({ fresh: true }));
}

function generate({ fresh = true } = {}) {
  if (!state.airports.length) {
    toast('Airport data is still loading.', 'bad');
    return;
  }
  const departure = extractIcao(document.getElementById('departure')?.value || '');
  state.departure = departure;
  savePrefs();
  if (fresh) state.seed = Math.floor(Math.random() * 1e9);
  state.result = discoverRoutes(state.airports, {
    category: state.category,
    duration: state.duration,
    aircraft: state.aircraft,
    difficulty: state.difficulty,
    departure: state.departure,
    regionId: state.regionId,
    seed: state.seed,
    recent: readRecent(),
  });
  state.selected = 0;
  rememberRecent(state.result);
  renderResults();
  const results = document.getElementById('results');
  if (results && typeof results.scrollIntoView === 'function') results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindControls() {
  document.getElementById('categories')?.addEventListener('click', event => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.category = button.dataset.category;
    renderCategories();
    savePrefs();
  });
  document.getElementById('durations')?.addEventListener('click', event => {
    const button = event.target.closest('[data-duration]');
    if (!button) return;
    state.duration = button.dataset.duration;
    renderDurations();
    savePrefs();
    if (state.result) generate({ fresh: true });
  });
  document.getElementById('difficulty')?.addEventListener('click', event => {
    const button = event.target.closest('[data-difficulty]');
    if (!button) return;
    state.difficulty = button.dataset.difficulty;
    renderDifficulty();
    savePrefs();
    if (state.result) generate({ fresh: true });
  });
  document.getElementById('aircraft')?.addEventListener('change', event => {
    state.aircraft = event.target.value;
    savePrefs();
    if (state.result) generate({ fresh: true });
  });
  document.getElementById('region')?.addEventListener('change', event => {
    state.regionId = event.target.value;
    savePrefs();
    if (state.result) generate({ fresh: true });
  });
  document.getElementById('find')?.addEventListener('click', () => generate({ fresh: true }));
  document.getElementById('reset')?.addEventListener('click', () => {
    state.category = 'scenic';
    state.duration = 'medium';
    state.aircraft = 'any';
    state.difficulty = 'any';
    state.departure = '';
    state.regionId = '';
    state.result = null;
    renderCategories(); renderDurations(); renderDifficulty(); renderSelectors();
    const host = document.getElementById('results');
    if (host) {
      host.innerHTML = '<div class="empty notice"><div><strong>Preferences reset.</strong><br>Pick a mood and press Find My Adventure.</div></div>';
    }
    try { localStorage.removeItem(PREFS_KEY); } catch (_) { /* private mode */ }
    toast('Preferences reset.', '');
  });
}

async function boot() {
  mountShell({ page: 'discover', theme: true });
  readPrefs();
  renderCategories();
  renderDurations();
  renderDifficulty();
  renderSelectors();
  bindControls();

  try {
    state.airports = await loadDirectory(defaultBridgeBase());
  } catch (_) {
    state.airports = [];
  }
  renderAirportList();
  const note = document.getElementById('db-note');
  if (note) {
    note.textContent = state.airports.length
      ? `${directoryLabel()} · ${state.airports.length.toLocaleString()} airports`
      : 'Airport database unavailable — connect the Stratos bridge for the worldwide list.';
  }
}

if (typeof document !== 'undefined' && document.getElementById('categories')) boot();
