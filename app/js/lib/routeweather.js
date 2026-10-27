/* Route weather analysis.
 *
 * Real-world METAR observations for the airports on a planned route. Pure so
 * the planner and the tests interpret the same report the same way.
 *
 * Deliberately limited: this reads surface observations, not winds aloft, and
 * it never turns a missing report into an invented condition. Flight category
 * follows the FAA thresholds only when visibility or ceiling is actually
 * reported; otherwise it stays null and the UI says so.
 */

import { bearingDeg } from './geo.js';

export const WEATHER_STALE_MS = 60 * 60 * 1000;
export const MAX_ROUTE_STATIONS = 8;

const CATEGORIES = new Set(['VFR', 'MVFR', 'IFR', 'LIFR']);

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = finite(value);
    if (number != null) return number;
  }
  return null;
}

/** Visibility token ("10", "1/2", "1 1/2", "M1/4") to statute miles. */
export function parseVisibility(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  const clean = text.replace(/^M/, '');
  if (/^\d+(?:\.\d+)?$/.test(clean)) return Number(clean);
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(clean);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = /^(\d+)\/(\d+)$/.exec(clean);
  if (fraction) return Number(fraction[2]) ? Number(fraction[1]) / Number(fraction[2]) : null;
  return null;
}

/** FAA flight category from reported visibility and ceiling, or null. */
export function flightCategory({ visibilitySm = null, ceilingFt = null } = {}) {
  const visibility = finite(visibilitySm);
  const ceiling = finite(ceilingFt);
  if (visibility == null && ceiling == null) return null;
  if ((visibility != null && visibility < 1) || (ceiling != null && ceiling < 500)) return 'LIFR';
  if ((visibility != null && visibility < 3) || (ceiling != null && ceiling < 1000)) return 'IFR';
  if ((visibility != null && visibility <= 5) || (ceiling != null && ceiling <= 3000)) return 'MVFR';
  return 'VFR';
}

