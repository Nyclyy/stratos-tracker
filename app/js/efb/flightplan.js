/* EFB · Flight Planner.
 *
 * A guided IFR flight-plan workspace: choose a departure, build the route on a
 * chart or from search, choose the arrival, apply the procedures the navigation
 * data actually publishes, plan fuel and a diversion, then review and send the
 * plan to the Navigator or the Flight Deck.
 *
 * The page owns the draft and the interaction; `lib/routeplan.js` owns the
 * model and every rule that decides what a plan may contain. Data comes from
 * what Stratos already has:
 *   airports  — the bundled OurAirports snapshot plus the bridge's database
 *   navaids   — OurAirports navaids through the bridge, or the bundled snapshot
 *   fixes     — the simulator's own nav data through the bridge, or the fixes a
 *               published procedure names. A chart tap resolves to a real record
 *               or to nothing at all; it never invents an identifier
 *   procedures— /procedures.json (X-Plane CIFP, or the shipped FAA CIFP dataset)
 *   weather   — the same NOAA feed the Weather app reads
 * An en-route airway database is not shipped with Stratos, so airways are not
 * offered rather than being drawn from memory. The page says so where it matters.
 *
 * Nothing is invented: a procedure the data does not publish is reported as
 * unavailable, a fuel figure names its source, and an unverified value is shown
 * as missing.
 */

import {
  airportDirectory, esc, fmtFl, fmtMinutes, fmtNum, loadRoute, loadRouteMeta,
  currentPlan, ensureLive, liveStatus, onLive, searchAirports, weatherFor,
} from './common.js';
import { defaultBridgeBase, isHostedPage } from '../bridge.js';
import { MiniMap } from '../minimap.js';
import * as RP from '../lib/routeplan.js';
import { parseWaypointText } from '../lib/planner.js';
import { bearingDeg, distanceNm, formatLatLon } from '../lib/geo.js';
import { formatAltitude } from '../lib/telemetry.js';
import {
  DEFAULT_RADIUS_NM, MAX_RADIUS_NM, NavPointIndex, coordinateIdent, coverageText, fetchNear,
  formatRadius,
} from '../lib/navnear.js';
import { BUNDLED_AIRPORTS, BUNDLED_NAVAIDS, nearbyAirports } from '../data/airports.js';
import { getSavedRoutes, saveRoutes } from '../lib/store.js';
import { parseMetar } from '../lib/routeweather.js';
import { decodeTaf } from '../lib/taf.js';
import { EARTH_STYLES, GIBS, TERRAIN, earthStyle } from '../lib/earthview.js';

const DRAFT_KEY = 'stratos.efb.builder';
const MAX_UNDO = 25;
const WEATHER_REFRESH_MS = 5 * 60 * 1000;

const CATEGORY_TONE = { VFR: 'good', MVFR: 'accent', IFR: 'warn', LIFR: 'bad' };

const ICON = {
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  fit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4.6h4.4M20 9V4.6h-4.4M4 15v4.4h4.4M20 15v4.4h-4.4"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/></svg>',
  panel: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.4h16M4 12h16M4 17.6h10"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10.6" cy="10.6" r="6"/><path d="m15.2 15.2 4.3 4.3"/></svg>',
};

