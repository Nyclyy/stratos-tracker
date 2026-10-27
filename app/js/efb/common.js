/* Shared EFB plumbing: preferences, the current plan, airport search, weather,
 * chart catalogues and one live-telemetry client.
 *
 * Everything here reuses what the tracker already owns — the stored SimBrief
 * OFP, the Flight Deck route, the bridge's airport/weather/chart endpoints and
 * the bridge telemetry stream — so the EFB cannot drift into a second, separate
 * source of truth.
 */

import { bridgeHealth, defaultBridgeBase, isHostedPage, TelemetryClient } from '../bridge.js';
import { loadDirectory } from '../pilot/common.js';
import { clearOfp, loadOfp, OFP_STORAGE_KEY, saveOfp } from '../lib/flightsummary.js';
import { fetchSimbriefPlan, loadSimbriefId } from '../lib/simbrief.js';
import { getResourceProfile, detectResourceMode, parseTelemetry } from '../lib/telemetry.js';
import { officialSourcesFor } from '../lib/chartdir.js';
import { chartCoverage } from '../lib/chartproviders.js';
import { groupCharts, normaliseCatalogue, searchCharts } from '../lib/charts.js';

export const PREFS_KEY = 'stratos.efb.prefs';

export const DEFAULT_PREFS = {
  units: 'kg',
  wallpaper: 'aurora',
  motion: 'full',
  simbriefId: '',
  aircraft: '',
  weatherRefresh: 300,
  chartSource: 'auto',
  // Navigator's chart style, and the airline the bag is dressed as. Automatic
  // takes the airline from the loaded SimBrief plan's callsign; manual always
  // wins, and an empty choice means the house Stratos appearance.
  chartTheme: 'night',
  airlineMode: 'auto',
  airline: '',
};

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function $(selector, root = document) { return root.querySelector(selector); }

export function fmtNum(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtFt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${fmtNum(Math.round(n))} ft`;
}

/* Visibility in the units the station actually reported: metres where the METAR
   used metres ("9999" is 10 km or more, not a number to print), statute miles
   where it used miles. Converting everything to one unit would be a quiet edit
   of the observation. */
export function fmtVisibility(decoded) {
  if (!decoded) return '—';
  const metres = Number(decoded.visibilityM);
  if (Number.isFinite(metres)) return metres >= 9999 ? '10 km or more' : `${fmtNum(metres)} m`;
  const miles = Number(decoded.visibilitySm);
  if (Number.isFinite(miles)) return `${miles} SM`;
  return '—';
}

export function fmtFl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 18000) return `FL${String(Math.round(n / 100)).padStart(3, '0')}`;
  return `${fmtNum(Math.round(n / 10) * 10)} ft`;
}

export function fmtKt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${fmtNum(Math.round(n))} kt` : '—';
}

export function fmtUtc(ms) {
  if (!Number.isFinite(Number(ms)) || !ms) return '—';
  return new Date(Number(ms)).toISOString().slice(11, 16) + 'Z';
}

export function fmtDateUtc(ms) {
  if (!Number.isFinite(Number(ms)) || !ms) return '—';
  const d = new Date(Number(ms));
  return `${d.toISOString().slice(0, 10)}`;
}

export function fmtMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0) return '—';
  const total = Math.round(n);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

export function fmtAge(timestamp, now = Date.now()) {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || t <= 0) return 'unknown time';
  const minutes = Math.max(0, Math.round((now - t) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/* ── preferences ─────────────────────────────────────────────────────── */

export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch (_) {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch) {
  const next = { ...loadPrefs(), ...(patch || {}) };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
  return next;
}

/* ── the current plan ────────────────────────────────────────────────── */

/**
 * Flight Deck route points, as the map stored them. The planned level and the
 * procedure a point came from travel with it: the Navigator prints both, and
 * dropping them here would make a planned SID look like an ordinary fix.
 */
export function loadRoute() {
  const shape = p => ({
    id: String(p.id || '').toUpperCase(),
    name: String(p.name || p.id || ''),
    lat: Number(p.lat),
    lon: Number(p.lon),
    kind: p.kind || p.k || 'fix',
    elev: Number.isFinite(Number(p.elev)) ? Number(p.elev) : 0,
    altFt: Number.isFinite(Number(p.altFt)) && Number(p.altFt) > 0 ? Number(p.altFt) : null,
    ss: String(p.ss || ''),
    aw: String(p.aw || ''),
  });
  const usable = p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon));
  try {
    const raw = JSON.parse(localStorage.getItem('stratos.activeRoute') || 'null');
    const points = raw && Array.isArray(raw.points) ? raw.points : null;
    if (points && points.length) return points.filter(usable).map(shape);
  } catch (_) { /* fall through */ }
  try {
    const legacy = JSON.parse(localStorage.getItem('dl.route') || 'null');
    if (Array.isArray(legacy)) return legacy.filter(usable).map(shape);
  } catch (_) { /* no route */ }
  return [];
}

