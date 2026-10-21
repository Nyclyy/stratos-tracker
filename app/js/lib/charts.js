/* Chart catalogue.
 *
 * One supported source today: the FAA Digital Terminal Procedures Publication
 * (d-TPP). The publication is a U.S. Government work (public domain) and is
 * published every 28 days. Nothing here invents a chart: an airport without
 * published charts gets an empty list, and a document whose cycle has expired
 * is reported as expired rather than "current".
 *
 * The module is pure so both the browser and the hosted API can use the same
 * classification rules, and the tests can drive it with a captured metafile.
 */

export const FAA_SOURCE = {
  id: 'faa-dtpp',
  name: 'FAA Digital Terminal Procedures',
  publisher: 'Federal Aviation Administration',
  license: 'U.S. Government work — public domain',
  terms: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/',
  redistributable: true,
};

export const FAA_BASE = 'https://aeronav.faa.gov/d-tpp';

/* Cycle 2601 took effect on 2026-01-22 (09:01Z). Each cycle is 28 days, and the
   cycle code is the year followed by the sequence number inside that year. The
   code below is only a *guess*: every import verifies it against the official
   metafile, which carries its own cycle attribute and effective dates. */
export const CYCLE_EPOCH = Date.UTC(2026, 0, 22, 9, 1);
export const CYCLE_DAYS = 28;

const DAY = 86400000;

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Cycle code ("2610") for a date, derived from the 2026-01-22 anchor. */
export function faaCycle(date = Date.now()) {
  const index = Math.floor((toMs(date) - CYCLE_EPOCH) / (CYCLE_DAYS * DAY));
  const start = new Date(CYCLE_EPOCH + index * CYCLE_DAYS * DAY);
  const year = start.getUTCFullYear();
  let first = index;
  for (let step = 0; step < 60; step++) {
    const previous = new Date(CYCLE_EPOCH + (first - 1) * CYCLE_DAYS * DAY);
    if (previous.getUTCFullYear() !== year) break;
    first--;
  }
  return `${String(year).slice(-2)}${String(index - first + 1).padStart(2, '0')}`;
}

/** Start of a cycle, or null when the code cannot be interpreted. */
export function cycleStart(cycle, now = Date.now()) {
  const code = String(cycle || '').trim();
  if (!/^\d{4}$/.test(code)) return null;
  let index = Math.floor((toMs(now) - CYCLE_EPOCH) / (CYCLE_DAYS * DAY));
  // Walk outwards from the current cycle until the code matches, so a stale or
  // upcoming cycle is still placed on the right date.
  for (let step = 0; step <= 60; step++) {
    for (const candidate of step ? [index - step, index + step] : [index]) {
      const start = new Date(CYCLE_EPOCH + candidate * CYCLE_DAYS * DAY);
      if (faaCycle(start) === code) return start.getTime();
    }
  }
  return null;
}

/** ISO timestamp of the end of a cycle (the next cycle's start). */
export function cycleEnd(cycle, now = Date.now()) {
  const start = cycleStart(cycle, now);
  return start == null ? null : start + CYCLE_DAYS * DAY;
}

/** Parse the FAA's "0901Z  10/01/26" effective-date format to epoch ms. */
export function parseFaaDate(value) {
  const raw = String(value || '').trim();
  // A whole day, used by a record's amendment date: "12/05/2019".
  const day = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (day) return Date.UTC(Number(day[3]), Number(day[1]) - 1, Number(day[2]));
  // A publication window: "0901Z  10/01/26" (HHMMZ, not HH:MMZ).
  const match = /(\d{2})(\d{2})Z\s+(\d{2})\/(\d{2})\/(\d{2})/.exec(raw);
  if (!match) return null;
  const [, hh, mm, month, date, year] = match;
  return Date.UTC(2000 + Number(year), Number(month) - 1, Number(date), Number(hh), Number(mm));
}

const CATEGORY_ORDER = ['diagram', 'sid', 'star', 'approach', 'odp', 'minimums', 'hotspot', 'supplement', 'other'];

const CATEGORY_LABELS = {
  diagram: 'Airport diagrams',
  sid: 'Departures (SID)',
  star: 'Arrivals (STAR)',
  approach: 'Instrument approaches',
  odp: 'Obstacle departures',
  minimums: 'Minimums',
  hotspot: 'Hot spots',
  supplement: 'Supplementary documents',
  other: 'Other documents',
};

