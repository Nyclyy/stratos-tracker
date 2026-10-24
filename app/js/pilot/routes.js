import { getSavedRoutes, saveRoutes } from '../lib/store.js';
import {
  validateRoute, routeTotals, moveWaypoint, removeWaypoint, directTo, insertWaypoint,
  parseWaypointText, exportPln, exportFms, exportGpx, importRoute, createSavedRoute,
  duplicateSavedRoute, searchPlaces, defaultRouteName, routeProfile, routeLegs,
  legDetails, routeProgress,
} from '../lib/planner.js';
import { BUNDLED_NAVAIDS } from '../data/airports.js';
import { fetchSimbriefPlan, loadSimbriefId, saveSimbriefId } from '../lib/simbrief.js';
import { saveOfp } from '../lib/flightsummary.js';
import { formatLatLon } from '../lib/geo.js';
import { esc, fmtDate, fmtDateTime, num, tag, toast, downloadText, pickFile, askText } from '../ui.js';
import { wireSearch } from './common.js';
import {
  analyseRouteWeather, pickWeatherStations, withRouteCourses,
} from '../lib/routeweather.js';
import { legWinds, parseWindsAloft, windsAreStale } from '../lib/windsaloft.js';
import { MiniMap } from '../minimap.js';

const WEATHER_TTL = 5 * 60 * 1000;
/** The winds-aloft table is published a few times a day; half an hour is plenty. */
const WINDS_TTL = 30 * 60 * 1000;
/** Sidebar state survives a reload so the map keeps the space the pilot gave it. */
const SIDEBAR_KEY = 'stratos.planSidebar';
const MAX_UNDO = 40;

/** METARs shared across planner renders; five minutes matches NOAA's own cadence. */
const weatherCache = new Map();

function readSidebarOpen() {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved === 'open') return true;
    if (saved === 'closed') return false;
  } catch (_) {}
  return window.innerWidth >= 1100;
}