/** Name and cruise figures stored beside the points, or empty defaults. */
export function loadRouteMeta() {
  try {
    const raw = JSON.parse(localStorage.getItem('stratos.activeRoute') || 'null');
    if (raw && typeof raw === 'object') {
      return {
        name: String(raw.name || ''),
        cruiseKts: Number(raw.cruiseKts) > 0 ? Number(raw.cruiseKts) : null,
        cruiseAlt: Number(raw.cruiseAlt) > 0 ? Number(raw.cruiseAlt) : null,
        plan: raw.plan && typeof raw.plan === 'object' ? raw.plan : null,
        id: raw.id || null,
      };
    }
  } catch (_) { /* nothing stored */ }
  return { name: '', cruiseKts: null, cruiseAlt: null, plan: null, id: null };
}

/* The point's symbol comes from the type SimBrief published. A point with no
   type is an airport only when its identifier is the plan's own departure or
   destination — never because of where it sits in the list. */
export function fixKind(fix, ofp) {
  const type = String((fix && fix.type) || '').toLowerCase();
  if (type === 'apt' || type === 'airport') return 'apt';
  if (type === 'vor' || type === 'ndb' || type === 'navaid' || type === 'dme' || type === 'vor/dme') return 'nav';
  const ident = String((fix && fix.ident) || '').toUpperCase();
  const origin = ofp && ofp.origin && ofp.origin.icao;
  const destination = ofp && ofp.destination && ofp.destination.icao;
  if (ident && (ident === origin || ident === destination)) return 'apt';
  return 'fix';
}

export function plannedRouteFromOfp(ofp) {
  if (!ofp || !Array.isArray(ofp.fixes) || ofp.fixes.length < 2) return [];
  return ofp.fixes
    .filter(fix => Number.isFinite(fix.lat) && Number.isFinite(fix.lon))
    .map(fix => ({
      id: fix.ident,
      name: fix.name || fix.ident,
      lat: fix.lat,
      lon: fix.lon,
      kind: fixKind(fix, ofp),
      altFt: Number.isFinite(Number(fix.altFt)) ? Number(fix.altFt) : null,
    }));
}

const planListeners = new Set();
let planCache = null;
let planFetch = null;

export function currentPlan() {
  if (planCache) return planCache;
  const stored = loadOfp(localStorage);
  planCache = {
    ofp: stored ? stored.ofp : null,
    simbriefId: loadSimbriefId(localStorage) || loadPrefs().simbriefId || '',
    fetchedAt: stored && stored.ofp ? stored.ofp.fetchedAt : null,
    error: '',
    busy: false,
  };
  return planCache;
}

export function onPlanChange(listener) {
  planListeners.add(listener);
  return () => planListeners.delete(listener);
}

function publishPlan() {
  planCache = { ...planCache };
  for (const listener of planListeners) {
    try { listener(planCache); } catch (_) { /* one app must not break the others */ }
  }
}

/**
 * Fetch the pilot's latest SimBrief plan and store it where the tracker expects
 * it, so the Flight Deck and the EFB share one import.
 */