/** Decode the parts of a raw METAR this page uses. Null when there is no report. */
export function parseMetar(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const windMatch = /(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT(?:\s|$)/.exec(text);
  const visibilityMatch = /(?:^|\s)((?:M?\d+\s+)?M?\d+\/\d+|M?\d+(?:\.\d+)?|CAVOK)SM(?:\s|$)/.exec(text)
    || /(?:^|\s)(CAVOK)(?:\s|$)/.exec(text);
  // Most of the world reports visibility in metres ("9999", "2000", "2000NE",
  // "0800"). It is a real observation, so it is converted rather than dropped.
  // Only the leading group after the wind is considered, which is where the
  // metric form always sits — a "9999"-shaped token further in could be anything.
  const metricVisibility = visibilityMatch ? null : (() => {
    const tokens = text.split(/\s+/).slice(2, 8);
    for (const token of tokens) {
      if (/^\d{3,4}(?:N|NE|E|SE|S|SW|W|NW)?$/.test(token)) return [token, token.slice(0, 4)];
    }
    return null;
  })();
  const clouds = [...text.matchAll(/(?:^|\s)(FEW|SCT|BKN|OVC|VV)(\d{3})(?:CB|TCU)?(?=\s|$)/g)]
    .map(match => ({ cover: match[1], baseFt: Number(match[2]) * 100 }));
  const tempMatch = /\s(M?\d{2})\/(M?\d{2})\s/.exec(text);
  const altimeterMatch = /\s([AQ])(\d{4})\s/.exec(text);

  const wind = windMatch ? {
    direction: windMatch[1] === 'VRB' ? null : Number(windMatch[1]),
    speedKt: Number(windMatch[2]),
    gustKt: windMatch[3] ? Number(windMatch[3]) : null,
  } : null;

  const visibilityM = metricVisibility ? Number(metricVisibility[1]) : null;
  const visibilitySm = visibilityMatch
    ? (visibilityMatch[1] === 'CAVOK' ? 10 : parseVisibility(visibilityMatch[1]))
    : visibilityM != null && Number.isFinite(visibilityM)
      ? Math.round((visibilityM / 1609.34) * 10) / 10
      : null;
  const ceilingFt = clouds
    .filter(layer => layer.cover === 'BKN' || layer.cover === 'OVC' || layer.cover === 'VV')
    .reduce((lowest, layer) => (lowest == null ? layer.baseFt : Math.min(lowest, layer.baseFt)), null);

  return {
    wind,
    visibilitySm,
    visibilityM,
    clouds,
    ceilingFt,
    temperatureC: tempMatch ? Number(tempMatch[1].replace('M', '-')) : null,
    dewpointC: tempMatch ? Number(tempMatch[2].replace('M', '-')) : null,
    altimeter: altimeterMatch
      ? (altimeterMatch[1] === 'A'
        ? Number(`${altimeterMatch[2].slice(0, 2)}.${altimeterMatch[2].slice(2)}`)
        : Number(altimeterMatch[2]))
      : null,
    altimeterUnit: altimeterMatch ? (altimeterMatch[1] === 'A' ? 'inHg' : 'hPa') : null,
    flightCategory: flightCategory({ visibilitySm, ceilingFt }),
  };
}

/**
 * Wind components relative to a course.
 * Positive headwindKt is a headwind; positive crosswindKt is from the right.
 * Gusts are used when present, because that is what a pilot plans for.
 */
export function windComponents(courseDeg, windFromDeg, speedKt, gustKt = null) {
  const course = finite(courseDeg);
  const from = finite(windFromDeg);
  const speed = finite(speedKt);
  if (course == null || from == null || speed == null) return null;
  const gust = finite(gustKt);
  const effective = gust == null ? speed : Math.max(speed, gust);
  const relative = ((from - course + 540) % 360) - 180;
  const radians = relative * Math.PI / 180;
  return {
    effectiveKt: Math.round(effective),
    angleDeg: Math.round(Math.abs(relative)),
    headwindKt: Math.round(effective * Math.cos(radians)),
    crosswindKt: Math.round(effective * Math.sin(radians)),
  };
}

/** Prefer the source's decoded fields, fall back to the raw report. */
export function observationFrom(station = {}) {
  const parsed = parseMetar(station.metar);
  const decoded = station.decoded && typeof station.decoded === 'object' ? station.decoded : {};
  const decodedLayers = Array.isArray(decoded.sky_conditions)
    ? decoded.sky_conditions.map(value => {
      const match = /(FEW|SCT|BKN|OVC|VV)(\d{3})/i.exec(String(value));
      return match ? { cover: match[1].toUpperCase(), baseFt: Number(match[2]) * 100 } : null;
    }).filter(Boolean)
    : [];
  const ceiling = decodedLayers.length
    ? decodedLayers
      .filter(layer => layer.cover === 'BKN' || layer.cover === 'OVC' || layer.cover === 'VV')
      .reduce((lowest, layer) => (lowest == null ? layer.baseFt : Math.min(lowest, layer.baseFt)), null)
    : parsed ? parsed.ceilingFt : null;
  // Do not mix a decoded speed with a raw gust from another report: prefer the
  // source's decoded group whole, and only fall back to the raw text without it.
  const decodedWind = decoded.wind_dir != null || decoded.wind_speed_kt != null;
  const direction = decodedWind
    ? firstFinite(decoded.wind_dir)
    : firstFinite(parsed && parsed.wind && parsed.wind.direction);
  const speed = decodedWind
    ? firstFinite(decoded.wind_speed_kt)
    : firstFinite(parsed && parsed.wind && parsed.wind.speedKt);
  const gust = decodedWind
    ? firstFinite(decoded.wind_gust_kt)
    : firstFinite(parsed && parsed.wind && parsed.wind.gustKt);
  const visibility = firstFinite(decoded.visibility_sm, parsed && parsed.visibilitySm);
  const decodedCategory = String(decoded.flight_category || '').toUpperCase();
  return {
    wind: direction == null && speed == null ? null : { direction, speedKt: speed, gustKt: gust },
    visibilitySm: visibility,
    ceilingFt: ceiling,
    flightCategory: CATEGORIES.has(decodedCategory)
      ? decodedCategory
      : parsed ? parsed.flightCategory : null,
    temperatureC: firstFinite(decoded.temp_c, parsed && parsed.temperatureC),
    hasObservation: Boolean(station.metar),
  };
}

/** ICAO airports on the route, deduplicated and sampled to a bounded request count. */
export function pickWeatherStations(points, isAirport, limit = MAX_ROUTE_STATIONS) {
  const list = Array.isArray(points) ? points : [];
  const usable = [];
  const seen = new Set();
  list.forEach((point, index) => {
    const id = String((point && point.id) || '').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(id) || seen.has(id)) return;
    if (typeof isAirport === 'function' && !isAirport(point)) return;
    seen.add(id);
    usable.push({ id, name: point.name || id, lat: point.lat, lon: point.lon, index });
  });
  if (usable.length <= limit) return usable;
  // Keep the endpoints and sample the middle evenly, so a long route still
  // costs a fixed number of weather requests.
  const picked = [];
  const step = (usable.length - 1) / Math.max(1, limit - 1);
  for (let slot = 0; slot < limit; slot++) picked.push(usable[Math.round(slot * step)]);
  return picked;
}

