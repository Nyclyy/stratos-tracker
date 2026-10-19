import { getSetting, setSetting, getSavedRoutes } from '../lib/store.js';
import { routeTotals } from '../lib/planner.js';
import { esc, fmtDateTime, num, tag, toast, downloadText } from '../ui.js';
import { wireSearch, searchDirectory, airportResultHtml, directoryLabel } from './common.js';

const WEATHER_TTL = 5 * 60 * 1000;
const weatherCache = new Map();

export async function mount(root, ctx) {
  const savedRoutes = await getSavedRoutes().catch(() => []);
  let saved = await getSetting('briefing', null).catch(() => null);
  let dep = saved?.dep || 'KSFO';
  let dest = saved?.dest || 'KLAX';
  let alternate = saved?.alternate || '';
  let cruiseKts = Number(saved?.cruiseKts) || 450;
  let cruiseAlt = Number(saved?.cruiseAlt) || 35000;
  let routeMode = saved?.routeMode || 'saved';
  let savedRouteId = saved?.savedRouteId || (savedRoutes[0]?.id || '');
  let weather = new Map();
  let weatherBusy = false;
  let weatherError = '';
  const cleanups = [];

  const find = code => ctx.directory.find(a => a.id === String(code || '').toUpperCase()) || null;

  function activeRoute() {
    if (routeMode === 'saved' && savedRoutes.length) {
      const chosen = savedRoutes.find(r => r.id === savedRouteId) || savedRoutes[0];
      if (chosen && chosen.points && chosen.points.length >= 2) return chosen.points;
    }
    const points = [];
    const a = find(dep);
    const b = find(dest);
    if (a) points.push({ id: a.id, name: a.name, lat: a.lat, lon: a.lon, elev: a.elev, kind: 'apt' });
    if (b) points.push({ id: b.id, name: b.name, lat: b.lat, lon: b.lon, elev: b.elev, kind: 'apt' });
    return points;
  }

  function routeLabel() {
    const route = activeRoute();
    if (route.length < 2) return 'Direct (airports not resolved)';
    if (routeMode === 'saved' && savedRoutes.length) {
      const chosen = savedRoutes.find(r => r.id === savedRouteId) || savedRoutes[0];
      return `${chosen.name} · ${route.map(p => p.id).join(' → ')}`;
    }
    return `${route.map(p => p.id).join(' → ')} · direct`;
  }

  function persist() {
    setSetting('briefing', { dep, dest, alternate, cruiseKts, cruiseAlt, routeMode, savedRouteId }).catch(() => {});
  }

  function airportInfoCard(code, role) {
    const airport = find(code);
    if (!airport) {
      return `<div class="card"><div class="card-head"><h3>${esc(role)}</h3><span class="spacer"></span>${tag('not resolved', 'warn')}</div>
        <p class="muted small">${code ? `No airport data for ${esc(code)} in the current directory.` : 'Not set.'}</p></div>`;
    }
    const runways = runwayList(airport);
    return `<div class="card">
      <div class="card-head"><div><h3>${esc(role)} · <span class="route-id">${esc(airport.id)}</span></h3>
        <span class="muted small">${esc(airport.name)}</span></div>
        <span class="spacer"></span><span class="tag">${esc(airport.source === 'bridge' ? 'bridge data' : 'bundled OurAirports')}</span></div>
      <dl class="kv">
        <dt>Elevation</dt><dd>${airport.elev != null ? `${num(airport.elev)} ft` : '—'}</dd>
        <dt>Position</dt><dd>${Number(airport.lat).toFixed(4)}, ${Number(airport.lon).toFixed(4)}</dd>
        <dt>Runways</dt><dd>${runways.length ? runways.map(r => `${esc(r.id)} ${r.lengthFt ? `${num(r.lengthFt)} ft` : ''}`).join(' · ') : 'not available'}</dd>
        ${airport.fqs && Object.keys(airport.fqs).length ? `<dt>Frequencies</dt><dd>${Object.entries(airport.fqs).slice(0, 6).map(([key, value]) => `${esc(key)} ${esc(value)}`).join(' · ')}</dd>` : ''}
      </dl>
      <div class="btn-row" style="margin-top:10px">
        <a class="btn small" href="pilot.html#charts?icao=${encodeURIComponent(airport.id)}">Charts</a>
        <a class="btn small ghost" href="https://skyvector.com/airport/${encodeURIComponent(airport.id)}" target="_blank" rel="noopener">SkyVector ↗</a>
      </div>
    </div>`;
  }

  function runwayList(airport) {
    const runways = [];
    if (Array.isArray(airport.rws) && airport.rws.length) {
      for (const row of airport.rws) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const a = { lat: Number(row[2]), lon: Number(row[3]) };
        const b = { lat: Number(row[4]), lon: Number(row[5]) };
        runways.push({
          id: `${row[0]}/${row[1]}`,
          lengthFt: Number(row[6]) || Math.round(distanceNm(a, b) * 6076.12),
          widthFt: Number(row[7]) || null,
          heading: bearingDeg(a, b),
          verified: true,
          a, b,
        });
      }
      return runways;
    }
    const designators = Array.isArray(airport.rw) ? airport.rw : [];
    const lengths = Array.isArray(airport.len) ? airport.len : [];
    designators.forEach((number, index) => {
      const other = number <= 18 ? number + 18 : number - 18;
      runways.push({
        id: `${String(number).padStart(2, '0')}/${String(other).padStart(2, '0')}`,
        lengthFt: Number(lengths[index]) || null,
        widthFt: null,
        heading: number * 10,
        verified: false,
      });
    });
    return runways;
  }

  function decodeRaw(raw) {
    if (!raw) return null;
    const windMatch = raw.match(/(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT/);
    const visMatch = raw.match(/\s(\d+(?:\/\d+)?|\d{4})SM\s|\s(CAVOK)\s/);
    const clouds = raw.match(/(FEW|SCT|BKN|OVC)(\d{3})/g) || [];
    const tempMatch = raw.match(/\s(M?\d{2})\/(M?\d{2})\s/);
    const altMatch = raw.match(/\s([AQ])(\d{4})\s/);
    return {
      wind: windMatch ? {
        direction: windMatch[1] === 'VRB' ? null : Number(windMatch[1]),
        speedKt: Number(windMatch[2]),
        gustKt: windMatch[4] ? Number(windMatch[4]) : null,
      } : null,
      visibility: visMatch ? (visMatch[2] || visMatch[1]) : null,
      clouds,
      temperatureC: tempMatch ? Number(tempMatch[1].replace('M', '-')) : null,
      dewpointC: tempMatch ? Number(tempMatch[2].replace('M', '-')) : null,
      altimeter: altMatch ? (altMatch[1] === 'A' ? Number(`${altMatch[2].slice(0, 2)}.${altMatch[2].slice(2)}`) : Number(altMatch[2])) : null,
      altimeterUnit: altMatch ? (altMatch[1] === 'A' ? 'inHg' : 'hPa') : null,
    };
  }

  function weatherCard(code, role) {
    const entry = weather.get(code);
    const airport = find(code);
    if (!code) return `<div class="card"><h3>${esc(role)}</h3><p class="muted small">Not selected.</p></div>`;
    if (!entry) {
      return `<div class="card"><div class="card-head"><h3>${esc(role)} · ${esc(code)}</h3><span class="spacer"></span>${weatherBusy ? tag('loading', 'muted') : tag('unavailable', 'warn')}</div>
        <p class="muted small">${weatherBusy ? 'Requesting METAR and TAF…' : 'No weather has been fetched for this airport.'}</p></div>`;
    }
    const parsed = entry.decoded || decodeRaw(entry.metar);
    const age = entry.fetchedAt ? Date.now() - entry.fetchedAt : Infinity;
    const stale = age > WEATHER_TTL;
    return `<div class="card">
      <div class="card-head"><div><h3>${esc(role)} · ${esc(code)}</h3>
        <span class="muted small">${esc(airport ? airport.name : '')}</span></div>
        <span class="spacer"></span>${entry.source ? tag(entry.source, 'accent') : ''}
        ${stale ? tag('stale', 'warn') : tag('fresh', 'good')}</div>
      ${entry.metar ? `<pre class="raw" style="white-space:pre-wrap;background:color-mix(in srgb,var(--bg) 50%, var(--ui2));padding:9px 11px;border-radius:8px;margin:0 0 8px">${esc(entry.metar)}</pre>` : '<div class="notice warn">No current METAR was returned for this airport.</div>'}
      ${parsed ? `<dl class="kv">
        <dt>Wind</dt><dd>${parsed.wind ? `${parsed.wind.direction == null ? 'variable' : `${String(parsed.wind.direction).padStart(3, '0')}°`} at ${parsed.wind.speedKt} kt${parsed.wind.gustKt ? ` gusting ${parsed.wind.gustKt} kt` : ''}` : 'not decoded'}</dd>
        <dt>Visibility</dt><dd>${esc(parsed.visibility || 'not decoded')}</dd>
        <dt>Cloud</dt><dd>${esc(parsed.clouds.length ? parsed.clouds.join(' ') : 'not decoded')}</dd>
        <dt>Temperature</dt><dd>${parsed.temperatureC != null ? `${parsed.temperatureC}°C / dew ${parsed.dewpointC}°C` : 'not decoded'}</dd>
        <dt>Altimeter</dt><dd>${parsed.altimeter != null ? `${parsed.altimeter} ${parsed.altimeterUnit}` : 'not decoded'}</dd>
        ${parsed.flight_category ? `<dt>Flight category</dt><dd>${esc(parsed.flight_category)}</dd>` : ''}
      </dl>` : ''}
      ${entry.taf ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer">TAF${entry.tafIssueTime ? ` · issued ${esc(new Date(entry.tafIssueTime).toLocaleString())}` : ''}</summary>
        <pre style="white-space:pre-wrap;margin:8px 0 0;font-size:11.5px">${esc(entry.taf)}</pre></details>` : '<p class="help" style="margin-top:8px">No TAF available for this airport from the current weather source.</p>'}
      <p class="help" style="margin-top:8px">Fetched ${esc(fmtDateTime(entry.fetchedAt))} · ${esc(entry.source || 'weather source')}. Forecasts change; re-check before flight.</p>
    </div>`;
  }

  function windComponents() {
    const entry = weather.get(dep);
    const parsed = entry ? (entry.decoded || decodeRaw(entry.metar)) : null;
    if (!parsed || !parsed.wind || parsed.wind.direction == null) return '';
    const airport = find(dep);
    if (!airport) return '';
    const runways = runwayList(airport).slice(0, 6);
    if (!runways.length) return '';
    const speed = Math.max(parsed.wind.speedKt, parsed.wind.gustKt || 0);
    return `<div class="card" style="margin-top:12px">
      <div class="card-head"><h2>Departure wind components</h2><span class="hint">${esc(dep)} · using ${speed} kt ${parsed.wind.gustKt ? '(gust)' : ''}</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Runway</th><th class="num">Head / tail</th><th class="num">Crosswind</th></tr></thead><tbody>
      ${runways.map(runway => {
        const angle = ((parsed.wind.direction - runway.heading) * Math.PI) / 180;
        const head = Math.round(speed * Math.cos(angle));
        const cross = Math.round(speed * Math.sin(angle));
        return `<tr><td>${esc(runway.id)}${runway.verified ? '' : ' <span class="tag" title="Orientation derived from the runway designator">approx</span>'}</td>
          <td class="num">${Math.abs(head)} kt ${head >= 0 ? 'headwind' : 'tailwind'}</td>
          <td class="num">${Math.abs(cross)} kt ${cross > 0 ? 'from right' : cross < 0 ? 'from left' : ''}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="help" style="margin-top:8px">Calculated from the current METAR wind. Not a crosswind limit check — consult your aircraft manual.</p>
    </div>`;
  }

  async function fetchWeather(code, force = false) {
    if (!code) return;
    const cached = weatherCache.get(code);
    if (!force && cached && Date.now() - cached.fetchedAt < WEATHER_TTL) {
      weather.set(code, cached);
      return;
    }
    const tryUrls = [];
    const bridgeIsSameOrigin = location.port === '8765';
    if (ctx.health || bridgeIsSameOrigin) {
      tryUrls.push(`${ctx.bridgeBase.replace(/\/+$/, '')}/weather?icao=${encodeURIComponent(code)}`);
    }
    tryUrls.push(`/api/weather?icao=${encodeURIComponent(code)}`);
    let lastError = '';
    for (const url of tryUrls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(url, { credentials: location.protocol === 'file:' ? 'omit' : 'include', cache: 'no-store', signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
        const data = await response.json();
        if (!data || (!data.metar && !data.taf)) { lastError = 'No METAR or TAF returned.'; continue; }
        const entry = {
          ...data,
          fetchedAt: data.fetchedAt || Date.now(),
          source: data.source || (url.includes('/api/weather') ? 'NOAA via Stratos API' : 'NOAA via local bridge'),
        };
        weatherCache.set(code, entry);
        weather.set(code, entry);
        return;
      } catch (error) {
        lastError = error.name === 'AbortError' ? 'request timed out' : error.message;
      }
    }
    weatherError = lastError || 'Weather is not available from this page.';
  }

  async function loadAllWeather(force = false) {
    weatherBusy = true;
    weatherError = '';
    updateWeatherPanels();
    const codes = [...new Set([dep, dest, alternate].filter(Boolean))];
    await Promise.all(codes.map(code => fetchWeather(code, force)));
    weatherBusy = false;
    updateWeatherPanels();
  }

  function updateWeatherPanels() {
    const container = document.getElementById('briefing-weather');
    if (!container) return;
    container.innerHTML = `
      <div class="grid grid-3">
        ${weatherCard(dep, 'Departure')}
        ${weatherCard(dest, 'Destination')}
        ${alternate ? weatherCard(alternate, 'Alternate') : `<div class="card"><div class="card-head"><h3>Alternate</h3></div><p class="muted small">No alternate selected. Add one for a more complete briefing.</p></div>`}
      </div>
      ${windComponents()}
      <div class="row" style="margin-top:10px">
        <button class="btn small" id="refresh-weather" ${weatherBusy ? 'disabled' : ''}>Refresh weather</button>
        <span class="muted small">${weatherError ? esc(weatherError) : `Source: NOAA Aviation Weather Center. Cached for 5 minutes.`}</span>
      </div>`;
    document.getElementById('refresh-weather')?.addEventListener('click', () => loadAllWeather(true));
    updateWarnings();
  }

  function warnings() {
    const list = [];
    if (!find(dep)) list.push(`Departure ${dep || '(not set)'} is not in the airport directory.`);
    if (!find(dest)) list.push(`Destination ${dest || '(not set)'} is not in the airport directory.`);
    if (alternate && !find(alternate)) list.push(`Alternate ${alternate} is not in the airport directory.`);
    const route = activeRoute();
    if (route.length < 2) list.push('The route has fewer than two resolved waypoints.');
    for (const code of [dep, dest, alternate].filter(Boolean)) {
      const entry = weather.get(code);
      if (!entry) list.push(`No weather loaded for ${code}.`);
      else if (!entry.metar) list.push(`No current METAR for ${code}.`);
      else if (Date.now() - entry.fetchedAt > WEATHER_TTL) list.push(`Weather for ${code} is older than 5 minutes.`);
    }
    if (weatherError) list.push(`Weather source error: ${weatherError}`);
    list.push('NOTAMs are not included: no free, verified NOTAM source is configured in this build. Check the official AIS/NOTAM service for your departure, destination and alternate.');
    return list;
  }

  function updateWarnings() {
    const container = document.getElementById('briefing-warnings');
    if (!container) return;
    const items = warnings();
    container.innerHTML = `<div class="card">
      <div class="card-head"><h2>Warnings and missing data</h2><span class="spacer"></span>${tag(`${items.length} item${items.length === 1 ? '' : 's'}`, 'warn')}</div>
      <ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--mut)">${items.map(item => `<li style="margin-bottom:4px">${esc(item)}</li>`).join('')}</ul>
      <div class="btn-row" style="margin-top:12px">
        <a class="btn small" href="https://www.faa.gov/air_traffic/flight_info/aeronav/notams/" target="_blank" rel="noopener">FAA NOTAM search ↗</a>
        <a class="btn small ghost" href="https://www.eurocontrol.int/service/european-aeronautical-information-service" target="_blank" rel="noopener">European AIS ↗</a>
      </div>
    </div>`;
  }

  function render() {
    cleanups.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
    const route = activeRoute();
    const totals = routeTotals(route, { cruiseKts, cruiseAlt });
    const fuel = ctx.live && ctx.live.raw && ctx.live.raw.telemetry && Number.isFinite(Number(ctx.live.raw.telemetry.fuel))
      ? `${num(Number(ctx.live.raw.telemetry.fuel))} (simulator units)` : null;
    const payload = 'Not provided by the simulator bridge.';
    const canRoute = route.length >= 2;

    root.innerHTML = `
      <div class="page-head">
        <div><h1>Flight briefing</h1>
        <p>A preflight summary built from your route, the airport directory and live METAR/TAF data. Estimates are labelled; nothing is invented when a source is missing.</p></div>
        <span class="spacer"></span>
        <button class="btn small ghost" id="print-briefing">Print</button>
        <button class="btn small ghost" id="export-briefing">Export .md</button>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="field-row">
          <div class="field" style="flex:1 1 140px"><label for="brief-dep">Departure</label>
            <input class="input" id="brief-dep" value="${esc(dep)}" placeholder="ICAO" autocomplete="off"></div>
          <div class="field" style="flex:1 1 140px"><label for="brief-dest">Destination</label>
            <input class="input" id="brief-dest" value="${esc(dest)}" placeholder="ICAO" autocomplete="off"></div>
          <div class="field" style="flex:1 1 140px"><label for="brief-alt">Alternate (optional)</label>
            <input class="input" id="brief-alt" value="${esc(alternate)}" placeholder="ICAO" autocomplete="off"></div>
          <div class="field" style="flex:0 1 110px"><label for="brief-speed">Cruise kt</label>
            <input class="input" id="brief-speed" type="number" min="60" max="600" value="${cruiseKts}"></div>
          <div class="field" style="flex:0 1 120px"><label for="brief-altitude">Cruise ft</label>
            <input class="input" id="brief-altitude" type="number" min="1000" max="60000" step="1000" value="${cruiseAlt}"></div>
        </div>
        <div class="field-row" style="margin-top:10px">
          <div class="field" style="flex:1 1 220px"><label for="brief-route-mode">Routing</label>
            <select class="input" id="brief-route-mode">
              <option value="direct" ${routeMode === 'direct' ? 'selected' : ''}>Direct between airports</option>
              <option value="saved" ${routeMode === 'saved' ? 'selected' : ''} ${savedRoutes.length ? '' : 'disabled'}>Saved route</option>
            </select></div>
          <div class="field" style="flex:2 1 260px"><label for="brief-saved-route">Saved route</label>
            <select class="input" id="brief-saved-route" ${savedRoutes.length ? '' : 'disabled'}>
              ${savedRoutes.length ? savedRoutes.map(r => `<option value="${esc(r.id)}" ${r.id === savedRouteId ? 'selected' : ''}>${esc(r.name)}</option>`).join('') : '<option>No saved routes</option>'}
            </select></div>
          <div class="field" style="flex:0 0 auto;justify-content:flex-end"><label>&nbsp;</label>
            <a class="btn" href="#/routes">Edit routes</a></div>
        </div>
      </div>

      <div class="grid grid-4">
        <div class="stat"><span class="stat-label">Planned distance</span><b class="stat-value">${canRoute ? `${num(totals.distanceNm, 0)} nm` : '—'}</b><span class="stat-hint">${canRoute ? 'Along the selected route' : 'Resolve both airports'}</span></div>
        <div class="stat"><span class="stat-label">Estimated time</span><b class="stat-value">${canRoute ? `${Math.floor(totals.eteMinutes / 60)}h ${String(totals.eteMinutes % 60).padStart(2, '0')}m` : '—'}</b><span class="stat-hint">Includes climb/descent estimate</span></div>
        <div class="stat"><span class="stat-label">Route</span><b class="stat-value" style="font-size:17px">${esc(routeLabel())}</b><span class="stat-hint">${route.length} waypoint${route.length === 1 ? '' : 's'}</span></div>
        <div class="stat"><span class="stat-label">Estimate basis</span><b class="stat-value" style="font-size:14px;font-weight:600">${esc(`${cruiseKts} kt · FL${Math.round(cruiseAlt / 100)}`)}</b><span class="stat-hint">No winds, fuel or ATC modelling</span></div>
      </div>

      <div class="section-title"><h2>Airports</h2><span class="hint">${esc(directoryLabel(ctx.directory))}</span></div>
      <div class="grid grid-3">
        ${airportInfoCard(dep, 'Departure')}
        ${airportInfoCard(dest, 'Destination')}
        ${alternate ? airportInfoCard(alternate, 'Alternate') : `<div class="card"><div class="card-head"><h3>Alternate</h3></div><p class="muted small">Not selected.</p></div>`}
      </div>

      <div class="section-title"><h2>Route</h2><span class="hint">Estimates only — not an operational flight plan</span></div>
      <div class="card flush">
        ${canRoute ? `<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>#</th><th>Waypoint</th><th>Name</th><th class="num">Leg</th><th class="num">Track</th></tr></thead><tbody>
          ${route.map((point, index) => {
            const leg = totals.legs[index - 1];
            return `<tr><td>${index + 1}</td><td class="route-id">${esc(point.id)}</td><td class="muted">${esc(point.name || '')}</td>
              <td class="num">${leg ? `${num(leg.distanceNm, 1)} nm` : '—'}</td>
              <td class="num">${leg ? `${String(Math.round(leg.initialBearing)).padStart(3, '0')}°` : '—'}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<p class="muted small" style="padding:16px">Select a departure and destination that exist in the airport directory.</p>'}
        <p class="help" style="padding:12px 16px">${esc(totals.method)}</p>
      </div>

      <div class="section-title"><h2>Weather</h2><span class="hint">METAR and TAF · source and age shown</span></div>
      <div id="briefing-weather"></div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-head"><h2>Fuel and payload</h2></div>
          <dl class="kv">
            <dt>Fuel now</dt><dd>${fuel ? esc(fuel) : 'Not available'}</dd>
            <dt>Payload</dt><dd>${esc(payload)}</dd>
            <dt>Planned fuel</dt><dd>Not calculated — use SimBrief or your aircraft's performance data.</dd>
          </dl>
          <p class="help" style="margin-top:8px">Simulator fuel is shown only when the connected bridge reports it. No fuel figure is invented for planning.</p>
        </div>
        <div id="briefing-warnings"></div>
      </div>

      <div class="notice" style="margin-top:16px">
        <div><strong>Use official sources for flight.</strong> Stratos is a simulator companion. Weather can lag or be unavailable, NOTAMs are not included, and route times are estimates without winds. Not for real-world navigation.</div>
      </div>
    `;

    bindSelection('brief-dep', value => { dep = value.toUpperCase().slice(0, 8); persist(); render(); loadAllWeather(); });
    bindSelection('brief-dest', value => { dest = value.toUpperCase().slice(0, 8); persist(); render(); loadAllWeather(); });
    bindSelection('brief-alt', value => { alternate = value.toUpperCase().slice(0, 8); persist(); render(); loadAllWeather(); });

    document.getElementById('brief-speed').addEventListener('change', event => {
      cruiseKts = Math.max(60, Math.min(600, Number(event.target.value) || 450));
      persist(); render();
    });
    document.getElementById('brief-altitude').addEventListener('change', event => {
      cruiseAlt = Math.max(1000, Math.min(60000, Number(event.target.value) || 35000));
      persist(); render();
    });
    document.getElementById('brief-route-mode').addEventListener('change', event => {
      routeMode = event.target.value; persist(); render();
    });
    document.getElementById('brief-saved-route').addEventListener('change', event => {
      savedRouteId = event.target.value; persist(); render();
    });
    document.getElementById('print-briefing').addEventListener('click', () => window.print());
    document.getElementById('export-briefing').addEventListener('click', () => exportBriefing());
    updateWeatherPanels();
  }

  function bindSelection(id, onPick) {
    const input = document.getElementById(id);
    if (!input) return;
    cleanups.push(wireSearch(input, {
      getItems: query => searchDirectory(ctx.directory, query, 10),
      renderItem: airportResultHtml,
      onPick: airport => onPick(airport.id),
    }));
    input.addEventListener('change', event => onPick(String(event.target.value || '').trim()));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') onPick(String(input.value || '').trim());
    });
  }

  function exportBriefing() {
    const route = activeRoute();
    const totals = routeTotals(route, { cruiseKts, cruiseAlt });
    const lines = [
      '# Stratos flight briefing',
      '',
      `Generated: ${new Date().toLocaleString()}`,
      `Route: ${routeLabel()}`,
      `Planned distance: ${totals.distanceNm.toFixed(0)} nm`,
      `Estimated time: ${Math.floor(totals.eteMinutes / 60)}h ${String(totals.eteMinutes % 60).padStart(2, '0')}m`,
      `Estimate basis: ${totals.method}`,
      '',
      '## Airports',
    ];
    for (const [role, code] of [['Departure', dep], ['Destination', dest], ['Alternate', alternate]]) {
      const airport = find(code);
      if (!code) continue;
      lines.push(`- ${role}: ${code}${airport ? ` — ${airport.name}, elev ${airport.elev} ft` : ' (not in directory)'}`);
    }
    lines.push('', '## Route');
    route.forEach((point, index) => {
      const leg = totals.legs[index - 1];
      lines.push(`${index + 1}. ${point.id}${leg ? ` — ${leg.distanceNm.toFixed(1)} nm, ${Math.round(leg.initialBearing)}°` : ''}`);
    });
    lines.push('', '## Weather (NOAA Aviation Weather Center)');
    for (const code of [dep, dest, alternate].filter(Boolean)) {
      const entry = weather.get(code);
      lines.push('', `### ${code}`);
      lines.push(entry?.metar ? entry.metar : 'No METAR available.');
      if (entry?.taf) lines.push('', entry.taf);
      if (entry?.fetchedAt) lines.push('', `Fetched: ${new Date(entry.fetchedAt).toLocaleString()} (${entry.source || 'weather source'})`);
    }
    lines.push('', '## Warnings');
    warnings().forEach(item => lines.push(`- ${item}`));
    lines.push('', 'NOTAMs are not included. Use official AIS sources. Not for real-world navigation.');
    downloadText(`stratos-briefing-${dep}-${dest}.md`, lines.join('\n'), 'text/markdown');
    toast('Briefing exported.');
  }

  render();
  loadAllWeather();
  return {
    destroy() {
      cleanups.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
      root.innerHTML = '';
    },
  };
}

function distanceNm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.asin(Math.sqrt(h));
}

function bearingDeg(a, b) {
  const toRad = Math.PI / 180;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / toRad) + 360) % 360;
}