export async function refreshPlan(id = '') {
  const entered = String(id || planCache?.simbriefId || loadSimbriefId(localStorage) || loadPrefs().simbriefId || '').trim();
  if (!entered) {
    planCache = { ...(planCache || currentPlan()), error: 'Enter your SimBrief Pilot ID in EFB Settings first.', busy: false };
    publishPlan();
    return planCache;
  }
  if (planFetch) return planFetch;
  planCache = { ...(planCache || currentPlan()), busy: true, error: '' };
  publishPlan();
  planFetch = (async () => {
    try {
      const plan = await fetchSimbriefPlan(entered);
      const ofp = plan && plan.ofp ? plan.ofp : null;
      if (!ofp) throw new Error('SimBrief returned a plan without an operational flight plan.');
      saveOfp(localStorage, ofp, entered);
      savePrefs({ simbriefId: entered });
      planCache = { ofp, simbriefId: entered, fetchedAt: ofp.fetchedAt || Date.now(), error: '', busy: false };
      publishPlan();
      return planCache;
    } catch (error) {
      planCache = {
        ...(planCache || currentPlan()),
        busy: false,
        error: error.name === 'TypeError'
          ? 'SimBrief could not be reached. Check the connection, then retry.'
          : error.message,
      };
      publishPlan();
      return planCache;
    } finally {
      planFetch = null;
    }
  })();
  return planFetch;
}

export function forgetPlan() {
  clearOfp(localStorage);
  try { localStorage.removeItem(OFP_STORAGE_KEY); } catch (_) { /* nothing stored */ }
  planCache = { ofp: null, simbriefId: loadSimbriefId(localStorage) || '', fetchedAt: null, error: '', busy: false };
  publishPlan();
}

/* ── airports ────────────────────────────────────────────────────────── */

let directoryPromise = null;
let directory = [];

export async function airportDirectory() {
  if (directory.length) return directory;
  if (!directoryPromise) {
    directoryPromise = loadDirectory(isHostedPage() ? '' : defaultBridgeBase())
      .then(rows => { directory = Array.isArray(rows) ? rows : []; return directory; })
      .catch(() => { directory = []; return directory; });
  }
  return directoryPromise;
}

function localMatches(query, limit = 12) {
  const q = String(query || '').trim().toUpperCase();
  if (!q) return [];
  const scored = [];
  for (const airport of directory) {
    const id = String(airport.id || '').toUpperCase();
    const name = String(airport.name || '').toUpperCase();
    let score = 0;
    if (id === q) score = 100;
    else if (id.startsWith(q)) score = 80;
    else if (name.startsWith(q)) score = 55;
    else if (id.includes(q)) score = 40;
    else if (name.includes(q)) score = 20;
    if (score) scored.push({ score, airport });
  }
  scored.sort((a, b) => b.score - a.score || a.airport.id.localeCompare(b.airport.id));
  return scored.slice(0, limit).map(row => row.airport);
}

/** Airports by ICAO/IATA/name, from the bridge directory or the hosted API. */
export async function searchAirports(query, limit = 12) {
  await airportDirectory();
  const local = localMatches(query, limit);
  if (local.length >= limit || String(query || '').trim().length < 2) return local;
  const hosted = isHostedPage() || location.port === '';
  if (!hosted && !isHostedPage()) {
    // The bridge also exposes the full OurAirports list at /airports.json,
    // which loadDirectory has already merged; nothing more to ask for.
    return local;
  }
  try {
    const response = await fetch(`/api/ourairports?q=${encodeURIComponent(query)}&limit=${limit}`, { cache: 'no-store' });
    if (!response.ok) return local;
    const payload = await response.json();
    const seen = new Set(local.map(a => a.id));
    const extra = (payload.results || [])
      .filter(row => row && row.ident && !seen.has(row.ident.toUpperCase()))
      .map(row => ({
        id: String(row.ident).toUpperCase(),
        name: String(row.name || row.ident),
        lat: Number(row.lat),
        lon: Number(row.lon),
        elev: Number(row.elev) || 0,
        source: 'ourairports',
      }));
    return [...local, ...extra].slice(0, limit);
  } catch (_) {
    return local;
  }
}

export async function airportByCode(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  await airportDirectory();
  const found = directory.find(a => String(a.id || '').toUpperCase() === wanted);
  if (found) return found;
  const results = await searchAirports(wanted, 4);
  return results.find(a => String(a.id).toUpperCase() === wanted) || null;
}

/**
 * The magnetic heading a runway designator stands for: 03L is 030, 17 is 170.
 * A designator carrying a parallel suffix still has a heading; a designator with
 * no usable number has none, and null says so instead of 0 or NaN.
 */
