/* Shared helpers for the pilot sections. */

import { BUNDLED_AIRPORTS, searchAirports } from '../data/airports.js';
import { searchPlaces } from '../lib/planner.js';
import { esc, fmtDate, statusDot, tag } from '../ui.js';

let directoryCache = null;
let directorySource = 'Bundled OurAirports snapshot';

export function bundledDirectory() {
  return BUNDLED_AIRPORTS.map(airport => ({ ...airport, source: 'bundled' }));
}

/** Bundled airports plus, when the bridge is reachable, its worldwide list. */
export async function loadDirectory(bridgeBase) {
  if (directoryCache) return directoryCache;
  const merged = new Map();
  for (const airport of BUNDLED_AIRPORTS) {
    merged.set(airport.id, { ...airport, source: 'bundled' });
  }
  if (bridgeBase) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(bridgeBase.replace(/\/+$/, '') + '/airports.json', {
        credentials: location.protocol === 'file:' ? 'omit' : 'include', cache: 'no-store', signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok && (response.headers.get('content-type') || '').includes('json')) {
        const rows = await response.json();
        if (Array.isArray(rows) && rows.length) {
          for (const row of rows) {
            if (!Array.isArray(row) || row.length < 5) continue;
            merged.set(row[0], {
              id: row[0], name: row[1], lat: Number(row[2]), lon: Number(row[3]),
              elev: Number(row[4]) || 0,
              rw: Array.isArray(row[5]) ? row[5] : [],
              len: Array.isArray(row[6]) ? row[6] : [],
              rws: Array.isArray(row[7]) ? row[7] : [],
              fqs: row[8] || {},
              source: 'bridge',
            });
          }
          directorySource = `Bridge airport database (${rows.length.toLocaleString()} airports)`;
        }
      }
    } catch (_) {
      /* Bridge offline: the bundled snapshot is enough for the UI. */
    }
  }
  directoryCache = [...merged.values()];
  return directoryCache;
}

export function directoryLabel() {
  return directorySource;
}

export function searchDirectory(directory, query, limit = 12) {
  const results = searchPlaces(directory, query, limit);
  if (results.length) return results;
  return searchAirports(query, limit).map(a => ({ ...a, source: 'bundled' }));
}

/**
 * Wire an input to a results panel. The caller supplies a renderItem callback
 * returning HTML for a result, and an onPick callback.
 */
export function wireSearch(input, { getItems, renderItem, onPick, minChars = 1, emptyText = 'No matches.' }) {
  if (!input) return () => {};
  const panel = document.createElement('div');
  panel.className = 'dropdown-panel';
  panel.hidden = true;
  input.parentElement.style.position = 'relative';
  input.parentElement.appendChild(panel);
  let items = [];
  let index = -1;

  const hide = () => { panel.hidden = true; index = -1; };
  const select = i => {
    const item = items[i];
    if (!item) return;
    hide();
    onPick(item);
  };
  const show = () => {
    const query = input.value.trim();
    if (query.length < minChars) { hide(); return; }
    items = (getItems(query) || []).slice(0, 12);
    if (!items.length) {
      panel.innerHTML = `<div class="dropdown-empty">${esc(emptyText)}</div>`;
    } else {
      panel.innerHTML = items.map((item, i) => `<button type="button" data-index="${i}">${renderItem(item)}</button>`).join('');
    }
    panel.hidden = false;
    index = -1;
  };

  const onInput = () => show();
  const onKey = event => {
    if (panel.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      index = Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      [...panel.querySelectorAll('button')].forEach((button, i) => button.classList.toggle('focus', i === index));
      const active = panel.querySelectorAll('button')[index];
      if (active) active.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      if (index >= 0) { event.preventDefault(); select(index); }
    } else if (event.key === 'Escape') {
      hide();
    }
  };
  const onClick = event => {
    const button = event.target.closest('button[data-index]');
    if (button) select(Number(button.dataset.index));
  };
  const onDocClick = event => {
    if (!input.parentElement.contains(event.target)) hide();
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('focus', onInput);
  panel.addEventListener('mousedown', event => event.preventDefault());
  panel.addEventListener('click', onClick);
  document.addEventListener('click', onDocClick);
  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('focus', onInput);
    panel.removeEventListener('click', onClick);
    document.removeEventListener('click', onDocClick);
    panel.remove();
  };
}

export function airportResultHtml(airport) {
  const extra = [
    airport.elev != null ? `${Math.round(airport.elev)} ft` : null,
    airport.rw && airport.rw.length ? `RWY ${airport.rw.slice(0, 3).map(n => String(n).padStart(2, '0')).join('/')}` : null,
    airport.distanceNm != null ? `${Math.round(airport.distanceNm)} nm` : null,
  ].filter(Boolean).join(' · ');
  return `<span class="route-id">${esc(airport.id)}</span> ${esc(airport.name)}<span class="sub">${esc(extra)}</span>`;
}

export function flightRow(flight, extra = '') {
  const duration = flight.takeoffTime && flight.landingTime
    ? (flight.landingTime - flight.takeoffTime) / 1000 : null;
  const hours = duration ? `${Math.floor(duration / 3600)}:${String(Math.floor((duration % 3600) / 60)).padStart(2, '0')}` : '—';
  return `<div class="list-item">
    <div class="main">
      <div class="title"><span class="route-id">${esc(flight.depAirport || '????')}</span><span class="route-arrow">→</span><span class="route-id">${esc(flight.arrAirport || '????')}</span></div>
      <div class="sub">${esc(fmtDate(flight.startTime))} · ${esc(flight.aircraft || 'Unknown aircraft')} · ${hours}${flight.incomplete ? ' · incomplete' : ''}</div>
    </div>
    ${extra || `<span class="muted small nowrap">${flight.distanceNm ? `${Math.round(flight.distanceNm)} nm` : ''}</span>`}
  </div>`;
}

export function landingTag(classification, extraTitle = '') {
  if (!classification) return tag('No data');
  const tone = classification.tone === 'good' ? 'good' : classification.tone === 'warn' ? 'warn' : classification.tone === 'bad' ? 'bad' : 'muted';
  return tag(classification.label || classification.key, tone, extraTitle || classification.description || '');
}

export function bridgePill(health, status) {
  if (status === 'connected') return statusDot('connected', 'Simulator live');
  if (status === 'connecting' || status === 'reconnecting') return statusDot('connecting', 'Connecting to bridge');
  if (status === 'paused') return statusDot('paused', 'Live paused');
  if (!health) return statusDot('disconnected', 'Bridge offline');
  if (health.simulator && health.simulator.connected) return statusDot('connected', health.simulator.source || 'Simulator');
  return statusDot('waiting', 'Waiting for simulator');
}

export function sectionError(message, retryId = 'retry') {
  return `<div class="notice bad"><div><strong>Something went wrong.</strong><br>${esc(message)}</div>
    <span class="spacer"></span><button class="btn small" id="${esc(retryId)}">Retry</button></div>`;
}

export function classifyDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export const LANDING_FILTERS = ['all', 'smooth', 'good', 'firm', 'hard', 'severe', 'unclassified'];
