/* Stratos shared geodesy helpers.
   Pure functions, no DOM. Units: nautical miles, feet, knots, degrees. */

export const EARTH_NM = 3440.065;
export const DEG = Math.PI / 180;

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validLatLon(lat, lon) {
  return isFiniteNumber(lat) && isFiniteNumber(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function toRad(deg) { return deg * DEG; }
export function toDeg(rad) { return rad / DEG; }

/** Great-circle distance in nautical miles. */
export function distanceNm(a, b) {
  if (!a || !b || !validLatLon(a.lat, a.lon) || !validLatLon(b.lat, b.lon)) return 0;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return EARTH_NM * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing in degrees true (0-360). */
export function bearingDeg(a, b) {
  if (!a || !b || !validLatLon(a.lat, a.lon) || !validLatLon(b.lat, b.lon)) return 0;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function normalizeHeading(value) {
  if (!isFiniteNumber(value)) return null;
  return ((value % 360) + 360) % 360;
}

/** Smallest absolute angular difference between two headings, 0-180. */
export function headingDelta(a, b) {
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) return 180;
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

/** Point at a bearing/distance from an origin. */
export function destination(origin, bearing, nm) {
  const r = nm / EARTH_NM;
  const lat1 = origin.lat * DEG;
  const lon1 = origin.lon * DEG;
  const brg = bearing * DEG;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(r) + Math.cos(lat1) * Math.sin(r) * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brg) * Math.sin(r) * Math.cos(lat1),
    Math.cos(r) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/** Linear interpolation between two geographic points (adequate for short legs). */
export function interpolate(a, b, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

/**
 * Cross-track distance from point p to the great-circle segment a-b, plus the
 * fraction along the segment of the closest point. Used for runway touchdown
 * placement and route progress. Result in nautical miles.
 */
export function crossTrackNm(p, a, b) {
  const total = distanceNm(a, b);
  if (!total) return { distance: distanceNm(p, a), alongNm: 0, fraction: 0 };
  // Locally planar projection is numerically stable at the distances we care
  // about here (runways and single route legs).
  const latRef = ((a.lat + b.lat) / 2) * DEG;
  const ax = 0;
  const ay = 0;
  const bx = (b.lon - a.lon) * Math.cos(latRef) * 60;
  const by = (b.lat - a.lat) * 60;
  const px = (p.lon - a.lon) * Math.cos(latRef) * 60;
  const py = (p.lat - a.lat) * 60;
  const len2 = bx * bx + by * by || 1e-12;
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const dx = px - bx * t;
  const dy = py - by * t;
  const local = Math.hypot(dx, dy);
  return { distance: local, alongNm: t * total, fraction: t };
}

/** Bounds for a list of points, padded slightly. */
export function boundsOf(points) {
  const pts = (points || []).filter(p => p && validLatLon(p.lat, p.lon));
  if (!pts.length) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon, centerLat: (minLat + maxLat) / 2, centerLon: (minLon + maxLon) / 2 };
}

export function formatDuration(seconds) {
  if (!isFiniteNumber(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatHours(hours) {
  if (!isFiniteNumber(hours) || hours <= 0) return '0:00';
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatLatLon(lat, lon, digits = 4) {
  if (!validLatLon(lat, lon)) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}°${ns} ${Math.abs(lon).toFixed(digits)}°${ew}`;
}
