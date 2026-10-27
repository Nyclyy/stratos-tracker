/* Points near a place: the real navigation data the map draws and names.
 *
 * Two sources, kept separate because they answer for different parts of the
 * world and are licensed differently:
 *
 *   published  airports and radio navaids from OurAirports (CC0). The bridge
 *              serves the worldwide list; the bundled snapshot answers offline.
 *   simulator  fixes and radio navaids from the simulator's own nav data, read
 *              by the bridge on the pilot's PC (Navigraph/Jeppesen, licensed to
 *              that pilot, never bundled). Only the bridge can supply these.
 *
 * A query is a true great-circle radius search: a one-degree grid narrows the
 * candidates, then every candidate is measured with the haversine formula. The
 * radius is a distance in nautical miles, never a count of cells or pixels, so
 * a 40 NM ring draws at the same real size at every latitude.
 *
 * Nothing here invents a point. When no real record is within the search radius
 * the answer is an empty list, and it says which sources were consulted.
 */

import { distanceNm, validLatLon } from './geo.js';

export const DEFAULT_RADIUS_NM = 40;
export const MAX_RADIUS_NM = 600;

export const NO_DATA_NOTE = 'No navigation data is loaded: connect the bridge, or open a page that loads the airport directory.';
const COVERED_NOTE = 'Airports and the worldwide navaid set come from OurAirports (CC0). Fixes come from the simulator\'s own nav data when the bridge is connected.';

/** Grid cell size. One degree of latitude is 60 NM, so a 40 NM query spans two cells. */
const CELL = 1;

function key(lat, lon) {
  const latCell = Math.floor(lat / CELL);
  const lonCell = Math.floor((((lon + 180) % 360) + 360) % 360 - 180);
  return `${latCell}:${lonCell}`;
}

function cellsAround(lat, lon, nm) {
  const span = Math.ceil(nm / 60 / CELL) + 1;
  const latBase = Math.floor(lat / CELL);
  const lonBase = Math.floor(lon / CELL);
  const out = [];
  for (let dLat = -span; dLat <= span; dLat++) {
    const latCell = latBase + dLat;
    if (latCell < -90 / CELL || latCell > 90 / CELL) continue;
    for (let dLon = -span; dLon <= span; dLon++) {
      const lonCell = ((lonBase + dLon + 180) % 360) - 180;
      out.push(`${latCell}:${lonCell}`);
    }
  }
  return out;
}

/** One identifier per place: a VOR and its co-located DME are one station. */
function samePoint(a, b) {
  return String(a.id).toUpperCase() === String(b.id).toUpperCase()
    && distanceNm(a, b) < 1.5;
}

export class NavPointIndex {
  constructor() {
    this.published = [];   // airports and navaids from OurAirports
    this.simulator = [];   // fixes and navaids from the simulator's nav data
    this.index = [];       // published plus simulator, in grid order
    this.grid = new Map();
    this.publishedAt = 0;
    this.coverage = {
      airports: 0,
      navaids: 0,
      fixes: 0,
      sources: [],
      note: NO_DATA_NOTE,
    };
  }

  /**
   * Replace the published set. Rows are OurAirports-shaped records; a row
   * without usable coordinates or an identifier is dropped rather than drawn
   * at a guessed position.
   */
  setPublished(airports = [], navaids = []) {
    const rows = [];
    const push = (row, kind) => {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      const id = String(row.id || row.ident || '').trim().toUpperCase();
      if (!id || !validLatLon(lat, lon)) return;
      rows.push({
        id,
        name: String(row.name || id),
        kind,
        type: kind === 'nav' ? String(row.type || row.kind || 'NAVAID').toUpperCase() : 'AIRPORT',
        lat,
        lon,
        elev: Number.isFinite(Number(row.elev)) ? Number(row.elev) : null,
        freq: String(row.freq || '').trim() || null,
        region: String(row.region || row.country || '').trim(),
        source: kind === 'nav' ? 'OurAirports navaids' : 'OurAirports airports',
      });
    };
    for (const airport of airports) push(airport, 'apt');
    for (const navaid of navaids) push(navaid, 'nav');
    this.published = rows;
    this.reindex();
    return this.published.length;
  }

  /**
   * The simulator points for the place the chart is looking at. These are
   * replaced, never accumulated: a fix belongs to a region, and a set left over
   * from a previous pan would draw the last place's fixes over this one.
   *
   * The bridge has already measured the radius, but every point is measured
   * again here against the caller's query, so what the page draws always comes
   * from one distance rule. A record the published set already holds is not
   * duplicated.
   */
  setSimulator(points = []) {
    const rows = Array.isArray(points) ? points : [];
    const next = [];
    for (const row of rows) {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      const id = String(row.id || '').trim().toUpperCase();
      if (!id || !validLatLon(lat, lon)) continue;
      const point = {
        id,
        name: String(row.name || id),
        kind: row.kind === 'apt' ? 'apt' : row.kind === 'fix' ? 'fix' : 'nav',
        type: String(row.type || '').toUpperCase(),
        lat,
        lon,
        elev: Number.isFinite(Number(row.elev)) ? Number(row.elev) : null,
        freq: row.freq ? String(row.freq) : null,
        region: String(row.region || ''),
        source: String(row.source || 'Simulator nav data'),
      };
      if (next.some(existing => samePoint(existing, point))) continue;
      if (this.published.some(existing => samePoint(existing, point))) continue;
      next.push(point);
    }
    this.simulator = next;
    this.reindex();
    return next.length;
  }