/** Course to fly at each station, from the real route order. */
export function withRouteCourses(points, stations) {
  const list = Array.isArray(points) ? points : [];
  return (stations || []).map(station => {
    const index = list.findIndex(point => String((point && point.id) || '').toUpperCase() === station.id);
    const next = index >= 0 ? list[index + 1] : null;
    const previous = index > 0 ? list[index - 1] : null;
    return {
      ...station,
      courseDeg: next
        ? bearingDeg(station, next)
        : previous ? bearingDeg(previous, station) : null,
    };
  });
}

/**
 * Annotate each station and collect only challenges the reports actually show.
 * A missing METAR produces "unknown", never a guessed category or wind.
 */
export function analyseRouteWeather(stations, now = Date.now()) {
  const rows = [];
  const challenges = [];
  for (const station of stations || []) {
    const observation = observationFrom(station);
    const course = finite(station.courseDeg);
    const components = observation.wind && observation.wind.direction != null && course != null
      ? windComponents(course, observation.wind.direction, observation.wind.speedKt, observation.wind.gustKt)
      : null;
    const fetchedAt = finite(station.fetchedAt);
    const ageMs = fetchedAt == null ? null : Math.max(0, now - fetchedAt);
    const stale = ageMs != null && ageMs > WEATHER_STALE_MS;
    const row = { ...station, ...observation, components, ageMs, stale };
    rows.push(row);

    if (!observation.hasObservation) {
      challenges.push({ kind: 'missing', station: station.id, text: `No current METAR for ${station.id}; its conditions are unknown.` });
      continue;
    }
    if (stale) challenges.push({ kind: 'stale', station: station.id, text: `${station.id} was fetched more than an hour ago; re-check before relying on it.` });
    if (observation.flightCategory === 'IFR' || observation.flightCategory === 'LIFR') {
      challenges.push({ kind: 'imc', station: station.id, text: `${station.id} reports ${observation.flightCategory} conditions.` });
    }
    const speed = observation.wind && observation.wind.speedKt;
    const gust = observation.wind && observation.wind.gustKt;
    if (finite(speed) != null && finite(gust) != null && gust - speed >= 10) {
      challenges.push({ kind: 'gusts', station: station.id, text: `${station.id} gusts to ${gust} kt, ${gust - speed} kt above the mean wind.` });
    }
    if (components && Math.abs(components.crosswindKt) >= 15) {
      const side = components.crosswindKt > 0 ? 'from the right' : 'from the left';
      challenges.push({
        kind: 'crosswind',
        station: station.id,
        text: `${station.id}: ${Math.abs(components.crosswindKt)} kt crosswind ${side} on course ${String(Math.round(course)).padStart(3, '0')}° (surface wind).`,
      });
    }
    if (components && components.headwindKt <= -10) {
      challenges.push({
        kind: 'tailwind',
        station: station.id,
        text: `${station.id}: ${Math.abs(components.headwindKt)} kt tailwind on course ${String(Math.round(course)).padStart(3, '0')}° (surface wind).`,
      });
    }
  }
  return { stations: rows, challenges };
}
