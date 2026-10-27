/* EFB · Weather.
 *
 * NOAA observations and forecasts, decoded for reading, with the raw report
 * always visible underneath. The station shortcuts come from the loaded plan so
 * departure, destination and alternate are one tap apart. Runway wind components
 * use the airport's published runway headings where the directory has them.
 *
 * Staleness is shown, not hidden: every card stamps its observation and its
 * source. Winds aloft are the NOAA FD table. SIGMETs are not included because no
 * verified free source is configured; the card says so and links to the official
 * service instead of inventing one.
 */

import {
  airportByCode, airportRunways, esc, fmtAge, fmtFt, fmtUtc, fmtVisibility,
  searchAirports, weatherFor, windsAloft,
} from './common.js';
import { parseMetar } from '../lib/routeweather.js';
import { decodeTaf } from '../lib/taf.js';
import { windComponents } from '../lib/aircraftperformance.js';

const CATEGORY_TONE = { VFR: 'good', MVFR: 'accent', IFR: 'warn', LIFR: 'bad' };

function dirText(deg) {
  return deg == null ? 'VRB' : `${String(Math.round(deg)).padStart(3, '0')}°`;
}

function cloudText(clouds) {
  if (!clouds || !clouds.length) return 'No cloud reported';
  return clouds.map(layer => `${layer.cover} ${fmtFt(layer.baseFt)}${layer.cb ? ' CB' : ''}`).join(' · ');
}

