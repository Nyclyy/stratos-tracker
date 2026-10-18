import { getSavedRoutes, saveRoutes } from '../lib/store.js';
import {
  validateRoute, routeTotals, moveWaypoint, removeWaypoint, directTo, insertWaypoint,
  parseWaypointText, exportPln, exportFms, exportGpx, importRoute, createSavedRoute,
  duplicateSavedRoute, searchPlaces, defaultRouteName,
} from '../lib/planner.js';
import { BUNDLED_NAVAIDS } from '../data/airports.js';
import { MiniMap } from '../minimap.js';
import { esc, fmtDate, num, tag, toast, downloadText, pickFile } from '../ui.js';
import { wireSearch } from './common.js';

export async function mount(root, ctx) {
  let savedRoutes = await getSavedRoutes().catch(() => []);
  let points = [];
  let name = 'Untitled route';
  let currentId = null;
  let dirty = false;
  let cruiseKts = 450;
  let cruiseAlt = 35000;
  let map = null;
  let cleanups = [];
  let lastValidation = null;

  // Restore the last active route or start from the most recent saved route.
  try {
    const stored = JSON.parse(localStorage.getItem('stratos.activeRoute') || 'null');
    if (stored && Array.isArray(stored.points) && stored.points.length) {
      points = stored.points;
      name = stored.name || defaultRouteName(points);
      currentId = stored.id || null;
    }
  } catch (_) {}
  if (!points.length && savedRoutes.length) {
    points = savedRoutes[0].points.map(p => ({ ...p }));
    name = savedRoutes[0].name;
    currentId = savedRoutes[0].id;
  }

  function persistActive() {
    try {
      localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: currentId, name, points }));
    } catch (_) {}
  }

  function setPoints(next, { markDirty = true } = {}) {
    points = next;
    if (markDirty) dirty = true;
    persistActive();
    render();
  }

  function addPoint(point) {
    if (points.length >= 200) { toast('Routes are limited to 200 waypoints.', 'bad'); return; }
    setPoints(insertWaypoint(points, point));
  }

  function combinedItems(query) {
    const navs = BUNDLED_NAVAIDS.map(nav => ({ ...nav, kind: 'nav', elev: 0 }));
    const all = [...ctx.directory, ...navs];
    return searchPlaces(all, query, 12);
  }

  async function saveCurrent() {
    if (points.length < 2) { toast('Add at least two waypoints before saving.', 'bad'); return; }
    const validation = validateRoute(points);
    if (!validation.valid) { toast(validation.errors[0].message, 'bad'); return; }
    if (currentId) {
      const index = savedRoutes.findIndex(route => route.id === currentId);
      if (index !== -1) {
        savedRoutes[index] = { ...savedRoutes[index], name, points: points.map(p => ({ ...p })), updatedAt: Date.now() };
      } else {
        const created = createSavedRoute(name, points);
        currentId = created.id;
        savedRoutes.unshift(created);
      }
    } else {
      const created = createSavedRoute(name, points);
      currentId = created.id;
      savedRoutes.unshift(created);
    }
    await saveRoutes(savedRoutes);
    dirty = false;
    persistActive();
    toast('Route saved on this device.', 'good');
    render();
  }

  async function deleteRoute(id) {
    if (!confirm('Delete this saved route?')) return;
    savedRoutes = savedRoutes.filter(route => route.id !== id);
    await saveRoutes(savedRoutes);
    if (currentId === id) { currentId = null; dirty = true; }
    toast('Route deleted.');
    render();
  }

  async function importFile() {
    const file = await pickFile('.pln,.fms,.gpx,text/plain,text/xml');
    if (!file) return;
    try {
      const text = await file.text();
      const result = importRoute(text);
      points = result.points.map(p => ({ ...p, name: p.name || p.id, elev: Number(p.elev) || 0 }));
      name = defaultRouteName(points);
      currentId = null;
      dirty = true;
      persistActive();
      toast(`Imported ${points.length} waypoints from ${result.format.toUpperCase()}.`, 'good');
      render();
    } catch (error) {
      toast(error.message, 'bad');
    }
  }

  async function importSimbrief() {
    const id = prompt('SimBrief username or Pilot ID:');
    if (!id) return;
    const query = /^\d+$/.test(id.trim()) ? `userid=${encodeURIComponent(id.trim())}` : `username=${encodeURIComponent(id.trim())}`;
    try {
      const response = await fetch(`https://www.simbrief.com/api/xml.fetcher.php?${query}&json=v2`);
      if (!response.ok) throw new Error(`SimBrief returned HTTP ${response.status}.`);
      const data = await response.json();
      const fixes = data.navlog && data.navlog.fix;
      if (!Array.isArray(fixes) || !fixes.length) throw new Error('The SimBrief plan contains no waypoints.');
      const origin = data.origin && data.origin.icao_code ? data.origin.icao_code : null;
      const destination = data.destination && data.destination.icao_code ? data.destination.icao_code : null;
      points = fixes.map((fix, index) => ({
        id: String(fix.ident || `WP${index + 1}`).toUpperCase(),
        name: fix.name || fix.ident || 'Waypoint',
        lat: Number(fix.pos_lat),
        lon: Number(fix.pos_long),
        elev: Number(fix.altitude_feet) || 0,
        kind: fix.type === 'apt' ? 'apt' : fix.type === 'vor' || fix.type === 'ndb' ? 'nav' : 'fix',
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (points.length < 2) throw new Error('No usable coordinates in the SimBrief plan.');
      name = `${origin || points[0].id} → ${destination || points[points.length - 1].id} (SimBrief)`;
      currentId = null;
      dirty = true;
      const cruise = Number(data.general && data.general.cruise_altitude);
      if (Number.isFinite(cruise) && cruise > 0) cruiseAlt = cruise;
      const tas = Number(data.general && data.general.cruise_tas);
      if (Number.isFinite(tas) && tas > 0) cruiseKts = tas;
      persistActive();
      toast(`Imported ${points.length} waypoints from SimBrief. Weather, winds and fuel are not imported.`, 'good');
      render();
    } catch (error) {
      toast(`SimBrief import failed: ${error.message}`, 'bad');
    }
  }

  function sendToMap() {
    if (points.length < 2) { toast('Add at least two waypoints first.', 'bad'); return; }
    const mapRoute = points.map(p => ({
      id: p.id, name: p.name || p.id, lat: p.lat, lon: p.lon,
      elev: Number(p.elev) || 0, k: p.kind || p.k || 'fix',
    }));
    try {
      localStorage.setItem('dl.route', JSON.stringify(mapRoute));
      localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: currentId, name, points }));
      toast('Route sent to the map.', 'good');
      setTimeout(() => { location.href = 'index.html'; }, 450);
    } catch (_) {
      toast('This browser refused local storage.', 'bad');
    }
  }

  function render() {
    cleanups.forEach(fn => { try { fn(); } catch (_) {} });
    cleanups = [];
    map?.destroy();
    map = null;

    const validation = validateRoute(points);
    lastValidation = validation;
    const totals = routeTotals(validation.points, { cruiseKts, cruiseAlt });
    const legs = totals.legs;

    root.innerHTML = `
      <div class="page-head">
        <div><h1>Route planner</h1>
        <p>Build, validate and export a route. Times are estimates with no wind, fuel or ATC rules; use SimBrief for operational planning.</p></div>
        <span class="spacer"></span>
        <button class="btn" id="import-simbrief">Import SimBrief</button>
        <button class="btn ghost" id="import-file">Import file</button>
      </div>

      <div class="grid grid-main">
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>${esc(name)}</h2>${dirty ? tag('unsaved changes', 'warn') : tag('saved', 'good')}
              <span class="spacer"></span><button class="btn small" id="save-route">Save</button></div>
            <div class="field-row">
              <div class="field" style="flex:2 1 240px"><label for="route-name">Route name</label>
                <input class="input" id="route-name" value="${esc(name)}" maxlength="60"></div>
              <div class="field" style="flex:0 1 110px"><label for="route-speed">Cruise kt</label>
                <input class="input" id="route-speed" type="number" min="60" max="600" value="${cruiseKts}"></div>
              <div class="field" style="flex:0 1 120px"><label for="route-alt">Cruise ft</label>
                <input class="input" id="route-alt" type="number" min="1000" max="60000" step="1000" value="${cruiseAlt}"></div>
            </div>
            <div class="field" style="margin-top:10px">
              <label for="route-add">Add waypoint — airport, navaid, or latitude,longitude</label>
              <input class="input" id="route-add" placeholder="KSFO, SFO, or 37.62,-122.38" autocomplete="off" spellcheck="false">
            </div>
            ${validation.errors.length ? `<div class="notice bad" style="margin-top:10px"><div><strong>${validation.errors.length} problem${validation.errors.length === 1 ? '' : 's'}.</strong><br>${validation.errors.map(e => esc(e.message)).join('<br>')}</div></div>` : ''}
            ${validation.warnings.length ? `<div class="notice warn" style="margin-top:10px"><div>${validation.warnings.map(w => esc(w.message)).join('<br>')}</div></div>` : ''}
          </div>

          <div class="card flush">
            <div style="padding:14px 16px 4px"><h2>Waypoints</h2></div>
            ${points.length ? `<div class="table-wrap" style="border:0;border-radius:0">
              <table class="data"><thead><tr><th>#</th><th>Ident</th><th>Name</th><th class="num">Leg</th><th>Actions</th></tr></thead><tbody>
              ${points.map((point, index) => {
                const leg = legs[index - 1];
                return `<tr>
                  <td>${index + 1}</td>
                  <td class="route-id">${esc(point.id)}</td>
                  <td class="muted clamp" style="max-width:220px">${esc(point.name || '')}</td>
                  <td class="num">${leg ? `${num(leg.distanceNm, 1)} nm` : '—'}</td>
                  <td><div class="row" style="gap:3px">
                    <button class="btn small icon" data-up="${index}" aria-label="Move ${esc(point.id)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button class="btn small icon" data-down="${index}" aria-label="Move ${esc(point.id)} down" ${index === points.length - 1 ? 'disabled' : ''}>↓</button>
                    <button class="btn small" data-direct="${index}" ${index === 0 || index === points.length - 1 ? 'disabled' : ''}>Direct</button>
                    <button class="btn small danger" data-remove="${index}" aria-label="Remove ${esc(point.id)}">✕</button>
                  </div></td>
                </tr>`;
              }).join('')}
              </tbody></table></div>` : `<p class="muted small" style="padding:16px">No waypoints yet. Search for an airport above or import a flight plan.</p>`}
          </div>

          <div class="card">
            <div class="card-head"><h2>Preview</h2><span class="hint">Recorded airports are shown at their real positions</span></div>
            <div class="map-wrap preview"><canvas id="route-map" aria-label="Route preview"></canvas></div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Estimate</h2><span class="spacer"></span>${tag('estimate', 'warn')}</div>
            <div class="grid grid-2">
              <div><span class="stat-label">Distance</span><b style="font-size:20px">${points.length > 1 ? `${num(totals.distanceNm, 1)} nm` : '—'}</b></div>
              <div><span class="stat-label">Flight time</span><b style="font-size:20px">${points.length > 1 ? `${Math.floor(totals.eteMinutes / 60)}h ${String(totals.eteMinutes % 60).padStart(2, '0')}m` : '—'}</b></div>
              <div><span class="stat-label">Great circle</span><b>${totals.greatCircleNm ? `${num(totals.greatCircleNm, 1)} nm` : '—'}</b></div>
              <div><span class="stat-label">Waypoints</span><b>${points.length}</b></div>
            </div>
            <p class="help" style="margin-top:10px">${esc(totals.method)}</p>
          </div>

          <div class="card">
            <div class="card-head"><h2>Send and export</h2></div>
            <div class="btn-row">
              <button class="btn primary" id="send-map">Send to map</button>
              <button class="btn" id="export-pln">MSFS .pln</button>
              <button class="btn" id="export-fms">X-Plane .fms</button>
              <button class="btn" id="export-gpx">GPX</button>
            </div>
            <p class="help" style="margin-top:10px">Exports contain the waypoint identifiers and coordinates you see here. They do not include SIDs, STARs, airways or performance data.</p>
          </div>

          <div class="card flush">
            <div class="card-head" style="padding:14px 16px 0"><h2>Saved routes</h2><span class="spacer"></span><span class="tag">${savedRoutes.length}</span></div>
            ${savedRoutes.length ? `<div class="list" style="padding:4px 16px 12px">
              ${savedRoutes.map(route => `<div class="list-item">
                <div class="main"><div class="title">${esc(route.name)}</div>
                <div class="sub">${route.points.length} waypoints · ${esc(fmtDate(route.updatedAt || route.createdAt))}${route.id === currentId ? ' · open' : ''}</div></div>
                <div class="row" style="gap:3px">
                  <button class="btn small" data-load="${esc(route.id)}">Load</button>
                  <button class="btn small ghost" data-copy="${esc(route.id)}">Copy</button>
                  <button class="btn small danger" data-delete="${esc(route.id)}">✕</button>
                </div>
              </div>`).join('')}
            </div>` : '<p class="muted small" style="padding:0 16px 16px">No saved routes yet.</p>'}
          </div>

          <div class="notice"><div><strong>Where the data comes from.</strong><br>Airports: bundled OurAirports snapshot plus the bridge's worldwide database. Navaids: bundled snapshot. SimBrief is an external service and may be unavailable or rate limited.</div></div>
        </div>
      </div>
    `;

    const mapWrap = document.getElementById('route-map');
    if (mapWrap && points.length) {
      map = new MiniMap(mapWrap);
      map.setTrack(points);
    }

    document.getElementById('route-name').addEventListener('change', event => {
      name = event.target.value.trim().slice(0, 60) || defaultRouteName(points);
      dirty = true;
      persistActive();
      render();
    });
    document.getElementById('route-speed').addEventListener('change', event => {
      cruiseKts = Math.max(60, Math.min(600, Number(event.target.value) || 450));
      render();
    });
    document.getElementById('route-alt').addEventListener('change', event => {
      cruiseAlt = Math.max(1000, Math.min(60000, Number(event.target.value) || 35000));
      render();
    });

    const addInput = document.getElementById('route-add');
    const cleanupSearch = wireSearch(addInput, {
      getItems: combinedItems,
      renderItem: item => `<span class="route-id">${esc(item.id)}</span> ${esc(item.name || '')}<span class="sub">${esc(item.kind === 'nav' || item.type ? (item.type || 'navaid') : 'airport')}${item.elev ? ` · ${Math.round(item.elev)} ft` : ''}</span>`,
      onPick: item => addPoint({ ...item, kind: item.type ? 'nav' : 'apt', elev: Number(item.elev) || 0 }),
      emptyText: 'No airport or navaid matched. You can also type latitude,longitude.',
    });
    cleanups.push(cleanupSearch);

    addInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      const parsed = parseWaypointText(addInput.value);
      if (parsed && parsed.error) { toast(parsed.error, 'bad'); return; }
      if (parsed) {
        const existing = ctx.directory.find(a => a.id === parsed.id) || BUNDLED_NAVAIDS.find(n => n.id === parsed.id);
        addPoint(existing ? { ...existing, kind: existing.type ? 'nav' : 'apt' } : parsed);
      }
    });

    document.getElementById('save-route').addEventListener('click', saveCurrent);
    document.getElementById('import-simbrief').addEventListener('click', importSimbrief);
    document.getElementById('import-file').addEventListener('click', importFile);
    document.getElementById('send-map').addEventListener('click', sendToMap);
    document.getElementById('export-pln').addEventListener('click', () => {
      try { downloadText(`${safeName(name)}.pln`, exportPln(points, { title: name }), 'application/xml'); }
      catch (error) { toast(error.message, 'bad'); }
    });
    document.getElementById('export-fms').addEventListener('click', () => {
      try { downloadText(`${safeName(name)}.fms`, exportFms(points), 'text/plain'); }
      catch (error) { toast(error.message, 'bad'); }
    });
    document.getElementById('export-gpx').addEventListener('click', () => {
      try { downloadText(`${safeName(name)}.gpx`, exportGpx(points, { title: name }), 'application/gpx+xml'); }
      catch (error) { toast(error.message, 'bad'); }
    });

    root.querySelectorAll('[data-up]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.up);
      setPoints(moveWaypoint(points, index, index - 1));
    }));
    root.querySelectorAll('[data-down]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.down);
      setPoints(moveWaypoint(points, index, index + 1));
    }));
    root.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => {
      setPoints(removeWaypoint(points, Number(button.dataset.remove)));
    }));
    root.querySelectorAll('[data-direct]').forEach(button => button.addEventListener('click', () => {
      if (!confirm('Drop intermediate waypoints and fly direct to this point?')) return;
      setPoints(directTo(points, Number(button.dataset.direct)));
    }));
    root.querySelectorAll('[data-load]').forEach(button => button.addEventListener('click', () => {
      const route = savedRoutes.find(item => item.id === button.dataset.load);
      if (!route) return;
      points = route.points.map(p => ({ ...p }));
      name = route.name;
      currentId = route.id;
      dirty = false;
      persistActive();
      render();
    }));
    root.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
      const route = savedRoutes.find(item => item.id === button.dataset.copy);
      if (!route) return;
      savedRoutes.unshift(duplicateSavedRoute(route));
      await saveRoutes(savedRoutes);
      toast('Route duplicated.');
      render();
    }));
    root.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => deleteRoute(button.dataset.delete)));
  }

  render();
  return {
    destroy() {
      cleanups.forEach(fn => { try { fn(); } catch (_) {} });
      map?.destroy();
      root.innerHTML = '';
    },
  };
}

function safeName(name) {
  return String(name || 'stratos-route').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'stratos-route';
}

