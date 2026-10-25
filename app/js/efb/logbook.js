/* EFB · Flight Log.
 *
 * The same local logbook the Career, Landings and Replay pages read — no second
 * store, no duplicated records. Every row says whether it was recorded by the
 * bridge or entered/imported, and the detail view marks what the recorder could
 * not measure instead of filling it in.
 */

import { esc, fmtFt, fmtNum } from './common.js';
import { getFlights } from '../lib/store.js';

function dateText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toISOString().slice(0, 10);
}

function clockText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toISOString().slice(11, 16) + 'Z';
}

function durationMinutes(flight) {
  const takeoff = Number(flight.takeoffTime);
  const landing = Number(flight.landingTime);
  if (Number.isFinite(takeoff) && Number.isFinite(landing) && landing > takeoff) return Math.round((landing - takeoff) / 60000);
  const start = Number(flight.startTime);
  const end = Number(flight.endTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.round((end - start) / 60000);
  return null;
}

function durationText(minutes) {
  if (minutes == null) return '—';
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export async function mount(root, ctx) {
  let flights = [];
  let loading = true;
  let error = '';
  let query = '';
  let year = '';
  let selectedId = null;
  let destroyed = false;

  root.innerHTML = '<div class="e-loading"><i></i>Reading the logbook…</div>';

  function years() {
    const set = new Set();
    for (const flight of flights) {
      const n = Number(flight.startTime);
      if (Number.isFinite(n) && n > 0) set.add(new Date(n).getUTCFullYear());
    }
    return [...set].sort((a, b) => b - a);
  }

  function filtered() {
    const term = query.trim().toUpperCase();
    return flights
      .filter(flight => {
        if (year && String(new Date(Number(flight.startTime) || 0).getUTCFullYear()) !== year) return false;
        if (!term) return true;
        const haystack = [flight.depAirport, flight.arrAirport, flight.aircraft, flight.registration, flight.callsign, flight.sim]
          .filter(Boolean).join(' ').toUpperCase();
        return haystack.includes(term);
      })
      .sort((a, b) => Number(b.startTime || 0) - Number(a.startTime || 0));
  }

  function totals(rows) {
    let minutes = 0;
    let nm = 0;
    let landings = 0;
    for (const flight of rows) {
      const d = durationMinutes(flight);
      if (d != null) minutes += d;
      if (Number.isFinite(Number(flight.distanceNm))) nm += Number(flight.distanceNm);
      if (flight.landing && Number.isFinite(Number(flight.landing.vsFpm))) landings += 1;
    }
    return { minutes, nm, landings, count: rows.length };
  }

  function renderDetail(flight) {
    if (!flight) return '';
    const landing = flight.landing || null;
    const recorded = flight.recordedBy === 'bridge';
    return `<div class="e-card" style="margin-bottom:12px" id="log-detail">
      <div class="e-row" style="align-items:flex-start">
        <div>
          <div class="e-hero"><b>${esc(flight.depAirport || '????')} <s>→</s> ${esc(flight.arrAirport || '????')}</b></div>
          <div class="e-small e-muted" style="margin-top:2px">${esc(dateText(flight.startTime))} · ${esc(clockText(flight.startTime))} · ${esc(flight.aircraft || 'Aircraft not reported')}${flight.registration ? ` · ${esc(flight.registration)}` : ''}</div>
        </div>
        <span class="e-spacer"></span>
        <span class="e-badge ${recorded ? 'accent' : ''}">${recorded ? 'Recorded by bridge' : 'Local / imported'}</span>
        <button class="e-btn small ghost" type="button" data-close-detail aria-label="Close details">×</button>
      </div>
      <div class="e-grid four" style="margin-top:12px">
        <div><div class="e-label">Airborne</div><div class="e-value">${durationText(durationMinutes(flight))}</div></div>
        <div><div class="e-label">Distance</div><div class="e-value">${flight.distanceNm != null ? `${fmtNum(flight.distanceNm, 0)} nm` : '—'}</div></div>
        <div><div class="e-label">Max altitude</div><div class="e-value">${flight.maxAlt ? fmtFt(flight.maxAlt) : '—'}</div></div>
        <div><div class="e-label">Landing</div><div class="e-value">${landing && landing.vsFpm != null ? `${fmtNum(landing.vsFpm)} fpm` : flight.landingVS != null ? `${fmtNum(flight.landingVS)} fpm` : '—'}</div></div>
      </div>
      <dl class="e-kv" style="margin-top:12px">
        <dt>Simulator</dt><dd>${esc(flight.sim || 'unknown')}</dd>
        <dt>Callsign</dt><dd>${esc(flight.callsign || '—')}</dd>
        <dt>Runway at touchdown</dt><dd>${landing && landing.runway ? esc(landing.runway.id) : 'not measured'}</dd>
        <dt>Track</dt><dd>${Array.isArray(flight.track) && flight.track.length ? `${flight.track.length} recorded samples` : 'no recorded track'}</dd>
        <dt>Fuel at departure</dt><dd>${flight.fuelDep != null ? fmtNum(flight.fuelDep) : '—'}</dd>
        <dt>Fuel at arrival</dt><dd>${flight.fuelArr != null ? fmtNum(flight.fuelArr) : '—'}</dd>
        <dt>Notes</dt><dd>${esc(flight.notes || '—')}</dd>
      </dl>
      ${flight.incomplete ? '<div class="e-notice warn" style="margin-top:10px">The recorder marked this flight incomplete. It is kept for reference; missing values are not estimated.</div>' : ''}
      ${landing && landing.estimated ? '<div class="e-notice" style="margin-top:10px">Some landing values are marked as estimates in the record (the source did not report them directly).</div>' : ''}
      <div class="e-row" style="margin-top:12px">
        ${Array.isArray(flight.track) && flight.track.length > 1 ? `<a class="e-btn small" href="pilot.html#/replay?flight=${encodeURIComponent(flight.id)}">Replay in the tracker ↗</a>` : ''}
        <a class="e-btn small ghost" href="logbook.html">Open the full logbook ↗</a>
      </div>
    </div>`;
  }

  function render() {
    if (destroyed) return;
    const rows = filtered();
    const stats = totals(rows);
    const selected = flights.find(flight => flight.id === selectedId) || null;
    ctx.setSubtitle(`${flights.length} recorded flight${flights.length === 1 ? '' : 's'}`);
    root.innerHTML = `
      <div class="e-row" style="margin-bottom:12px">
        <input class="e-input small" id="log-search" placeholder="Search airport, aircraft or callsign" value="${esc(query)}" style="max-width:320px" aria-label="Search the logbook">
        <select class="e-select" id="log-year" style="max-width:150px" aria-label="Filter by year">
          <option value="">All years</option>
          ${years().map(value => `<option value="${value}" ${String(value) === year ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
        <span class="e-spacer"></span>
        <span class="e-small e-faint">${stats.count} shown · ${durationText(stats.minutes)} · ${fmtNum(stats.nm, 0)} nm</span>
      </div>
      <div id="log-detail-host">${renderDetail(selected)}</div>
      ${loading ? '<div class="e-loading"><i></i>Reading the logbook…</div>'
        : error ? `<div class="e-notice bad">${esc(error)}</div>`
        : !flights.length ? `<div class="e-empty"><b>No flights recorded yet</b><p>Flights appear here when the bridge records one, or when the tracker syncs its logbook. Stratos does not invent a flight to fill the space.</p><a class="e-btn small" href="index.html">Open the Flight Deck</a></div>`
        : !rows.length ? '<div class="e-empty"><b>Nothing matches</b><p>Clear the search or choose another year.</p></div>'
        : `<div class="e-card" style="padding:6px 12px 8px;overflow-x:auto">
            <table class="e-table">
              <thead><tr><th>Date</th><th>Flight</th><th>Aircraft</th><th class="num">Airborne</th><th class="num">Distance</th><th class="num">Landing</th></tr></thead>
              <tbody>${rows.map(flight => `<tr data-flight="${esc(flight.id)}" style="cursor:pointer" class="${flight.id === selectedId ? 'is-current' : ''}">
                <td>${esc(dateText(flight.startTime))}</td>
                <td><b>${esc(flight.depAirport || '????')} → ${esc(flight.arrAirport || '????')}</b>${flight.callsign ? `<div class="e-small e-faint">${esc(flight.callsign)}</div>` : ''}</td>
                <td>${esc(flight.aircraft || '—')}${flight.registration ? `<div class="e-small e-faint">${esc(flight.registration)}</div>` : ''}</td>
                <td class="num">${durationText(durationMinutes(flight))}</td>
                <td class="num">${flight.distanceNm != null ? `${fmtNum(flight.distanceNm, 0)} nm` : '—'}</td>
                <td class="num">${flight.landing && flight.landing.vsFpm != null ? `${fmtNum(flight.landing.vsFpm)} fpm` : flight.landingVS != null ? `${fmtNum(flight.landingVS)} fpm` : '—'}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>`}
      <div class="e-small e-faint" style="margin:14px 2px 0">This is the device's logbook (IndexedDB). Bridge records are imported, not duplicated. ${stats.landings ? `${stats.landings} of the shown flights have a measured landing rate.` : ''}</div>`;

    root.querySelector('#log-search')?.addEventListener('input', event => {
      query = event.target.value;
      const caret = event.target.selectionStart;
      render();
      const again = root.querySelector('#log-search');
      if (again) { again.focus(); if (caret != null) again.setSelectionRange(caret, caret); }
    });
    root.querySelector('#log-year')?.addEventListener('change', event => { year = event.target.value; render(); });
    root.querySelectorAll('[data-flight]').forEach(row => {
      row.addEventListener('click', () => { selectedId = row.dataset.flight; render(); });
    });
    root.querySelector('[data-close-detail]')?.addEventListener('click', () => { selectedId = null; render(); });
  }

  try {
    flights = await getFlights();
    flights = Array.isArray(flights) ? flights : [];
  } catch (loadError) {
    error = `The logbook could not be read: ${loadError.message}`;
  }
  loading = false;
  render();

  return { destroy() { destroyed = true; } };
}