function runwayHeading(designator) {
  const match = String(designator == null ? '' : designator).trim().match(/^(\d{1,2})/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 1 && value <= 36 ? value * 10 : null;
}

export function airportRunways(airport) {
  if (!airport) return [];
  if (Array.isArray(airport.rws) && airport.rws.length) {
    return airport.rws
      .filter(row => Array.isArray(row) && row.length >= 6)
      .map(row => ({
        id: `${row[0]}/${row[1]}`,
        heading: runwayHeading(row[0]),
        lengthFt: Number(row[6]) || null,
        widthFt: Number(row[7]) || null,
        surface: row[8] || '',
        verified: true,
      }));
  }
  const designators = Array.isArray(airport.rw) ? airport.rw : [];
  const lengths = Array.isArray(airport.len) ? airport.len : [];
  return designators.map((number, index) => ({
    id: `${String(number).padStart(2, '0')}/${String(Number(number) <= 18 ? Number(number) + 18 : Number(number) - 18).padStart(2, '0')}`,
    heading: runwayHeading(number),
    lengthFt: Number(lengths[index]) || null,
    widthFt: null,
    surface: '',
    verified: false,
  }));
}

export function airportFrequencies(airport) {
  const fqs = airport && airport.fqs;
  if (!fqs || typeof fqs !== 'object') return [];
  return Object.entries(fqs)
    .filter(([, value]) => value)
    .map(([key, value]) => ({ label: key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim(), value: String(value) }));
}

export async function nearestAirport(lat, lon) {
  const { nearbyAirports } = await import('../data/airports.js');
  return nearbyAirports(lat, lon, 1, 400)[0] || null;
}

/* ── weather ─────────────────────────────────────────────────────────── */

const weatherCache = new Map();
const WEATHER_TTL = 5 * 60 * 1000;

export async function weatherFor(code, { force = false } = {}) {
  const icao = String(code || '').trim().toUpperCase();
  if (!icao) return { error: 'No station given.' };
  const hit = weatherCache.get(icao);
  if (!force && hit && Date.now() - hit.fetchedAt < WEATHER_TTL) return hit;
  const urls = [];
  if (!isHostedPage()) urls.push(`${defaultBridgeBase().replace(/\/+$/, '')}/weather?icao=${encodeURIComponent(icao)}`);
  urls.push(`/api/weather?icao=${encodeURIComponent(icao)}`);
  let lastError = 'Weather is unavailable.';
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(url, {
        credentials: location.protocol === 'file:' ? 'omit' : 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) { lastError = `The weather service answered ${response.status}.`; continue; }
      const data = await response.json();
      if (!data || (!data.metar && !data.taf)) { lastError = 'No METAR or TAF is published for this station.'; continue; }
      const record = {
        ...data,
        icao,
        fetchedAt: Number(data.fetchedAt) || Date.now(),
        source: data.source || 'NOAA Aviation Weather Center',
      };
      weatherCache.set(icao, record);
      return record;
    } catch (error) {
      lastError = error.name === 'AbortError' ? 'The weather request timed out.' : error.message;
    }
  }
  return { icao, error: lastError, fetchedAt: null };
}

export async function windsAloft(fcst = '06') {
  try {
    // Winds aloft is the NOAA text table, checked and served as text by the API.
    const response = await fetch(`/api/winds?fcst=${encodeURIComponent(fcst)}`, { cache: 'no-store' });
    const body = await response.text();
    if (!response.ok) {
      let message = `Winds aloft answered ${response.status}.`;
      try {
        const payload = JSON.parse(body);
        message = payload.message || payload.error || message;
      } catch (_) { /* the error body was not JSON */ }
      return { error: message };
    }
    const { parseWindsAloft } = await import('../lib/windsaloft.js');
    return parseWindsAloft(body);
  } catch (error) {
    return { error: error.message };
  }
}

/* ── charts ──────────────────────────────────────────────────────────── */

export function chartSourcesFor(icao) {
  return officialSourcesFor(icao);
}

/* normaliseCatalogue answers with the chart records themselves; the EFB view
   wants them on a catalogue object that also carries the cycle the documents
   belong to, so the validity window and the source line can be shown. */
export function catalogueFromPayload(payload, icao) {
  const charts = normaliseCatalogue(payload, icao);
  if (!Array.isArray(charts) || !charts.length) return null;
  const data = payload && typeof payload === 'object' ? payload : {};
  return {
    icao: String(icao || data.icao || '').trim().toUpperCase(),
    cycle: data.cycle || null,
    effective: data.effective,
    expires: data.expires,
    checkedAt: data.checkedAt,
    source: data.source,
    sourceName: data.sourceName,
    charts,
  };
}

