import { getSetting, setSetting } from '../lib/store.js';
import { nearbyAirports } from '../data/airports.js';
import { MiniMap } from '../minimap.js';
import { esc, fmtDateTime, num, tag, toast } from '../ui.js';
import { wireSearch, searchDirectory, airportResultHtml } from './common.js';

const WEATHER_TTL = 5 * 60 * 1000;

export async function mount(root, ctx) {
  let favorites = await getSetting('favoriteAirports', []).catch(() => []);
  if (!Array.isArray(favorites)) favorites = [];
  let selected = String(ctx.params.get('airport') || favorites[0] || 'KSFO').toUpperCase();
  let weather = null;
  let weatherBusy = false;
  let weatherError = '';
  let map = null;
  let cleanups = [];

  const find = code => ctx.directory.find(a => a.id === code) || null;

  function airportRunways(airport) {
    if (!airport) return [];
    if (Array.isArray(airport.rws) && airport.rws.length) {
      return airport.rws.filter(row => Array.isArray(row) && row.length >= 6).map(row => ({
        id: `${row[0]}/${row[1]}`,
        lengthFt: Number(row[6]) || null,
        widthFt: Number(row[7]) || null,
        verified: true,
      }));
    }
    const designators = Array.isArray(airport.rw) ? airport.rw : [];
    const lengths = Array.isArray(airport.len) ? airport.len : [];
    return designators.map((number, index) => ({
      id: `${String(number).padStart(2, '0')}/${String(number <= 18 ? number + 18 : number - 18).padStart(2, '0')}`,
      lengthFt: Number(lengths[index]) || null,
      widthFt: null,
      verified: false,
    }));
  }

  async function toggleFavorite(code) {
    if (favorites.includes(code)) favorites = favorites.filter(item => item !== code);
    else favorites = [...favorites, code].slice(0, 24);
    await setSetting('favoriteAirports', favorites);
    render();
  }

  async function loadWeather(code, force = false) {
    if (!code) return;
    if (!force && weather && weather.icao === code && Date.now() - weather.fetchedAt < WEATHER_TTL) return;
    weatherBusy = true;
    weatherError = '';
    updateWeatherPanel();
    const urls = [];
    if (ctx.health || location.port === '8765') urls.push(`${ctx.bridgeBase.replace(/\/+$/, '')}/weather?icao=${encodeURIComponent(code)}`);
    urls.push(`/api/weather?icao=${encodeURIComponent(code)}`);
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(url, { credentials: location.protocol === 'file:' ? 'omit' : 'include', cache: 'no-store', signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) { weatherError = `HTTP ${response.status}`; continue; }
        const data = await response.json();
        if (!data || (!data.metar && !data.taf)) { weatherError = 'No METAR or TAF returned.'; continue; }
        weather = {
          ...data,
          fetchedAt: data.fetchedAt || Date.now(),
          source: data.source || (url.includes('/api/weather') ? 'NOAA via Stratos API' : 'NOAA via bridge'),
        };
        weatherBusy = false;
        updateWeatherPanel();
        return;
      } catch (error) {
        weatherError = error.name === 'AbortError' ? 'Request timed out.' : error.message;
      }
    }
    weatherBusy = false;
    updateWeatherPanel();
  }

  function updateWeatherPanel() {
    const container = document.getElementById('airport-weather');
    if (!container) return;
    const parsed = weather && (weather.decoded || null);
    container.innerHTML = `
      <div class="card-head"><h2>Weather</h2><span class="spacer"></span>
        ${weatherBusy ? tag('loading', 'muted') : weather ? tag(weather.source || 'NOAA', 'accent') : tag('unavailable', 'warn')}</div>
      ${weather && weather.metar ? `<pre style="white-space:pre-wrap;margin:0 0 10px;padding:9px 11px;background:color-mix(in srgb,var(--bg) 50%,var(--ui2));border-radius:8px">${esc(weather.metar)}</pre>` : `<p class="muted small">${esc(weatherError || (weatherBusy ? 'Fetching METAR…' : 'No METAR available for this airport.'))}</p>`}
      ${parsed ? `<dl class="kv">
        <dt>Wind</dt><dd>${parsed.wind_dir != null ? `${String(parsed.wind_dir).padStart(3, '0')}° at ${parsed.wind_speed_kt || 0} kt${parsed.wind_gust_kt ? ` gust ${parsed.wind_gust_kt}` : ''}` : 'calm / variable'}</dd>
        <dt>Visibility</dt><dd>${esc(parsed.visibility_sm != null ? `${parsed.visibility_sm} SM` : '—')}</dd>
        <dt>Temperature</dt><dd>${parsed.temp_c != null ? `${parsed.temp_c}°C / dew ${parsed.dewpoint_c}°C` : '—'}</dd>
        <dt>Altimeter</dt><dd>${parsed.altimeter != null ? `${parsed.altimeter} inHg` : '—'}</dd>
        ${parsed.flight_category ? `<dt>Category</dt><dd>${esc(parsed.flight_category)}</dd>` : ''}
      </dl>` : ''}
      ${weather && weather.taf ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer">TAF</summary><pre style="white-space:pre-wrap;font-size:11.5px">${esc(weather.taf)}</pre></details>` : ''}
      ${weather ? `<p class="help" style="margin-top:8px">Fetched ${esc(fmtDateTime(weather.fetchedAt))}. Source: NOAA Aviation Weather Center (public domain).</p>` : ''}
      <div class="btn-row" style="margin-top:10px"><button class="btn small" id="refresh-airport-weather">Refresh</button></div>
    `;
    document.getElementById('refresh-airport-weather')?.addEventListener('click', () => loadWeather(selected, true));
  }

  function render() {
    cleanups.forEach(fn => { try { fn(); } catch (_) {} });
    cleanups = [];
    map?.destroy();
    map = null;
    const airport = find(selected);
    const runways = airportRunways(airport);
    const nearby = airport ? nearbyAirports(airport.lat, airport.lon, 6, 300) : [];
    const isFavorite = favorites.includes(selected);
    const frequencies = airport && airport.fqs ? Object.entries(airport.fqs) : [];

    root.innerHTML = `
      <div class="page-head">
        <div><h1>Airport explorer</h1>
        <p>Search by ICAO, name or city. Runway dimensions come from the airport database; headings derived from designators are marked <em>approx</em>.</p></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="field">
          <label for="airport-search">Search airports</label>
          <input class="input" id="airport-search" placeholder="Try KJFK, Heathrow, Toronto, Sydney" autocomplete="off" value="">
        </div>
        ${favorites.length ? `<div class="row" style="margin-top:10px"><span class="muted small">Favorites</span>
          ${favorites.map(code => `<button class="btn small ${code === selected ? 'primary' : ''}" data-favorite="${esc(code)}">${esc(code)}</button>`).join('')}</div>` : ''}
      </div>

      <div class="grid grid-main">
        <div class="stack">
          <div class="card">
            <div class="card-head">
              <div><h2 style="font-size:22px" class="route-id">${esc(selected)}</h2>
                <span class="muted small">${esc(airport ? airport.name : 'Airport not found in the current directory')}</span></div>
              <span class="spacer"></span>
              <button class="btn small ${isFavorite ? 'primary' : ''}" id="favorite-toggle">${isFavorite ? '★ Saved' : '☆ Save'}</button>
            </div>
            ${airport ? `<dl class="kv">
              <dt>Elevation</dt><dd>${num(airport.elev)} ft</dd>
              <dt>Position</dt><dd>${Number(airport.lat).toFixed(5)}, ${Number(airport.lon).toFixed(5)}</dd>
              <dt>Runways</dt><dd>${runways.length}</dd>
              <dt>Data source</dt><dd>${esc(airport.source === 'bridge' ? 'Bridge (OurAirports)' : 'Bundled OurAirports snapshot')}</dd>
            </dl>` : '<div class="notice warn">This code is not in the current airport directory. It may still exist; connect the bridge to search the full worldwide database.</div>'}
            <div class="map-wrap preview" style="margin-top:12px"><canvas id="airport-map" aria-label="Airport location"></canvas></div>
          </div>

          <div class="card flush">
            <div style="padding:14px 16px 4px"><h2>Runways</h2></div>
            ${runways.length ? `<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>Runway</th><th class="num">Length</th><th class="num">Width</th><th>Orientation</th></tr></thead><tbody>
              ${runways.map(runway => `<tr><td class="route-id">${esc(runway.id)}</td>
                <td class="num">${runway.lengthFt ? `${num(runway.lengthFt)} ft` : '—'}</td>
                <td class="num">${runway.widthFt ? `${num(runway.widthFt)} ft` : '—'}</td>
                <td>${runway.verified ? tag('verified ends', 'good') : tag('approx', 'warn', 'Derived from the runway designator')}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted small" style="padding:0 16px 16px">Runway data is not available for this airport.</p>'}
          </div>

          ${frequencies.length ? `<div class="card"><div class="card-head"><h2>Frequencies</h2></div>
            <div class="grid grid-3">${frequencies.map(([key, value]) => `<div><span class="stat-label">${esc(key)}</span><b>${esc(value)}</b> <span class="muted small">MHz</span></div>`).join('')}</div></div>` : ''}

          <div class="card" id="airport-weather"></div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Nearby airports</h2><span class="hint">Within 300 nm</span></div>
            ${nearby.length > 1 ? `<div class="list">${nearby.filter(item => item.id !== selected).slice(0, 6).map(item => `
              <button class="list-item" style="background:none;border:0;color:inherit;text-align:left;cursor:pointer;width:100%;padding:10px 0" data-nearby="${esc(item.id)}">
                <div class="main"><div class="title"><span class="route-id">${esc(item.id)}</span> <span class="muted small">${num(item.distanceNm)} nm</span></div>
                <div class="sub">${esc(item.name)}</div></div>
                <span class="muted">→</span>
              </button>`).join('')}</div>` : '<p class="muted small">No nearby airports in the bundled directory.</p>'}
          </div>

          <div class="card">
            <div class="card-head"><h2>Official information</h2></div>
            <div class="btn-row">
              <a class="btn small" href="https://skyvector.com/airport/${encodeURIComponent(selected)}" target="_blank" rel="noopener">SkyVector ↗</a>
              <a class="btn small ghost" href="https://chartfox.org/${encodeURIComponent(selected)}" target="_blank" rel="noopener">ChartFox ↗</a>
              <a class="btn small ghost" href="https://ourairports.com/airports/${encodeURIComponent(selected)}/" target="_blank" rel="noopener">OurAirports ↗</a>
              <a class="btn small ghost" href="https://www.airnav.com/airport/${encodeURIComponent(selected)}" target="_blank" rel="noopener">AirNav ↗</a>
            </div>
            <p class="help" style="margin-top:10px">Stratos links to official/third-party sources and does not redistribute licensed charts. Charts can require a subscription or a regional AIS account.</p>
          </div>

          <div class="notice"><div><strong>Data notes.</strong><br>OurAirports is public domain (CC0). Runway headings are derived from designators unless the bridge supplies threshold coordinates. Weather is NOAA public-domain data and can be unavailable.</div></div>
        </div>
      </div>
    `;

    const input = document.getElementById('airport-search');
    cleanups.push(wireSearch(input, {
      getItems: query => searchDirectory(ctx.directory, query, 10),
      renderItem: airportResultHtml,
      onPick: item => { selected = item.id; weather = null; render(); loadWeather(selected); },
    }));
    input.addEventListener('change', () => {
      const code = input.value.trim().toUpperCase();
      if (code) { selected = code; weather = null; render(); loadWeather(selected); }
    });
    document.getElementById('favorite-toggle')?.addEventListener('click', () => toggleFavorite(selected));
    document.querySelectorAll('[data-favorite]').forEach(button => button.addEventListener('click', () => {
      selected = button.dataset.favorite;
      weather = null;
      render();
      loadWeather(selected);
    }));
    document.querySelectorAll('[data-nearby]').forEach(button => button.addEventListener('click', () => {
      selected = button.dataset.nearby;
      weather = null;
      render();
      loadWeather(selected);
    }));

    if (airport) {
      const canvas = document.getElementById('airport-map');
      map = new MiniMap(canvas);
      map.setTrack([{ lat: airport.lat, lon: airport.lon }]);
    }
    updateWeatherPanel();
  }

  render();
  loadWeather(selected);
  return {
    destroy() {
      cleanups.forEach(fn => { try { fn(); } catch (_) {} });
      map?.destroy();
      root.innerHTML = '';
    },
  };
}