  reindex() {
    const grid = new Map();
    const all = this.all();
    all.forEach((point, position) => {
      const cell = key(point.lat, point.lon);
      const list = grid.get(cell);
      if (list) list.push(position);
      else grid.set(cell, [position]);
    });
    this.grid = grid;
    this.index = all;
    this.publishedAt = Date.now();
    const count = kind => all.filter(point => point.kind === kind).length;
    this.coverage = {
      airports: count('apt'),
      navaids: count('nav'),
      fixes: count('fix'),
      sources: [...new Set(all.map(point => point.source))].sort(),
      note: all.length ? COVERED_NOTE : NO_DATA_NOTE,
    };
  }

  all() {
    return [...this.published, ...this.simulator];
  }

  /**
   * Real points within `nm` great-circle of a position, nearest first.
   * `kinds` filters by record type without dropping anything from the search.
   */
  near(lat, lon, nm = DEFAULT_RADIUS_NM, { kinds = null, limit = 500 } = {}) {
    const center = { lat: Number(lat), lon: Number(lon) };
    if (!validLatLon(center.lat, center.lon) || !(nm > 0)) {
      return { ok: false, reason: 'bad-request', points: [], count: 0, coverage: this.coverage };
    }
    const radius = Math.min(Number(nm), MAX_RADIUS_NM);
    const found = [];
    const seen = new Set();
    for (const cell of cellsAround(center.lat, center.lon, radius)) {
      for (const position of this.grid.get(cell) || []) {
        const point = this.index[position];
        if (!point) continue;
        if (kinds && !kinds.includes(point.kind)) continue;
        const distance = distanceNm(center, point);
        if (distance > radius) continue;
        const dedupe = `${point.id}|${point.kind}|${Math.round(point.lat * 100)}|${Math.round(point.lon * 100)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        found.push({ ...point, distanceNm: Math.round(distance * 1000) / 1000 });
      }
    }
    found.sort((a, b) => a.distanceNm - b.distanceNm || a.id.localeCompare(b.id));
    return {
      ok: true,
      center: { lat: center.lat, lon: center.lon },
      radiusNm: radius,
      count: found.length,
      truncated: found.length > limit,
      points: found.slice(0, limit),
      coverage: this.coverage,
    };
  }

  /**
   * The real point a click should resolve to, plus any others close enough that
   * the pilot has to choose. `nm` is how far the click may reach for a record;
   * it is set by the caller from the chart's own scale, so a click at a wide
   * zoom does not silently grab a fix 30 NM away.
   */
  pick(lat, lon, nm = 5, { limit = 6 } = {}) {
    const answer = this.near(lat, lon, nm, { limit });
    if (!answer.ok || !answer.points.length) {
      return { ok: false, reason: 'nothing-nearby', radiusNm: nm, options: [], coverage: this.coverage };
    }
    const nearest = answer.points[0];
    // Anything within a quarter of a mile of the closest record is the same
    // place: two idents on one station are one choice, not two.
    const options = answer.points.filter(point => point.distanceNm <= Math.max(nearest.distanceNm + 0.25, 0.5));
    return {
      ok: true,
      point: nearest,
      options: options.length > 1 ? options : [nearest],
      radiusNm: nm,
      coverage: this.coverage,
    };
  }
}

/** The bridge's own nav-data answer for a position, or null when unavailable. */
export async function fetchNear(base, lat, lon, nm = DEFAULT_RADIUS_NM, { kinds = null, signal } = {}) {
  const root = String(base || '').replace(/\/+$/, '');
  if (!root) return null;
  const query = new URLSearchParams({ lat: String(lat), lon: String(lon), nm: String(nm) });
  if (kinds && kinds.length) query.set('kinds', kinds.join(','));
  try {
    const response = await fetch(`${root}/navdata/near?${query.toString()}`, { signal, cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && payload.ok ? payload : null;
  } catch (_) {
    return null;
  }
}

/**
 * A position written the way a pilot reads it: 47°27N 122°19W is 4727N12219W.
 * Used only for a point the pilot asked for by tapping empty chart, so a custom
 * coordinate can never be mistaken for a published fix.
 */
export function coordinateIdent(lat, lon) {
  const latValue = Number(lat);
  const lonValue = Number(lon);
  if (!validLatLon(latValue, lonValue)) return '';
  const half = value => {
    const total = Math.round(Math.abs(value) * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
  };
  return `${half(latValue)}${latValue >= 0 ? 'N' : 'S'}${half(lonValue)}${lonValue >= 0 ? 'E' : 'W'}`;
}

export function formatRadius(nm) {
  const value = Number(nm);
  if (!Number.isFinite(value)) return '—';
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} NM`;
}

/** A one-line statement of what the data covers, for the interface. */
export function coverageText(coverage) {
  if (!coverage || !coverage.sources || !coverage.sources.length) {
    return 'No navigation data loaded.';
  }
  const parts = [];
  if (coverage.airports) parts.push(`${coverage.airports.toLocaleString('en-US')} airports`);
  if (coverage.navaids) parts.push(`${coverage.navaids.toLocaleString('en-US')} navaids`);
  if (coverage.fixes) parts.push(`${coverage.fixes.toLocaleString('en-US')} fixes`);
  return parts.join(' · ');
}