/** Category for one FAA chart_code. Unknown codes stay visible, never guessed. */
export function classifyChart(code) {
  switch (String(code || '').trim().toUpperCase()) {
    case 'APD': return { key: 'diagram', label: CATEGORY_LABELS.diagram };
    case 'DP': return { key: 'sid', label: CATEGORY_LABELS.sid };
    case 'STR': return { key: 'star', label: CATEGORY_LABELS.star };
    case 'IAP': return { key: 'approach', label: CATEGORY_LABELS.approach };
    case 'ODP': return { key: 'odp', label: CATEGORY_LABELS.odp };
    case 'MIN': return { key: 'minimums', label: CATEGORY_LABELS.minimums };
    case 'HOT': return { key: 'hotspot', label: CATEGORY_LABELS.hotspot };
    case 'LAH':
    case 'DAU': return { key: 'supplement', label: CATEGORY_LABELS.supplement };
    default: return { key: 'other', label: CATEGORY_LABELS.other };
  }
}

export function categoryLabel(key) {
  return CATEGORY_LABELS[key] || CATEGORY_LABELS.other;
}

export function categoryRank(key) {
  const index = CATEGORY_ORDER.indexOf(key);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/** Approach family from the published procedure name, or null when unknown. */
export function approachType(title) {
  const name = String(title || '').toUpperCase();
  if (!name) return null;
  const ils = /\bILS\b/.test(name);
  const loc = /\bLOC\b|\bLOCALIZER\b/.test(name);
  if (ils && loc) return 'ILS/LOC';
  if (ils) return 'ILS';
  if (loc) return 'LOC';
  // "VOR OR GPS" and "NDB OR GPS" are ground-based approaches that also use
  // GPS, so the ground aid is checked before the satellite one.
  if (/\bVOR\b/.test(name)) return 'VOR';
  if (/\bNDB\b/.test(name)) return 'NDB';
  if (/\bRNAV\b|\bGPS\b|\bRNP\b/.test(name)) return 'RNAV';
  if (/\bVISUAL\b|\bVIS\b/.test(name)) return 'Visual';
  return null;
}

/**
 * Charts that need no licence: ILS and localiser approaches.
 *
 * The FAA titles them "ILS RWY 28L", "ILS OR LOC RWY 04R", "LOC/DME RWY 22L"
 * or "ILS PRM ...". A localiser-only procedure is free for the same reason an
 * ILS is: the app's product rule is that lateral-guidance approaches stay open
 * to every pilot. Diagrams, SIDs, STARs and every other approach stay Premium.
 *
 * The FAA documents are public-domain government data either way — the gate is
 * a product decision, not a licence restriction.
 */
export function isFreeChart(chart) {
  if (!chart || chart.category !== 'approach') return false;
  if (chart.approach === 'ILS' || chart.approach === 'LOC' || chart.approach === 'ILS/LOC') return true;
  // A source may omit the family; the published title is then the authority.
  return /\bILS\b|\bLOC\b|\bLOCALIZER\b/.test(String(chart.title || '').toUpperCase());
}

/** 'free' | 'premium' — the single classification every surface should show. */
export function accessLevel(chart) {
  return isFreeChart(chart) ? 'free' : 'premium';
}

/**
 * Whether this entitlement may open the chart. A verified Premium licence
 * opens everything; otherwise only ILS/LOC procedures are available.
 */
export function canOpenChart(chart, premium = false) {
  return Boolean(premium) || isFreeChart(chart);
}

/** Runway identifiers mentioned by a procedure title ("ILS RWY 28L"). */
export function runwaysInTitle(title) {
  const found = [];
  const text = String(title || '').toUpperCase();
  const pattern = /\bRWY\s+(\d{1,2})([LRC]?)\b/g;
  let match;
  while ((match = pattern.exec(text))) {
    const runway = `${match[1].padStart(2, '0')}${match[2]}`;
    if (!found.includes(runway)) found.push(runway);
  }
  return found;
}

function attributeMap(source) {
  const map = {};
  for (const match of String(source || '').matchAll(/([a-z_]+)="([^"]*)"/g)) map[match[1]] = match[2];
  return map;
}

function tagText(body, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return match ? match[1].trim() : '';
}

/** Records of one <airport_name> element. */
export function parseFaaRecords(blockXml) {
  const records = [];
  for (const match of String(blockXml || '').matchAll(/<record>([\s\S]*?)<\/record>/g)) {
    const body = match[1];
    const code = tagText(body, 'chart_code');
    const title = tagText(body, 'chart_name');
    const pdf = tagText(body, 'pdf_name');
    if (!pdf) continue;
    records.push({
      code,
      title,
      pdf,
      amended: tagText(body, 'amdtdate') || null,
      procedure: tagText(body, 'procuid') || null,
    });
  }
  return records;
}

/** Header of the metafile: cycle code plus the publication window. */
export function parseMetafileHeader(xml) {
  const source = String(xml || '');
  const header = /<digital_tpp\b([^>]*)>/.exec(source);
  if (!header) return { cycle: '', from: null, to: null };
  const attributes = attributeMap(header[1]);
  return {
    cycle: attributes.cycle || '',
    from: parseFaaDate(attributes.from_edate),
    to: parseFaaDate(attributes.to_edate),
  };
}

/** One airport block from the metafile, matched by ICAO or local identifier. */
export function parseFaaAirport(xml, icao) {
  const wanted = normalizeIcao(icao);
  if (!wanted) return null;
  const pattern = /<airport_name\b([^>]*)>([\s\S]*?)<\/airport_name>/g;
  let match;
  while ((match = pattern.exec(String(xml || '')))) {
    const attributes = attributeMap(match[1]);
    const local = String(attributes.apt_ident || '').toUpperCase();
    const international = String(attributes.icao_ident || '').toUpperCase();
    const candidates = [international, local, local ? `K${local}` : '', local ? `P${local}` : ''].filter(Boolean);
    if (!candidates.includes(wanted)) continue;
    return {
      icao: normalizeIcao(attributes.icao_ident) || wanted,
      local,
      name: String(attributes.ID || '').trim(),
      records: parseFaaRecords(match[2]),
    };
  }
  return null;
}

export function normalizeIcao(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{2}$/.test(code) ? code : '';
}

export function chartId(chart) {
  return `${chart.icao}:${chart.code}:${chart.pdf}`;
}

/**
 * Normalise a source record to the catalogue shape. Every field has a defined
 * meaning; a field the source did not supply stays null and the UI says so.
 */
export function toChart(record, context = {}) {
  const category = classifyChart(record.code);
  const icao = normalizeIcao(context.icao) || '';
  const title = String(record.title || '').trim();
  const cycle = String(context.cycle || '');
  const chart = {
    id: '',
    icao,
    code: String(record.code || '').trim().toUpperCase(),
    category: category.key,
    categoryLabel: category.label,
    title,
    procedure: record.procedure || null,
    approach: category.key === 'approach' ? approachType(title) : null,
    runways: runwaysInTitle(title),
    pdf: String(record.pdf || '').trim().toUpperCase(),
    source: context.source || FAA_SOURCE.id,
    sourceName: context.sourceName || FAA_SOURCE.name,
    provider: context.provider || context.source || FAA_SOURCE.id,
    format: 'PDF',
    retrieval: context.retrieval || 'faa-cycle',
    cycle: cycle || null,
    effective: Number.isFinite(context.effective) ? context.effective : null,
    expires: Number.isFinite(context.expires) ? context.expires : null,
    amended: record.amended ? parseFaaDate(record.amended) : null,
    checkedAt: Number.isFinite(context.checkedAt) ? context.checkedAt : null,
    url: cycle && record.pdf ? officialChartUrl(cycle, record.pdf) : null,
  };
  chart.id = chartId(chart);
  return chart;
}

export function officialChartUrl(cycle, pdf) {
  if (!/^\d{4}$/.test(String(cycle || '')) || !/^[A-Z0-9]{1,12}\.PDF$/i.test(String(pdf || ''))) return null;
  return `${FAA_BASE}/${cycle}/${String(pdf).toUpperCase()}`;
}

/** Normalise a whole API payload (bridge or hosted) into catalogue records. */
export function normaliseCatalogue(payload, icao) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const charts = Array.isArray(data.charts) ? data.charts : [];
  const context = {
    icao: data.icao || icao,
    cycle: data.cycle,
    effective: data.effective,
    expires: data.expires,
    checkedAt: data.checkedAt,
    sourceName: data.sourceName,
    source: data.source,
    provider: data.provider,
    retrieval: data.retrieval,
  };
  return charts
    .map(record => toChart(record, context))
    .filter(chart => chart.pdf && chart.icao)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.title.localeCompare(b.title));
}