export async function loadChartCatalogue(icao) {
  const code = String(icao || '').trim().toUpperCase();
  const coverage = chartCoverage(code);
  if (!code) return { ok: false, error: 'Choose an airport.', coverage };
  if (!coverage.integrated) {
    return { ok: false, unsupported: true, coverage, sources: chartSourcesFor(code) };
  }
  const candidates = [];
  if (!isHostedPage()) candidates.push(`${defaultBridgeBase().replace(/\/+$/, '')}/charts?icao=${encodeURIComponent(code)}`);
  candidates.push(`/api/charts?icao=${encodeURIComponent(code)}`);
  let lastError = 'No chart catalogue was returned.';
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (response.status === 404) {
        const payload = await response.json().catch(() => ({}));
        return { ok: false, coverage, error: payload.message || 'No published charts were found for this airport.', sources: chartSourcesFor(code) };
      }
      if (!response.ok) { lastError = `The chart source answered ${response.status}.`; continue; }
      const payload = await response.json();
      const catalogue = catalogueFromPayload(payload, code);
      if (!catalogue) {
        return { ok: false, coverage, error: 'The catalogue was empty for this airport.', sources: chartSourcesFor(code) };
      }
      return { ok: true, coverage, catalogue, groups: groupCharts(catalogue.charts), sources: chartSourcesFor(code), source: payload.source || 'FAA d-TPP' };
    } catch (error) {
      lastError = error.name === 'AbortError' ? 'The chart catalogue request timed out.' : error.message;
    }
  }
  return { ok: false, coverage, error: lastError, sources: chartSourcesFor(code) };
}

export function filterCharts(charts, query) {
  return searchCharts(charts || [], query);
}

/* ── live telemetry ──────────────────────────────────────────────────── */

const liveState = {
  status: 'offline',
  detail: '',
  health: null,
  snapshot: null,
  base: defaultBridgeBase(),
  started: false,
  client: null,
};

const liveListeners = new Set();

export function liveSnapshot() {
  if (!liveState.snapshot) return null;
  return liveState.snapshot;
}

export function liveStatus() {
  return { status: liveState.status, detail: liveState.detail, health: liveState.health, snapshot: liveState.snapshot };
}

export function onLive(listener) {
  liveListeners.add(listener);
  ensureLive();
  listener(liveStatus());
  return () => liveListeners.delete(listener);
}

function publishLive() {
  for (const listener of liveListeners) {
    try { listener(liveStatus()); } catch (_) { /* isolate apps */ }
  }
}

async function refreshHealth() {
  try {
    liveState.health = await bridgeHealth(liveState.base, 2500);
    liveState.base = defaultBridgeBase();
    if (liveState.status !== 'live') {
      liveState.status = liveState.health && liveState.health.simulator && liveState.health.simulator.connected ? 'connecting' : 'waiting';
      liveState.detail = liveState.health
        ? (liveState.health.simulator && liveState.health.simulator.connected ? 'Bridge connected, waiting for telemetry' : 'Bridge running, simulator not detected')
        : '';
    }
  } catch (error) {
    liveState.health = null;
    if (liveState.status !== 'live') {
      liveState.status = 'offline';
      // "Failed to fetch" is the browser's words, not an explanation a pilot can
      // act on. A network-level failure means the bridge is not answering here.
      const raw = String((error && error.message) || '');
      const network = !raw || /failed to fetch|networkerror|load failed|terminated/i.test(raw);
      liveState.detail = isHostedPage()
        ? 'This hosted page cannot reach the bridge directly. Open the Flight Deck on the PC or use the phone relay.'
        : network
          ? `The bridge did not answer at ${liveState.base}. Make sure Stratos is running on this PC.`
          : raw;
    }
  }
  publishLive();
}

