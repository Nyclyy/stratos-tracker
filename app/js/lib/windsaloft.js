/* Winds aloft from the NOAA Aviation Weather Center legacy FD table
   (api/data/windtemp, region=us, level=low). Public-domain NWS data.

   The table is fixed-width. Wind groups are DDFF (direction in tens of degrees,
   speed in knots). Below 24,000 ft temperatures are ±TT °C. Above 24,000 ft the
   header says "TEMPS NEG ABV 24000": the sign is omitted and the value is always
   negative. Speeds of 100 kt or more add 50 to the direction group, and
   light-and-variable is coded 9900. There is no temperature at 3,000 ft. Nothing
   is estimated: a blank cell stays null. */

import { distanceNm } from './geo.js';
import { windComponents } from './routeweather.js';

/**
 * Column layout of the low-level table, read from the sample's header row.
 * temp: 'signed' (±TT), 'negative' (TT, always below zero), or null.
 */
export const LOW_LEVEL_COLUMNS = [
  { ft: 3000, start: 4, width: 4, temp: null },
  { ft: 6000, start: 9, width: 7, temp: 'signed' },
  { ft: 9000, start: 17, width: 7, temp: 'signed' },
  { ft: 12000, start: 25, width: 7, temp: 'signed' },
  { ft: 18000, start: 33, width: 7, temp: 'signed' },
  { ft: 24000, start: 41, width: 7, temp: 'signed' },
  { ft: 30000, start: 49, width: 6, temp: 'negative' },
  { ft: 34000, start: 56, width: 6, temp: 'negative' },
  { ft: 39000, start: 63, width: 6, temp: 'negative' },
];

const HEADER_PREFIXES = new Set(['FBU', 'FD1', 'DAT', 'VAL', 'FT ']);

/** Decode one DDFF wind group. Returns null for a blank cell. */
export function decodeWind(token) {
  const text = String(token || '').trim();
  if (!text) return null;
  if (text === '9900') return { variable: true, dirDeg: null, speedKt: 0 };
  if (!/^\d{4}$/.test(text)) throw new Error(`Bad wind group "${text}".`);
  const dd = Number(text.slice(0, 2));
  const ff = Number(text.slice(2, 4));
  // Speeds of 100 kt and above add 50 to the direction group.
  if (dd > 50) return { variable: false, dirDeg: (dd - 50) * 10, speedKt: ff + 100 };
  return { variable: false, dirDeg: dd * 10, speedKt: ff };
}

/** Decode a ±TT temperature group in °C. Returns null when absent. */
export function decodeTemp(token) {
  const text = String(token || '').trim();
  if (!text) return null;
  if (!/^[+-]\d{2}$/.test(text)) throw new Error(`Bad temperature group "${text}".`);
  return Number(text);
}

/** Decode an unsigned TT group that is always below zero. */
export function decodeNegativeTemp(token) {
  const text = String(token || '').trim();
  if (!text) return null;
  if (!/^\d{2}$/.test(text)) throw new Error(`Bad temperature group "${text}".`);
  const value = Number(text);
  return value === 0 ? 0 : -value;
}

/**
 * Resolve a UTC stamp such as "200600Z" (day, hour, minute) to the instant
 * nearest to `now`, trying the previous, current and next month.
 */
export function utcStampNear(stamp, now) {
  const match = /^(\d{2})(\d{2})(\d{2})Z?$/.exec(String(stamp || '').trim());
  if (!match) return null;
  const [day, hour, minute] = match.slice(1).map(Number);
  const base = new Date(now);
  let best = null;
  for (const offset of [-1, 0, 1]) {
    const candidate = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, day, hour, minute);
    if (best === null || Math.abs(candidate - now) < Math.abs(best - now)) best = candidate;
  }
  return best;
}

/**
 * Parse the low-level winds-aloft table.
 * @returns {{ issuedMs, validMs, validUntilMs, stale, levels, stations }}
 * Throws when the text is not the expected table, so a changed format is reported
 * rather than mis-decoded.
 */