/** Charts grouped by category, in publication order. Unknown codes are kept. */
export function groupCharts(charts) {
  const groups = new Map();
  for (const chart of charts || []) {
    const key = chart.category || 'other';
    if (!groups.has(key)) groups.set(key, { key, label: categoryLabel(key), charts: [] });
    groups.get(key).charts.push(chart);
  }
  return [...groups.values()].sort((a, b) => categoryRank(a.key) - categoryRank(b.key));
}

/** Filter by chart title, category, or procedure/runway text. */
export function searchCharts(charts, query) {
  const term = String(query || '').trim().toUpperCase();
  if (!term) return charts || [];
  return (charts || []).filter(chart => {
    const haystack = [chart.title, chart.code, chart.categoryLabel, chart.approach, ...(chart.runways || [])]
      .filter(Boolean).join(' ').toUpperCase();
    return haystack.includes(term);
  });
}

/** 'current' | 'expired' | 'unverified'. Never assumes a chart is valid. */
export function validityState(chart, now = Date.now()) {
  const raw = chart && chart.expires != null ? Number(chart.expires) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return 'unverified';
  return toMs(now) < raw ? 'current' : 'expired';
}

/** Plain-language validity line for the viewer. */
export function validityText(chart, now = Date.now()) {
  const state = validityState(chart, now);
  if (state === 'expired') return 'This publication cycle has expired — check the current source before use.';
  if (state === 'unverified') return 'Validity could not be verified: the source did not supply an effective window.';
  return 'Current publication cycle.';
}