export function ensureLive() {
  if (liveState.started) return liveState;
  liveState.started = true;
  const mode = detectResourceMode();
  liveState.client = new TelemetryClient({
    base: liveState.base,
    mode,
    onTelemetry: message => {
      const parsed = message && (message.telemetry || (message.raw ? parseTelemetry(message.raw) : null));
      liveState.snapshot = { ...message, telemetry: parsed || null, parsed: parsed || null, receivedAt: Date.now() };
      // A bridge snapshot without a usable position is not live tracking: the
      // simulator may be loaded but sitting on a menu. Say so instead of placing
      // the aircraft at 0,0.
      if (parsed) {
        liveState.status = 'live';
        liveState.detail = '';
      } else if (liveState.status !== 'live') {
        liveState.status = 'waiting';
        liveState.detail = 'The bridge is running but the simulator has not reported a position.';
      }
      publishLive();
    },
    onStatus: status => {
      if (status.state === 'connected') {
        liveState.status = 'live';
      } else if (status.state === 'connecting' || status.state === 'reconnecting') {
        // A retry loop against a bridge that is not there is offline, not
        // connecting: the health check is what decides, not the socket attempt.
        if (liveState.health) {
          liveState.status = 'connecting';
          liveState.detail = status.detail || 'Reconnecting…';
        } else {
          liveState.status = 'offline';
          liveState.detail = status.detail || 'The bridge is not reachable.';
        }
      } else {
        liveState.status = 'offline';
        liveState.detail = status.detail || 'The telemetry stream is closed.';
        liveState.snapshot = null;
      }
      publishLive();
    },
  });
  liveState.client.connect();
  refreshHealth();
  setInterval(() => {
    if (liveState.status === 'live' && liveState.snapshot && Date.now() - liveState.snapshot.receivedAt > 15000) {
      liveState.status = 'connecting';
      liveState.detail = 'No telemetry for 15 s.';
      publishLive();
    }
  }, 5000).unref?.();
  setInterval(refreshHealth, 30000).unref?.();
  window.addEventListener('online', () => {
    liveState.client?.connect();
    refreshHealth();
  });
  return liveState;
}

export function liveMode() {
  return detectResourceMode();
}

export function liveProfile() {
  return getResourceProfile(liveMode());
}

export function connectionText(status) {
  switch (status) {
    case 'live': return 'Connected';
    case 'connecting': return 'Connecting';
    case 'waiting': return 'Waiting for sim';
    default: return 'Offline';
  }
}

/* ── flight phase ────────────────────────────────────────────────────── */

/* The bridge records a phase for the flight it is logging. A page opened
   before recording starts, or a track that is only being watched, has
   telemetry but no flight record — the phase is then read from the position
   itself (on the ground, climbing, descending) and marked as derived rather
   than presented as something the aircraft reported. */
const PHASE_LABELS = {
  PARKED: 'Parked',
  TAXI: 'Taxiing',
  TAKEOFF: 'Takeoff',
  CLIMB: 'Climb',
  CRUISE: 'Cruise',
  LEVEL: 'Level',
  DESCENT: 'Descent',
  APPROACH: 'Approach',
  AIRBORNE: 'Airborne',
  LANDED: 'Landed',
  COMPLETE: 'Complete',
};

export function phaseLabel(code) {
  if (!code) return '';
  return PHASE_LABELS[code] || String(code);
}

/** The phase to show, or null when there is no position to read one from. */
export function flightPhase(message) {
  const t = message && message.telemetry;
  if (!t) return null;
  const recorded = message.currentFlight && message.currentFlight.phase;
  if (recorded) return { code: String(recorded), label: phaseLabel(recorded), derived: false };

  const gs = Number.isFinite(Number(t.gs)) ? Number(t.gs) : 0;
  const vs = Number.isFinite(Number(t.vs)) ? Number(t.vs) : 0;
  const agl = Number.isFinite(Number(t.agl)) ? Number(t.agl) : null;
  const alt = Number.isFinite(Number(t.alt)) ? Number(t.alt) : null;
  const derive = code => ({ code, label: phaseLabel(code), derived: true });

  if (t.onGround) {
    if (gs < 2) return derive('PARKED');
    if (gs < 40) return derive('TAXI');
    return derive('TAKEOFF');
  }
  if (vs > 200) return derive('CLIMB');
  if (vs < -200) return derive(agl != null && agl <= 3000 ? 'APPROACH' : 'DESCENT');
  // Level at a low height is not cruise, however steady the altitude is.
  return derive(agl != null && agl <= 3000 ? 'LEVEL' : 'CRUISE');
}