export async function mount(root, ctx) {
  let destroyed = false;
  const plan = ctx.plan();
  const ofp = plan && plan.ofp;
  const shortcuts = [
    { role: 'Departure', code: ofp && ofp.origin && ofp.origin.icao },
    { role: 'Destination', code: ofp && ofp.destination && ofp.destination.icao },
    { role: 'Alternate', code: ofp && ofp.alternate && ofp.alternate.icao },
  ].filter(item => item.code);

  let icao = String(ctx.params.get('icao') || shortcuts[0]?.code || '').toUpperCase();
  let station = null;
  let airport = null;
  let record = null;
  let error = '';
  let loading = false;
  let runway = '';
  let winds = null;
  let windsFcst = '06';
  let windsBusy = false;

  root.innerHTML = `
    <div class="e-row" style="margin-bottom:10px">
      <div class="e-search" style="max-width:380px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.6"/><path d="m15 15 4.4 4.4"/></svg>
        <input class="e-input" id="wx-icao" placeholder="Airport ICAO or name" value="${esc(icao)}" autocomplete="off" spellcheck="false" aria-label="Search weather by airport">
        <div class="e-results" id="wx-results" hidden></div>
      </div>
      <button class="e-btn" type="button" data-load>Get weather</button>
      <span class="e-spacer"></span>
      <button class="e-btn small" type="button" data-refresh title="Fetch a fresh observation">Refresh</button>
    </div>
    <div class="e-row" style="margin-bottom:12px" id="wx-shortcuts"></div>
    <div id="wx-body"><div class="e-loading"><i></i>Reading the station…</div></div>`;

  const body = root.querySelector('#wx-body');
  const shortcutsHost = root.querySelector('#wx-shortcuts');

  function renderShortcuts() {
    const items = shortcuts.length
      ? shortcuts
      : (airport ? [{ role: 'Selected', code: airport.id }] : []);
    shortcutsHost.innerHTML = items.map(item => `<button class="e-btn small ${String(item.code).toUpperCase() === icao ? 'primary' : 'ghost'}" type="button" data-quick="${esc(item.code)}">${esc(item.role)} · ${esc(item.code)}</button>`).join('');
    shortcutsHost.querySelectorAll('[data-quick]').forEach(button => {
      button.addEventListener('click', () => {
        icao = button.dataset.quick.toUpperCase();
        root.querySelector('#wx-icao').value = icao;
        load();
      });
    });
  }

  function runwayOptions() {
    const runways = airportRunways(airport);
    if (!runways.length) return '<option value="">No runway data</option>';
    return ['<option value="">Choose a runway</option>', ...runways.map((row, index) => {
      const value = `${row.heading}`;
      return `<option value="${value}" ${String(row.heading) === runway ? 'selected' : ''}>${esc(row.id)}${row.lengthFt ? ` · ${row.lengthFt.toLocaleString('en-US')} ft` : ''}${row.lengthFt ? '' : ''}</option>`;
    })].join('');
  }

  function windCard(decoded) {
    if (!decoded || !decoded.wind) {
      return '<div class="e-small e-muted">The observation does not report wind.</div>';
    }
    const components = runway !== ''
      ? windComponents(Number(runway), decoded.wind.direction, decoded.wind.speedKt, decoded.wind.gustKt)
      : null;
    return `<div class="e-grid two" style="gap:8px">
      <dl class="e-kv">
        <dt>Direction</dt><dd>${dirText(decoded.wind.direction)} ${decoded.wind.direction == null ? '(variable)' : 'true'}</dd>
        <dt>Speed</dt><dd>${decoded.wind.speedKt} kt</dd>
        <dt>Gusts</dt><dd>${decoded.wind.gustKt ? `${decoded.wind.gustKt} kt` : 'None reported'}</dd>
      </dl>
      <div class="e-field">
        <label for="wx-runway" class="wx-wind-label">Runway wind components</label>
        <select class="e-select" id="wx-runway">${runwayOptions()}</select>
        ${components ? `<div class="e-notice" style="margin-top:8px">
          <div><b>${components.headwindKt >= 0 ? `${components.headwindKt} kt headwind` : `${Math.abs(components.headwindKt)} kt tailwind`}</b><br>
          ${components.crosswindKt} kt crosswind${components.crosswindSide && components.crosswindSide !== 'none' ? ` from the ${components.crosswindSide}` : ''}${components.gustCrosswindKt != null && components.gustCrosswindKt > components.crosswindKt ? `<br>Gusts: ${components.gustHeadwindKt >= 0 ? `${components.gustHeadwindKt} kt head` : `${Math.abs(components.gustHeadwindKt)} kt tail`}, ${components.gustCrosswindKt} kt cross` : ''}</div>
        </div>` : '<div class="e-small e-faint" style="margin-top:6px">Choose a runway to resolve the wind across it.</div>'}
      </div>
    </div>`;
  }

  function metarCard() {
    if (!record) return '';
    const decoded = record.metar ? parseMetar(record.metar) : null;
    const category = decoded && decoded.flightCategory;
    const categoryText = record.decoded && record.decoded.flight_category ? record.decoded.flight_category : category;
    const tone = CATEGORY_TONE[categoryText] || '';
    const altitude = airport && Number(airport.elev) ? fmtFt(airport.elev) : null;
    return `<div class="e-card" style="margin-bottom:12px">
      <h3>METAR <span class="e-spacer"></span>
        ${categoryText ? `<span class="e-badge ${tone}">${esc(categoryText)}</span>` : ''}
        <span class="e-badge">${record.metar ? `observed ${esc(fmtAge(record.fetchedAt))}` : 'no report'}</span>
      </h3>
      <div class="e-row" style="align-items:center;gap:10px;margin-bottom:4px">
        <div class="e-hero"><b>${esc(record.icao || icao)}</b><span>${esc(station || (airport && airport.name) || '')}</span></div>
        ${altitude ? `<span class="e-badge">${esc(altitude)}</span>` : ''}
      </div>
      ${record.metar ? `<code class="e-code" style="margin:10px 0 12px">${esc(record.metar)}</code>` : '<div class="e-notice warn" style="margin:10px 0">No current METAR is published for this station. The page will not display an older observation as current.</div>'}
      ${decoded ? `<div class="e-grid two" style="gap:10px">
        <dl class="e-kv">
          <dt>Visibility</dt><dd>${esc(fmtVisibility(decoded))}</dd>
          <dt>Ceiling</dt><dd>${decoded.ceilingFt != null ? fmtFt(decoded.ceilingFt) : 'No ceiling'}</dd>
          <dt>Cloud</dt><dd style="font-weight:500">${esc(cloudText(decoded.clouds))}</dd>
          <dt>Temperature</dt><dd>${decoded.temperatureC != null ? `${decoded.temperatureC}°C` : '—'}</dd>
          <dt>Dew point</dt><dd>${decoded.dewpointC != null ? `${decoded.dewpointC}°C` : '—'}</dd>
          <dt>Altimeter</dt><dd>${decoded.altimeter != null ? `${decoded.altimeter} ${decoded.altimeterUnit === 'inHg' ? 'inHg' : 'hPa'}` : '—'}</dd>
        </dl>
        <div class="wx-wind">${windCard(decoded)}</div>
      </div>` : ''}
      <div class="e-small e-faint" style="margin-top:9px">Source: ${esc(record.source || 'NOAA Aviation Weather Center')} · fetched ${esc(fmtAge(record.fetchedAt))}${record.decoded && record.decoded.obs_time ? ` · observation ${esc(fmtUtc(Number(record.decoded.obs_time) * 1000))}` : ''}</div>
    </div>`;
  }

  function tafGroupHtml(group) {
    const bits = [];
    if (group.wind) bits.push(`Wind ${group.wind.text}`);
    if (group.visibility) bits.push(`Visibility ${group.visibility.text}`);
    if (group.clouds.length) bits.push(`Cloud ${group.clouds.map(c => c.text).join(', ')}`);
    if (group.weather.length) bits.push(`Weather ${group.weather.join(', ')}`);
    if (group.unknown.length) bits.push(`Not decoded: ${group.unknown.join(' ')}`);
    return `<div style="padding:8px 0;border-top:1px solid rgba(148,163,184,.1)">
      <div class="e-row" style="gap:8px"><b style="font-size:12px">${esc(group.label)}</b>${group.atMs ? `<span class="e-small e-faint">${esc(fmtUtc(group.atMs))}</span>` : ''}</div>
      <div class="e-small e-muted">${bits.length ? esc(bits.join(' · ')) : 'No conditions decoded for this group.'}</div>
    </div>`;
  }

  function tafCard() {
    if (!record) return '';
    if (!record.taf) {
      return `<div class="e-card" style="margin-bottom:12px"><h3>TAF</h3><div class="e-small e-muted">No current TAF is published for this station.</div></div>`;
    }
    const taf = decodeTaf(record.taf);
    return `<div class="e-card" style="margin-bottom:12px">
      <h3>TAF <span class="e-spacer"></span>${record.tafIssueTime ? `<span class="e-badge">issued ${esc(fmtAge(Number(record.tafIssueTime) * 1000))}</span>` : ''}</h3>
      <code class="e-code">${esc(record.taf)}</code>
      ${taf ? `<div class="e-small e-faint" style="margin-top:8px">Valid ${esc(fmtUtc(taf.validFromMs))} to ${esc(fmtUtc(taf.validToMs))}${taf.issuedMs ? ` · issued ${esc(fmtUtc(taf.issuedMs))}` : ''}</div>
        ${tafGroupHtml(taf.initial)}
        ${taf.changes.map(tafGroupHtml).join('')}` : '<div class="e-small e-faint" style="margin-top:8px">The forecast could not be decoded; read the raw text above.</div>'}
    </div>`;
  }

  function windsCard() {
    const code3 = String(icao || '').slice(-3);
    const stationLevels = winds && winds.stations ? winds.stations[code3] : null;
    return `<div class="e-card" style="margin-bottom:12px">
      <h3>Winds and temperature aloft <span class="e-spacer"></span>
        <span class="e-seg" role="group" aria-label="Forecast period">
          ${['06', '12', '24'].map(fcst => `<button type="button" data-fcst="${fcst}" aria-pressed="${fcst === windsFcst ? 'true' : 'false'}">${fcst} h</button>`).join('')}
        </span>
      </h3>
      ${windsBusy ? '<div class="e-loading"><i></i>Reading the winds table…</div>' : ''}
      ${winds && winds.error ? `<div class="e-notice warn">${esc(winds.error)} Winds aloft are only available through the hosted Stratos site, which fetches the NOAA FD table.</div>` : ''}
      ${winds && !winds.error ? (stationLevels
        ? `<table class="e-table"><thead><tr><th>Level</th><th class="num">Wind</th><th class="num">Temp</th></tr></thead><tbody>
            ${stationLevels.map(level => `<tr><td>${fmtFt(level.ft)}</td><td class="num">${level.variable ? 'Light/variable' : `${dirText(level.dirDeg)} / ${level.speedKt} kt`}</td><td class="num">${level.tempC != null ? `${level.tempC}°C` : '—'}</td></tr>`).join('')}
          </tbody></table>
          <div class="e-small e-faint" style="margin-top:8px">Station ${esc(code3)} · ${winds.validMs ? `valid ${esc(fmtAge(winds.validMs))}` : ''}${winds.validUntilMs ? ` to ${esc(fmtUtc(winds.validUntilMs))}` : ''} · NOAA FD table${winds.stale ? ' · this table has expired' : ''}</div>`
        : `<div class="e-small e-muted">The NOAA FD table does not publish a row for station <b>${esc(code3)}</b>. US low-level winds only.</div>`)
        : ''}
    </div>`;
  }

  function hazardsCard() {
    return `<div class="e-card">
      <h3>SIGMETs and advisories</h3>
      <div class="e-notice"><div>No verified free SIGMET feed is configured in this build, so none are shown. Stratos will not invent an advisory. Check the official source for your airspace before flight.</div></div>
      <div class="e-row" style="margin-top:10px">
        <a class="e-btn small" href="https://aviationweather.gov/airsigmet/" target="_blank" rel="noopener">NOAA airsigmet ↗</a>
        <a class="e-btn small" href="https://www.eurocontrol.int/" target="_blank" rel="noopener">Eurocontrol ↗</a>
      </div>
    </div>`;
  }

  function render() {
    if (destroyed) return;
    if (loading) {
      body.innerHTML = '<div class="e-loading"><i></i>Reading the station…</div>';
      return;
    }
    if (error) {
      body.innerHTML = `<div class="e-notice bad"><div><b>${esc(icao || 'Station')}</b><br>${esc(error)}</div></div>
        <div class="e-row" style="margin-top:10px"><button class="e-btn" type="button" data-retry>Retry</button></div>`;
      body.querySelector('[data-retry]')?.addEventListener('click', () => load());
      return;
    }
    if (!record) {
      body.innerHTML = `<div class="e-empty"><b>Search for a station</b><p>Weather is fetched from NOAA for one airport at a time. Departure, destination and alternate are one tap away above.</p></div>`;
      return;
    }
    ctx.setSubtitle(station || (airport && airport.name) || icao);
    body.innerHTML = `${metarCard()}${tafCard()}${windsCard()}${hazardsCard()}
      <div class="e-small e-faint" style="margin:14px 2px 0">Observations and forecasts are NOAA Aviation Weather Center data. Not for real-world flight.</div>`;
    body.querySelector('#wx-runway')?.addEventListener('change', event => {
      runway = event.target.value;
      render();
    });
    body.querySelectorAll('[data-fcst]').forEach(button => {
      button.addEventListener('click', () => {
        windsFcst = button.dataset.fcst;
        loadWinds();
      });
    });
  }

  async function loadWinds() {
    windsBusy = true;
    render();
    const result = await windsAloft(windsFcst);
    if (destroyed) return;
    winds = result;
    windsBusy = false;
    render();
  }

  async function load() {
    icao = String(icao || '').trim().toUpperCase();
    if (!icao) {
      error = 'Enter an airport ICAO code.';
      render();
      return;
    }
    loading = true;
    error = '';
    record = null;
    station = '';
    airport = null;
    render();
    airport = await airportByCode(icao).catch(() => null);
    station = airport && airport.name ? airport.name : '';
    const answer = await weatherFor(icao, { force: true });
    if (destroyed) return;
    loading = false;
    if (answer.error) {
      error = answer.error;
      record = answer.metar ? answer : null;
      render();
      return;
    }
    record = answer;
    if (airport) station = airport.name || station;
    render();
    loadWinds();
  }

  /* station search */
  const input = root.querySelector('#wx-icao');
  const results = root.querySelector('#wx-results');
  let timer = null;
  input.addEventListener('input', () => {
    const term = input.value.trim();
    clearTimeout(timer);
    if (!term) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const rows = await searchAirports(term, 8);
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
  root.querySelector('[data-refresh]').addEventListener('click', () => load());

  renderShortcuts();
  if (icao) load();
  else render();

  return {
    destroy() {
      destroyed = true;
    },
  };
}