/** True when the bytes carry a PDF header. A local file is never trusted blindly. */
export function isPdfBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/** Cache key for a downloaded chart document. */
export function chartCacheKey(chart) {
  return `faa:${chart.cycle || 'unknown'}:${chart.pdf}`;
}

/* ── local document cache ────────────────────────────────────────────────
   One small IndexedDB database of its own, so the logbook schema and its
   migrations are untouched. Entries are dropped by age and count. */

const CACHE_DB = 'stratos_charts';
const CACHE_STORE = 'documents';
const CACHE_MAX_ENTRIES = 40;
const CACHE_MAX_AGE = 30 * DAY;

let cachePromise = null;

export function openChartCache() {
  if (cachePromise) return cachePromise;
  cachePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available.')); return; }
    const request = indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) {
        database.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the chart cache.'));
  }).catch(error => {
    cachePromise = null;
    throw error;
  });
  return cachePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readChartCache(key, now = Date.now()) {
  try {
    const db = await openChartCache();
    const row = await requestResult(db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key));
    if (!row || !row.bytes) return null;
    if (now - Number(row.at || 0) > CACHE_MAX_AGE) return null;
    return row;
  } catch (_) {
    return null;
  }
}

export async function writeChartCache(key, bytes, now = Date.now()) {
  try {
    const db = await openChartCache();
    const store = db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE);
    await requestResult(store.put({ key, bytes, at: now, size: bytes.byteLength || bytes.length || 0 }));
    const rows = await requestResult(store.getAll());
    const excess = rows
      .filter(row => now - Number(row.at || 0) > CACHE_MAX_AGE)
      .concat(
        rows
          .filter(row => now - Number(row.at || 0) <= CACHE_MAX_AGE)
          .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
          .slice(CACHE_MAX_ENTRIES),
      );
    for (const row of excess) store.delete(row.key);
    return true;
  } catch (_) {
    return false;
  }
}

/** Total bytes held by the cache, for the Data & Performance page. */
export async function chartCacheSize() {
  try {
    const db = await openChartCache();
    const rows = await requestResult(db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).getAll());
    return rows.reduce((sum, row) => sum + Number(row.size || 0), 0);
  } catch (_) {
    return 0;
  }
}

export async function clearChartCache() {
  try {
    const db = await openChartCache();
    await requestResult(db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE).clear());
    return true;
  } catch (_) {
    return false;
  }
}