/** Airport designators a pilot can select: the suffix is only used when known. */
function runwayOptions(airport) {
  if (!airport) return [];
  const rows = [];
  const seen = new Set();
  const add = (designator, lengthFt) => {
    const id = String(designator || '').trim().toUpperCase();
    if (!/^\d{1,2}[LRC]?$/.test(id) || seen.has(id)) return;
    seen.add(id);
    rows.push({ id, lengthFt: Number(lengthFt) > 0 ? Number(lengthFt) : null });
  };
  if (Array.isArray(airport.rws)) {
    airport.rws.forEach(row => {
      if (!Array.isArray(row) || row.length < 7) return;
      add(row[0], row[6]);
      add(row[1], row[6]);
    });
  }
  if (!rows.length && Array.isArray(airport.rw)) {
    airport.rw.forEach((number, index) => {
      const low = Number(number);
      if (!Number.isFinite(low) || low < 1) return;
      const high = low <= 18 ? low + 18 : low - 18;
      const length = (airport.len || [])[index];
      add(String(low).padStart(2, '0'), length);
      add(String(high === 36 ? 36 : high).padStart(2, '0'), length);
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** A published transition runway matches a selected designator, suffix included. */
function runwayMatches(published, selected) {
  const a = String(published || '').toUpperCase();
  const b = String(selected || '').toUpperCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Sub-2 nm separations are the same place on a chart; keep the list readable. */
function dedupeByIdent(points) {
  const seen = new Set();
  return (points || []).filter(point => {
    const key = String(point.id || '').toUpperCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readDraft() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!raw) return null;
    const stored = raw.plan && Array.isArray(raw.plan.points) ? raw.plan : raw;
    const plan = RP.planFromStored(stored);
    if (!plan) return null;
    return { plan, step: RP.STEP_IDS.includes(raw.step) ? raw.step : 'departure' };
  } catch (_) {
    return null;
  }
}

export async function mount(root, ctx) {
  let destroyed = false;

  /* ── state ───────────────────────────────────────────────────────────── */

  let plan;
  let step = 'departure';
  let selection = null;
  let panelOpen = !window.matchMedia('(max-width: 900px)').matches;
  let undoStack = [];
  let savedRoutes = [];
  let notice = { text: '', tone: '', at: 0 };
  let chartTheme = ctx.prefs().chartTheme === 'day' ? 'day' : 'night';

  const searches = {
    dep: { rows: [], token: 0 },
    arr: { rows: [], token: 0 },
    route: { rows: [], token: 0 },
    alt: { rows: [], token: 0 },
  };
  const searchTimers = {};
  const navaids = { status: 'idle', rows: [], reason: '' };
  const procedures = {
    sid: { status: 'idle', payload: null, error: '' },
    star: { status: 'idle', payload: null, error: '' },
  };
  const choice = {
    sid: { ident: '', runwayTransition: '', enrouteTransition: '', showAll: false },
    star: { ident: '', runwayTransition: '', enrouteTransition: '', showAll: false },
  };
  let weather = { status: 'idle', rows: [], error: '', fetchedAt: 0 };
  let alternates = { status: 'idle', rows: [], error: '', maxNm: 250, minRunwayFt: 6000 };
  let mapPick = null;

  /* The real navigation points around the chart. The centre is the middle of the
     view — never the aircraft's position — so this answers for the place the
     pilot is looking at, with or without a simulator running. */
  const navNear = {
    status: 'idle',        // idle | loading | ready | empty
    radiusNm: DEFAULT_RADIUS_NM,
    center: null,
    rows: [],              // what the chart is drawing for this query
    total: 0,              // every record inside the radius, before the draw cap
    hidden: 0,
    coverage: null,
    reason: '',
    key: '',
    at: 0,
  };
  const navIndex = new NavPointIndex();
  let navIndexPromise = null;
  let nearTimer = 0;
  // A tap that found more than one record, waiting on the pilot to choose.
  let pickChooser = null;

  const seeded = readDraft();
  // A stored route from the Flight Deck or SimBrief belongs to the flight that
  // filed it. Changing the departure airport on such a plan must drop the route
  // with it; a route the pilot is building here keeps its fixes.
  let adoptedRoute = false;
  if (seeded) {
    plan = seeded.plan;
    step = seeded.step;
  } else {
    // First visit: adopt the route the Flight Deck or a SimBrief import left in
    // the shared store, so the pilot is not asked to retype a plan.
    const stored = loadRoute();
    const meta = loadRouteMeta();
    plan = stored.length
      ? RP.planFromStored({ ...meta, points: stored }) || RP.createPlan({ cruiseKts: meta.cruiseKts || 450, cruiseAlt: meta.cruiseAlt || 35000 })
      : RP.createPlan({ cruiseKts: meta.cruiseKts || 450, cruiseAlt: meta.cruiseAlt || 35000 });
    adoptedRoute = Boolean(stored.length && plan.points.length > 1);
  }
  if (!RP.STEP_IDS.includes(step)) step = 'departure';

  getSavedRoutes().then(routes => { savedRoutes = Array.isArray(routes) ? routes : []; }).catch(() => {});

  /* ── map ─────────────────────────────────────────────────────────────── */

  const canvas = document.createElement('canvas');
  canvas.id = 'fp-canvas';
  canvas.setAttribute('aria-label', 'Flight plan chart');
  let map = null;
  const accentNow = () => getComputedStyle(document.documentElement).getPropertyValue('--efb-accent').trim() || '#22d3ee';

  try {
    map = new MiniMap(canvas, {
      padding: 40,
      /* The radius circle is off unless the pilot asks for it: the query radius
         is what decides which real points are drawn, and a circle across the
         chart is not needed to read that. */
      layers: { tiles: true, route: true, track: false, traffic: false, nav: true, range: false, scale: true },
      routeStyle: 'nav',
      accent: accentNow(),
      chartTheme,
      tint: chartTheme === 'night' ? 'rgba(6, 10, 18, .42)' : null,
      pannable: true,
      attribution: false,
      rangeNm: navNear.radiusNm,
      showRange: false,
      showScale: true,
      onSelect: hit => {
        if (!hit) { select(null); return; }
        select({ type: hit.kind === 'segment' ? 'leg' : 'wp', index: hit.index });
      },
      onDragWaypoint: (index, position, meta) => {
        if (!plan.points[index]) return;
        if (meta && meta.committed) {
          pushUndo();
          plan = RP.movePointPosition(plan, index, position);
          select({ type: 'wp', index });
          afterChange({ fit: false });
          return;
        }
        // Live preview: redraw the line without re-rendering the panel.
        const preview = plan.points.map((point, i) => (i === index ? { ...point, lat: position.lat, lon: position.lon } : point));
        map?.setRoute(preview.map(point => ({ id: point.id, lat: point.lat, lon: point.lon, kind: point.kind })));
      },
      onPick: position => handleChartPick(position),
      onViewChange: () => {
        mapPick = null;
        // Panned or zoomed: the query radius now covers a different piece of the
        // world, so the points are re-read and the scale and centre are redrawn.
        scheduleNear();
        paintReadout();
      },
    });
  } catch (error) {
    map = null;
    notice = { text: `The chart could not start: ${error.message}`, tone: 'bad', at: Date.now() };
  }

  /* ── shell markup ────────────────────────────────────────────────────── */

  root.innerHTML = `
    <div class="fp-shell map-shell">
      <nav class="fp-steps" id="fp-steps" aria-label="Flight plan steps"></nav>
      <div class="fp-view map-view">
        <div class="fp-map" id="fp-map"></div>

        <div class="map-hud">
          <div class="map-flight">
            <div class="map-route" id="fp-route"></div>
            <div class="map-sub" id="fp-sub"></div>
          </div>
          <div class="map-hud-right">
            <span class="map-chip" id="fp-chip">New plan</span>
            <button class="map-hud-btn" type="button" data-act="reset-plan" title="Discard this plan and start a new one">Reset plan</button>
          </div>
        </div>

        <div class="map-banner" id="fp-banner" hidden></div>

        <div class="map-readout" id="fp-readout" aria-label="Chart readout">
          <div class="map-readout-head">
            <b>Chart</b>
            <label class="map-readout-field">Radius
              <select class="map-readout-select" data-act="radius" aria-label="Navigation-point radius in nautical miles">
                <option value="20">20 NM</option>
                <option value="40" selected>40 NM</option>
                <option value="80">80 NM</option>
                <option value="160">160 NM</option>
                <option value="320">320 NM</option>
              </select>
            </label>
            <button class="map-readout-btn" type="button" data-act="ring" aria-pressed="false" title="Show or hide the radius circle">Circle</button>
            <button class="map-readout-btn" type="button" data-act="globe" aria-pressed="false" title="Flat chart or a movable globe">Globe</button>
          </div>
          <div class="map-readout-globe" id="fp-globe-tools" hidden></div>
          <div class="map-readout-facts" id="fp-readout-facts"></div>
        </div>

        <div class="map-pick" id="fp-pick" hidden></div>

        <div class="nav-tools" role="group" aria-label="Chart controls">
          <button class="nav-tool" type="button" data-act="zoom" data-dir="in" title="Zoom in" aria-label="Zoom in">+</button>
          <button class="nav-tool" type="button" data-act="zoom" data-dir="out" title="Zoom out" aria-label="Zoom out">−</button>
          <button class="nav-tool" type="button" data-act="fit" title="Fit the plan" aria-label="Fit the plan">${ICON.fit}</button>
          <span class="nav-tool-gap" aria-hidden="true"></span>
          <button class="nav-tool" type="button" data-act="chart" title="Day or night chart" aria-label="Day or night chart">${ICON.chart}</button>
          <button class="nav-tool" type="button" data-act="panel" aria-pressed="${panelOpen}" title="Plan panel" aria-label="Plan panel">${ICON.panel}</button>
        </div>

        <aside class="nav-panel fp-panel" id="fp-panel" aria-label="Flight plan" ${panelOpen ? '' : 'hidden'}>
          <header class="nav-panel-head">
            <b id="fp-panel-title">Departure</b>
            <span class="nav-panel-count" id="fp-panel-hint"></span>
            <button class="nav-panel-close" type="button" data-act="panel-close" aria-label="Hide the plan panel">${ICON.close}</button>
          </header>
          <div class="fp-scroll" id="fp-scroll"></div>
          <footer class="fp-actions" id="fp-actions"></footer>
        </aside>
      </div>
      <div class="map-foot">
        <div class="map-strip" id="fp-strip"></div>
        <p class="map-credit">© Esri, HERE, Garmin · © OpenStreetMap contributors · airports and navaids © OurAirports · procedures from the CIFP data · weather NOAA</p>
      </div>
    </div>`;

  const el = {
    steps: root.querySelector('#fp-steps'),
    mapHost: root.querySelector('#fp-map'),
    route: root.querySelector('#fp-route'),
    sub: root.querySelector('#fp-sub'),
    chip: root.querySelector('#fp-chip'),
    banner: root.querySelector('#fp-banner'),
    readout: root.querySelector('#fp-readout'),
    pick: root.querySelector('#fp-pick'),
    panel: root.querySelector('#fp-panel'),
    title: root.querySelector('#fp-panel-title'),
    panelHint: root.querySelector('#fp-panel-hint'),
    scroll: root.querySelector('#fp-scroll'),
    actions: root.querySelector('#fp-actions'),
    strip: root.querySelector('#fp-strip'),
  };

  if (map) el.mapHost.replaceChildren(canvas);

  /* ── small helpers ───────────────────────────────────────────────────── */

  const stepMeta = id => RP.STEPS.find(entry => entry.id === id) || RP.STEPS[0];

  function setNotice(text, tone = '') {
    notice = text ? { text, tone, at: Date.now() } : { text: '', tone: '', at: 0 };
    paintBanner();
    if (text) setTimeout(() => {
      if (notice.text === text) { notice = { text: '', tone: '', at: 0 }; paintBanner(); }
    }, 9000);
  }

  function paintBanner() {
    if (!el.banner) return;
    const has = Boolean(notice.text);
    el.banner.hidden = !has;
    el.banner.innerHTML = has
      ? `<div class="map-banner-card ${notice.tone === 'bad' ? 'bad' : notice.tone === 'warn' ? 'warn' : ''}">
          <span class="map-banner-text">${esc(notice.text)}</span>
          <button class="map-banner-btn" type="button" data-act="dismiss">Dismiss</button>
        </div>`
      : '';
  }

  function pushUndo() {
    undoStack.push(plan);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, step, plan: RP.storedRoute(plan) }));
    } catch (_) { /* private mode: the draft simply is not kept */ }
  }

  function afterChange({ fit = true, nextStep = null } = {}) {
    if (nextStep) step = nextStep;
    saveDraft();
    if (fit) map?.fitRoute();
    render();
  }

  /** Undo restores the whole plan: points, procedures, fuel and alternate. */
  function undo() {
    const previous = undoStack.pop();
    if (!previous) { setNotice('Nothing to undo.', 'warn'); return; }
    plan = previous;
    selection = null;
    afterChange();
  }

  function confirmDiscard(message) {
    return !plan.dirty || window.confirm(message);
  }

  /** The unit the fuel figures are in: the plan's own when its burn is used. */
  function fuelUnit() {
    const burn = plan.fuel.mode !== 'manual' && plan.fuel.burnSource === 'plan' ? burnFromPlan() : null;
    if (burn && plan.fuel.burnSource === 'plan') return burn.unit === 'lb' ? 'lb' : 'kg';
    return plan.fuel.unit === 'lb' ? 'lb' : 'kg';
  }

  function select(next) {
    selection = next && Number.isInteger(Number(next.index)) ? { type: next.type, index: Number(next.index) } : null;
    if (map) {
      if (!selection) map.setSelection({});
      else if (selection.type === 'wp') map.setSelection({ waypointIndex: selection.index });
      else map.setSelection({ segmentIndex: selection.index });
    }
    paintDetail();
    paintReadout();
  }

  /* ── map interaction ─────────────────────────────────────────────────── */

  /**
   * The published half of the index: airports and radio navaids. The bridge
   * serves the worldwide OurAirports lists and the bundled snapshot answers
   * offline. En-route fixes are not here — they are the simulator's own
   * navigation data, which only the bridge can read, and `refreshNear` asks it.
   */
  function ensureNavIndex() {
    if (!navIndexPromise) {
      navIndexPromise = (async () => {
        const directory = await airportDirectory().catch(() => []);
        await loadNavaids().catch(() => {});
        navIndex.setPublished(directory && directory.length ? directory : BUNDLED_AIRPORTS, navaidPool());
        return navIndex;
      })();
    }
    return navIndexPromise;
  }

  /**
   * How far a chart tap reaches for a record: a fraction of what is on screen,
   * clamped. A tap at a wide zoom therefore does not silently grab a fix 30 NM
   * away, and a tap on a local chart still finds the symbol it landed on.
   */
  function snapRadiusNm() {
    const span = map ? map.viewSpanNm() : null;
    if (!Number.isFinite(span) || span <= 0) return 5;
    return Math.max(2, Math.min(20, span / 40));
  }

  function scheduleNear(delay = 260) {
    clearTimeout(nearTimer);
    nearTimer = setTimeout(() => { refreshNear(); }, delay);
  }

  /**
   * The real points inside the query radius of the chart's centre — the middle
   * of the view, not the aircraft — so the chart is useful before the simulator
   * is even started. Every record is measured against a true great-circle
   * radius: the ring is a distance on the ground, never a count of pixels, so it
   * draws the same real size at every latitude.
   */
  async function refreshNear({ force = false } = {}) {
    if (destroyed || !map) return;
    const center = map.viewCenter();
    if (!center) return;
    navNear.center = center;
    const key = `${center.lat.toFixed(3)}|${center.lon.toFixed(3)}|${navNear.radiusNm}`;
    if (!force && key === navNear.key && (navNear.status === 'ready' || navNear.status === 'empty')) return;
    navNear.key = key;
    navNear.status = 'loading';
    paintReadout();
    await ensureNavIndex();
    if (destroyed || navNear.key !== key) return;

    /* Fixes are the simulator's own navigation data (Navigraph/Jeppesen,
       licensed to that pilot and never bundled with Stratos). Without the
       bridge they are simply absent, and the readout says so. */
    const bridge = isHostedPage() ? '' : defaultBridgeBase();
    const fixNote = 'En-route fixes need the simulator\u2019s own navigation data: connect the bridge to read them.';
    let fixes = [];
    let fixesRead = false;
    if (bridge) {
      const answer = await fetchNear(bridge, center.lat, center.lon, navNear.radiusNm, { kinds: ['fix'] });
      if (answer) {
        fixes = Array.isArray(answer.points) ? answer.points : [];
        fixesRead = true;
      }
    }
    if (destroyed || navNear.key !== key) return;
    navIndex.setSimulator(fixes);

    const answer = navIndex.near(center.lat, center.lon, navNear.radiusNm, { limit: 600 });
    const rows = answer.ok ? answer.points : [];
    navNear.rows = rows;
    navNear.total = answer.count || rows.length;
    navNear.hidden = Math.max(0, (answer.count || 0) - rows.length);
    navNear.coverage = answer.coverage || navIndex.coverage;
    navNear.status = rows.length ? 'ready' : 'empty';
    navNear.reason = rows.length
      ? (fixesRead ? '' : fixNote)
      : `No record in the loaded navigation data is within ${formatRadius(navNear.radiusNm)} of the chart centre. ${fixesRead ? '' : fixNote}`.trim();
    navNear.at = Date.now();
    map.setNavPoints(rows);
    paintReadout();
  }

  /**
   * What the chart is showing, in the units a pilot reads: the centre, the query
   * radius with the number of real records inside it, the visible span in NM,
   * the selected point, and the two altitudes that are actually known — the
   * aircraft's, from the simulator, and the nearest airport's elevation, from
   * the airport database. There is no terrain elevation dataset, and the card
   * says so rather than showing a number it does not have.
   */
  function paintReadout() {
    const host = el.readout;
    if (!host) return;
    const select = host.querySelector('[data-act="radius"]');
    if (select && select.value !== String(navNear.radiusNm)) select.value = String(navNear.radiusNm);
    const ring = host.querySelector('[data-act="ring"]');
    if (ring && map) ring.setAttribute('aria-pressed', String(Boolean(map.showRange)));
    const globeBtn = host.querySelector('[data-act="globe"]');
    if (globeBtn && map) globeBtn.setAttribute('aria-pressed', String(map.mode === 'globe'));
    paintGlobeTools(host.querySelector('#fp-globe-tools'));
    const facts = host.querySelector('#fp-readout-facts');
    if (!facts) return;

    const center = navNear.center || (map ? map.viewCenter() : null);
    const span = map ? map.viewSpanNm() : null;
    const status = liveStatus();
    const parsed = status.snapshot && status.snapshot.parsed ? status.snapshot.parsed : null;
    const count = navNear.status === 'ready'
      ? `${fmtNum(navNear.total)} point${navNear.total === 1 ? '' : 's'}`
      : navNear.status === 'loading' ? 'reading the data…'
        : navNear.status === 'empty' ? 'none in the loaded data' : '—';

    const rows = [];
    rows.push(['Centre', center ? formatLatLon(center.lat, center.lon, 2) : '—', 'the middle of the chart, not the aircraft']);
    rows.push(['Radius', `${formatRadius(navNear.radiusNm)} · ${count}`, 'great-circle distance from the centre']);
    if (span) rows.push(['Across', `${fmtNum(span, 0)} NM`, 'visible span at this zoom']);
    if (selection && selection.type === 'wp' && plan.points[selection.index]) {
      const point = plan.points[selection.index];
      const bits = [formatLatLon(point.lat, point.lon, 3)];
      if (center) bits.push(`${fmtNum(distanceNm(center, point), 1)} NM from centre`);
      if (point.elev) bits.push(`${fmtNum(point.elev)} ft elev`);
      rows.push([
        'Selected',
        `${point.id} · ${bits.join(' · ')}`,
        point.kind === 'apt' ? 'airport' : point.kind === 'nav' ? 'navaid' : 'fix',
      ]);
    }
    rows.push([
      'Aircraft',
      parsed && Number.isFinite(parsed.alt) ? `${formatAltitude(parsed.alt)} · live` : 'not connected',
      'aircraft altitude comes from the simulator',
    ]);
    const nearestApt = navNear.rows
      .filter(point => point.kind === 'apt' && point.elev != null)
      .sort((a, b) => a.distanceNm - b.distanceNm)[0];
    rows.push([
      'Ground',
      nearestApt ? `${nearestApt.id} ${fmtNum(nearestApt.elev)} ft` : 'not available',
      nearestApt ? 'nearest airport elevation' : 'no airport elevation in range',
    ]);

    /* Real terrain elevation, once any has been read: the height of the ground
       under the centre and the highest ground inside the query radius, from the
       same elevation tiles. The row states how complete the sample is instead of
       implying it covered every metre, and says what would produce a reading
       when there is none — it never shows a number it does not have. */
    if (map && map.mode === 'globe') {
      const earth = map.earth;
      const feet = metres => Math.round(metres * 3.280839895);
      const here = earth && center ? earth.elevationAt(center.lat, center.lon) : null;
      rows.push([
        'Terrain',
        here == null ? 'not read' : `${fmtNum(feet(here))} ft`,
        here == null
          ? (earth && earth.stats().waiting ? 'terrain tiles are still loading' : 'choose Relief or Elevation, or press Read terrain')
          : 'ground elevation at the centre, from the terrain tiles',
      ]);
      const highest = earth && center ? earth.highestNear(center.lat, center.lon, navNear.radiusNm) : null;
      if (highest) {
        rows.push([
          'Highest',
          `${fmtNum(feet(highest.maxMetres))} ft`,
          `highest of ${highest.read} samples inside the radius${highest.partial ? `, ${highest.total - highest.read} unread` : ''} · display only`,
        ]);
      }
    }

    const note = [
      navNear.rows.length ? `${coverageText(navNear.coverage)} in the index.` : '',
      navNear.reason,
      navNear.hidden ? `${fmtNum(navNear.hidden)} further points are inside the radius.` : '',
      map && map.mode === 'globe' && map.earth ? map.earth.notes().join(' ') : '',
      map && map.mode === 'globe' && !map.earth
        ? 'Globe surface: outlines from Natural Earth 1:110m. No imagery or terrain is loaded, so nothing has been fetched.'
        : '',
    ].filter(Boolean).join(' ');
    facts.innerHTML = rows.map(([label, value, hint]) =>
      `<span class="map-readout-row"><em>${esc(label)}</em><b>${esc(value)}</b><i>${esc(hint)}</i></span>`).join('')
      + (note ? `<p class="map-readout-note">${esc(note)}</p>` : '');
  }

  /**
   * The globe's own controls, shown only while the chart is a globe: what its
   * surface is drawn from, and how to get the camera back to the route. Every
   * style is real data — bundled outlines, NASA imagery, or elevations read from
   * the terrain tiles — and the one showing is named underneath it.
   */
  function paintGlobeTools(host) {
    if (!host) return;
    if (!map || map.mode !== 'globe') { host.hidden = true; host.innerHTML = ''; return; }
    const current = earthStyle(map.globeStyleId);
    const buttons = EARTH_STYLES.map(entry =>
      `<button type="button" data-act="globe-style" data-style="${esc(entry.id)}" aria-pressed="${entry.id === current.id}" title="${esc(entry.hint)}">${esc(entry.label)}</button>`).join('');
    host.hidden = false;
    host.innerHTML = `
      <span class="map-readout-label">Surface</span>
      <div class="map-readout-seg" role="group" aria-label="Globe surface">${buttons}</div>
      <div class="map-readout-tools">
        <button class="map-readout-btn" type="button" data-act="globe-reset" title="Centre the globe on the route again">Reset view</button>
        <button class="map-readout-btn" type="button" data-act="terrain-read" title="Read terrain elevations around the centre">Read terrain</button>
      </div>
      <p class="map-readout-note">${esc(current.hint)}</p>`;
  }

  /**
   * Choose what the globe's surface is drawn from. A style that reads tiles says
   * who publishes them, in the notice the pilot is already looking at.
   */
  function setGlobeStyle(id) {
    if (!map) return;
    const style = earthStyle(id);
    map.setGlobeStyle(style.id);
    if (style.source === 'nasa') setNotice(`${style.hint} ${GIBS.attribution}. ${GIBS.terms}`, '');
    else if (style.source === 'terrain') setNotice(`${style.hint} ${TERRAIN.attribution}. ${TERRAIN.displayOnly}`, '');
    else setNotice('', '');
    paintReadout();
  }

  /**
   * The chart as a flat plan or as a movable globe. Both draw the same route and
   * the same real navigation points, and the globe's camera target is the centre
   * the radius query is measured from, so the two modes answer identically.
   */
  function toggleGlobe() {
    if (!map) return;
    const mode = map.setMode(map.mode === 'globe' ? 'plane' : 'globe');
    if (mode === 'globe' && map.globeLandState === 'unavailable') {
      setNotice('The globe is drawing its graticule, the route and the navigation points, but the bundled world outline could not be loaded, so no coastlines are shown.', 'warn');
    }
    paintReadout();
    refreshNear({ force: true });
  }

  /** A record from the navigation index, shaped for the route model. */
  function planPointFrom(record) {
    return {
      id: record.id,
      name: record.name || record.id,
      lat: record.lat,
      lon: record.lon,
      elev: Number.isFinite(record.elev) ? record.elev : 0,
      kind: record.kind === 'apt' ? 'apt' : record.kind === 'nav' ? 'nav' : 'fix',
      source: record.source || '',
    };
  }

  /** Which record type a navigation point is, in words. */
  function pointKindLabel(point) {
    if (point.kind === 'apt') return 'airport';
    if (point.kind === 'nav') return String(point.type || 'navaid').toLowerCase() || 'navaid';
    return 'fix';
  }

  /** The card a tap opens when it found more than one record, or none. */
  function renderPick() {
    const host = el.pick;
    if (!host) return;
    // The chooser is a decision the pilot has to make, so it takes the chart's
    // lower corner from the readout rather than being layered over it.
    if (el.readout) el.readout.hidden = Boolean(pickChooser);
    if (!pickChooser) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    const { options, position, reach } = pickChooser;
    const rows = options.map((option, index) => `
      <button class="map-pick-row" type="button" data-act="pick-point" data-index="${index}">
        <span class="map-pick-id">${esc(option.id)}</span>
        <span class="map-pick-main"><b>${esc(option.name || option.id)}</b><small>${esc(pointKindLabel(option))} · ${esc(formatRadius(option.distanceNm))} from the tap${option.elev != null ? ` · ${esc(fmtNum(option.elev))} ft` : ''}</small></span>
      </button>`).join('');
    host.innerHTML = `
      <div class="map-pick-head">
        <b>${options.length ? `${options.length} records at that tap` : `Nothing published within ${esc(formatRadius(reach))}`}</b>
        <span>${esc(coverageText(pickChooser.coverage))}</span>
      </div>
      ${rows}
      <button class="map-pick-row is-custom" type="button" data-act="pick-custom">
        <span class="map-pick-id">${esc(coordinateIdent(position.lat, position.lon))}</span>
        <span class="map-pick-main"><b>Custom coordinate</b><small>${esc(formatLatLon(position.lat, position.lon, 4))} · not a published fix</small></span>
      </button>
      <button class="map-pick-row is-ghost" type="button" data-act="drop-pick">Cancel</button>`;
    host.hidden = false;
  }

  /** Put a real record, or a custom coordinate, on the route. */
  function addRecord(record, note = '') {
    pickChooser = null;
    renderPick();
    const point = planPointFrom(record);
    const result = RP.addPoint(plan, point);
    if (!result.ok) {
      if (result.blocked === 'no-departure') {
        step = 'departure';
        setNotice(RP.NO_DEPARTURE, 'warn');
        render();
      } else {
        setNotice(result.error || 'That point could not be added.', 'bad');
      }
      return;
    }
    pushUndo();
    plan = result.plan;
    const index = plan.points.findIndex(entry => entry.id === point.id);
    selection = index >= 0 ? { type: 'wp', index } : null;
    afterChange({ fit: false });
    setNotice(note || `${point.id} added from the navigation data.`, '');
  }

  async function handleChartPick(position) {
    if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) return;
    // The departure and arrival steps read a chart tap as "the airport under the
    // tap"; every other step adds a user fix at that position.
    if (step === 'departure' || step === 'arrival') {
      const directory = await airportDirectory();
      const nearest = directory
        .map(airport => ({ airport, nm: distanceNm(position, airport) }))
        .filter(entry => Number.isFinite(entry.nm) && entry.nm <= 60)
        .sort((a, b) => a.nm - b.nm)[0]
        || nearbyAirports(position.lat, position.lon, 1, 60)[0];
      if (!nearest) {
        setNotice('No airport in the airport database is within 60 nm of that point. Search for the airport instead.', 'warn');
        return;
      }
      const airport = nearest.airport || nearest;
      const nm = nearest.nm != null ? nearest.nm : distanceNm(position, airport);
      mapPick = { airport, nm, role: step };
      render();
      return;
    }
    // The departure rule comes first, whatever the tap found: a plan is built
    // from its departure airport outwards.
    if (!plan.origin) {
      step = 'departure';
      setNotice(RP.NO_DEPARTURE, 'warn');
      render();
      return;
    }
    await ensureNavIndex();
    if (destroyed) return;
    const reach = snapRadiusNm();
    const answer = navIndex.pick(position.lat, position.lon, reach);
    if (!answer.ok) {
      // Nothing published there. The pilot may still place the exact position,
      // but it is named as a custom coordinate, not as a fix.
      pickChooser = { position, options: [], reach, coverage: answer.coverage };
      renderPick();
      setNotice(`No navigation record in the loaded data is within ${formatRadius(reach)} of that tap. Choose a nearby fix, or place the exact position as a custom coordinate.`, 'warn');
      return;
    }
    if (answer.options.length > 1) {
      pickChooser = { position, options: answer.options, reach, coverage: answer.coverage };
      renderPick();
      return;
    }
    addRecord(answer.point);
  }

  /* ── entry points that must respect the departure rule ───────────────── */

  function attemptAdd(point) {
    const result = RP.addPoint(plan, point);
    if (!result.ok) {
      if (result.blocked === 'no-departure') {
        step = 'departure';
        setNotice(RP.NO_DEPARTURE, 'warn');
        render();
      } else {
        setNotice(result.error || 'That point could not be added.', 'bad');
      }
      return;
    }
    pushUndo();
    plan = result.plan;
    afterChange();
  }

  function chooseDeparture(airport) {
    pushUndo();
    const keepRoute = !(adoptedRoute && plan.points.length > 1);
    const result = RP.setDeparture(plan, airport, { keepRoute });
    if (!result.ok) { setNotice(result.error, 'bad'); return; }
    adoptedRoute = false;
    plan = result.plan;
    choice.sid = { ident: '', runwayTransition: '', enrouteTransition: '', showAll: false };
    procedures.sid = { status: 'idle', payload: null, error: '' };
    weather = { status: 'idle', rows: [], error: '', fetchedAt: 0 };
    if (!keepRoute) {
      choice.star = { ident: '', runwayTransition: '', enrouteTransition: '', showAll: false };
      procedures.star = { status: 'idle', payload: null, error: '' };
      alternates = { ...alternates, status: 'idle', rows: [] };
      setNotice('The previous flight\'s route was cleared with its departure. Build the new route from this airport.', '');
    }
    map?.centerOn(Number(airport.lat), Number(airport.lon), 8);
    afterChange({ fit: false, nextStep: plan.destination ? 'route' : 'route' });
  }

  function chooseArrival(airport) {
    pushUndo();
    const result = RP.setArrival(plan, airport);
    if (!result.ok) {
      if (result.blocked === 'no-departure') {
        step = 'departure';
        setNotice(RP.NO_DEPARTURE, 'warn');
        render();
      } else setNotice(result.error, 'bad');
      return;
    }
    plan = result.plan;
    choice.star = { ident: '', runwayTransition: '', enrouteTransition: '', showAll: false };
    procedures.star = { status: 'idle', payload: null, error: '' };
    weather = { status: 'idle', rows: [], error: '', fetchedAt: 0 };
    afterChange();
  }

  /* ── search ──────────────────────────────────────────────────────────── */

  async function loadNavaids() {
    if (navaids.status !== 'idle') return;
    if (isHostedPage()) {
      navaids.status = 'bundled';
      navaids.reason = 'The bridge navaid database lives on the simulator PC; this hosted page searches the bundled snapshot.';
      return;
    }
    navaids.status = 'loading';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(`${defaultBridgeBase().replace(/\/+$/, '')}/navaids.json`, {
        cache: 'no-store',
        credentials: location.protocol === 'file:' ? 'omit' : 'include',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`The bridge answered ${response.status}.`);
      const rows = await response.json();
      navaids.rows = (Array.isArray(rows) ? rows : [])
        .filter(row => Array.isArray(row) && row.length >= 6)
        .map(row => ({
          id: String(row[0] || '').toUpperCase(),
          name: String(row[1] || ''),
          type: String(row[2] || ''),
          lat: Number(row[3]),
          lon: Number(row[4]),
          freq: String(row[5] || ''),
          source: 'bridge',
        }))
        .filter(row => row.id && Number.isFinite(row.lat) && Number.isFinite(row.lon));
      navaids.status = navaids.rows.length ? 'ready' : 'bundled';
      if (!navaids.rows.length) navaids.reason = 'The bridge has no navaid database loaded; the bundled snapshot is used.';
    } catch (error) {
      navaids.status = 'bundled';
      navaids.reason = `The bridge navaid database could not be read (${error.message}); the bundled snapshot is used.`;
    }
  }

  function navaidPool() {
    const bundled = BUNDLED_NAVAIDS.map(row => ({
      id: String(row.id || '').toUpperCase(),
      name: row.name || '',
      type: row.type || 'VOR',
      lat: Number(row.lat),
      lon: Number(row.lon),
      freq: row.freq || '',
      source: 'bundled',
    }));
    const seen = new Set(bundled.map(row => `${row.id}@${row.lat.toFixed(2)},${row.lon.toFixed(2)}`));
    const extra = navaids.rows.filter(row => !seen.has(`${row.id}@${row.lat.toFixed(2)},${row.lon.toFixed(2)}`));
    return [...bundled, ...extra];
  }

  function searchNavaids(query, limit = 6) {
    const q = String(query || '').trim().toUpperCase();
    if (!q) return [];
    const scored = [];
    for (const row of navaidPool()) {
      let score = 0;
      if (row.id === q) score = 100;
      else if (row.id.startsWith(q)) score = 75;
      else if (row.name.toUpperCase().startsWith(q)) score = 40;
      else if (row.name.toUpperCase().includes(q) && q.length >= 3) score = 15;
      if (score) scored.push({ score, row });
    }
    scored.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
    return scored.slice(0, limit).map(entry => entry.row);
  }

  /** Fixes the published procedures already named, with their real coordinates. */
  function knownFixes(limit = 6) {
    const seen = new Set();
    const out = [];
    for (const kind of ['sid', 'star']) {
      const payload = procedures[kind].payload;
      if (!payload || !payload.ok) continue;
      for (const list of Object.values(payload.procedures || {})) {
        for (const procedure of Array.isArray(list) ? list : []) {
          for (const transition of procedure.transitions || []) {
            for (const point of transition.points || []) {
              const id = String(point.id || '').toUpperCase();
              if (!id || seen.has(id) || !Number.isFinite(Number(point.lat))) continue;
              if (id === String(plan.origin && plan.origin.id) || id === String(plan.destination && plan.destination.id)) continue;
              seen.add(id);
              out.push({ id, name: `Procedure fix · ${procedure.id}`, lat: Number(point.lat), lon: Number(point.lon), kind: 'fix', source: 'procedure' });
            }
          }
        }
      }
    }
    return out.slice(0, limit);
  }

  function renderSearchResults(kind) {
    const host = root.querySelector(`#fp-results-${kind}`);
    if (!host) return;
    const rows = searches[kind].rows;
    if (!rows.length) {
      host.innerHTML = `<div class="e-empty-small e-faint">${String(root.querySelector(`#fp-search-${kind}`)?.value || '').trim() ? 'No airport, navaid or fix matched.' : 'Type an ICAO or IATA code, a navaid, an airport name, or latitude,longitude.'}</div>`;
      return;
    }
    host.innerHTML = rows.map((row, index) => `<button class="fp-result" type="button" data-act="pick" data-kind="${kind}" data-index="${index}">
        <span class="fp-result-id">${esc(row.id)}</span>
        <span class="fp-result-main"><b>${esc(row.name || row.id)}</b><small>${esc(row.detail || '')}</small></span>
        <span class="e-badge ${row.tone || ''}">${esc(row.type)}</span>
      </button>`).join('');
  }

  async function runSearch(kind) {
    const input = root.querySelector(`#fp-search-${kind}`);
    if (!input) return;
    const query = String(input.value || '').trim();
    const token = ++searches[kind].token;
    if (!query) {
      searches[kind].rows = [];
      renderSearchResults(kind);
      return;
    }
    if (kind === 'route') loadNavaids().then(() => { if (!destroyed) renderSearchResults(kind); });
    const rows = [];
    const coord = parseWaypointText(query);
    if (coord && !coord.error && Number.isFinite(coord.lat)) {
      rows.push({
        id: coord.id,
        name: 'Position you entered',
        detail: formatLatLon(coord.lat, coord.lon, 4),
        type: 'Point',
        tone: '',
        point: { ...coord, kind: 'fix', source: 'entered' },
      });
    }
    try {
      const airports = await searchAirports(query, 8);
      for (const airport of airports) {
        rows.push({
          id: String(airport.id || '').toUpperCase(),
          name: airport.name || airport.id,
          detail: [airport.elev != null ? `${fmtNum(airport.elev)} ft` : '', airport.source === 'bridge' ? 'airport database' : 'bundled'].filter(Boolean).join(' · '),
          type: 'Airport',
          tone: 'accent',
          point: {
            id: airport.id,
            name: airport.name,
            lat: Number(airport.lat),
            lon: Number(airport.lon),
            elev: Number(airport.elev) || 0,
            kind: 'apt',
            source: airport.source || '',
          },
        });
      }
    } catch (_) { /* the navaid and coordinate results still stand */ }
    if (token !== searches[kind].token) return;
    if (kind === 'route') {
      for (const nav of searchNavaids(query)) {
        rows.push({
          id: nav.id,
          name: nav.name,
          detail: [nav.type, nav.freq, nav.source === 'bridge' ? 'navaid database' : 'bundled snapshot'].filter(Boolean).join(' · '),
          type: 'Navaid',
          tone: '',
          point: { id: nav.id, name: nav.name, lat: nav.lat, lon: nav.lon, kind: 'nav', source: nav.source },
        });
      }
      for (const fix of knownFixes()) {
        if (!fix.id.startsWith(query.toUpperCase())) continue;
        rows.push({
          id: fix.id,
          name: fix.name,
          detail: `${formatLatLon(fix.lat, fix.lon, 3)} · published procedure fix`,
          type: 'Fix',
          tone: '',
          point: fix,
        });
      }
      // The real records around the chart, by identifier or name. This is the
      // same index the chart draws, so a search result and a map symbol agree
      // on the identifier, the position and the source.
      await ensureNavIndex();
      if (token !== searches[kind].token || destroyed) return;
      const centre = navNear.center || (map ? map.viewCenter() : null);
      const around = centre ? navIndex.near(centre.lat, centre.lon, navNear.radiusNm, { limit: 600 }) : null;
      for (const point of (around && around.ok ? around.points : [])) {
        const id = String(point.id || '').toUpperCase();
        const name = String(point.name || '').toUpperCase();
        const q = query.toUpperCase();
        if (id !== q && !id.startsWith(q) && !(q.length >= 4 && name.includes(q))) continue;
        rows.push({
          id,
          name: point.name || id,
          detail: [
            pointKindLabel(point),
            point.type,
            point.freq,
            centre ? `${fmtNum(point.distanceNm, 1)} NM from centre` : '',
            point.source,
          ].filter(Boolean).join(' · '),
          type: point.kind === 'apt' ? 'Airport' : point.kind === 'nav' ? 'Navaid' : 'Fix',
          tone: '',
          point: planPointFrom(point),
        });
      }
    }
    const seen = new Set();
    searches[kind].rows = rows.filter(row => {
      const key = `${row.type}:${row.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 14);
    renderSearchResults(kind);
  }

  function pickResult(kind, index) {
    const row = searches[kind].rows[Number(index)];
    if (!row) return;
    const input = root.querySelector(`#fp-search-${kind}`);
    if (input) input.value = '';
    searches[kind].rows = [];
    renderSearchResults(kind);
    if (kind === 'dep') { chooseDeparture(row.point); return; }
    if (kind === 'arr') { chooseArrival(row.point); return; }
    if (kind === 'alt') {
      const result = RP.setAlternate(plan, row.point);
      plan = result;
      alternates = { ...alternates, status: 'picked' };
      afterChange({ fit: true });
      return;
    }
    attemptAdd(row.point);
  }

  /* ── procedures ──────────────────────────────────────────────────────── */

  function procedureUrls(code) {
    const urls = [];
    if (!isHostedPage()) urls.push(`${defaultBridgeBase().replace(/\/+$/, '')}/procedures.json?airport=${encodeURIComponent(code)}`);
    return urls;
  }

  async function loadProcedures(kind) {
    const airport = kind === 'sid' ? plan.origin : plan.destination;
    if (!airport) return;
    const expected = airport.id;
    const current = procedures[kind];
    if (current.status === 'loading') return;
    if (current.payload && current.payload.airport === expected) return;
    procedures[kind] = { status: 'loading', payload: null, error: '' };
    paintStep();
    const urls = procedureUrls(expected);
    // The pilot can change the airport while a request is in flight; a payload
    // for the airport that is no longer in the plan is discarded.
    const stillCurrent = () => String((kind === 'sid' ? plan.origin : plan.destination)?.id || '') === expected;
    if (!urls.length) {
      procedures[kind] = {
        status: 'unavailable',
        payload: null,
        error: 'Procedure data comes from the Stratos bridge on the simulator PC. This hosted page cannot read it.',
      };
      paintStep();
      return;
    }
    let lastError = 'The procedure data could not be read.';
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: location.protocol === 'file:' ? 'omit' : 'include',
          signal: controller.signal,
        });
        clearTimeout(timer);
        const payload = await response.json().catch(() => null);
        if (payload && payload.ok) {
          if (!stillCurrent()) return;
          procedures[kind] = { status: 'ready', payload, error: '' };
          paintStep();
          return;
        }
        lastError = (payload && (payload.error || payload.reason)) || `The bridge answered ${response.status}.`;
        if (payload && payload.reason) lastError = payload.error || payload.reason;
      } catch (error) {
        lastError = error.name === 'AbortError' ? 'The procedure request timed out.' : error.message;
      }
    }
    if (!stillCurrent()) return;
    procedures[kind] = { status: 'unavailable', payload: null, error: lastError };
    paintStep();
  }

  function selectedProcedure(kind) {
    const payload = procedures[kind].payload;
    if (!payload || !payload.ok) return null;
    return RP.procedureList(payload, kind).find(procedure => String(procedure.id || '').toUpperCase() === choice[kind].ident) || null;
  }

  function applyProcedureSelection(kind) {
    const payload = procedures[kind].payload;
    const ident = choice[kind].ident;
    if (!payload || !payload.ok || !ident) return;
    const runway = kind === 'sid' ? plan.departureRwy : plan.arrivalRwy;
    const route = RP.procedureRoute(payload, {
      kind,
      ident,
      runway,
      runwayTransition: choice[kind].runwayTransition,
      enrouteTransition: choice[kind].enrouteTransition,
    });
    if (!route.ok) {
      // The card has to paint anyway: its transition pickers are how this is
      // resolved, and a procedure whose legs all live in transitions cannot be
      // placed until one is chosen.
      setNotice(route.error || 'That procedure is not available.', route.reason === 'needs-transition' ? 'warn' : 'bad');
      render();
      return;
    }
    const applied = RP.applyProcedure(plan, kind, route);
    if (!applied.ok) { setNotice(applied.error || 'That procedure could not be added.', 'bad'); render(); return; }
    pushUndo();
    plan = applied.plan;
    afterChange();
  }

  function chooseProcedure(kind, ident) {
    const current = choice[kind];
    if (current.ident === ident) {
      // Tapping the selected procedure removes it, which is how a pilot undoes a
      // wrong tap without hunting for another control.
      const cleared = RP.clearProcedure(plan, kind);
      pushUndo();
      plan = cleared;
      choice[kind] = { ident: '', runwayTransition: '', enrouteTransition: '', showAll: current.showAll };
      afterChange();
      return;
    }
    const payload = procedures[kind].payload;
    const runway = kind === 'sid' ? plan.departureRwy : plan.arrivalRwy;
    const routeIds = plan.points
      .filter(point => (kind === 'sid' ? point.index !== 0 : true))
      .map(point => point.id);
    const suggestion = payload && payload.ok
      ? RP.suggestTransitions(payload, { kind, ident, runway, routeIds, airport: (kind === 'sid' ? plan.origin : plan.destination)?.id })
      : { runway: '', enroute: '', reason: '' };
    choice[kind] = {
      ident,
      runwayTransition: suggestion.runway,
      enrouteTransition: suggestion.enroute,
      showAll: choice[kind].showAll,
    };
    applyProcedureSelection(kind);
  }

  function setProcedureTransition(kind, field, value) {
    choice[kind] = { ...choice[kind], [field]: value };
    if (choice[kind].ident) applyProcedureSelection(kind);
    else render();
  }

  function setRunway(kind, runway) {
    // The runway belongs to the plan, so the procedure applied to it is redone
    // with the new transition instead of keeping the old geometry.
    const next = kind === 'sid' ? { ...plan, departureRwy: runway } : { ...plan, arrivalRwy: runway };
    plan = next;
    if (choice[kind].ident) {
      const payload = procedures[kind].payload;
      const suggestion = payload && payload.ok
        ? RP.suggestTransitions(payload, { kind, ident: choice[kind].ident, runway, routeIds: plan.points.map(point => point.id) })
        : { runway: '', enroute: choice[kind].enrouteTransition };
      choice[kind] = { ...choice[kind], runwayTransition: suggestion.runway, enrouteTransition: choice[kind].enrouteTransition || suggestion.enroute };
      applyProcedureSelection(kind);
      return;
    }
    afterChange({ fit: false });
  }

  /* ── weather ─────────────────────────────────────────────────────────── */

  async function loadWeather({ force = false } = {}) {
    const stations = dedupeByIdent([plan.origin, plan.destination, plan.alternate].filter(Boolean));
    if (!stations.length) {
      weather = { status: 'unavailable', rows: [], error: 'Choose the airports first.', fetchedAt: 0 };
      paintStep();
      return;
    }
    if (!force && weather.status === 'ready' && Date.now() - weather.fetchedAt < WEATHER_REFRESH_MS) return;
    weather = { ...weather, status: 'loading', error: '' };
    paintStep();
    const results = await Promise.all(stations.map(station => weatherFor(station.id, { force })));
    weather = {
      status: 'ready',
      fetchedAt: Date.now(),
      error: '',
      rows: results.map((record, index) => {
        const station = stations[index];
        const ok = record && !record.error;
        return {
          icao: station.id,
          name: station.name || station.id,
          error: ok ? '' : (record && record.error) || 'No observation is published.',
          metar: ok ? record.metar || '' : '',
          taf: ok ? record.taf || '' : '',
          parsed: ok && record.metar ? parseMetar(record.metar) : null,
          tafDecoded: ok && record.taf ? decodeTaf(record.taf) : null,
          source: ok ? record.source || 'NOAA Aviation Weather Center' : '',
          freshness: RP.weatherFreshness(ok ? record.fetchedAt : null),
          role: station.id === String(plan.origin && plan.origin.id) ? 'Departure'
            : station.id === String(plan.destination && plan.destination.id) ? 'Arrival' : 'Alternate',
        };
      }),
    };
    paintStep();
  }

  /* ── alternates ──────────────────────────────────────────────────────── */

  async function suggestAlternates() {
    if (!plan.destination) {
      setNotice('Choose the arrival airport first.', 'warn');
      return;
    }
    alternates = { ...alternates, status: 'loading', rows: [], error: '' };
    paintStep();
    const directory = await airportDirectory();
    const rows = RP.alternateCandidates(plan.destination, directory, {
      maxNm: alternates.maxNm,
      minRunwayFt: alternates.minRunwayFt,
    }).slice(0, 6);
    if (!rows.length) {
      alternates = {
        ...alternates,
        status: 'empty',
        rows: [],
        error: `No airport in the database is within ${alternates.maxNm} nm of ${plan.destination.id} with a runway of at least ${fmtNum(alternates.minRunwayFt)} ft.`,
      };
      paintStep();
      return;
    }
    // Weather is fetched for the shortlist only: six stations is a bounded,
    // cached request set, and a candidate without a METAR says so.
    const reports = await Promise.all(rows.map(row => weatherFor(row.id)));
    alternates = {
      ...alternates,
      status: 'ready',
      rows: rows.map((row, index) => {
        const record = reports[index];
        const ok = record && !record.error;
        const parsed = ok && record.metar ? parseMetar(record.metar) : null;
        return {
          ...row,
          weather: ok
            ? { category: parsed ? parsed.flightCategory : null, metar: record.metar || '', fetchedAt: record.fetchedAt, source: record.source || 'NOAA' }
            : { error: (record && record.error) || 'No METAR is published.', fetchedAt: null },
        };
      }),
    };
    paintStep();
  }

  async function useAlternate(candidate) {
    const result = RP.setAlternate(plan, candidate);
    if (!result || result === plan) { setNotice('That airport cannot be the alternate of this arrival.', 'bad'); return; }
    pushUndo();
    plan = result;
    await loadWeather({ force: true });
    afterChange({ fit: true });
  }

  /* ── fuel ────────────────────────────────────────────────────────────── */

  function burnFromPlan() {
    const planNow = currentPlan();
    const burn = planNow && planNow.ofp ? RP.burnFromOfp(planNow.ofp) : null;
    if (!burn) return null;
    // The plan's burn belongs to the aircraft the plan was flown in. It is used
    // only when that is the aircraft this plan is for, which is the loaded plan.
    return burn;
  }

  /** The cruise flow actually in use: the loaded plan's, or the one typed in. */
  function effectiveBurn() {
    if (plan.fuel.mode === 'manual') return null;
    if (plan.fuel.burnSource === 'plan') {
      const burn = burnFromPlan();
      return burn ? burn.burnPerHour : null;
    }
    return Number(plan.fuel.burnPerHour) > 0 ? Number(plan.fuel.burnPerHour) : null;
  }

  function fuelInputs() {
    const summary = RP.routeSummary(plan);
    const burn = plan.fuel.burnSource === 'plan' ? burnFromPlan() : null;
    const burnPerHour = effectiveBurn();
    // A plan's burn is stated in the plan's own unit, so the sheet follows it
    // rather than printing a lb figure under a kg heading.
    const unit = plan.fuel.mode !== 'manual' && plan.fuel.burnSource === 'plan' && burn
      ? (burn.unit === 'lb' ? 'lb' : 'kg')
      : (plan.fuel.unit === 'lb' ? 'lb' : 'kg');
    const alternateNm = plan.alternate && plan.destination ? distanceNm(plan.destination, plan.alternate) : 0;
    return {
      mode: plan.fuel.mode,
      unit,
      routeNm: summary.distanceNm,
      cruiseKts: plan.cruiseKts,
      headwindKt: Number(plan.fuel.headwindKt) || 0,
      burnPerHour,
      alternateNm,
      taxiMin: plan.fuel.taxiMin,
      contingencyPct: plan.fuel.contingencyPct,
      reserveMin: plan.fuel.reserveMin,
      extra: plan.fuel.extra,
      components: plan.fuel.components,
      block: plan.fuel.block,
      burnUnit: burn ? burn.unit : plan.fuel.unit,
      burnAircraft: burn ? burn.aircraft : '',
    };
  }

  function currentFuel() {
    return RP.fuelEstimate(fuelInputs());
  }

  /* ── storage hand-off ────────────────────────────────────────────────── */

  function storePlan() {
    const stored = RP.storedRoute(plan);
    try {
      localStorage.setItem(RP.ROUTE_KEY, JSON.stringify(stored));
      localStorage.setItem(RP.MAP_ROUTE_KEY, JSON.stringify(RP.mapRoute(plan)));
    } catch (_) {
      setNotice('This browser refused local storage, so the plan could not be handed to the map.', 'bad');
      return false;
    }
    return true;
  }

  function loadIntoNavigator() {
    if (!plan.origin || !plan.destination) {
      setNotice('A flight plan needs a departure and an arrival before it can be loaded.', 'warn');
      return;
    }
    if (!storePlan()) return;
    plan = { ...plan, dirty: false, builtAt: Date.now() };
    saveDraft();
    ctx.go('navigator');
  }

  function trackOnFlightDeck() {
    if (!plan.origin || !plan.destination) {
      setNotice('A flight plan needs a departure and an arrival before it can be tracked.', 'warn');
      return;
    }
    if (!storePlan()) return;
    saveDraft();
    location.href = 'index.html';
  }

  async function saveCurrentPlan() {
    const stored = RP.storedRoute(plan);
    const id = plan.savedId || `plan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const existing = savedRoutes.find(route => route.id === id);
    const record = {
      id,
      name: RP.planDisplayName(plan),
      points: stored.points,
      plan: stored.plan,
      cruiseKts: plan.cruiseKts,
      cruiseAlt: plan.cruiseAlt,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    const next = existing
      ? savedRoutes.map(route => (route.id === id ? record : route))
      : [record, ...savedRoutes];
    try {
      await saveRoutes(next);
      savedRoutes = next;
      plan = { ...plan, savedId: id, dirty: false, name: record.name };
      saveDraft();
      setNotice(`Saved “${record.name}” on this device.`, 'good');
      render();
    } catch (error) {
      setNotice(`The plan could not be saved: ${error.message}`, 'bad');
    }
  }

  async function openSavedPlan(id) {
    const route = savedRoutes.find(entry => entry.id === id);
    if (!route) return;
    if (!confirmDiscard('Discard the unsaved changes to this plan?')) return;
    const opened = RP.planFromStored({ ...route, points: route.points || [], plan: route.plan || null });
    if (!opened) { setNotice('That saved plan could not be read.', 'bad'); return; }
    pushUndo();
    plan = opened;
    selection = null;
    step = 'review';
    afterChange({ fit: true });
    setNotice(`Opened “${route.name}”.`, 'good');
  }

  async function deleteSavedPlan(id) {
    const route = savedRoutes.find(entry => entry.id === id);
    if (!route || !window.confirm(`Delete “${route.name}” from this device?`)) return;
    const next = savedRoutes.filter(entry => entry.id !== id);
    try {
      await saveRoutes(next);
      savedRoutes = next;
      if (plan.savedId === id) plan = { ...plan, savedId: null, dirty: true };
      render();
    } catch (error) {
      setNotice(`The plan could not be deleted: ${error.message}`, 'bad');
    }
  }

  /**
   * Start over. `clearShared` also removes the copy of the route the Navigator
   * and the Flight Deck read, because a reset that left the old route drawn on
   * the tracker would not be a reset. The saved plans in the library are the
   * pilot's own records and are never touched here.
   */
  function newPlan({ clearShared = false } = {}) {
    if (!confirmDiscard(clearShared
      ? 'Reset the builder? The departure, the route, the procedures, the fuel and the alternate are cleared, and the route is removed from the Navigator and the Flight Deck.'
      : 'Discard this plan and start a new one?')) return;
    pushUndo();
    plan = RP.createPlan();
    selection = null;
    step = 'departure';
    weather = { status: 'idle', rows: [], error: '', fetchedAt: 0 };
    alternates = { ...alternates, status: 'idle', rows: [] };
    choice.sid = { ident: '', runwayTransition: '', enrouteTransition: '', showAll: false };
    choice.star = { ident: '', runwayTransition: '', enrouteTransition: '', showAll: false };
    navNear.status = 'idle';
    navNear.key = '';
    mapPick = null;
    pickChooser = null;
    renderPick();
    if (clearShared) {
      try {
        localStorage.removeItem(RP.ROUTE_KEY);
        localStorage.removeItem(RP.MAP_ROUTE_KEY);
        localStorage.removeItem(DRAFT_KEY);
      } catch (_) { /* private mode: there is nothing stored to clear */ }
    }
    setNotice(clearShared
      ? 'Builder reset. No route is left on the chart, the Navigator or the Flight Deck: select a departure airport to begin.'
      : 'New plan. Select a departure airport to begin.', '');
    afterChange({ fit: false });
  }

  /* ── painting ────────────────────────────────────────────────────────── */

  function paintSteps() {
    if (!el.steps) return;
    const states = RP.stepState(plan, { burnPerHour: effectiveBurn() });
    const currentIndex = RP.STEP_IDS.indexOf(step);
    el.steps.innerHTML = states.map((entry, index) => `<button class="fp-step${entry.id === step ? ' is-current' : ''}${entry.done ? ' is-done' : ''}${entry.available ? '' : ' is-muted'}" type="button" data-act="step" data-step="${entry.id}" aria-current="${entry.id === step ? 'step' : 'false'}">
        <span class="fp-step-n">${entry.done ? '✓' : index + 1}</span>
        <span class="fp-step-label">${esc(entry.label)}</span>
      </button>`).join('');
    el.steps.querySelectorAll('[data-step]').forEach(node => {
      const id = node.dataset.step;
      const at = RP.STEP_IDS.indexOf(id);
      node.classList.toggle('is-past', at < currentIndex);
    });
  }

  function paintHud() {
    const summary = RP.routeSummary(plan);
    if (el.route) {
      el.route.innerHTML = plan.origin || plan.destination
        ? `${esc((plan.origin && plan.origin.id) || '????')}<s>→</s>${esc((plan.destination && plan.destination.id) || '????')}`
        : '<span class="map-route-empty">No departure selected</span>';
    }
    if (el.sub) {
      const bits = [];
      if (plan.points.length) bits.push(`${plan.points.length} point${plan.points.length === 1 ? '' : 's'}`);
      if (summary.distanceNm > 0) bits.push(`${fmtNum(summary.distanceNm, 0)} nm`);
      if (summary.eteMinutes > 0) bits.push(`${fmtMinutes(summary.eteMinutes)} est.`);
      if (plan.departureRwy) bits.push(`RWY ${plan.departureRwy}`);
      el.sub.textContent = bits.length ? bits.join(' · ') : 'Choose the departure airport to start the plan';
    }
    if (el.chip) {
      el.chip.textContent = plan.savedId && !plan.dirty ? 'Saved' : plan.dirty ? 'Unsaved' : 'Draft';
      el.chip.dataset.state = plan.dirty ? 'warn' : 'ok';
    }
    if (el.strip) {
      const rows = [];
      rows.push(`<span class="map-strip-facts">
        <span><em>Route</em><b>${esc((plan.origin && plan.origin.id) || '—')} → ${esc((plan.destination && plan.destination.id) || '—')}</b><i>${plan.points.length} points</i></span>
        <span><em>Distance</em><b>${summary.distanceNm > 0 ? `${fmtNum(summary.distanceNm, 0)} nm` : '—'}</b><i>great-circle legs</i></span>
        <span><em>Est. time</em><b>${summary.eteMinutes > 0 ? fmtMinutes(summary.eteMinutes) : '—'}</b><i>no wind model</i></span>
        <span><em>Cruise</em><b>${esc(fmtFl(plan.cruiseAlt))}</b><i>${fmtNum(plan.cruiseKts)} kt</i></span>
        <span><em>Alternate</em><b>${esc((plan.alternate && plan.alternate.id) || '—')}</b><i>${plan.alternate ? 'selected' : 'not selected'}</i></span>
      </span>
      <span class="map-strip-actions">
        <button class="map-strip-btn" type="button" data-act="undo" ${undoStack.length ? '' : 'disabled'}>Undo</button>
        <button class="map-strip-btn" type="button" data-act="fit">Fit</button>
      </span>`);
      el.strip.innerHTML = rows.join('');
    }
  }

  function paintMap() {
    if (!map) return;
    const points = plan.points.map(point => ({ id: point.id, lat: point.lat, lon: point.lon, kind: point.kind }));
    map.setRoute(points);
    map.setLayers({ route: points.length > 1, track: false });
    map.options.accent = accentNow();
    map.draw();
    paintReadout();
    if (selection) {
      if (selection.type === 'wp') map.setSelection({ waypointIndex: selection.index });
      else map.setSelection({ segmentIndex: selection.index });
    } else map.setSelection({});
  }

  const stepTitles = {
    departure: 'Departure',
    route: 'Build the route',
    arrival: 'Arrival',
    procedures: 'Procedures',
    fuel: 'Fuel & alternate',
    review: 'Review & send',
  };

  /* ── step bodies ─────────────────────────────────────────────────────── */

  /* The field starts empty even when something is already selected: pre-filling
     it would fire a search for the current airport on every render and leave a
     result list open under a field the pilot is not using. */
  function searchBlock(kind, label, placeholder) {
    return `<div class="fp-search-block">
      <label class="fp-search-label" for="fp-search-${kind}">${esc(label)}</label>
      <div class="e-search fp-search">
        ${ICON.search}
        <input class="e-input" id="fp-search-${kind}" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}">
      </div>
      <div class="e-results fp-results" id="fp-results-${kind}" role="listbox"></div>
    </div>`;
  }

  function airportCard(airport, role, kindForRunway) {
    if (!airport) {
      return `<div class="e-empty fp-empty-small"><b>No ${role.toLowerCase()} selected</b><p>Search an airport above, or tap the chart to use the nearest airport to your tap.</p></div>`;
    }
    const runways = runwayOptions(airport);
    const selected = kindForRunway === 'sid' ? plan.departureRwy : plan.arrivalRwy;
    return `<div class="e-card fp-card">
      <div class="fp-stop-head">
        <span class="e-badge accent">${esc(role)}</span>
        <b>${esc(airport.id)}</b>
        <span class="e-small e-muted">${esc(airport.name || '')}</span>
      </div>
      <dl class="e-kv">
        <dt>Position</dt><dd>${esc(formatLatLon(airport.lat, airport.lon, 3))}</dd>
        <dt>Elevation</dt><dd>${Number.isFinite(Number(airport.elev)) ? `${fmtNum(airport.elev)} ft` : 'not stated'}</dd>
        <dt>Runways in the data</dt><dd>${runways.length ? runways.map(row => esc(row.id)).join(' · ') : '<span class="e-faint">Not stated</span>'}</dd>
      </dl>
      <div class="e-field" style="margin-top:9px">
        <label for="fp-rwy-${kindForRunway}">${esc(role)} runway</label>
        <select class="e-select" id="fp-rwy-${kindForRunway}" data-act="runway" data-kind="${kindForRunway}">
          <option value="">Not selected</option>
          ${runways.map(row => `<option value="${esc(row.id)}" ${selected === row.id ? 'selected' : ''}>${esc(row.id)}${row.lengthFt ? ` · ${fmtNum(row.lengthFt)} ft` : ''}</option>`).join('')}
        </select>
        <span class="e-hint">Runway selection filters the published procedures and is kept in the plan.</span>
      </div>
    </div>`;
  }

  function mapPickCard() {
    if (!mapPick) return '';
    const role = mapPick.role === 'arrival' ? 'arrival' : 'departure';
    const { airport, nm } = mapPick;
    return `<div class="e-card fp-card fp-pick">
      <div class="fp-stop-head"><span class="e-badge">Nearest airport</span><b>${esc(String(airport.id).toUpperCase())}</b><span class="e-small e-muted">${esc(airport.name || '')}</span></div>
      <p class="e-small e-muted" style="margin:6px 0 8px">${fmtNum(nm, 1)} nm from the point you tapped, from the airport database.</p>
      <div class="e-row">
        <button class="e-btn small primary" type="button" data-act="use-map-pick" data-role="${role}">Use as ${role}</button>
        <button class="e-btn small ghost" type="button" data-act="drop-map-pick">Dismiss</button>
      </div>
    </div>`;
  }

  /**
   * Saved plans. The list belongs on the first step as well as the last: a pilot
   * who has cleared the draft must be able to reopen a plan without building a
   * new route first.
   */
  function savedPlansCard({ actions = false } = {}) {
    return `<div class="e-card fp-card">
      <h3>Saved plans <span class="e-spacer"></span><span class="e-badge">${savedRoutes.length}</span></h3>
      ${savedRoutes.length ? `<div class="fp-saved">${savedRoutes.map(route => `<div class="fp-saved-row">
          <div class="fp-saved-main"><b>${esc(route.name || 'Untitled')}</b><span>${(route.points || []).length} points · ${route.plan && route.plan.origin ? `${esc(route.plan.origin.id)} → ${esc((route.plan.destination || {}).id || '')}` : 'route only'}</span></div>
          <button class="e-btn small" type="button" data-act="open-plan" data-id="${esc(route.id)}">Open</button>
          <button class="e-btn small ghost" type="button" data-act="delete-plan" data-id="${esc(route.id)}" aria-label="Delete ${esc(route.name || 'plan')}">Delete</button>
        </div>`).join('')}</div>` : '<p class="e-small e-faint" style="margin:0">No saved plan on this device yet.</p>'}
      ${actions ? `<div class="e-row" style="margin-top:8px">
        <button class="e-btn small primary" type="button" data-act="save-plan">Save this plan</button>
        <button class="e-btn small ghost" type="button" data-act="new-plan">New plan</button>
      </div>` : ''}
    </div>`;
  }

  function bodyDeparture() {
    return `
      ${searchBlock('dep', 'Find the departure airport', 'ICAO, IATA or airport name — e.g. CYUL')}
      ${mapPickCard()}
      ${airportCard(plan.origin, 'Departure', 'sid')}
      ${plan.points.length > 1 ? `<div class="e-notice"><div>The rest of the route is kept when you change the departure. A SID applied to the previous airport is removed, because a procedure belongs to the airport it was published for.</div></div>` : ''}
      ${savedRoutes.length ? savedPlansCard() : ''}
      <p class="e-small e-faint">A route cannot start without a departure: any waypoint, navaid or chart tap before this step is refused with the reason.</p>`;
  }

  function selectionDetail() {
    if (!selection) return '';
    if (selection.type === 'wp') {
      const point = plan.points[selection.index];
      if (!point) return '';
      return `<div class="fp-detail">
        <div class="fp-detail-head"><b>${esc(point.id)}</b><span>${esc(point.name && point.name !== point.id ? point.name : '')}</span></div>
        <dl class="e-kv">
          <dt>Position</dt><dd>${esc(formatLatLon(point.lat, point.lon, 4))}</dd>
          <dt>Type</dt><dd>${esc(point.kind === 'apt' ? 'Airport' : point.kind === 'nav' ? 'Navaid' : point.ss ? `${esc(point.ss)} leg` : 'Fix')}</dd>
          <dt>Planned level</dt><dd>${point.altFt ? esc(fmtFl(point.altFt)) : '<span class="e-faint">not in the plan</span>'}</dd>
        </dl>
      </div>`;
    }
    const from = plan.points[selection.index];
    const to = plan.points[selection.index + 1];
    if (!from || !to) return '';
    return `<div class="fp-detail">
      <div class="fp-detail-head"><b>Leg ${selection.index + 1}</b><span>${esc(from.id)} → ${esc(to.id)}</span></div>
      <dl class="e-kv">
        <dt>Distance</dt><dd>${fmtNum(distanceNm(from, to), 1)} nm</dd>
        <dt>Initial track</dt><dd>${String(Math.round(bearingDeg(from, to))).padStart(3, '0')}° true</dd>
        <dt>Method</dt><dd><span class="e-faint">great-circle between the two points</span></dd>
      </dl>
    </div>`;
  }

  function routeList() {
    if (!plan.points.length) {
      return `<div class="e-empty fp-empty-small"><b>No route yet</b><p>Choose the departure airport first. Fixes, navaids and published procedure legs are added here.</p></div>`;
    }
    const legs = plan.points.map((point, index) => {
      const next = plan.points[index + 1];
      return next ? distanceNm(point, next) : null;
    });
    return `<div class="fp-route-list" id="fp-route-list">${plan.points.map((point, index) => {
      const isOrigin = index === 0;
      const isArrival = index === plan.points.length - 1 && plan.points.length > 1;
      const legNm = index > 0 ? legs[index - 1] : null;
      const selected = selection && selection.type === 'wp' && selection.index === index;
      return `${index > 0 ? `<div class="fp-leg-row">${legNm != null ? `${fmtNum(legNm, 1)} nm` : ''}</div>` : ''}
        <div class="fp-route-row${selected ? ' is-selected' : ''}" data-act="select-wp" data-index="${index}" role="button" tabindex="0">
          <span class="fp-route-seq">${String(index + 1).padStart(2, '0')}</span>
          <i class="nav-sym" data-kind="${esc(point.kind === 'apt' ? 'apt' : point.kind === 'nav' ? 'nav' : 'fix')}" aria-hidden="true"></i>
          <span class="fp-route-main">
            <b>${esc(point.id)}</b>
            <span>${esc(isOrigin ? 'Departure' : isArrival ? 'Arrival' : point.ss ? `${point.ss} leg` : point.name && point.name !== point.id ? point.name : 'Fix')}</span>
          </span>
          ${point.altFt ? `<span class="fp-route-alt">${esc(fmtFl(point.altFt))}</span>` : ''}
          <span class="fp-route-actions">
            ${isOrigin || isArrival ? '' : `<button type="button" class="fp-mini" data-act="move-up" data-index="${index}" title="Move up" aria-label="Move ${esc(point.id)} up">↑</button>
            <button type="button" class="fp-mini" data-act="move-down" data-index="${index}" title="Move down" aria-label="Move ${esc(point.id)} down">↓</button>`}
            ${isOrigin ? '' : `<button type="button" class="fp-mini danger" data-act="remove-wp" data-index="${index}" title="Remove" aria-label="Remove ${esc(point.id)}">×</button>`}
          </span>
        </div>`;
    }).join('')}</div>`;
  }

  function bodyRoute() {
    if (!plan.origin) {
      return `<div class="e-empty"><b>Select a departure first</b><p>${esc(RP.NO_DEPARTURE)}</p>
        <button class="e-btn small primary" type="button" data-act="step" data-step="departure">Choose departure</button></div>`;
    }
    const summary = RP.routeSummary(plan);
    const navaidNote = navaids.status === 'ready'
      ? `Navaid search uses the bridge database (${fmtNum(navaids.rows.length)} stations from OurAirports).`
      : navaids.status === 'loading'
        ? 'Loading the bridge navaid database… the bundled snapshot can be searched meanwhile.'
        : navaids.reason || 'Navaid search uses the bundled snapshot.';
    return `
      ${searchBlock('route', 'Add a point', 'Airport, navaid, fix or 45.47,-73.74')}
      <div class="e-row fp-tools">
        <button class="e-btn small ghost" type="button" data-act="route-hint">${ICON.search} Chart tap</button>
        <span class="e-spacer"></span>
        <button class="e-btn small ghost" type="button" data-act="undo" ${undoStack.length ? '' : 'disabled'}>Undo</button>
        <button class="e-btn small ghost" type="button" data-act="clear-route" ${plan.points.length > 1 ? '' : 'disabled'}>Clear</button>
      </div>
      <div id="fp-detail-host">${selectionDetail()}</div>
      ${routeList()}
      <div class="fp-summary-row">
        <span><em>Points</em><b>${plan.points.length}</b></span>
        <span><em>Distance</em><b>${summary.distanceNm > 0 ? `${fmtNum(summary.distanceNm, 0)} nm` : '—'}</b></span>
        <span><em>Est. time</em><b>${summary.eteMinutes > 0 ? fmtMinutes(summary.eteMinutes) : '—'}</b></span>
      </div>
      <div class="fp-cruise">
        <label class="e-field"><span class="fp-search-label">Cruise speed (kt TAS)</span>
          <input class="e-input small" type="number" min="60" max="700" step="5" id="fp-cruise-kts" value="${plan.cruiseKts}"></label>
        <label class="e-field"><span class="fp-search-label">Cruise level (ft)</span>
          <input class="e-input small" type="number" min="1000" max="60000" step="1000" id="fp-cruise-alt" value="${plan.cruiseAlt}"></label>
      </div>
      <p class="e-small e-faint">Distances and times are great-circle estimates at the cruise speed above, with no wind and no ATC routing. ${esc(navaidNote)}</p>`;
  }

  function bodyArrival() {
    if (!plan.origin) {
      return `<div class="e-empty"><b>Select a departure first</b><p>${esc(RP.NO_DEPARTURE)}</p>
        <button class="e-btn small primary" type="button" data-act="step" data-step="departure">Choose departure</button></div>`;
    }
    const check = RP.validatePlan(plan);
    const summary = RP.routeSummary(plan);
    return `
      ${searchBlock('arr', 'Find the arrival airport', 'ICAO, IATA or airport name')}
      ${mapPickCard()}
      ${airportCard(plan.destination, 'Arrival', 'star')}
      ${plan.points.length > 2 ? `<div class="e-notice"><div>${plan.points.length - 2} intermediate point${plan.points.length - 2 === 1 ? '' : 's'} between ${esc(plan.origin.id)} and ${esc(plan.destination ? plan.destination.id : 'the arrival')}.</div></div>` : ''}
      <div class="fp-summary-row">
        <span><em>Route</em><b>${esc(plan.origin.id)} → ${esc((plan.destination && plan.destination.id) || '—')}</b></span>
        <span><em>Distance</em><b>${summary.distanceNm > 0 ? `${fmtNum(summary.distanceNm, 0)} nm` : '—'}</b></span>
        <span><em>Points</em><b>${plan.points.length}</b></span>
      </div>
      ${check.errors.length ? `<div class="e-notice warn"><div>${check.errors.map(error => esc(error.message)).join('<br>')}</div></div>` : ''}
      <p class="e-small e-faint">Procedures are a separate page: choose the arrival here, then continue.</p>`;
  }

  function procedureCard(kind) {
    const airport = kind === 'sid' ? plan.origin : plan.destination;
    const state = procedures[kind];
    const label = kind === 'sid' ? 'SID — departure' : 'STAR — arrival';
    if (!airport) {
      return `<div class="e-card fp-card"><h3>${label}</h3><p class="e-small e-faint">Choose the ${kind === 'sid' ? 'departure' : 'arrival'} airport first.</p></div>`;
    }
    if (state.status === 'idle') {
      return `<div class="e-card fp-card"><h3>${label}</h3>
        <p class="e-small e-muted">Published procedures for ${esc(airport.id)} have not been read yet.</p>
        <button class="e-btn small" type="button" data-act="load-procedures" data-kind="${kind}">Read published procedures</button></div>`;
    }
    if (state.status === 'loading') {
      return `<div class="e-card fp-card"><h3>${label}</h3><div class="e-loading"><i></i>Reading the published procedures for ${esc(airport.id)}…</div></div>`;
    }
    if (state.status === 'unavailable') {
      return `<div class="e-card fp-card"><h3>${label}</h3>
        <div class="e-notice warn"><div><b>Verified procedure data is currently unavailable for this airport.</b><br>${esc(state.error || 'The navigation data did not answer.')}</div></div>
        <div class="e-row" style="margin-top:8px"><button class="e-btn small ghost" type="button" data-act="load-procedures" data-kind="${kind}">Try again</button></div></div>`;
    }
    const payload = state.payload;
    const list = RP.procedureList(payload, kind);
    const selected = choice[kind].ident;
    const selectedRecord = kind === 'sid' ? plan.sid : plan.star;
    const runway = kind === 'sid' ? plan.departureRwy : plan.arrivalRwy;
    const source = `${payload.source || 'navigation data'}${payload.cycle ? ` · AIRAC ${payload.cycle}` : ''}`;
    if (!list.length) {
      return `<div class="e-card fp-card"><h3>${label}</h3>
        <div class="e-notice"><div>No ${kind.toUpperCase()} is published for ${esc(airport.id)} in this dataset. ${esc(source)}.</div></div></div>`;
    }
    // Published procedures are filtered by the selected runway when the data
    // names that runway; the pilot can still see everything.
    const filtered = list.filter(procedure => {
      if (!runway || choice[kind].showAll) return true;
      return (procedure.transitions || []).some(transition => runwayMatches(RP.runwayFromTransitionId(transition.id), runway));
    });
    const shown = filtered.length ? filtered : list;
    const procedure = selectedProcedure(kind);
    const transitions = procedure ? RP.procedureTransitions(procedure) : [];
    const runwayTransitions = transitions.filter(entry => entry.role === 'runway');
    const enrouteTransitions = transitions.filter(entry => entry.role === 'enroute');
    const suggestion = procedure
      ? RP.suggestTransitions(payload, {
        kind,
        ident: procedure.id,
        runway,
        routeIds: plan.points.map(point => point.id),
        airport: airport.id,
      })
      : null;
    return `<div class="e-card fp-card">
      <h3>${label} <span class="e-spacer"></span><span class="e-badge">${esc(payload.airport || airport.id)}</span></h3>
      <div class="fp-proc-list" role="listbox" aria-label="${kind === 'sid' ? 'SIDs' : 'STARs'} for ${esc(airport.id)}">
        ${shown.map(procedureRow => {
          const isSelected = selected === String(procedureRow.id);
          return `<button class="fp-proc${isSelected ? ' is-selected' : ''}" type="button" data-act="pick-procedure" data-kind="${kind}" data-ident="${esc(procedureRow.id)}" role="option" aria-selected="${isSelected}">
            <span class="fp-proc-id">${esc(procedureRow.id)}</span>
            <span class="fp-proc-meta">${(procedureRow.transitions || []).length} transition${(procedureRow.transitions || []).length === 1 ? '' : 's'}</span>
          </button>`;
        }).join('')}
      </div>
      ${runway && !choice[kind].showAll ? `<button class="fp-link" type="button" data-act="toggle-all" data-kind="${kind}">Show every ${kind.toUpperCase()}, not only runway ${esc(runway)}</button>` : ''}
      ${!filtered.length && runway ? `<p class="e-small e-faint">No ${kind.toUpperCase()} publishes a runway ${esc(runway)} transition; every procedure is listed instead.</p>` : ''}
      ${procedure ? `
        <div class="fp-proc-detail">
          <div class="fp-summary-row">
            <span><em>Runway</em><b>${esc(runway || 'not selected')}</b></span>
            <span><em>Common legs</em><b>${transitions.filter(entry => entry.role === 'common').length ? 'published' : 'none'}</b></span>
            <span><em>Transitions</em><b>${transitions.length}</b></span>
          </div>
          ${runwayTransitions.length ? `<label class="e-field"><span class="fp-search-label">Runway transition</span>
            <select class="e-select" data-act="transition" data-kind="${kind}" data-field="runwayTransition">
              <option value="">Published runway legs only</option>
              ${runwayTransitions.map(entry => `<option value="${esc(entry.id)}" ${choice[kind].runwayTransition === entry.id ? 'selected' : ''}>${esc(entry.label)}${entry.combined ? ' (both runways)' : ''} · ${entry.points} legs${entry.complete ? '' : ' · partial'}</option>`).join('')}
            </select></label>` : ''}
          ${enrouteTransitions.length ? `<label class="e-field" style="margin-top:8px"><span class="fp-search-label">En-route transition</span>
            <select class="e-select" data-act="transition" data-kind="${kind}" data-field="enrouteTransition">
              <option value="">Common legs only</option>
              ${enrouteTransitions.map(entry => `<option value="${esc(entry.id)}" ${choice[kind].enrouteTransition === entry.id ? 'selected' : ''}>${esc(entry.label)} → ${esc(entry.first)}…${esc(entry.last)} · ${entry.points} legs${entry.complete ? '' : ' · partial'}</option>`).join('')}
            </select></label>` : ''}
          ${suggestion && suggestion.reason ? `<p class="e-small fp-suggest">${esc(suggestion.reason)}. A suggestion from the published geometry, not a clearance.</p>` : ''}
          ${selectedRecord ? `<div class="e-badge accent" style="margin-top:8px">${esc(selectedRecord.label || selectedRecord.id)} · ${selectedRecord.points} legs in the plan${selectedRecord.complete ? '' : ' · partial'}</div>
            <button class="e-btn small ghost" type="button" data-act="clear-procedure" data-kind="${kind}" style="margin-top:8px">Remove ${kind.toUpperCase()}</button>` : ''}
          <p class="e-small e-faint" style="margin-top:8px">${esc(source)}. Legs are the published fixes. Where the source publishes no runway leg, the runway is joined to the first fix by one straight connector and the plan says so.</p>
        </div>` : `<p class="e-small e-faint" style="margin-top:8px">Tap a ${kind.toUpperCase()} to place its published legs in the plan.</p>`}
    </div>`;
  }

  function bodyProcedures() {
    if (!plan.destination) {
      return `<div class="e-empty"><b>Choose the arrival airport first</b><p>SIDs and STARs belong to an airport, so the plan needs both ends before procedures can be selected.</p>
        <button class="e-btn small primary" type="button" data-act="step" data-step="arrival">Choose arrival</button></div>`;
    }
    return `
      ${procedureCard('sid')}
      ${procedureCard('star')}
      <div class="e-notice"><div><b>Source.</b> Procedures come from the CIFP navigation data on this PC (or the FAA CIFP dataset shipped with Stratos, which covers the United States). Coverage outside that dataset is reported as unavailable. Airways are not part of any dataset Stratos ships, so no airway can be inserted.</div></div>`;
  }

  function weatherRow(row) {
    const parsed = row.parsed;
    const category = parsed && parsed.flightCategory;
    const wind = parsed && parsed.wind
      ? parsed.wind.direction == null
        ? `VRB ${parsed.wind.speedKt} kt${parsed.wind.gustKt ? ` G${parsed.wind.gustKt}` : ''}`
        : `${String(parsed.wind.direction).padStart(3, '0')}° ${parsed.wind.speedKt} kt${parsed.wind.gustKt ? ` G${parsed.wind.gustKt}` : ''}`
      : null;
    const tafWind = row.tafDecoded && row.tafDecoded.initial && row.tafDecoded.initial.wind
      ? row.tafDecoded.initial.wind.text
      : null;
    return `<div class="fp-wx">
      <div class="fp-wx-head">
        <b>${esc(row.icao)}</b>
        <span class="e-small e-muted">${esc(row.role)}</span>
        <span class="e-spacer"></span>
        ${category ? `<span class="e-badge ${CATEGORY_TONE[category] || ''}">${esc(category)}</span>` : '<span class="e-badge">No category</span>'}
      </div>
      ${row.error ? `<p class="e-small e-faint">${esc(row.error)}</p>` : `
        <div class="fp-wx-facts">
          <span><em>Wind</em><b>${esc(wind || '—')}</b></span>
          <span><em>Visibility</em><b>${parsed && Number.isFinite(parsed.visibilitySm) ? `${fmtNum(parsed.visibilitySm, 1)} SM` : '—'}</b></span>
          <span><em>Ceiling</em><b>${parsed && Number.isFinite(parsed.ceilingFt) ? `${fmtNum(parsed.ceilingFt)} ft` : '—'}</b></span>
          <span><em>Temp / dew</em><b>${parsed && Number.isFinite(parsed.temperatureC) ? `${parsed.temperatureC}° / ${Number.isFinite(parsed.dewpointC) ? parsed.dewpointC : '—'}°` : '—'}</b></span>
        </div>
        ${row.metar ? `<code class="e-code fp-raw">${esc(row.metar)}</code>` : ''}
        ${row.taf ? `<div class="e-small e-faint" style="margin-top:6px">TAF${tafWind ? ` · initial wind ${esc(tafWind)}` : ''}</div><code class="e-code fp-raw">${esc(row.taf)}</code>` : '<div class="e-small e-faint" style="margin-top:6px">No TAF is published.</div>'}
        <div class="e-small e-faint" style="margin-top:6px">${esc(row.source || '')} · ${esc(row.freshness.label)}${row.freshness.stale ? ' · <b style="color:var(--efb-warn)">stale — re-check before use</b>' : ''}</div>`}
    </div>`;
  }

  function alternateCard() {
    const destination = plan.destination;
    const chosen = plan.alternate;
    return `<div class="e-card fp-card">
      <h3>Alternate <span class="e-spacer"></span>${chosen ? `<span class="e-badge accent">${esc(chosen.id)}</span>` : '<span class="e-badge">None</span>'}</h3>
      ${destination ? searchBlock('alt', 'Search an alternate', 'ICAO or airport name') : '<p class="e-small e-faint">Choose the arrival airport first.</p>'}
      ${chosen ? `<div class="fp-stop-head" style="margin-top:8px">
          <b>${esc(chosen.id)}</b><span class="e-small e-muted">${esc(chosen.name || '')}</span>
          <span class="e-spacer"></span>
          <span class="e-small">${destination ? `${fmtNum(distanceNm(destination, chosen), 0)} nm from ${esc(destination.id)}` : ''}</span>
        </div>
        <div class="e-row" style="margin-top:8px"><button class="e-btn small ghost" type="button" data-act="clear-alternate">Remove alternate</button></div>` : ''}
      ${destination ? `<div class="fp-alt-tools">
          <label class="e-field"><span class="fp-search-label">Within (nm)</span>
            <input class="e-input small" type="number" min="20" max="600" step="10" id="fp-alt-max" value="${alternates.maxNm}"></label>
          <label class="e-field"><span class="fp-search-label">Longest runway at least (ft)</span>
            <input class="e-input small" type="number" min="0" max="15000" step="500" id="fp-alt-rwy" value="${alternates.minRunwayFt}"></label>
        </div>
        <button class="e-btn small" type="button" data-act="suggest-alternates">${alternates.status === 'loading' ? 'Assessing…' : 'Suggest alternates'}</button>
        ${alternates.error ? `<div class="e-notice warn" style="margin-top:8px"><div>${esc(alternates.error)}</div></div>` : ''}
        ${alternates.rows.length ? `<div class="fp-alt-list">
          ${alternates.rows.map((row, index) => `<div class="fp-alt">
            <div class="fp-alt-head"><b>${esc(row.id)}</b><span>${esc(row.name)}</span><span class="e-spacer"></span>
              ${row.weather && row.weather.category ? `<span class="e-badge ${CATEGORY_TONE[row.weather.category] || ''}">${esc(row.weather.category)}</span>` : '<span class="e-badge">No wx</span>'}
            </div>
            <div class="fp-alt-facts">${row.reasons.map(reason => `<span>${esc(reason)}</span>`).join('')}</div>
            <details class="fp-alt-why"><summary>What is not assessed</summary><ul>${row.missing.map(text => `<li>${esc(text)}</li>`).join('')}</ul></details>
            <div class="e-row">
              <button class="e-btn small" type="button" data-act="use-alternate" data-index="${index}">Use as alternate</button>
              ${row.weather && row.weather.error ? `<span class="e-small e-faint">${esc(row.weather.error)}</span>` : ''}
            </div>
          </div>`).join('')}
        </div>` : ''}` : ''}
      <p class="e-small e-faint">Suggestions are ranked by distance and the runway length the airport data states. Minima, aircraft performance and company policy are not assessed, and each suggestion lists what is missing.</p>
    </div>`;
  }

  function fuelBreakdown() {
    const fuel = currentFuel();
    if (!fuel.ok) {
      return `<div class="e-notice warn"><div>${esc(fuel.error)}</div></div>
        ${plan.fuel.mode === 'auto' ? `<button class="e-btn small ghost" type="button" data-act="fuel-mode" data-mode="manual" style="margin-top:8px">Enter the fuel manually instead</button>` : ''}`;
    }
    const unit = fuel.unit;
    return `<div class="fp-fuel-out">
      <table class="e-table">
        <thead><tr><th>Component</th><th>Source</th><th class="num">${esc(unit)}</th></tr></thead>
        <tbody>${fuel.rows.map(row => `<tr>
          <td>${esc(row.label)}${row.basis ? `<div class="e-small e-faint">${esc(row.basis)}</div>` : ''}</td>
          <td><span class="e-badge ${row.source === 'entered' ? '' : row.source === 'calculated' ? 'accent' : ''}">${esc(row.source || 'not set')}</span></td>
          <td class="num">${row.value != null ? fmtNum(row.value) : '<span class="e-faint">—</span>'}</td>
        </tr>`).join('')}</tbody>
        <tfoot>
          <tr><td><b>Block fuel</b></td><td></td><td class="num"><b>${fmtNum(fuel.block)} ${esc(unit)}</b></td></tr>
          <tr><td>At destination</td><td><span class="e-badge accent">calculated</span></td><td class="num">${fuel.landing != null ? `${fmtNum(fuel.landing)} ${esc(unit)}` : '<span class="e-faint">—</span>'}</td></tr>
        </tfoot>
      </table>
      ${fuel.notes.length ? `<ul class="fp-notes">${fuel.notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
      <p class="e-small e-faint" style="margin-top:8px">${esc(fuel.method)}</p>
    </div>`;
  }

  function bodyFuel() {
    const burn = burnFromPlan();
    const summary = RP.routeSummary(plan);
    const unit = fuelUnit();
    return `
      <div class="e-card fp-card">
        <h3>Fuel <span class="e-spacer"></span>
          <span class="e-badge">${esc(summary.distanceNm > 0 ? `${fmtNum(summary.distanceNm, 0)} nm` : 'no route')}</span>
        </h3>
        <div class="e-seg" role="group" aria-label="Fuel source">
          <button type="button" data-act="fuel-mode" data-mode="auto" aria-pressed="${plan.fuel.mode !== 'manual'}">Automatic estimate</button>
          <button type="button" data-act="fuel-mode" data-mode="manual" aria-pressed="${plan.fuel.mode === 'manual'}">Manual</button>
        </div>
        ${plan.fuel.mode === 'manual' ? `
          <p class="e-small e-faint" style="margin:8px 0">Enter the components yourself. Nothing is calculated from a model.</p>
          <div class="fp-fuel-grid">
            ${RP.FUEL_ROWS.map(row => `<label class="e-field"><span class="fp-search-label">${esc(row.label)}</span>
              <input class="e-input small" type="number" min="0" step="10" data-fuel="${row.key}" value="${esc(plan.fuel.components[row.key] ?? '')}" placeholder="—"></label>`).join('')}
          </div>
          <div class="e-row" style="margin-top:8px">
            <label class="e-field" style="flex:1 1 120px"><span class="fp-search-label">Block fuel override</span>
              <input class="e-input small" type="number" min="0" step="10" id="fp-fuel-block" value="${esc(plan.fuel.block ?? '')}" placeholder="Total the components">
            </label>
            <label class="e-field" style="flex:0 1 90px"><span class="fp-search-label">Unit</span>
              <select class="e-select" id="fp-fuel-unit">
                <option value="kg" ${plan.fuel.unit === 'kg' ? 'selected' : ''}>kg</option>
                <option value="lb" ${plan.fuel.unit === 'lb' ? 'selected' : ''}>lb</option>
              </select>
            </label>
          </div>` : `
          <div class="fp-fuel-head">
            <div class="e-label">Burn rate source</div>
            <div class="e-seg" role="group" aria-label="Burn rate source" style="margin-top:5px">
              <button type="button" data-act="burn-source" data-source="plan" aria-pressed="${plan.fuel.burnSource === 'plan'}">From the SimBrief plan</button>
              <button type="button" data-act="burn-source" data-source="entered" aria-pressed="${plan.fuel.burnSource === 'entered'}">Enter a fuel flow</button>
            </div>
            ${plan.fuel.burnSource === 'plan'
              ? (burn
                ? `<p class="e-small e-muted" style="margin:8px 0 0">${fmtNum(burn.burnPerHour)} ${esc(burn.unit)}/h — the loaded plan's trip fuel over its enroute time${burn.aircraft ? ` (${esc(burn.aircraft)})` : ''}. The same aircraft the plan was flown in.</p>`
                : `<div class="e-notice warn" style="margin-top:8px"><div>No SimBrief plan with trip fuel and enroute time is stored, so there is no fuel flow to use. Load a plan in the Flight Plan app, or enter a fuel flow.</div></div>`)
              : `<div class="e-row" style="margin-top:8px">
                  <label class="e-field" style="flex:1 1 130px"><span class="fp-search-label">Cruise fuel flow</span>
                    <input class="e-input small" type="number" min="0" step="50" id="fp-fuel-burn" value="${esc(plan.fuel.burnPerHour ?? '')}" placeholder="e.g. 2600">
                  </label>
                  <label class="e-field" style="flex:0 1 90px"><span class="fp-search-label">Unit</span>
                    <select class="e-select" id="fp-fuel-unit">
                      <option value="kg" ${plan.fuel.unit === 'kg' ? 'selected' : ''}>kg/h</option>
                      <option value="lb" ${plan.fuel.unit === 'lb' ? 'selected' : ''}>lb/h</option>
                    </select>
                  </label>
                </div>`}
          </div>
          <div class="fp-fuel-grid" style="margin-top:10px">
            <label class="e-field"><span class="fp-search-label">Cruise TAS (kt)</span>
              <input class="e-input small" type="number" min="60" max="700" step="5" id="fp-fuel-tas" value="${plan.cruiseKts}"></label>
            <label class="e-field"><span class="fp-search-label">Headwind (kt, + ahead)</span>
              <input class="e-input small" type="number" min="-150" max="150" step="5" id="fp-fuel-wind" value="${esc(plan.fuel.headwindKt ?? 0)}"></label>
            <label class="e-field"><span class="fp-search-label">Taxi (min)</span>
              <input class="e-input small" type="number" min="0" max="90" step="1" id="fp-fuel-taxi" value="${esc(plan.fuel.taxiMin ?? 0)}"></label>
            <label class="e-field"><span class="fp-search-label">Contingency (%)</span>
              <input class="e-input small" type="number" min="0" max="50" step="1" id="fp-fuel-cont" value="${esc(plan.fuel.contingencyPct ?? 0)}"></label>
            <label class="e-field"><span class="fp-search-label">Final reserve (min)</span>
              <input class="e-input small" type="number" min="0" max="180" step="5" id="fp-fuel-reserve" value="${esc(plan.fuel.reserveMin ?? 0)}"></label>
            <label class="e-field"><span class="fp-search-label">Extra fuel (${esc(unit === 'lb' ? 'lb' : 'kg')})</span>
              <input class="e-input small" type="number" min="0" step="10" id="fp-fuel-extra" value="${esc(plan.fuel.extra ?? '')}" placeholder="—"></label>
          </div>
          <p class="e-small e-faint" style="margin-top:8px">No aircraft performance table is applied: the burn rate, the taxi time, the contingency and the reserve are the assumptions on this page. A wind is not imported, so the headwind field starts at zero.</p>`}
        <div id="fp-fuel-out" style="margin-top:10px">${fuelBreakdown()}</div>
      </div>
      ${alternateCard()}
      <div class="e-card fp-card">
        <h3>Weather <span class="e-spacer"></span>
          <button class="e-btn small ghost" type="button" data-act="weather-refresh">${weather.status === 'loading' ? 'Reading…' : 'Refresh'}</button></h3>
        ${weather.status === 'idle' ? '<p class="e-small e-muted">Read the current METAR and TAF for the airports in this plan.</p>'
          : weather.status === 'loading' ? '<div class="e-loading"><i></i>Reading METAR and TAF…</div>'
            : weather.status === 'unavailable' ? `<div class="e-notice warn"><div>${esc(weather.error || 'Weather is unavailable.')}</div></div>`
              : weather.rows.map(weatherRow).join('')}
        <p class="e-small e-faint">Real-world NOAA reports, not simulator weather. Times are the fetch time; a report older than an hour is marked stale and never shown as current.</p>
      </div>`;
  }

  function bodyReview() {
    const summary = RP.routeSummary(plan);
    const check = RP.validatePlan(plan);
    const fuel = currentFuel();
    const sid = plan.sid;
    const star = plan.star;
    const provenance = [
      ['Airports', 'OurAirports (bundled snapshot plus the bridge database)'],
      ['Navaids', navaids.status === 'ready' ? 'OurAirports navaids via the bridge' : 'Bundled OurAirports navaid snapshot'],
      ['Procedures', sid || star
        ? [sid ? `SID ${sid.id} from ${sid.source || 'navigation data'}${sid.cycle ? ` · AIRAC ${sid.cycle}` : ''}` : '', star ? `STAR ${star.id} from ${star.source || 'navigation data'}${star.cycle ? ` · AIRAC ${star.cycle}` : ''}` : ''].filter(Boolean).join(' · ')
        : 'None selected'],
      ['Weather', weather.status === 'ready' ? 'NOAA Aviation Weather Center (METAR, TAF)' : 'Not fetched'],
      ['Fuel', fuel.ok ? fuel.method : 'Not calculated'],
      ['Airways', 'Not offered: no airway dataset is shipped with Stratos'],
    ];
    return `
      <div class="e-card fp-card">
        <h3>Route <span class="e-spacer"></span><span class="e-badge">${plan.points.length} points</span></h3>
        <div class="fp-summary-row">
          <span><em>From</em><b>${esc((plan.origin && plan.origin.id) || '—')}</b></span>
          <span><em>To</em><b>${esc((plan.destination && plan.destination.id) || '—')}</b></span>
          <span><em>Alternate</em><b>${esc((plan.alternate && plan.alternate.id) || '—')}</b></span>
        </div>
        <dl class="e-kv" style="margin-top:8px">
          <dt>Distance</dt><dd>${summary.distanceNm > 0 ? `${fmtNum(summary.distanceNm, 1)} nm` : '<span class="e-faint">No route</span>'}</dd>
          <dt>Estimated time</dt><dd>${summary.eteMinutes > 0 ? `${fmtMinutes(summary.eteMinutes)} <small>no wind, ${fmtNum(plan.cruiseKts)} kt, ${esc(fmtFl(plan.cruiseAlt))}</small>` : '<span class="e-faint">—</span>'}</dd>
          <dt>SID</dt><dd>${sid ? `${esc(sid.label || sid.id)} <small>${esc(sid.source || '')}${sid.cycle ? ` · AIRAC ${esc(sid.cycle)}` : ''}${sid.complete === false ? ' · partial' : ''}</small>` : '<span class="e-faint">Not selected</span>'}</dd>
          <dt>STAR</dt><dd>${star ? `${esc(star.label || star.id)} <small>${esc(star.source || '')}${star.cycle ? ` · AIRAC ${esc(star.cycle)}` : ''}${star.complete === false ? ' · partial' : ''}</small>` : '<span class="e-faint">Not selected</span>'}</dd>
          <dt>Runways</dt><dd>${esc([plan.departureRwy, plan.arrivalRwy].filter(Boolean).join(' / ') || 'Not selected')}</dd>
        </dl>
      </div>

      <div class="e-card fp-card">
        <h3>Fuel <span class="e-spacer"></span>${fuel.ok ? `<span class="e-badge accent">${fmtNum(fuel.block)} ${esc(fuel.unit)}</span>` : '<span class="e-badge bad">Not calculated</span>'}</h3>
        ${fuel.ok
          ? `<dl class="e-kv">
              <dt>Block</dt><dd>${fmtNum(fuel.block)} ${esc(fuel.unit)}</dd>
              <dt>At destination</dt><dd>${fuel.landing != null ? `${fmtNum(fuel.landing)} ${esc(fuel.unit)}` : '<span class="e-faint">—</span>'}</dd>
              <dt>Source</dt><dd><span class="e-small">${esc(fuel.method)}</span></dd>
            </dl>`
          : `<div class="e-notice warn"><div>${esc(fuel.error || 'Fuel has not been planned.')}</div></div>`}
      </div>

      <div class="e-card fp-card">
        <h3>Weather <span class="e-spacer"></span>${weather.status === 'ready' ? '<span class="e-badge good">Read</span>' : '<span class="e-badge">Not read</span>'}</h3>
        ${weather.status === 'ready'
          ? weather.rows.map(row => `<div class="fp-wx-mini"><b>${esc(row.icao)}</b><span>${esc(row.role)}</span><span class="e-spacer"></span>
              ${row.parsed && row.parsed.flightCategory ? `<span class="e-badge ${CATEGORY_TONE[row.parsed.flightCategory] || ''}">${esc(row.parsed.flightCategory)}</span>` : '<span class="e-badge">—</span>'}
              <span class="e-small e-faint">${esc(row.freshness.label)}</span></div>`).join('')
          : '<p class="e-small e-faint">Read the weather on the fuel step; the review shows what was read and when.</p>'}
      </div>

      <div class="e-card fp-card">
        <h3>Validation</h3>
        ${check.errors.length
          ? `<ul class="fp-check bad">${check.errors.map(error => `<li>${esc(error.message)}</li>`).join('')}</ul>`
          : '<p class="e-small" style="margin:0;color:var(--efb-good)">No blocking problem found in the plan.</p>'}
        ${check.warnings.length
          ? `<ul class="fp-check warn">${check.warnings.map(warning => `<li>${esc(warning.message)}</li>`).join('')}</ul>`
          : ''}
        <p class="e-small e-faint" style="margin-top:8px">This checks the plan's own structure: endpoints, waypoint limits and procedure completeness. It is not a route-validity, obstacle, minima or dispatch check, and it cannot make a plan operationally valid.</p>
      </div>

      ${savedPlansCard({ actions: true })}

      <div class="e-card fp-card">
        <h3>Data and limitations</h3>
        <dl class="e-kv">${provenance.map(([label, value]) => `<dt>${esc(label)}</dt><dd><span class="e-small">${esc(value)}</span></dd>`).join('')}</dl>
        <p class="e-small e-faint" style="margin-top:8px">SIDs, STARs and approaches are only what the CIFP data publishes for the airports in this plan; a procedure the data does not carry is reported, never approximated. No airway, wind, performance, minima or obstacle data is invented. Simulator use only.</p>
      </div>`;
  }

  function bodyFor(id) {
    if (id === 'departure') return bodyDeparture();
    if (id === 'route') return bodyRoute();
    if (id === 'arrival') return bodyArrival();
    if (id === 'procedures') return bodyProcedures();
    if (id === 'fuel') return bodyFuel();
    return bodyReview();
  }

  function actionsFor(id) {
    const index = RP.STEP_IDS.indexOf(id);
    const prev = index > 0 ? RP.STEP_IDS[index - 1] : null;
    const next = index < RP.STEP_IDS.length - 1 ? RP.STEP_IDS[index + 1] : null;
    const check = RP.validatePlan(plan);
    const back = prev ? `<button class="e-btn small ghost" type="button" data-act="step" data-step="${prev}">Back</button>` : '';
    if (id === 'review') {
      return `${back}
        <span class="e-spacer"></span>
        <button class="e-btn small ghost" type="button" data-act="save-plan">Save</button>
        <button class="e-btn small" type="button" data-act="track" ${plan.origin && plan.destination ? '' : 'disabled'} title="Open this plan on the Flight Deck map">Track on deck</button>
        <button class="e-btn small primary" type="button" data-act="navigator" ${plan.origin && plan.destination ? '' : 'disabled'}>Load into Navigator</button>`;
    }
    if (id === 'procedures') {
      return `${back}<span class="e-spacer"></span>
        <button class="e-btn small" type="button" data-act="step" data-step="fuel">Continue to fuel</button>`;
    }
    if (id === 'fuel') {
      return `${back}<span class="e-spacer"></span>
        <button class="e-btn small" type="button" data-act="step" data-step="review">Review the plan</button>`;
    }
    if (id === 'arrival') {
      const enabled = check.canContinueToProcedures;
      return `${back}<span class="e-spacer"></span>
        <button class="e-btn small primary" type="button" data-act="continue-procedures" ${enabled ? '' : 'disabled'} title="${enabled ? 'SID and STAR selection' : 'A departure, an arrival and a route are needed first'}">Continue to Procedures</button>`;
    }
    if (id === 'route') {
      // The arrival page is where the "Continue to Procedures" rule lives, so
      // this step always hands over; it does not pretend the route is finished.
      return `${back}<span class="e-spacer"></span>
        <button class="e-btn small" type="button" data-act="step" data-step="arrival">Continue to arrival</button>`;
    }
    return `<span class="e-spacer"></span>
      <button class="e-btn small primary" type="button" data-act="step" data-step="route" ${plan.origin ? '' : 'disabled'}>Continue to route</button>`;
  }

  /** The panel body and footer, painted on their own for async updates. */
  function paintStep() {
    if (!el.scroll || !el.actions) return;
    const meta = stepMeta(step);
    if (el.title) el.title.textContent = stepTitles[step] || meta.label;
    if (el.panelHint) el.panelHint.textContent = `${RP.STEP_IDS.indexOf(step) + 1}/${RP.STEPS.length}`;
    const scrollTop = el.scroll.scrollTop;
    el.scroll.innerHTML = bodyFor(step);
    el.scroll.scrollTop = scrollTop;
    el.actions.innerHTML = actionsFor(step);
    bindStepInputs();
    // Weather and procedures are read when their step is first opened, not on
    // every render: the bridge should not be polled for a page nobody is on.
    if (step === 'fuel' && plan.origin && plan.destination && weather.status === 'idle') loadWeather();
    if (step === 'procedures') {
      if (plan.origin && procedures.sid.status === 'idle') loadProcedures('sid');
      if (plan.destination && procedures.star.status === 'idle') loadProcedures('star');
    }
  }

  /** Selection is a local DOM update: the map highlight plus this panel. */
  function paintDetail() {
    if (step !== 'route') return;
    const host = root.querySelector('#fp-detail-host');
    if (host) host.innerHTML = selectionDetail();
    const list = root.querySelector('#fp-route-list');
    if (list) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = routeList();
      list.replaceWith(wrapper.firstElementChild);
    }
  }

  function render() {
    paintSteps();
    paintHud();
    paintMap();
    paintBanner();
    if (el.panel) el.panel.hidden = !panelOpen;
    root.querySelector('[data-act="panel"]')?.setAttribute('aria-pressed', panelOpen ? 'true' : 'false');
    paintStep();
    paintBanner();
  }

  /* ── input wiring ────────────────────────────────────────────────────── */

  function bindStepInputs() {
    for (const kind of Object.keys(searches)) {
      const input = root.querySelector(`#fp-search-${kind}`);
      if (!input) continue;
      // Typing never re-renders the panel: only the result list changes, so the
      // caret and the query stay exactly where the pilot left them.
      input.addEventListener('input', () => {
        clearTimeout(searchTimers[kind]);
        searchTimers[kind] = setTimeout(() => runSearch(kind), 220);
      });
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (searches[kind].rows.length) pickResult(kind, 0);
      });
    }

    const runwaySelect = root.querySelector('#fp-rwy-sid');
    runwaySelect?.addEventListener('change', event => setRunway('sid', event.target.value));
    const arrivalRunway = root.querySelector('#fp-rwy-star');
    arrivalRunway?.addEventListener('change', event => setRunway('star', event.target.value));

    const cruiseKts = root.querySelector('#fp-cruise-kts');
    cruiseKts?.addEventListener('change', event => {
      plan = RP.setCruise(plan, { kts: event.target.value, altFt: plan.cruiseAlt });
      afterChange({ fit: false });
    });
    const cruiseAlt = root.querySelector('#fp-cruise-alt');
    cruiseAlt?.addEventListener('change', event => {
      plan = RP.setCruise(plan, { kts: plan.cruiseKts, altFt: event.target.value });
      afterChange({ fit: false });
    });

    // Fuel assumes its own inputs so the breakdown updates as the pilot types.
    const fuelField = (id, apply) => {
      const node = root.querySelector(id);
      if (!node) return;
      node.addEventListener('input', () => {
        apply(node.value);
        const host = root.querySelector('#fp-fuel-out');
        if (host) host.innerHTML = fuelBreakdown();
      });
    };
    fuelField('#fp-fuel-burn', value => { plan = { ...plan, fuel: { ...plan.fuel, burnPerHour: value, burnSource: 'entered' } }; });
    fuelField('#fp-fuel-tas', value => { plan = RP.setCruise(plan, { kts: value, altFt: plan.cruiseAlt }); });
    fuelField('#fp-fuel-wind', value => { plan = { ...plan, fuel: { ...plan.fuel, headwindKt: value } }; });
    fuelField('#fp-fuel-taxi', value => { plan = { ...plan, fuel: { ...plan.fuel, taxiMin: value } }; });
    fuelField('#fp-fuel-cont', value => { plan = { ...plan, fuel: { ...plan.fuel, contingencyPct: value } }; });
    fuelField('#fp-fuel-reserve', value => { plan = { ...plan, fuel: { ...plan.fuel, reserveMin: value } }; });
    fuelField('#fp-fuel-extra', value => { plan = { ...plan, fuel: { ...plan.fuel, extra: value } }; });
    fuelField('#fp-fuel-block', value => { plan = { ...plan, fuel: { ...plan.fuel, block: value } }; });
    root.querySelector('#fp-fuel-unit')?.addEventListener('change', event => {
      plan = { ...plan, fuel: { ...plan.fuel, unit: event.target.value === 'lb' ? 'lb' : 'kg' } };
      render();
    });
    root.querySelectorAll('[data-fuel]').forEach(input => {
      input.addEventListener('input', () => {
        const components = { ...plan.fuel.components, [input.dataset.fuel]: input.value };
        plan = { ...plan, fuel: { ...plan.fuel, components } };
        const host = root.querySelector('#fp-fuel-out');
        if (host) host.innerHTML = fuelBreakdown();
      });
    });
    root.querySelector('#fp-alt-max')?.addEventListener('change', event => {
      alternates = { ...alternates, maxNm: Math.max(20, Number(event.target.value) || 250) };
    });
    root.querySelector('#fp-alt-rwy')?.addEventListener('change', event => {
      alternates = { ...alternates, minRunwayFt: Math.max(0, Number(event.target.value) || 0) };
    });
    paintBanner();
  }

  /* ── delegated actions ───────────────────────────────────────────────── */

  function onRootClick(event) {
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;
    if (act === 'pick') { pickResult(target.dataset.kind, target.dataset.index); return; }
    if (act === 'step') {
      const id = target.dataset.step;
      if (!RP.STEP_IDS.includes(id)) return;
      // A step is a place in the plan, and the plan is edited in the panel. On a
      // narrow screen the panel starts closed, so choosing a step opens it
      // rather than leaving the tap with nothing visible to act on.
      panelOpen = true;
      if (id === 'departure' || id === 'route' || id === 'arrival') {
        step = id;
        render();
        return;
      }
      const check = RP.validatePlan(plan);
      if (!check.canContinueToProcedures) {
        step = 'arrival';
        setNotice('Choose a departure, an arrival and a route before procedures, fuel or review.', 'warn');
        render();
        return;
      }
      step = id;
      render();
      return;
    }
    if (act === 'continue-procedures') {
      const check = RP.validatePlan(plan);
      if (!check.canContinueToProcedures) { setNotice('A departure, an arrival and a route are needed first.', 'warn'); return; }
      step = 'procedures';
      panelOpen = true;
      render();
      return;
    }
    if (act === 'zoom') { map?.zoomBy(target.dataset.dir === 'in' ? 1 : -1); return; }
    if (act === 'fit') { map?.fitRoute(); return; }
    if (act === 'chart') {
      chartTheme = chartTheme === 'night' ? 'day' : 'night';
      ctx.setPrefs({ chartTheme });
      if (map) {
        map.options.chartTheme = chartTheme;
        map.options.tint = chartTheme === 'night' ? 'rgba(6, 10, 18, .42)' : null;
        map.draw();
      }
      return;
    }
    if (act === 'panel') { panelOpen = !panelOpen; render(); return; }
    if (act === 'panel-close') { panelOpen = false; render(); return; }
    if (act === 'dismiss') { setNotice(''); return; }
    if (act === 'undo') { undo(); return; }
    if (act === 'route-hint') {
      setNotice('Tap the chart and the nearest published record inside the radius is added under its own identifier. A tap that finds nothing offers a custom coordinate instead. On the departure and arrival steps a tap uses the nearest airport.', '');
      return;
    }
    if (act === 'radius') return;
    if (act === 'ring') {
      if (map) { map.showRange = !map.showRange; map.draw(); paintReadout(); }
      return;
    }
    if (act === 'globe') { toggleGlobe(); return; }
    if (act === 'globe-style') { setGlobeStyle(target.dataset.style); return; }
    if (act === 'globe-reset') {
      if (!map) return;
      map.globeReset();
      paintReadout();
      refreshNear({ force: true });
      return;
    }
    if (act === 'terrain-read') {
      if (!map) return;
      if (!map.readTerrain()) { setNotice('The globe is not open, so there is no centre to read terrain around.', 'warn'); return; }
      setNotice('Reading terrain tiles around the centre. Elevations are a display product from the AWS/Mapzen terrain tiles, not for navigation.', '');
      paintReadout();
      return;
    }
    if (act === 'pick-point') {
      const option = pickChooser && pickChooser.options[Number(target.dataset.index)];
      if (option) addRecord(option);
      return;
    }
    if (act === 'pick-custom') {
      const position = pickChooser && pickChooser.position;
      if (!position) { pickChooser = null; renderPick(); return; }
      const id = coordinateIdent(position.lat, position.lon);
      addRecord({
        id,
        name: `Custom coordinate ${formatLatLon(position.lat, position.lon, 3)}`,
        lat: position.lat,
        lon: position.lon,
        kind: 'fix',
        elev: null,
        source: 'chart position',
      }, `${id} placed as a custom coordinate, not a published fix.`);
      return;
    }
    if (act === 'drop-pick') { pickChooser = null; renderPick(); return; }
    if (act === 'clear-route') {
      if (!window.confirm('Remove every intermediate point and the arrival, keeping only the departure?')) return;
      pushUndo();
      plan = RP.clearArrival(plan);
      selection = null;
      afterChange({ fit: false });
      return;
    }
    if (act === 'select-wp') { select({ type: 'wp', index: Number(target.dataset.index) }); return; }
    if (act === 'move-up' || act === 'move-down') {
      const index = Number(target.dataset.index);
      pushUndo();
      plan = RP.movePoint(plan, index, index + (act === 'move-up' ? -1 : 1));
      selection = { type: 'wp', index: index + (act === 'move-up' ? -1 : 1) };
      afterChange({ fit: false });
      return;
    }
    if (act === 'remove-wp') {
      const index = Number(target.dataset.index);
      pushUndo();
      plan = RP.removePoint(plan, index);
      selection = null;
      afterChange({ fit: false });
      return;
    }
    if (act === 'use-map-pick') {
      const airport = mapPick && mapPick.airport;
      if (!airport) return;
      const role = target.dataset.role;
      mapPick = null;
      if (role === 'departure') chooseDeparture(airport);
      else chooseArrival(airport);
      return;
    }
    if (act === 'drop-map-pick') { mapPick = null; render(); return; }
    if (act === 'load-procedures') { loadProcedures(target.dataset.kind); return; }
    if (act === 'pick-procedure') { chooseProcedure(target.dataset.kind, target.dataset.ident); return; }
    if (act === 'clear-procedure') {
      pushUndo();
      plan = RP.clearProcedure(plan, target.dataset.kind);
      choice[target.dataset.kind] = { ...choice[target.dataset.kind], ident: '', runwayTransition: '', enrouteTransition: '' };
      afterChange({ fit: false });
      return;
    }
    if (act === 'toggle-all') {
      const kind = target.dataset.kind;
      choice[kind] = { ...choice[kind], showAll: !choice[kind].showAll };
      render();
      return;
    }
    if (act === 'fuel-mode') {
      plan = { ...plan, fuel: { ...plan.fuel, mode: target.dataset.mode === 'manual' ? 'manual' : 'auto' } };
      render();
      return;
    }
    if (act === 'burn-source') {
      plan = { ...plan, fuel: { ...plan.fuel, burnSource: target.dataset.source === 'entered' ? 'entered' : 'plan' } };
      render();
      return;
    }
    if (act === 'weather-refresh') { loadWeather({ force: true }); return; }
    if (act === 'suggest-alternates') { suggestAlternates(); return; }
    if (act === 'use-alternate') {
      const row = alternates.rows[Number(target.dataset.index)];
      if (row) useAlternate(row);
      return;
    }
    if (act === 'clear-alternate') {
      pushUndo();
      plan = RP.setAlternate(plan, null);
      afterChange({ fit: false });
      return;
    }
    if (act === 'save-plan') { saveCurrentPlan(); return; }
    if (act === 'new-plan') { newPlan(); return; }
    if (act === 'reset-plan') { newPlan({ clearShared: true }); refreshNear({ force: true }); return; }
    if (act === 'open-plan') { openSavedPlan(target.dataset.id); return; }
    if (act === 'delete-plan') { deleteSavedPlan(target.dataset.id); return; }
    if (act === 'navigator') { loadIntoNavigator(); return; }
    if (act === 'track') { trackOnFlightDeck(); return; }
  }

  root.addEventListener('click', onRootClick);

  function onRootKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-act="select-wp"]');
    if (!row) return;
    event.preventDefault();
    select({ type: 'wp', index: Number(row.dataset.index) });
  }
  root.addEventListener('keydown', onRootKeydown);

  function onTransitionChange(event) {
    const radius = event.target.closest('[data-act="radius"]');
    if (radius) {
      const wanted = Number(radius.value);
      navNear.radiusNm = Number.isFinite(wanted) && wanted > 0
        ? Math.max(5, Math.min(MAX_RADIUS_NM, wanted))
        : DEFAULT_RADIUS_NM;
      map?.setRange(navNear.radiusNm);
      refreshNear({ force: true });
      return;
    }
    const node = event.target.closest('[data-act="transition"]');
    if (!node) return;
    setProcedureTransition(node.dataset.kind, node.dataset.field, node.value);
  }
  root.addEventListener('change', onTransitionChange);

  const onResize = () => {
    if (!map) return;
    const beside = panelOpen && window.matchMedia('(min-width: 1000px)').matches;
    map.options.paddingRight = 34 + (beside ? 340 : 0);
    map.draw();
  };
  window.addEventListener('resize', onResize);

  const onAirline = () => { if (map) { map.options.accent = accentNow(); map.draw(); } };
  window.addEventListener('stratos:efb-airline', onAirline);

  document.body.classList.add('view-map', 'view-plan');

  /* ── first paint ─────────────────────────────────────────────────────── */

  onResize();
  render();
  if (plan.points.length > 1) map?.fitRoute();
  // The chart reads its own navigation points. The aircraft altitude in the
  // readout follows the simulator, and the live subscription is what makes it
  // appear without touching the map.
  ensureLive();
  onLive(() => { if (!destroyed) paintReadout(); });
  refreshNear({ force: true });
  if (step === 'procedures' || (plan.sid || plan.star)) {
    if (plan.origin) loadProcedures('sid');
    if (plan.destination) loadProcedures('star');
  }

  return {
    destroy() {
      destroyed = true;
      document.body.classList.remove('view-map', 'view-plan');
      for (const timer of Object.values(searchTimers)) clearTimeout(timer);
      clearTimeout(nearTimer);
      root.removeEventListener('click', onRootClick);
      root.removeEventListener('keydown', onRootKeydown);
      root.removeEventListener('change', onTransitionChange);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('stratos:efb-airline', onAirline);
      if (map) { try { map.destroy(); } catch (_) { /* already gone */ } map = null; }
    },
  };
}