export function parseWindsAloft(text, now = Date.now()) {
  const lines = String(text || '').split(/\r?\n/);
  const issued = /DATA BASED ON (\d{6}Z)/.exec(text || '');
  const valid = /VALID (\d{6}Z)/.exec(text || '');
  const useWindow = /FOR USE (\d{4})-(\d{4})Z/.exec(text || '');
  const header = lines.find(line => /^FT\s+3000/.test(line));
  if (!valid || !useWindow || !header) {
    throw new Error('The winds-aloft text is not the expected low-level table.');
  }
  const headerLevels = (header.match(/\d{4,5}/g) || []).map(Number);
  const expected = LOW_LEVEL_COLUMNS.map(column => column.ft);
  if (headerLevels.length !== expected.length || headerLevels.some((ft, index) => ft !== expected[index])) {
    throw new Error('The winds-aloft level layout has changed; the decoder needs an update.');
  }

  const stations = {};
  for (const line of lines) {
    const code = line.slice(0, 3);
    if (!/^[A-Z]{3}$/.test(code) || HEADER_PREFIXES.has(code) || line.length < 9) continue;
    const levels = LOW_LEVEL_COLUMNS.map(column => {
      const cell = line.slice(column.start, column.start + column.width);
      const wind = decodeWind(cell.slice(0, 4));
      if (!wind) return null;
      let tempC = null;
      if (column.temp === 'signed') tempC = decodeTemp(cell.slice(4, 7));
      else if (column.temp === 'negative') tempC = decodeNegativeTemp(cell.slice(4, 6));
      return {
        ft: column.ft,
        dirDeg: wind.dirDeg,
        speedKt: wind.speedKt,
        variable: wind.variable,
        tempC,
      };
    }).filter(Boolean);
    if (levels.length) stations[code] = levels;
  }

  // VALID gives the day-hour-minute the winds apply to; FOR USE is the window.
  const validMs = utcStampNear(valid[1], now);
  const day = Number(valid[1].slice(0, 2));
  const endHour = Number(useWindow[2].slice(0, 2));
  const endMinute = Number(useWindow[2].slice(2, 4));
  const validUntilMs = utcStampNear(`${String(day).padStart(2, '0')}${String(endHour).padStart(2, '0')}${String(endMinute).padStart(2, '0')}Z`, now);
  const issuedMs = issued ? utcStampNear(issued[1], now) : null;
  return {
    issuedMs,
    validMs,
    validUntilMs,
    stale: windsAreStale({ validUntilMs }, now),
    levels: expected,
    stations,
  };
}

/**
 * Winds at cruise for each route leg. Each leg uses the table station nearest its
 * midpoint, within maxNm, and the reported level nearest cruiseFt. Head and
 * crosswind components use the leg's initial bearing. The midpoint is a simple
 * average of the endpoints, which is an approximation for very long legs.
 * @param {object} input
 * @param {object} input.parsed result of parseWindsAloft()
 * @param {Array<{id, lat, lon}>} input.legs legs from routeLegs(): { from, to, initialBearing }
 * @param {Array<{code, lat, lon}>} input.stations table stations with known positions
 * @param {number} input.cruiseFt cruise altitude in feet
 */
export function legWinds({ parsed, legs, stations, cruiseFt, maxNm = 150 }) {
  return (legs || []).map((leg, index) => {
    const row = {
      index,
      from: leg.from.id,
      to: leg.to.id,
      courseDeg: leg.initialBearing,
      station: null,
      stationDistanceNm: null,
      ft: null,
      dirDeg: null,
      speedKt: null,
      variable: false,
      tempC: null,
      headwindKt: null,
      crosswindKt: null,
      reason: null,
    };
    const midpoint = { lat: (leg.from.lat + leg.to.lat) / 2, lon: (leg.from.lon + leg.to.lon) / 2 };
    let nearest = null;
    for (const station of stations || []) {
      const distance = distanceNm(midpoint, station);
      if (distance <= maxNm && (!nearest || distance < nearest.distance)) nearest = { station, distance };
    }
    if (!nearest) {
      row.reason = `No winds-aloft station within ${maxNm} nm of this leg.`;
      return row;
    }
    row.station = nearest.station.code;
    row.stationDistanceNm = Math.round(nearest.distance);
    const level = windAt(parsed, nearest.station.code, cruiseFt);
    if (!level) {
      row.reason = `The table has no winds for ${nearest.station.code}.`;
      return row;
    }
    row.ft = level.ft;
    row.dirDeg = level.dirDeg;
    row.speedKt = level.speedKt;
    row.variable = level.variable;
    row.tempC = level.tempC;
    if (level.variable) {
      // Light and variable: no meaningful component.
      row.headwindKt = 0;
      row.crosswindKt = 0;
    } else {
      const components = windComponents(leg.initialBearing, level.dirDeg, level.speedKt);
      if (components) {
        row.headwindKt = components.headwindKt;
        row.crosswindKt = components.crosswindKt;
      }
    }
    return row;
  });
}

/**
 * True once the forecast window has closed. Callers evaluate this at render time,
 * because a cached table outlives the moment it was parsed.
 */
export function windsAreStale(parsed, now = Date.now()) {
  return parsed != null && parsed.validUntilMs != null && now > parsed.validUntilMs;
}

/** The reported level nearest to a target altitude (in feet) for one station. */
export function windAt(parsed, station, targetFt) {
  const levels = parsed && parsed.stations ? parsed.stations[String(station || '').toUpperCase()] : null;
  if (!levels || !levels.length) return null;
  let best = null;
  for (const level of levels) {
    if (best === null || Math.abs(level.ft - targetFt) < Math.abs(best.ft - targetFt)) best = level;
  }
  return best;
}
