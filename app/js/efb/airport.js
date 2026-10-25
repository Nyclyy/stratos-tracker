/* EFB · Airport Information.
 *
 * Elevation, runways, frequencies and published procedures for one airport,
 * from the bridge's OurAirports directory and the simulator navigation data.
 * NOTAMs are the one thing Stratos cannot fetch from a verified free source, so
 * the card says exactly that and links to the official services instead of
 * inventing a notice.
 */

import {
  airportByCode, airportFrequencies, airportRunways, esc, fmtFt, searchAirports,
  currentPlan, loadRoute,
} from './common.js';
import { defaultBridgeBase, isHostedPage } from '../bridge.js';

function runwaySurface(row) {
  if (!row.surface) return '—';
  return row.surface;
}

export async function mount(root, ctx) {
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const route = loadRoute();
  const shortcuts = [
    { role: 'Departure', code: ofp && ofp.origin && ofp.origin.icao },
    { role: 'Destination', code: ofp && ofp.destination && ofp.destination.icao },
    { role: 'Alternate', code: ofp && ofp.alternate && ofp.alternate.icao },
  ].filter(item => item.code);

  let icao = String(ctx.params.get('icao') || shortcuts[0]?.code || (route[0] && route[0].id) || '').toUpperCase();
  let airport = null;
  let loading = false;
  let error = '';
  let procedures = null;
  let proceduresError = '';
  let proceduresBusy = false;
  let destroyed = false;

  root.innerHTML = `
    <div class="e-row" style="margin-bottom:10px">
      <div class="e-search" style="max-width:380px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.6"/><path d="m15 15 4.4 4.4"/></svg>
        <input class="e-input" id="apt-icao" placeholder="Airport ICAO or name" value="${esc(icao)}" autocomplete="off" spellcheck="false" aria-label="Search airports">
        <div class="e-results" id="apt-results" hidden></div>
      </div>
      <button class="e-btn" type="button" data-load>Show airport</button>
      <span class="e-spacer"></span>
      <button class="e-btn small" type="button" data-charts>Charts ↗</button>
    </div>
    <div class="e-row" style="margin-bottom:12px" id="apt-shortcuts"></div>
    <div id="apt-body"><div class="e-loading"><i></i>Loading the airport…</div></div>`;

  const body = root.querySelector('#apt-body');
  const shortcutsHost = root.querySelector('#apt-shortcuts');

  function renderShortcuts() {
    const items = shortcuts.length ? shortcuts : airport ? [{ role: 'Selected', code: airport.id }] : [];
    shortcutsHost.innerHTML = items.map(item => `<button class="e-btn small ${String(item.code).toUpperCase() === icao ? 'primary' : 'ghost'}" type="button" data-quick="${esc(item.code)}">${esc(item.role)} · ${esc(item.code)}</button>`).join('');
    shortcutsHost.querySelectorAll('[data-quick]').forEach(button => {
      button.addEventListener('click', () => {
        icao = button.dataset.quick.toUpperCase();
        root.querySelector('#apt-icao').value = icao;
        load();
      });
    });
  }

  function planContext(code) {
    if (!ofp) return '';
    const isOrigin = ofp.origin && ofp.origin.icao === code;
    const isDestination = ofp.destination && ofp.destination.icao === code;
    const isAlternate = ofp.alternate && ofp.alternate.icao === code;
    if (!isOrigin && !isDestination && !isAlternate) return '';
    const bits = [];
    if (isOrigin) {
      bits.push(`Departure${ofp.origin.rwy ? ` · runway ${ofp.origin.rwy}` : ''}${ofp.origin.sid ? ` · SID ${ofp.origin.sid}` : ''}`);
    }
    if (isDestination) {
      bits.push(`Destination${ofp.destination.rwy ? ` · runway ${ofp.destination.rwy}` : ''}${ofp.destination.star ? ` · STAR ${ofp.destination.star}` : ''}${ofp.destination.approach ? ` · ${ofp.destination.approach}` : ''}`);
    }
    if (isAlternate) bits.push('Alternate');
    return `<div class="e-notice" style="margin-bottom:12px"><div><b>In your flight plan</b><br>${esc(bits.join(' · '))}</div></div>`;
  }

  function runwaysCard() {
    const runways = airportRunways(airport);
    if (!runways.length) {
      return `<div class="e-card"><h3>Runways</h3><div class="e-small e-muted">The airport directory has no runway dimensions for ${esc(icao)}. They are not estimated from the airport coordinate.</div></div>`;
    }
    return `<div class="e-card"><h3>Runways <em>${runways.some(r => r.verified) ? 'threshold data' : 'designators only'}</em></h3>
      <table class="e-table">
        <thead><tr><th>Runway</th><th class="num">Length</th><th class="num">Width</th><th class="num">Heading</th><th>Surface</th></tr></thead>
        <tbody>${runways.map(row => `<tr>
          <td>${esc(row.id)}</td>
          <td class="num">${row.lengthFt ? `${row.lengthFt.toLocaleString('en-US')} ft` : '—'}</td>
          <td class="num">${row.widthFt ? `${row.widthFt} ft` : '—'}</td>
          <td class="num">${Math.round(row.heading)}°</td>
          <td>${esc(runwaySurface(row))}</td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="e-small e-faint" style="margin-top:8px">${runways.some(r => r.verified) ? 'Dimensions from the bridge runway database (OurAirports).' : 'Runway orientation derives from the designator; lengths come from the airport snapshot where available.'}</div>
    </div>`;
  }

  function frequenciesCard() {
    const frequencies = airportFrequencies(airport);
    return `<div class="e-card"><h3>Frequencies</h3>
      ${frequencies.length
        ? `<dl class="e-kv">${frequencies.map(item => `<dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd>`).join('')}</dl>
           <div class="e-small e-faint" style="margin-top:8px">From the bridge airport database. Always confirm against the current AIP.</div>`
        : `<div class="e-small e-muted">No frequencies are available for this airport in the directory. They are not invented here.</div>`}
    </div>`;
  }

  function proceduresCard() {
    const groups = ['SID', 'STAR', 'APPROACH'];
    return `<div class="e-card"><h3>Published procedures <span class="e-spacer"></span>${procedures && procedures.cycle ? `<span class="e-badge">${esc(procedures.cycle)}</span>` : ''}</h3>
      ${proceduresBusy ? '<div class="e-loading"><i></i>Reading the navigation data…</div>' : ''}
      ${!proceduresBusy && proceduresError ? `<div class="e-notice warn">${esc(proceduresError)}</div>` : ''}
      ${procedures && procedures.ok ? groups.map(kind => {
        const list = (procedures.procedures && procedures.procedures[kind]) || [];
        if (!list.length) return '';
        return `<div style="margin-bottom:10px"><div class="e-label">${kind}</div>
          <div class="e-row" style="margin-top:5px">${list.slice(0, 28).map(row => `<span class="e-badge">${esc(row.id)}</span>`).join('')}${list.length > 28 ? `<span class="e-badge">+${list.length - 28}</span>` : ''}</div></div>`;
      }).join('') || '<div class="e-small e-muted">The navigation data holds no procedures for this airport.</div>' : ''}
      <div class="e-small e-faint">${procedures && procedures.source ? `Source: ${esc(procedures.source)}${procedures.cycle ? ` · cycle ${esc(procedures.cycle)}` : ''}` : 'Published procedures load from the simulator navigation data when the bridge is running on this PC.'}</div>
    </div>`;
  }

  function notamCard() {
    return `<div class="e-card"><h3>NOTAMs</h3>
      <div class="e-notice warn"><div><b>Not available in Stratos</b><br>No verified free NOTAM source is configured in this build, so no NOTAM is shown. This page will not invent a closure, restriction or navaid outage.</div></div>
      <div class="e-row" style="margin-top:10px">
        <a class="e-btn small" href="https://www.faa.gov/air_traffic/flight_info/aeronav/notams/" target="_blank" rel="noopener">FAA NOTAM search ↗</a>
        <a class="e-btn small" href="https://www.eurocontrol.int/" target="_blank" rel="noopener">Eurocontrol AIS ↗</a>
        <a class="e-btn small" href="https://aim-suisse.ch/" target="_blank" rel="noopener">AIS providers ↗</a>
      </div>
      <div class="e-small e-faint" style="margin-top:8px">Use the official AIS for your departure, destination and alternate. Aviation weather is in the Weather app.</div>
    </div>`;
  }

  function render() {
    if (destroyed) return;
    if (loading) { body.innerHTML = '<div class="e-loading"><i></i>Loading the airport…</div>'; return; }
    if (error) {
      body.innerHTML = `<div class="e-notice bad"><div><b>${esc(icao)}</b><br>${esc(error)}</div></div>
        <div class="e-row" style="margin-top:10px"><button class="e-btn" type="button" data-retry>Retry</button></div>`;
      body.querySelector('[data-retry]')?.addEventListener('click', () => load());
      return;
    }
    if (!airport) {
      body.innerHTML = `<div class="e-empty"><b>Search for an airport</b><p>The directory covers the bundled snapshot and, with the bridge running, the world.</p></div>`;
      return;
    }
    ctx.setSubtitle(airport.name || airport.id);
    const elevation = Number(airport.elev);
    body.innerHTML = `
      ${planContext(airport.id)}
      <div class="e-card" style="margin-bottom:12px">
        <div class="e-row" style="align-items:flex-start">
          <div>
            <div class="e-hero"><b>${esc(airport.id)}</b><span>${esc(airport.name || '')}</span></div>
            <div class="e-small e-muted" style="margin-top:3px">${Number.isFinite(Number(airport.lat)) ? `${Number(airport.lat).toFixed(4)}, ${Number(airport.lon).toFixed(4)}` : 'Position unknown'}${airport.source ? ` · ${esc(airport.source === 'bridge' ? 'bridge airport database' : airport.source)}` : ''}</div>
          </div>
          <span class="e-spacer"></span>
          <div style="text-align:right">
            <div class="e-label">Elevation</div>
            <div class="e-big">${Number.isFinite(elevation) ? `${elevation.toLocaleString('en-US')}<small class="e-small e-faint"> ft</small>` : '—'}</div>
          </div>
        </div>
      </div>
      <div class="e-grid two" style="margin-bottom:12px">${runwaysCard()}${frequenciesCard()}</div>
      <div style="margin-bottom:12px">${proceduresCard()}</div>
      ${notamCard()}
      <div class="e-small e-faint" style="margin:14px 2px 0">Airport data: OurAirports (public domain). Procedures: the simulator navigation data. Confirm operational information against the current AIP.</div>`;
  }

  async function loadProcedures(code) {
    procedures = null;
    proceduresError = '';
    if (isHostedPage()) {
      proceduresError = 'The simulator navigation data is only reachable through the bridge on the PC running the simulator. Chart documents are in the Charts app.';
      render();
      return;
    }
    proceduresBusy = true;
    render();
    try {
      const response = await fetch(`${defaultBridgeBase().replace(/\/+$/, '')}/procedures.json?airport=${encodeURIComponent(code)}`, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        proceduresError = response.status === 503
          ? (payload.error || 'No navigation data is installed: point Stratos at X-Plane or load the bundled dataset.')
          : (payload.error || `The navigation data answered ${response.status}.`);
      } else {
        procedures = await response.json();
      }
    } catch (fetchError) {
      proceduresError = `The navigation data could not be reached (${fetchError.message}).`;
    }
    proceduresBusy = false;
    render();
  }

  async function load() {
    icao = String(icao || '').trim().toUpperCase();
    if (!icao) { error = 'Enter an airport ICAO code.'; render(); return; }
    loading = true;
    error = '';
    airport = null;
    render();
    try {
      airport = await airportByCode(icao);
    } catch (lookupError) {
      airport = null;
      error = lookupError.message;
    }
    if (destroyed) return;
    loading = false;
    if (!airport) {
      error = `No airport matches “${icao}”. Check the code, or search by name.`;
      render();
      return;
    }
    render();
    loadProcedures(airport.id);
  }

  /* search */
  const input = root.querySelector('#apt-icao');
  const results = root.querySelector('#apt-results');
  let timer = null;
  let rows = [];
  input.addEventListener('input', () => {
    const term = input.value.trim();
    clearTimeout(timer);
    if (!term) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      rows = await searchAirports(term, 8);
      if (destroyed) return;
      results.hidden = false;
      results.innerHTML = rows.length
        ? rows.map(row => `<button type="button" data-pick="${esc(row.id)}"><b>${esc(row.id)}</b><span>${esc(row.name || '')}</span></button>`).join('')
        : '<div class="e-empty-small">No airports match.</div>';
      results.querySelectorAll('[data-pick]').forEach(button => {
        button.addEventListener('click', () => {
          input.value = button.dataset.pick;
          icao = button.dataset.pick;
          results.hidden = true;
          load();
        });
      });
    }, 180);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { results.hidden = true; icao = input.value.trim().toUpperCase(); load(); }
    if (event.key === 'Escape') results.hidden = true;
  });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 160));
  root.querySelector('[data-load]').addEventListener('click', () => { icao = input.value.trim().toUpperCase(); load(); });
  root.querySelector('[data-charts]').addEventListener('click', () => ctx.go('charts', { icao }));

  renderShortcuts();
  if (icao) load();
  else render();

  return { destroy() { destroyed = true; } };
}