function writeSidebarOpen(open) {
  try { localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed'); } catch (_) {}
}

export async function mount(root, ctx) {
  let savedRoutes = await getSavedRoutes().catch(() => []);
  let points = [];
  let name = 'Untitled route';
  let currentId = null;
  let dirty = false;
  let cruiseKts = 450;
  let cruiseAlt = 35000;
  let cleanups = [];
  let undoStack = [];
  let selection = null;
  let sidebarOpen = readSidebarOpen();
  let lastValidation = null;
  let livePosition = null;
  let liveGroundspeed = null;
  let liveFlight = null;
  let livePaintedAt = 0;
  let routeWeather = { status: 'idle', rows: [], challenges: [], error: '', fetchedAt: 0 };
  let weatherKey = '';
  let weatherRun = 0;
  const weatherControllers = new Set();
  let windsStatus = 'idle';
  let windsError = '';
  let windsTable = null;
  let planMap = null;
  let dragSnapshotTaken = false;

  const findAirport = code => ctx.directory.find(airport => airport.id === String(code || '').toUpperCase()) || null;

  /* ── live flight ─────────────────────────────────────────────────── */

  function readLive() {
    const message = ctx.live;
    const telemetry = message && message.telemetry;
    liveFlight = message ? message.currentFlight || null : null;
    if (!telemetry) { livePosition = null; liveGroundspeed = null; return false; }
    // A snapshot older than ten seconds is not used for progress: a stale
    // marker would claim the aircraft is somewhere it has already left.
    if (Date.now() - (telemetry.receivedAt || 0) > 10000) return false;
    livePosition = { lat: telemetry.lat, lon: telemetry.lon };
    liveGroundspeed = telemetry.gs > 20 ? telemetry.gs : null;
    return true;
  }

  function onTelemetry() {
    const now = Date.now();
    // One repaint every half second is enough for a route summary and keeps
    // the map free for interaction on slower machines.
    if (now - livePaintedAt < 500) return;
    livePaintedAt = now;
    if (!readLive()) return;
    updateLiveUi();
  }

  function updateLiveUi() {
    const stats = document.getElementById('plan-stats');
    if (stats) stats.innerHTML = statsHtml();
  }

  /* ── route editing ───────────────────────────────────────────────── */

  function snapshot() {
    return {
      points: points.map(point => ({ ...point })),
      name,
      currentId,
      cruiseKts,
      cruiseAlt,
      selection,
    };
  }

  function pushSnapshot(state) {
    undoStack.push(state);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  function pushUndo() {
    pushSnapshot(snapshot());
  }

  function undo() {
    const previous = undoStack.pop();
    if (!previous) { toast('Nothing left to undo.'); return; }
    points = previous.points;
    name = previous.name;
    currentId = previous.currentId;
    cruiseKts = previous.cruiseKts;
    cruiseAlt = previous.cruiseAlt;
    selection = previous.selection;
    dirty = true;
    persistActive();
    render();
    toast('Change undone.', 'good');
  }

  function setPoints(next, { markDirty = true } = {}) {
    // Keep the default name in step with the endpoints. A name the pilot typed
    // (or a SimBrief name) is left alone.
    const previousDefault = defaultRouteName(points);
    points = next;
    if (!name || name === 'Untitled route' || name === previousDefault) name = defaultRouteName(points);
    if (markDirty) dirty = true;
    if (selection && selection.kind === 'waypoint' && selection.index >= points.length) selection = null;
    if (selection && selection.kind === 'leg' && selection.index >= points.length - 1) selection = null;
    persistActive();
    render();
  }

  function persistActive() {
    try {
      localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: currentId, name, points, cruiseKts, cruiseAlt, dirty }));
    } catch (_) {}
  }

  function addPoint(point) {
    if (points.length >= 200) { toast('Routes are limited to 200 waypoints.', 'bad'); return; }
    pushUndo();
    setPoints(insertWaypoint(points, point));
  }

  function removePoint(index) {
    pushUndo();
    setPoints(removeWaypoint(points, index));
  }

  function movePoint(from, to) {
    if (to < 0 || to >= points.length) return;
    pushUndo();
    setPoints(moveWaypoint(points, from, to));
    selection = { kind: 'waypoint', index: to };
    paintSelection();
  }

  function direct(index) {
    if (!confirm('Drop the intermediate waypoints and fly direct to this point?')) return;
    pushUndo();
    setPoints(directTo(points, index));
  }

  /* ── selection ───────────────────────────────────────────────────── */

  function select(next) {
    selection = next && next.kind ? { kind: next.kind, index: Number(next.index) } : null;
    paintSelection();
  }

  /* ── map ─────────────────────────────────────────────────────────── */

  /**
   * The map is created once and moved into the new markup on every render, so
   * its tile cache, listeners and view survive a route edit. Clicking a
   * waypoint or a leg on it selects exactly what the sidebar rows select. */
  function ensurePlanMap() {
    const host = document.getElementById('plan-map-canvas');
    if (!host) return;
    if (!planMap) {
      try {
        const canvas = document.createElement('canvas');
        planMap = new MiniMap(canvas, {
          padding: 30,
          onSelect(hit) {
            if (!hit) { select(null); return; }
            select({ kind: hit.kind === 'segment' ? 'leg' : 'waypoint', index: hit.index });
          },
          onDragWaypoint(index, position, meta) {
            if (!points[index]) return;
            if (!meta || !meta.committed) {
              if (!dragSnapshotTaken) { pushUndo(); dragSnapshotTaken = true; }
              points[index] = { ...points[index], lat: position.lat, lon: position.lon };
              planMap.setRoute(points.map(p => ({ id: p.id, lat: p.lat, lon: p.lon })));
              return;
            }
            dragSnapshotTaken = false;
            dirty = true;
            select({ kind: 'waypoint', index });
            persistActive();
            render();
          },
        });
      } catch (_) {
        // No canvas or no ResizeObserver (tests, very old browsers): the plan
        // stays usable, it just does not draw a map.
        planMap = null;
        return;
      }
    }
    planMap.attach(host);
    planMap.setRoute(points.map(p => ({ id: p.id, lat: p.lat, lon: p.lon })));
    syncMapSelection();
  }

  function syncMapSelection() {
    if (!planMap) return;
    if (!selection) {
      planMap.setSelection({ segments: [], segmentIndex: null, waypointIndex: null });
      return;
    }
    if (selection.kind === 'leg') {
      planMap.setSelection({ segments: [selection.index], segmentIndex: selection.index, waypointIndex: null });
      return;
    }
    const segments = [selection.index - 1, selection.index].filter(index => index >= 0 && index < points.length - 1);
    planMap.setSelection({ segments, segmentIndex: null, waypointIndex: selection.index });
  }

  function paintSelection() {
    root.querySelectorAll('[data-leg]').forEach(row => {
      row.classList.toggle('is-selected', Boolean(selection) && selection.kind === 'leg' && Number(row.dataset.leg) === selection.index);
      row.setAttribute('aria-selected', row.classList.contains('is-selected') ? 'true' : 'false');
    });
    root.querySelectorAll('[data-wp]').forEach(row => {
      row.classList.toggle('is-selected', Boolean(selection) && selection.kind === 'waypoint' && Number(row.dataset.wp) === selection.index);
      row.setAttribute('aria-selected', row.classList.contains('is-selected') ? 'true' : 'false');
    });
    paintInspector();
    paintProfileSelection();
    syncMapSelection();
  }

  function paintProfileSelection() {
    root.querySelectorAll('[data-profile-wp]').forEach(node => {
      node.classList.toggle('is-active', Boolean(selection) && selection.kind === 'waypoint' && Number(node.dataset.profileWp) === selection.index);
    });
  }

  /* ── display helpers ─────────────────────────────────────────────── */

  function courseText(deg) {
    return Number.isFinite(deg) ? `${String(Math.round(deg) % 360).padStart(3, '0')}°` : '—';
  }

  function minutesText(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return '—';
    const whole = Math.round(minutes);
    return `${Math.floor(whole / 60)}h ${String(whole % 60).padStart(2, '0')}m`;
  }

  function plannedTotals() {
    const validation = validateRoute(points);
    return routeTotals(validation.points, { cruiseKts, cruiseAlt });
  }

  function currentLegs() {
    const validation = validateRoute(points);
    return legDetails(validation.points, { cruiseKts, groundSpeedKts: liveGroundspeed });
  }

  function progressNow() {
    if (!livePosition || points.length < 2) return null;
    return routeProgress(points, livePosition);
  }

  function statsHtml() {
    if (points.length < 2) {
      return '<span class="plan-chip"><b>—</b><span>Distance</span></span>'
        + '<span class="plan-chip"><b>—</b><span>Legs</span></span>'
        + '<span class="plan-chip"><b>—</b><span>ETE</span></span>';
    }
    const totals = plannedTotals();
    const progress = progressNow();
    const remaining = progress
      ? `<span class="plan-chip${progress.onRoute ? '' : ' is-warn'}" title="${progress.onRoute ? 'Distance remaining along the planned route' : 'The aircraft is far from every planned leg, so this is measured to the nearest leg'}"><b>${num(progress.remainingNm, 0)} nm</b><span>Remaining</span></span>`
      : '<span class="plan-chip is-muted" title="Remaining distance appears while the simulator is live"><b>—</b><span>Remaining</span></span>';
    return `<span class="plan-chip"><b>${num(totals.distanceNm, 0)} nm</b><span>Distance</span></span>`
      + `<span class="plan-chip"><b>${totals.legs.length}</b><span>Legs</span></span>`
      + `<span class="plan-chip"><b>${minutesText(totals.eteMinutes)}</b><span>ETE</span></span>`
      + remaining;
  }

  function statementSummary() {
    if (points.length < 2) return 'Add a departure and a destination to build a plan.';
    const dep = points[0].id;
    const arr = points[points.length - 1].id;
    const totals = plannedTotals();
    return `${dep} to ${arr} · ${num(totals.distanceNm, 1)} nm · ${totals.legs.length} leg${totals.legs.length === 1 ? '' : 's'}. Estimates use the cruise speed above, no wind and no ATC routing.`;
  }

  function waypointTitle(point) {
    return point.name && point.name !== point.id ? `${point.id} · ${point.name}` : point.id;
  }

  // SimBrief gives each fix its planned altitude in `elev`; airports carry field elevation.
  function altitudeText(point, profilePoint) {
    if (point.constraintAlt) return restrictionText(point, profilePoint);
    if (Number(point.elev) > 0) {
      return point.kind === 'apt'
        ? `${num(point.elev)} ft <span class="muted">(field elevation)</span>`
        : `${num(point.elev)} ft <span class="muted">(planned altitude in the imported plan)</span>`;
    }
    return restrictionText(point, profilePoint);
  }

  function restrictionText(point, profilePoint) {
    if (point.constraintAlt) {
      return `${num(point.constraintAlt)} ft <span class="muted">(in the imported plan)</span>`;
    }
    if (profilePoint) {
      return `${num(profilePoint.plannedAlt)} ft <span class="muted">(estimate, no restriction)</span>`;
    }
    return 'No altitude restriction was supplied';
  }

  /* ── inspector ───────────────────────────────────────────────────── */

  function legInspector(index) {
    const legs = currentLegs();
    const leg = legs[index];
    if (!leg) return '<div class="plan-inspector-empty">That leg no longer exists.</div>';
    const magnetic = leg.magneticCourse == null
      ? `<span class="muted">Not available — no magnetic variation was supplied for these waypoints</span>`
      : `${courseText(leg.magneticCourse)} <span class="muted">(${leg.variationSource}, ${leg.variationDeg > 0 ? 'east' : 'west'} ${Math.abs(leg.variationDeg).toFixed(1)}°)</span>`;
    return `<div class="plan-inspector-head">
        <div><span class="plan-eyebrow">Leg ${leg.index} of ${legs.length}</span>
          <h3>${esc(leg.from.id)} <span class="plan-arrow">→</span> ${esc(leg.to.id)}</h3></div>
        <button class="plan-icon-btn" data-inspector-close aria-label="Close leg details">✕</button>
      </div>
      <dl class="plan-kv">
        <div><dt>Distance</dt><dd>${num(leg.distanceNm, 1)} nm</dd></div>
        <div><dt>Initial true course</dt><dd>${courseText(leg.trueCourse)} <span class="muted">T</span></dd></div>
        <div><dt>Magnetic course</dt><dd>${magnetic}</dd></div>
        <div><dt>Estimated leg time</dt><dd>${minutesText(leg.eteMinutes)} <span class="muted">at ${leg.groundspeedKts} kt ${leg.groundspeedSource === 'current ground speed' ? 'ground speed' : 'planned speed'}</span></dd></div>
        <div><dt>${esc(leg.from.id)}</dt><dd class="mono">${formatLatLon(leg.from.lat, leg.from.lon)}</dd></div>
        <div><dt>${esc(leg.to.id)}</dt><dd class="mono">${formatLatLon(leg.to.lat, leg.to.lon)}</dd></div>
      </dl>
      <details class="plan-note"><summary>Course, heading and track</summary>
        <p>True course is the geodesic initial bearing between the two waypoints. Magnetic course is that bearing with the supplied variation applied; it is shown only when variation came with the data. Neither is the aircraft's track over the ground, which depends on wind and steering.</p>
      </details>`;
  }

  function waypointInspector(index) {
    const point = points[index];
    if (!point) return '<div class="plan-inspector-empty">That waypoint no longer exists.</div>';
    const profile = routeProfile(validateRoute(points).points, { cruiseKts, cruiseAlt });
    const profilePoint = profile ? profile.points[index] : null;
    const legs = currentLegs();
    const inLeg = legs[index - 1];
    const outLeg = legs[index];
    const along = legs.slice(0, index).reduce((sum, leg) => sum + leg.distanceNm, 0);
    const adjacent = [
      inLeg ? `<li><button class="plan-link" data-leg="${inLeg.index - 1}">From ${esc(inLeg.from.id)}</button> · ${num(inLeg.distanceNm, 1)} nm · ${courseText(inLeg.trueCourse)} T</li>` : '',
      outLeg ? `<li><button class="plan-link" data-leg="${outLeg.index - 1}">To ${esc(outLeg.to.id)}</button> · ${num(outLeg.distanceNm, 1)} nm · ${courseText(outLeg.trueCourse)} T</li>` : '',
    ].filter(Boolean).join('');
    return `<div class="plan-inspector-head">
        <div><span class="plan-eyebrow">Waypoint ${index + 1} of ${points.length}</span>
          <h3>${esc(waypointTitle(point))}</h3></div>
        <button class="plan-icon-btn" data-inspector-close aria-label="Close waypoint details">✕</button>
      </div>
      <dl class="plan-kv">
        <div><dt>Identifier</dt><dd class="mono">${esc(point.id)}</dd></div>
        <div><dt>Coordinates</dt><dd class="mono">${formatLatLon(point.lat, point.lon)}</dd></div>
        <div><dt>Altitude</dt><dd>${altitudeText(point, profilePoint)}</dd></div>
        <div><dt>Distance from departure</dt><dd>${num(along, 1)} nm</dd></div>
        <div><dt>Distance from previous</dt><dd>${inLeg ? `${num(inLeg.distanceNm, 1)} nm` : '—'}</dd></div>
        <div><dt>Distance to next</dt><dd>${outLeg ? `${num(outLeg.distanceNm, 1)} nm` : '—'}</dd></div>
        <div><dt>Type</dt><dd>${esc(point.kind === 'apt' ? 'Airport' : point.kind === 'nav' ? 'Navaid' : 'Waypoint')}</dd></div>
      </dl>
      ${adjacent ? `<div class="plan-adjacent"><span class="plan-eyebrow">Connected legs</span><ul>${adjacent}</ul></div>` : ''}
      <div class="plan-inspector-actions">
        <button class="plan-btn" data-wp-up="${index}" ${index === 0 ? 'disabled' : ''}>Move up</button>
        <button class="plan-btn" data-wp-down="${index}" ${index === points.length - 1 ? 'disabled' : ''}>Move down</button>
        <button class="plan-btn" data-wp-direct="${index}" ${index === 0 || index === points.length - 1 ? 'disabled' : ''}>Direct</button>
        <button class="plan-btn danger" data-wp-remove="${index}">Delete</button>
      </div>`;
  }

  function paintInspector() {
    const panel = document.getElementById('plan-inspector');
    if (!panel) return;
    if (!selection) { panel.hidden = true; panel.innerHTML = ''; return; }
    panel.hidden = false;
    panel.innerHTML = selection.kind === 'leg' ? legInspector(selection.index) : waypointInspector(selection.index);
  }

  function paintStats() {
    const stats = document.getElementById('plan-stats');
    if (stats) stats.innerHTML = statsHtml();
    const summary = document.getElementById('plan-summary-line');
    if (summary) summary.textContent = statementSummary();
  }

  /* ── weather ─────────────────────────────────────────────────────── */

  function weatherSources(code) {
    const urls = [];
    const bridge = String(ctx.bridgeBase || '').replace(/\/+$/, '');
    if (bridge && (ctx.health || location.port === '8765')) {
      urls.push(`${bridge}/weather?icao=${encodeURIComponent(code)}`);
    }
    if (/^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      urls.push(`/api/weather?icao=${encodeURIComponent(code)}`);
    }
    return urls;
  }

  async function fetchStationWeather(code, force = false) {
    const cached = weatherCache.get(code);
    if (!force && cached && Date.now() - cached.at < WEATHER_TTL) return cached.payload;
    for (const url of weatherSources(code)) {
      const controller = new AbortController();
      weatherControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: location.protocol === 'file:' ? 'omit' : 'include',
          signal: controller.signal,
        });
        if (!response.ok) continue;
        const payload = await response.json();
        if (!payload || (!payload.metar && !payload.taf)) continue;
        weatherCache.set(code, { at: Date.now(), payload });
        return payload;
      } catch (_) {
        // Try the next source; when all fail the card reports unavailable.
      } finally {
        clearTimeout(timer);
        weatherControllers.delete(controller);
      }
    }
    return null;
  }

  function windText(wind) {
    if (!wind || wind.speedKt == null) return '—';
    const direction = wind.direction == null ? 'VRB' : `${String(wind.direction).padStart(3, '0')}°`;
    return `${direction} ${wind.speedKt} kt${wind.gustKt ? ` G${wind.gustKt}` : ''}`;
  }

  function componentText(components) {
    if (!components) return '—';
    const head = components.headwindKt >= 0
      ? `${components.headwindKt} kt head`
      : `${Math.abs(components.headwindKt)} kt tail`;
    const cross = components.crosswindKt === 0
      ? 'no crosswind'
      : `${Math.abs(components.crosswindKt)} kt ${components.crosswindKt > 0 ? 'right' : 'left'}`;
    return `${head} · ${cross}`;
  }

  function weatherBody() {
    if (points.length < 2) {
      return '<p class="muted small" style="padding:0 16px 16px">Add a departure and destination to fetch weather along the route.</p>';
    }
    if (routeWeather.status === 'loading') {
      return '<div class="muted small" style="padding:0 16px 16px"><span class="spinner" aria-hidden="true"></span> Fetching METAR for the airports on this route…</div>';
    }
    if (routeWeather.status === 'unavailable' || routeWeather.status === 'error') {
      return `<div class="notice warn" style="margin:0 16px 16px"><div>${esc(routeWeather.error || 'Route weather is unavailable.')}</div></div>`;
    }
    if (routeWeather.status !== 'ready') {
      return '<p class="muted small" style="padding:0 16px 16px">Weather has not been requested for this route.</p>';
    }
    const rows = routeWeather.rows.map(row => `<tr>
        <td><span class="route-id">${esc(row.id)}</span><span class="muted small clamp" style="display:block;max-width:150px">${esc(row.name || '')}</span></td>
        <td style="white-space:nowrap">${esc(windText(row.wind))}</td>
        <td>${row.visibilitySm == null ? '—' : `${num(row.visibilitySm, 1)} SM`}</td>
        <td>${row.ceilingFt == null ? '—' : `${num(row.ceilingFt)} ft`}</td>
        <td>${row.flightCategory
          ? tag(row.flightCategory, row.flightCategory === 'VFR' ? 'good' : row.flightCategory === 'MVFR' ? 'warn' : 'bad')
          : tag('unknown', 'warn')}</td>
        <td class="num">${esc(Number.isFinite(row.courseDeg) ? `${String(Math.round(row.courseDeg)).padStart(3, '0')}° · ${componentText(row.components)}` : componentText(row.components))}</td>
      </tr>`).join('');
    const challenges = routeWeather.challenges.length
      ? `<ul class="small" style="margin:10px 0 0;padding-left:18px">${routeWeather.challenges.map(challenge => `<li>${esc(challenge.text)}</li>`).join('')}</ul>`
      : '<p class="help" style="margin-top:10px">No IFR, gust, crosswind or tailwind challenge was derived from these reports. That is not a go/no-go assessment.</p>';
    const fetched = routeWeather.fetchedAt ? `Fetched ${fmtDateTime(routeWeather.fetchedAt)}. ` : '';
    return `<div class="table-wrap" style="border:0"><table class="data" style="min-width:0">
        <thead><tr><th>Station</th><th>Wind</th><th>Visibility</th><th>Ceiling</th><th>Category</th><th style="white-space:normal">Course · surface component</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div style="padding:0 16px 16px">${challenges}
        <p class="help" style="margin-top:10px">Real-world METAR from NOAA at the airports on this route. Surface wind only — this is not winds aloft and not simulator weather. ${esc(fetched)}Cached for 5 minutes.</p>
      </div>`;
  }

  /** Winds aloft: one cached table from the hosted endpoint, shared by every route. */
  async function loadWinds() {
    if (points.length < 2 || windsStatus === 'loading') return;
    if (windsTable && Date.now() - windsTable.at < WINDS_TTL) {
      windsStatus = 'ready';
      paintRouteWeather();
      return;
    }
    if (!/^https?:$/.test(location.protocol) || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      windsStatus = 'unavailable';
      windsError = 'Winds aloft come from the hosted Stratos site or a bridge that proxies them.';
      paintRouteWeather();
      return;
    }
    windsStatus = 'loading';
    paintRouteWeather();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/winds?fcst=06', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Winds aloft answered ${response.status}.`);
      const parsed = parseWindsAloft(await response.text());
      // A table station is placed by its airport (K + three letters, or the identifier itself).
      const stations = [];
      for (const code of Object.keys(parsed.stations)) {
        const airport = findAirport(`K${code}`) || findAirport(code);
        if (airport) stations.push({ code, lat: airport.lat, lon: airport.lon });
      }
      windsTable = { at: Date.now(), parsed, stations };
      windsStatus = 'ready';
      windsError = '';
    } catch (error) {
      windsStatus = 'unavailable';
      windsError = error.name === 'AbortError'
        ? 'Winds aloft timed out.'
        : (error.message || 'Winds aloft are unavailable right now.');
    } finally {
      clearTimeout(timer);
    }
    paintRouteWeather();
  }

  /** Leg-by-leg winds at the cruise level. Derived from the cached table, so a cruise change needs no fetch. */
  function windsSection() {
    if (points.length < 2 || windsStatus === 'idle') return '';
    const heading = '<div style="padding:14px 16px 4px"><h3 style="margin:0;font-size:13px">Winds aloft</h3></div>';
    if (windsStatus === 'loading') {
      return `${heading}<div class="muted small" style="padding:6px 16px 16px"><span class="spinner" aria-hidden="true"></span> Fetching the NOAA winds-aloft forecast…</div>`;
    }
    if (windsStatus !== 'ready' || !windsTable) {
      return `${heading}<div class="notice warn" style="margin:0 16px 16px"><div>${esc(windsError || 'Winds aloft are unavailable.')}</div></div>`;
    }
    const { parsed, stations } = windsTable;
    const rows = legWinds({ parsed, legs: routeLegs(points), stations, cruiseFt: cruiseAlt });
    const utc = ms => (ms == null ? '—' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`);
    const stale = windsAreStale(parsed, Date.now())
      ? `<div class="notice warn" style="margin:0 16px 12px"><div>This forecast window ended ${esc(utc(parsed.validUntilMs))}. Do not use these winds; they are no longer current.</div></div>`
      : '';
    const body = rows.map(row => `<tr>
        <td>${esc(row.from)} → ${esc(row.to)}</td>
        <td>${row.station ? `${esc(row.station)} · ${num(row.stationDistanceNm)} nm` : '—'}</td>
        <td class="num">${row.ft == null ? '—' : `${num(row.ft)} ft`}</td>
        <td style="white-space:nowrap">${row.speedKt == null ? '—' : row.variable ? 'light &amp; variable' : `${String(row.dirDeg).padStart(3, '0')}° ${row.speedKt} kt`}</td>
        <td class="num">${row.tempC == null ? '—' : `${row.tempC > 0 ? '+' : ''}${row.tempC} °C`}</td>
        <td style="white-space:normal">${row.reason ? esc(row.reason) : row.headwindKt == null ? '—' : esc(componentText({ headwindKt: row.headwindKt, crosswindKt: row.crosswindKt }))}</td>
      </tr>`).join('');
    return `${heading}${stale}<div class="table-wrap" style="border:0"><table class="data" style="min-width:0">
        <thead><tr><th>Leg</th><th>Station</th><th class="num">Level</th><th>Wind</th><th class="num">Temp</th><th style="white-space:normal">Head / cross</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <p class="help" style="padding:10px 16px 16px">NOAA Aviation Weather Center low-level winds aloft (public domain). Valid ${esc(utc(parsed.validMs))} to ${esc(utc(parsed.validUntilMs))}. Forecast, not observed. Each leg uses the nearest table station to its midpoint and the level nearest your cruise altitude. Not a flight-plan wind.</p>`;
  }

  function paintRouteWeather() {
    const body = document.getElementById('route-weather-body');
    if (body) body.innerHTML = weatherBody() + windsSection();
    const button = document.getElementById('route-weather-refresh');
    if (button) button.disabled = routeWeather.status === 'loading';
  }

  async function loadRouteWeather(force = false) {
    weatherRun++;
    for (const controller of weatherControllers) {
      try { controller.abort(); } catch (_) {}
    }
    weatherControllers.clear();
    const run = weatherRun;
    loadWinds();
    const stations = withRouteCourses(points, pickWeatherStations(
      points,
      point => point.kind === 'apt' || Boolean(findAirport(point.id)),
    ));
    if (!stations.length) {
      routeWeather = {
        status: 'unavailable', rows: [], challenges: [], fetchedAt: 0,
        error: 'No ICAO airports were found on this route, so there is no station weather to show. Fixes do not publish METARs.',
      };
      paintRouteWeather();
      return;
    }
    if (!weatherSources(stations[0].id).length) {
      routeWeather = {
        status: 'unavailable', rows: [], challenges: [], fetchedAt: 0,
        error: 'Weather is not reachable from this copy of Stratos. Open it with the desktop bridge or from the hosted site.',
      };
      paintRouteWeather();
      return;
    }
    routeWeather = { status: 'loading', rows: [], challenges: [], error: '', fetchedAt: 0 };
    paintRouteWeather();
    const payloads = await Promise.all(stations.map(async station => {
      const payload = await fetchStationWeather(station.id, force);
      return {
        ...station,
        metar: payload ? payload.metar : null,
        taf: payload ? payload.taf : null,
        decoded: payload ? payload.decoded : null,
        fetchedAt: payload ? (Number(payload.fetchedAt) || Date.now()) : null,
        source: payload ? payload.source : null,
      };
    }));
    if (run !== weatherRun) return;
    const analysed = analyseRouteWeather(payloads, Date.now());
    routeWeather = {
      status: 'ready',
      rows: analysed.stations,
      challenges: analysed.challenges,
      error: '',
      fetchedAt: Date.now(),
    };
    paintRouteWeather();
  }

  /* ── vertical profile ────────────────────────────────────────────── */

  function profileSvg(profile) {
    const W = 760, H = 210, left = 52, right = 18, top = 22, bottom = 34;
    const maxAlt = Math.max(profile.cruiseAlt, profile.depElev, profile.arrElev, 1000) * 1.08;
    const x = nm => left + (profile.distanceNm ? (nm / profile.distanceNm) * (W - left - right) : 0);
    const y = alt => top + (1 - Math.max(0, Number(alt) || 0) / maxAlt) * (H - top - bottom);
    const line = [
      `M ${x(0).toFixed(1)} ${y(profile.depElev).toFixed(1)}`,
      `L ${x(profile.tocNm).toFixed(1)} ${y(profile.cruiseAlt).toFixed(1)}`,
      `L ${x(profile.todNm).toFixed(1)} ${y(profile.cruiseAlt).toFixed(1)}`,
      `L ${x(profile.distanceNm).toFixed(1)} ${y(profile.arrElev).toFixed(1)}`,
    ].join(' ');
    const grid = [0, 0.5, 1].map(fraction => {
      const altitude = profile.cruiseAlt * fraction;
      const gy = y(altitude).toFixed(1);
      return `<line class="profile-grid" x1="${left}" x2="${W - right}" y1="${gy}" y2="${gy}"></line>`
        + `<text class="profile-axis" x="${left - 8}" y="${Number(gy) + 3}" text-anchor="end">${Math.round(altitude / 100) === 0 ? 'GND' : `FL${String(Math.round(altitude / 100)).padStart(3, '0')}`}</text>`;
    }).join('');
    const marks = profile.points.map(point => {
      const active = Boolean(selection) && selection.kind === 'waypoint' && selection.index === point.index;
      return `<g class="profile-wp${active ? ' is-active' : ''}" data-profile-wp="${point.index}" tabindex="0" role="button" aria-label="${esc(point.id)}, ${Math.round(point.nm)} nautical miles, planned ${Math.round(point.plannedAlt)} feet">
        <line class="profile-stem" x1="${x(point.nm).toFixed(1)}" x2="${x(point.nm).toFixed(1)}" y1="${y(point.plannedAlt).toFixed(1)}" y2="${(H - bottom).toFixed(1)}"></line>
        <circle class="profile-dot" cx="${x(point.nm).toFixed(1)}" cy="${y(point.plannedAlt).toFixed(1)}" r="${active ? 5.5 : 4}"></circle>
        <text class="profile-label${active ? ' is-active' : ''}" x="${x(point.nm).toFixed(1)}" y="${(H - 14).toFixed(1)}" text-anchor="${point.index === 0 ? 'start' : point.index === profile.points.length - 1 ? 'end' : 'middle'}">${esc(point.id)}</text>
      </g>`;
    }).join('');
    return `<svg class="profile-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vertical profile from ${esc(profile.points[0].id)} to ${esc(profile.points[profile.points.length - 1].id)}">
      ${grid}
      <path class="profile-line" d="${line}"></path>
      <g class="profile-toc"><line x1="${x(profile.tocNm).toFixed(1)}" x2="${x(profile.tocNm).toFixed(1)}" y1="${top}" y2="${(H - bottom).toFixed(1)}"></line>
        <text x="${x(profile.tocNm).toFixed(1)}" y="${top - 6}" text-anchor="middle">TOC</text></g>
      <g class="profile-tod"><line x1="${x(profile.todNm).toFixed(1)}" x2="${x(profile.todNm).toFixed(1)}" y1="${top}" y2="${(H - bottom).toFixed(1)}"></line>
        <text x="${x(profile.todNm).toFixed(1)}" y="${top - 6}" text-anchor="middle">TOD</text></g>
      ${marks}
    </svg>`;
  }

  function profileSection() {
    const profile = routeProfile(validateRoute(points).points, { cruiseKts, cruiseAlt });
    if (!profile) return '<p class="muted small" style="padding:0 16px 16px">Add a destination to draw the profile.</p>';
    return `<div class="profile-wrap">${profileSvg(profile)}</div>
      <p class="help" style="padding:0 16px 14px">TOC ${num(profile.tocNm, 0)} nm · TOD ${num(profile.todNm, 0)} nm · cruise ${num(profile.cruiseAlt)} ft. Climb and descent are estimate gradients at the cruise speed above. Terrain is not drawn because no terrain source is bundled.</p>`;
  }

  /* ── import, save, export ────────────────────────────────────────── */

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
      pushUndo();
      points = result.points.map(p => ({ ...p, name: p.name || p.id, elev: Number(p.elev) || 0 }));
      name = defaultRouteName(points);
      currentId = null;
      dirty = true;
      selection = null;
      persistActive();
      toast(`Imported ${points.length} waypoints from ${result.format.toUpperCase()}.`, 'good');
      render();
    } catch (error) {
      toast(error.message, 'bad');
    }
  }

  // The ID is asked for once and then remembered; 'SimBrief ID' changes it.
  async function changeSimbriefId() {
    const entered = await askText('SimBrief ID', 'SimBrief username or Pilot ID (remembered for next time)', 'e.g. pilot123 or 123456');
    if (!entered) return null;
    saveSimbriefId(localStorage, entered);
    toast('SimBrief ID saved.', 'good');
    return entered;
  }

  async function importSimbrief() {
    const entered = loadSimbriefId(localStorage) || await changeSimbriefId();
    if (!entered) return;
    try {
      const plan = await fetchSimbriefPlan(entered);
      saveSimbriefId(localStorage, entered);
      const { origin, destination, fixes, general, ofp } = plan;
      const imported = fixes.map((fix, index) => ({
        id: String(fix.ident || `WP${index + 1}`).toUpperCase(),
        name: fix.name || fix.ident || 'Waypoint',
        lat: Number(fix.pos_lat),
        lon: Number(fix.pos_long),
        elev: Number(fix.altitude_feet) || 0,
        kind: fix.type === 'apt' ? 'apt' : fix.type === 'vor' || fix.type === 'ndb' ? 'nav' : 'fix',
        // Kept exactly as the plan states them: the map draws a SID fix and an
        // arrival fix differently, and an airway fix differently again. Neither
        // is inferred from the fix's position or its name.
        ss: fix.is_sid_star == '1' ? (String(fix.stage || '').toUpperCase() === 'DES' ? 'star' : 'sid') : '',
        aw: fix.via_airway && !/^DCT$/i.test(fix.via_airway) ? String(fix.via_airway).toUpperCase() : '',
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      // The normalised OFP carries the SID, STAR and planned runways, so the
      // Flight Deck card can show them without a second import there.
      if (ofp) saveOfp(localStorage, ofp, entered);
      const procs = ofp ? [ofp.origin.sid ? `SID ${ofp.origin.sid}` : '', ofp.destination.star ? `STAR ${ofp.destination.star}` : ''].filter(Boolean).join(' · ') : '';
      if (imported.length < 2) {
        // Detailed Navlog off: no fixes, but the plan still names the
        // procedures, so they are imported and the current route is kept.
        if (!ofp) throw new Error('No usable coordinates in the SimBrief plan.');
        toast(`SimBrief plan saved${procs ? ` — ${procs}` : ''}. It has no navlog fixes, so the route was left unchanged. Turn on Detailed Navlog in SimBrief to import waypoints.`, 'bad');
        render();
        return;
      }
      pushUndo();
      points = imported;
      name = `${origin || points[0].id} → ${destination || points[points.length - 1].id} (SimBrief)`;
      currentId = null;
      dirty = true;
      selection = null;
      const cruise = Number(general.cruise_altitude);
      if (Number.isFinite(cruise) && cruise > 0) cruiseAlt = cruise;
      const tas = Number(general.cruise_tas);
      if (Number.isFinite(tas) && tas > 0) cruiseKts = tas;
      persistActive();
      toast(`Imported ${points.length} waypoints from SimBrief${procs ? ` — ${procs}` : ''}. Weather, winds and fuel are not imported.`, 'good');
      render();
    } catch (error) {
      toast(`SimBrief import failed: ${error.message}`, 'bad');
    }
  }

  function sendToMap() {
    if (points.length < 2) { toast('Add at least two waypoints first.', 'bad'); return; }
    const mapRoute = points.map(p => ({
      id: p.id, name: p.name || p.id, lat: p.lat, lon: p.lon,
      elev: Number(p.elev) || 0,
      // The planner names these 'airport' and 'navaid'; the map draws 'apt'
      // and 'nav'. Translating here keeps the airport ring and navaid symbol
      // instead of falling back to an ordinary waypoint.
      k: p.kind === 'airport' ? 'apt' : p.kind === 'navaid' ? 'nav' : (p.kind || p.k || 'fix'),
      // Kept so the map can draw a SID/STAR and an airway fix when the plan said so.
      ss: p.ss || '', aw: p.aw || '',
    }));
    try {
      localStorage.setItem('dl.route', JSON.stringify(mapRoute));
      localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: currentId, name, points, dirty }));
      toast('Opening the Flight Deck map.', 'good');
      setTimeout(() => { location.href = 'index.html'; }, 450);
    } catch (_) {
      toast('This browser refused local storage.', 'bad');
    }
  }

  /* ── page render ─────────────────────────────────────────────────── */

  // Restore the last active route or start from the most recent saved route.
  try {
    const stored = JSON.parse(localStorage.getItem('stratos.activeRoute') || 'null');
    if (stored && Array.isArray(stored.points) && stored.points.length) {
      points = stored.points;
      name = stored.name || defaultRouteName(points);
      currentId = stored.id || null;
      dirty = Boolean(stored.dirty);
      if (Number(stored.cruiseKts) > 0) cruiseKts = Number(stored.cruiseKts);
      if (Number(stored.cruiseAlt) > 0) cruiseAlt = Number(stored.cruiseAlt);
    }
  } catch (_) {}
  if (!points.length && savedRoutes.length) {
    points = savedRoutes[0].points.map(p => ({ ...p }));
    name = savedRoutes[0].name;
    currentId = savedRoutes[0].id;
  }

  readLive();

  function render() {
    // A render ends any interaction that was in flight.
    cleanups.forEach(fn => { try { fn(); } catch (_) {} });
    cleanups = [];

    const validation = validateRoute(points);
    lastValidation = validation;
    if (selection) {
      if (selection.kind === 'waypoint' && selection.index >= points.length) selection = null;
      if (selection.kind === 'leg' && selection.index >= points.length - 1) selection = null;
    }
    const profile = routeProfile(validation.points, { cruiseKts, cruiseAlt });
    const totals = profile ? profile.totals : routeTotals(validation.points, { cruiseKts, cruiseAlt });
    const legs = currentLegs();
    const routeSignature = points.map(point => `${point.id}@${point.lat},${point.lon}`).join('|');
    if (routeSignature !== weatherKey) {
      weatherKey = routeSignature;
      routeWeather = { status: 'idle', rows: [], challenges: [], error: '', fetchedAt: 0 };
      windsStatus = 'idle';
      windsTable = null;
    }

    const dep = points.length ? points[0].id : 'DEP';
    const arr = points.length > 1 ? points[points.length - 1].id : 'DEST';

    root.innerHTML = `
      <div class="plan-workspace${sidebarOpen ? ' is-side-open' : ''}" id="plan-workspace">
        <header class="plan-bar">
          <button class="plan-side-toggle" id="plan-side-toggle" aria-expanded="${sidebarOpen}" aria-controls="plan-side" title="${sidebarOpen ? 'Hide the flight plan' : 'Show the flight plan'}">
            <span aria-hidden="true">${sidebarOpen ? '‹' : '☰'}</span><span class="plan-side-toggle-label">Plan</span>
          </button>
          <div class="plan-ident">
            <span class="plan-eyebrow">${esc(dirty ? 'Flight plan · unsaved' : currentId ? 'Flight plan · saved' : 'Flight plan · new')}</span>
            <h1><span class="plan-ident-airport">${esc(dep)}</span><span class="plan-arrow">→</span><span class="plan-ident-airport">${esc(arr)}</span></h1>
            <div class="plan-name-line"><button class="plan-link" id="plan-name-edit" title="Rename this route">${esc(name)}</button></div>
          </div>
          <div class="plan-stats" id="plan-stats" aria-live="polite">${statsHtml()}</div>
          <div class="plan-bar-actions">
            <button class="plan-btn" id="plan-undo" ${undoStack.length ? '' : 'disabled'} title="Undo the last change (Ctrl+Z)">Undo</button>
            <button class="plan-btn primary" id="save-route">Save</button>
            <button class="plan-btn" id="send-map" ${points.length < 2 ? 'disabled' : ''}>Show on Flight Deck</button>
          </div>
        </header>

        <div class="plan-body">
          <div class="plan-mapbox" id="plan-mapbox">
            <div class="plan-map-canvas" id="plan-map-canvas" aria-label="Route map"></div>
            <div class="plan-inspector" id="plan-inspector" hidden></div>
            ${points.length < 2 ? `<div class="plan-empty" id="plan-empty">
              <b>Start a flight plan</b>
              <span>Search an airport in the plan panel to set a departure, then add a destination. Tap a leg for course and time; drag a waypoint to move it.</span>
              <button class="plan-btn" id="plan-empty-add">Add departure</button>
            </div>` : ''}
          </div>

          <aside class="plan-side" id="plan-side" aria-label="Flight plan">
            <div class="plan-side-scroll">
              <section class="plan-panel">
                <div class="plan-panel-head"><h2>Route setup</h2>${dirty ? tag('unsaved', 'warn') : currentId ? tag('saved', 'good') : tag('new', 'muted')}</div>
                <div class="plan-field-row">
                  <label class="plan-field" style="flex:2 1 160px"><span>Name</span>
                    <input class="input" id="route-name" value="${esc(name)}" maxlength="60"></label>
                  <label class="plan-field" style="flex:0 1 90px"><span>Cruise kt</span>
                    <input class="input" id="route-speed" type="number" min="60" max="600" value="${cruiseKts}"></label>
                  <label class="plan-field" style="flex:0 1 100px"><span>Cruise ft</span>
                    <input class="input" id="route-alt" type="number" min="1000" max="60000" step="1000" value="${cruiseAlt}"></label>
                </div>
                <label class="plan-field" style="margin-top:10px"><span>Add waypoint — airport, navaid, or latitude,longitude</span>
                  <input class="input" id="route-add" placeholder="KSFO, SFO, or 37.62,-122.38" autocomplete="off" spellcheck="false"></label>
                <div class="plan-btn-row">
                  <button class="plan-btn" id="import-simbrief">SimBrief</button>
                  <button class="plan-btn" id="change-simbrief">SimBrief ID</button>
                  <button class="plan-btn" id="import-file">Import file</button>
                </div>
                ${validation.errors.length ? `<div class="notice bad" style="margin-top:10px"><div><strong>${validation.errors.length} problem${validation.errors.length === 1 ? '' : 's'}.</strong><br>${validation.errors.map(e => esc(e.message)).join('<br>')}</div></div>` : ''}
                ${validation.warnings.length ? `<div class="notice warn" style="margin-top:10px"><div>${validation.warnings.map(w => esc(w.message)).join('<br>')}</div></div>` : ''}
              </section>

              <section class="plan-panel">
                <div class="plan-panel-head"><h2>Flight plan</h2><span class="spacer"></span><span class="plan-count">${points.length} wp</span></div>
                ${points.length ? `<ol class="plan-wp-list" role="listbox" aria-label="Waypoints">
                  ${points.map((point, index) => `<li class="plan-wp${selection && selection.kind === 'waypoint' && selection.index === index ? ' is-selected' : ''}" data-wp="${index}" role="option" aria-selected="${selection && selection.kind === 'waypoint' && selection.index === index}" tabindex="0">
                    <span class="plan-wp-index">${index + 1}</span>
                    <span class="plan-wp-main"><b>${esc(point.id)}</b><span>${esc(point.name || '')}</span></span>
                    <span class="plan-wp-meta">${legs[index - 1] ? `${num(legs[index - 1].distanceNm, 0)} nm · ${courseText(legs[index - 1].trueCourse)}` : 'departure'}</span>
                  </li>`).join('')}
                </ol>
                <div class="plan-legs">
                  <span class="plan-eyebrow">Legs</span>
                  <ol role="listbox" aria-label="Route legs">
                    ${legs.length ? legs.map(leg => `<li class="plan-leg${selection && selection.kind === 'leg' && selection.index === leg.index - 1 ? ' is-selected' : ''}" data-leg="${leg.index - 1}" role="option" aria-selected="${selection && selection.kind === 'leg' && selection.index === leg.index - 1}" tabindex="0">
                      <span class="plan-leg-n">${leg.index}</span>
                      <span class="plan-leg-main">${esc(leg.from.id)} → ${esc(leg.to.id)}</span>
                      <span class="plan-leg-meta">${num(leg.distanceNm, 0)} nm · ${courseText(leg.trueCourse)} · ${minutesText(leg.eteMinutes)}</span>
                    </li>`).join('') : '<li class="plan-empty-row">Legs appear once there are two waypoints.</li>'}
                  </ol>
                </div>
                <p class="plan-summary-line" id="plan-summary-line">${esc(statementSummary())}</p>` : '<p class="muted small" style="padding:0 14px 14px">No waypoints yet. Search for an airport above or import a flight plan.</p>'}
              </section>

              <section class="plan-panel">
                <div class="plan-panel-head"><h2>Vertical profile</h2>${tag('estimate', 'warn')}</div>
                <div id="profile-body">${profileSection()}</div>
              </section>

              <section class="plan-panel">
                <div class="plan-panel-head"><h2>Route weather</h2>${tag('real-world', 'accent')}<span class="spacer"></span>
                  <button class="plan-btn" id="route-weather-refresh" ${points.length < 2 ? 'disabled' : ''}>Refresh</button></div>
                <div id="route-weather-body">${weatherBody()}</div>
              </section>

              <section class="plan-panel">
                <div class="plan-panel-head"><h2>Import and export</h2></div>
                <div class="plan-btn-row">
                  <button class="plan-btn" id="export-pln">MSFS .pln</button>
                  <button class="plan-btn" id="export-fms">X-Plane .fms</button>
                  <button class="plan-btn" id="export-gpx">GPX</button>
                </div>
                <p class="help" style="margin-top:8px">Exports contain the waypoint identifiers and coordinates you see here. They do not include SIDs, STARs, airways or performance data.</p>
              </section>

              <section class="plan-panel">
                <div class="plan-panel-head"><h2>Saved routes</h2><span class="spacer"></span><span class="plan-count">${savedRoutes.length}</span></div>
                ${savedRoutes.length ? `<div class="plan-saved-list">
                  ${savedRoutes.map(route => `<div class="plan-saved">
                    <div class="plan-saved-main"><b>${esc(route.name)}</b><span>${route.points.length} waypoints · ${esc(fmtDate(route.updatedAt || route.createdAt))}${route.id === currentId ? ' · open' : ''}</span></div>
                    <div class="plan-btn-row">
                      <button class="plan-btn" data-load="${esc(route.id)}">Load</button>
                      <button class="plan-btn" data-copy="${esc(route.id)}">Copy</button>
                      <button class="plan-btn danger" data-delete="${esc(route.id)}" aria-label="Delete ${esc(route.name)}">✕</button>
                    </div>
                  </div>`).join('')}
                </div>` : '<p class="muted small" style="padding:0 14px 14px">No saved routes yet.</p>'}
              </section>

              <p class="help plan-source-note">Airports: bundled OurAirports snapshot plus the bridge's worldwide database. Navaids: bundled snapshot. SimBrief is an external service and may be unavailable or rate limited. Not for real-world navigation.</p>
            </div>
          </aside>
        </div>
      </div>`;

    const workspace = document.getElementById('plan-workspace');
    const toggleSidebar = () => {
      sidebarOpen = !sidebarOpen;
      workspace?.classList.toggle('is-side-open', sidebarOpen);
      writeSidebarOpen(sidebarOpen);
      const button = document.getElementById('plan-side-toggle');
      if (button) {
        button.setAttribute('aria-expanded', String(sidebarOpen));
        button.title = sidebarOpen ? 'Hide the flight plan' : 'Show the flight plan';
        button.innerHTML = `<span aria-hidden="true">${sidebarOpen ? '‹' : '☰'}</span><span class="plan-side-toggle-label">Plan</span>`;
      }
    };
    document.getElementById('plan-side-toggle')?.addEventListener('click', toggleSidebar);
    document.getElementById('plan-empty-add')?.addEventListener('click', () => {
      if (!sidebarOpen) toggleSidebar();
      document.getElementById('route-add')?.focus();
    });
    document.getElementById('plan-name-edit')?.addEventListener('click', async () => {
      const next = await askText('Route name', 'Name', name);
      if (!next) return;
      pushUndo();
      name = String(next).slice(0, 60);
      dirty = true;
      persistActive();
      render();
    });
    document.getElementById('plan-undo')?.addEventListener('click', undo);
    document.getElementById('save-route')?.addEventListener('click', saveCurrent);
    document.getElementById('send-map')?.addEventListener('click', sendToMap);
    document.getElementById('import-simbrief')?.addEventListener('click', importSimbrief);
    document.getElementById('change-simbrief')?.addEventListener('click', changeSimbriefId);
    document.getElementById('import-file')?.addEventListener('click', importFile);

    document.getElementById('route-weather-refresh')?.addEventListener('click', () => {
      if (points.length >= 2) loadRouteWeather(true);
    });
    if (points.length >= 2 && routeWeather.status === 'idle') loadRouteWeather();

    // Selection is a local DOM update plus one canvas redraw: the map, the
    // route rows and the simulator feed all keep their existing state.
    document.querySelectorAll('[data-wp]').forEach(row => {
      const pick = () => select({ kind: 'waypoint', index: Number(row.dataset.wp) });
      row.addEventListener('click', pick);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
      });
    });
    document.querySelectorAll('[data-leg]').forEach(row => {
      if (row.classList.contains('plan-link')) return;
      const pick = () => select({ kind: 'leg', index: Number(row.dataset.leg) });
      row.addEventListener('click', pick);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
      });
    });

    // Inspector actions are delegated: the inspector is replaced on selection.
    const inspector = document.getElementById('plan-inspector');
    inspector?.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.hasAttribute('data-inspector-close')) { select(null); return; }
      if (target.dataset.leg != null) { select({ kind: 'leg', index: Number(target.dataset.leg) }); return; }
      if (target.dataset.wpUp != null) movePoint(Number(target.dataset.wpUp), Number(target.dataset.wpUp) - 1);
      else if (target.dataset.wpDown != null) movePoint(Number(target.dataset.wpDown), Number(target.dataset.wpDown) + 1);
      else if (target.dataset.wpDirect != null) direct(Number(target.dataset.wpDirect));
      else if (target.dataset.wpRemove != null) removePoint(Number(target.dataset.wpRemove));
    });

    document.querySelectorAll('[data-profile-wp]').forEach(node => {
      const pick = () => select({ kind: 'waypoint', index: Number(node.dataset.profileWp) });
      node.addEventListener('click', pick);
      node.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
      });
    });

    document.getElementById('route-name')?.addEventListener('change', event => {
      const next = event.target.value.trim().slice(0, 60) || defaultRouteName(points);
      if (next === name) return;
      pushUndo();
      name = next;
      dirty = true;
      persistActive();
      render();
    });
    document.getElementById('route-speed')?.addEventListener('change', event => {
      cruiseKts = Math.max(60, Math.min(600, Number(event.target.value) || 450));
      dirty = true;
      persistActive();
      render();
    });
    document.getElementById('route-alt')?.addEventListener('change', event => {
      cruiseAlt = Math.max(1000, Math.min(60000, Number(event.target.value) || 35000));
      dirty = true;
      persistActive();
      render();
    });

    const addInput = document.getElementById('route-add');
    if (addInput) {
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
    }

    document.getElementById('export-pln')?.addEventListener('click', () => {
      try { downloadText(`${safeName(name)}.pln`, exportPln(points, { title: name }), 'application/xml'); }
      catch (error) { toast(error.message, 'bad'); }
    });
    document.getElementById('export-fms')?.addEventListener('click', () => {
      try { downloadText(`${safeName(name)}.fms`, exportFms(points), 'text/plain'); }
      catch (error) { toast(error.message, 'bad'); }
    });
    document.getElementById('export-gpx')?.addEventListener('click', () => {
      try { downloadText(`${safeName(name)}.gpx`, exportGpx(points, { title: name }), 'application/gpx+xml'); }
      catch (error) { toast(error.message, 'bad'); }
    });

    document.querySelectorAll('[data-load]').forEach(button => button.addEventListener('click', () => {
      const route = savedRoutes.find(item => item.id === button.dataset.load);
      if (!route) return;
      pushUndo();
      points = route.points.map(p => ({ ...p }));
      name = route.name;
      currentId = route.id;
      dirty = false;
      selection = null;
      persistActive();
      render();
    }));
    document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
      const route = savedRoutes.find(item => item.id === button.dataset.copy);
      if (!route) return;
      savedRoutes.unshift(duplicateSavedRoute(route));
      await saveRoutes(savedRoutes);
      toast('Route duplicated.');
      render();
    }));
    document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => deleteRoute(button.dataset.delete)));

    ensurePlanMap();
    paintInspector();
  }

  function onKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 'z') return;
    const tagName = (event.target && event.target.tagName || '').toLowerCase();
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return;
    event.preventDefault();
    undo();
  }

  window.addEventListener('keydown', onKeydown);
  window.addEventListener('stratos:telemetry', onTelemetry);

  render();
  if (readLive()) updateLiveUi();

  return {
    destroy() {
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('stratos:telemetry', onTelemetry);
      weatherRun++;
      for (const controller of weatherControllers) {
        try { controller.abort(); } catch (_) {}
      }
      weatherControllers.clear();
      cleanups.forEach(fn => { try { fn(); } catch (_) {} });
      if (planMap) { try { planMap.destroy(); } catch (_) {} planMap = null; }
      root.innerHTML = '';
    },
  };
}

function safeName(name) {
  return String(name || 'stratos-route').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'stratos-route';
}
