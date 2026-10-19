/* Route planner model: validation, editing, estimates, persistence helpers and
   PLN/FMS/GPX import-export. Estimates are clearly labelled as estimates; this
   is not an operational flight plan and contains no winds, fuel or ATC data. */

import { bearingDeg, distanceNm, isFiniteNumber, validLatLon } from './geo.js';

export const MAX_WAYPOINTS = 200;
export const IDENT_RE = /^[A-Z0-9]{2,8}$/;
const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/;

export function parseWaypointText(text) {
  const raw = String(text || '').trim().toUpperCase();
  if (!raw) return null;
  const coord = raw.match(COORD_RE);
  if (coord) {
    const a = Number(coord[1]), b = Number(coord[2]);
    // Accept "lat,lon" only; reject reversed or out-of-range input.
    if (!validLatLon(a, b)) return { error: 'Coordinates must be latitude, longitude (for example 37.62,-122.38).' };
    return { id: `WPT${String(Math.abs(Math.round(a * 100 + b * 100))).slice(0, 4)}`, name: 'User waypoint', lat: a, lon: b, kind: 'fix' };
  }
  if (!IDENT_RE.test(raw)) return { error: 'Use a 2-8 character identifier or latitude,longitude.' };
  return { id: raw, name: '', kind: 'fix' };
}

export function normalizeWaypoint(input) {
  if (!input) return null;
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  if (!validLatLon(lat, lon)) return null;
  return {
    id: String(input.id || input.ident || 'WPT').toUpperCase().slice(0, 12),
    name: String(input.name || '').slice(0, 80),
    lat, lon,
    elev: isFiniteNumber(Number(input.elev)) ? Number(input.elev) : 0,
    kind: ['apt', 'nav', 'fix'].includes(input.kind || input.k) ? (input.kind || input.k) : 'fix',
    // Only a value that came from an imported flight plan; never guessed.
    constraintAlt: isFiniteNumber(Number(input.constraintAlt)) && Number(input.constraintAlt) > 0
      ? Math.round(Number(input.constraintAlt)) : null,
  };
}

export function validateRoute(route) {
  const errors = [];
  const warnings = [];
  const points = (Array.isArray(route) ? route : []).map(normalizeWaypoint);
  if (!route || !route.length) errors.push({ code: 'empty', message: 'The route is empty.' });
  if (points.length === 1) errors.push({ code: 'short', message: 'Add a destination — a route needs at least two waypoints.' });
  if (points.length > MAX_WAYPOINTS) errors.push({ code: 'too-long', message: `Routes are limited to ${MAX_WAYPOINTS} waypoints.` });
  points.forEach((p, i) => {
    if (!p) errors.push({ code: 'invalid-point', index: i, message: `Waypoint ${i + 1} has invalid coordinates.` });
    else if (!p.id) errors.push({ code: 'missing-ident', index: i, message: `Waypoint ${i + 1} has no identifier.` });
  });
  const clean = points.filter(Boolean);
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].id === clean[i - 1].id && distanceNm(clean[i], clean[i - 1]) < 0.1) {
      warnings.push({ code: 'duplicate', index: i, message: `${clean[i].id} is repeated consecutively.` });
    }
  }
  const total = routeTotals(clean).distanceNm;
  if (clean.length > 1 && total < 1) warnings.push({ code: 'very-short', message: 'Total route distance is under 1 nm.' });
  return { valid: errors.length === 0, errors, warnings, points: clean };
}

export function routeLegs(route) {
  const points = (route || []).map(normalizeWaypoint).filter(Boolean);
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const nm = distanceNm(points[i - 1], points[i]);
    legs.push({
      index: i,
      from: points[i - 1],
      to: points[i],
      distanceNm: nm,
      initialBearing: bearingDeg(points[i - 1], points[i]),
      estimated: true,
    });
  }
  return legs;
}

/**
 * Distance/ETE estimate. No winds, no fuel, no routing rules: label it as an
 * estimate wherever it is displayed.
 */
export function routeTotals(route, options = {}) {
  const speed = Number(options.cruiseKts) > 0 ? Number(options.cruiseKts) : 450;
  const points = (route || []).map(normalizeWaypoint).filter(Boolean);
  const legs = routeLegs(points);
  const totalNm = legs.reduce((sum, leg) => sum + leg.distanceNm, 0);
  const estimate = estimateFlightTime(totalNm, {
    cruiseTas: speed,
    cruiseAlt: options.cruiseAlt,
    departureElev: points.length ? points[0].elev : 0,
    arrivalElev: points.length ? points[points.length - 1].elev : 0,
    climbFpm: options.climbFpm,
    descentFpm: options.descentFpm,
    climbKts: options.climbKts,
    descentKts: options.descentKts,
    taxiMinutes: options.taxiMinutes,
  });
  return {
    distanceNm: totalNm,
    greatCircleNm: points.length > 1 ? distanceNm(points[0], points[points.length - 1]) : 0,
    legs,
    cruiseKts: speed,
    cruiseAlt: estimate.cruiseAlt,
    eteMinutes: estimate.totalMinutes,
    airborneMinutes: estimate.airborneMinutes,
    taxiMinutes: estimate.taxiMinutes,
    climbMinutes: estimate.climbMinutes,
    descentMinutes: estimate.descentMinutes,
    climbDistanceNm: estimate.climbDistanceNm || 0,
    descentDistanceNm: estimate.descentDistanceNm || 0,
    tocNm: Math.min(totalNm, estimate.climbDistanceNm || 0),
    todNm: Math.max(
      Math.min(totalNm, estimate.climbDistanceNm || 0),
      totalNm - (estimate.descentDistanceNm || 0),
    ),
    estimated: true,
    method: estimate.method,
  };
}

export function estimateFlightTime(distanceNm, options = {}) {
  const cruiseTas = Number(options.cruiseTas) > 0 ? Number(options.cruiseTas) : 450;
  const cruiseAlt = isFiniteNumber(Number(options.cruiseAlt)) ? Number(options.cruiseAlt) : 35000;
  const depElev = isFiniteNumber(Number(options.departureElev)) ? Number(options.departureElev) : 0;
  const arrElev = isFiniteNumber(Number(options.arrivalElev)) ? Number(options.arrivalElev) : 0;
  const climbFpm = Number(options.climbFpm) > 0 ? Number(options.climbFpm) : 2200;
  const descentFpm = Number(options.descentFpm) > 0 ? Number(options.descentFpm) : 1800;
  const climbKts = Number(options.climbKts) > 0 ? Number(options.climbKts) : cruiseTas * 0.72;
  const descentKts = Number(options.descentKts) > 0 ? Number(options.descentKts) : cruiseTas * 0.82;
  const taxiMinutes = Number(options.taxiMinutes) >= 0 ? Number(options.taxiMinutes) : 0;

  if (!(distanceNm > 0)) {
    return {
      airborneMinutes: 0, totalMinutes: taxiMinutes, taxiMinutes, climbMinutes: 0, descentMinutes: 0,
      cruiseMinutes: 0, cruiseAlt, climbDistanceNm: 0, descentDistanceNm: 0,
      method: 'No distance to estimate.',
    };
  }
  const climbMinutes = Math.max(0, (cruiseAlt - depElev) / climbFpm);
  const descentMinutes = Math.max(0, (cruiseAlt - arrElev) / descentFpm);
  let climbDist = climbKts * (climbMinutes / 60);
  let descentDist = descentKts * (descentMinutes / 60);
  let minutes;
  if (climbDist + descentDist >= distanceNm) {
    // Short sector: the aircraft never reaches cruise altitude. Scale the
    // profile proportionally; still an approximation, not a performance model.
    const ratio = distanceNm / (climbDist + descentDist || 1);
    climbDist *= ratio;
    descentDist *= ratio;
    minutes = (climbMinutes + descentMinutes) * ratio;
  } else {
    const cruiseDist = distanceNm - climbDist - descentDist;
    minutes = climbMinutes + descentMinutes + (cruiseDist / cruiseTas) * 60;
  }
  return {
    airborneMinutes: Math.round(minutes),
    totalMinutes: Math.round(minutes + taxiMinutes),
    taxiMinutes,
    climbMinutes: Math.round(climbMinutes),
    descentMinutes: Math.round(descentMinutes),
    cruiseMinutes: Math.max(0, Math.round(minutes - climbMinutes - descentMinutes)),
    cruiseAlt,
    climbDistanceNm: climbDist,
    descentDistanceNm: descentDist,
    method: `Estimate from ${Math.round(cruiseTas)} kt cruise, ${Math.round(climbFpm)} fpm climb and ${Math.round(descentFpm)} fpm descent. No wind, fuel or ATC modelling.`,
  };
}

/**
 * Vertical profile for a route. Every altitude here is derived from the same
 * estimate routeTotals() returns, so the TOC/TOD shown in the planner, the
 * estimate card and the profile can never disagree. A waypoint's planned
 * altitude comes from that estimate; an imported flight plan's own altitude is
 * kept separately as a constraint and is never overwritten.
 */
export function routeProfile(route, options = {}) {
  const points = (route || []).map(normalizeWaypoint).filter(Boolean);
  if (points.length < 2) return null;
  const totals = routeTotals(points, options);
  const cruiseAlt = totals.cruiseAlt;
  const depElev = points[0].elev || 0;
  const arrElev = points[points.length - 1].elev || 0;
  const distance = totals.distanceNm;
  const tocNm = Math.min(distance, Math.max(0, totals.tocNm));
  const todNm = Math.max(tocNm, Math.min(distance, totals.todNm));

  const altAt = nm => {
    if (tocNm > 0 && nm <= tocNm) return depElev + (cruiseAlt - depElev) * (nm / tocNm);
    if (nm >= todNm) {
      const span = distance - todNm;
      return span > 0 ? arrElev + (cruiseAlt - arrElev) * ((distance - nm) / span) : arrElev;
    }
    return cruiseAlt;
  };

  let travelled = 0;
  const waypoints = points.map((point, index) => {
    if (index > 0) travelled += totals.legs[index - 1] ? totals.legs[index - 1].distanceNm : 0;
    return {
      index,
      id: point.id,
      name: point.name || '',
      nm: travelled,
      elev: point.elev || 0,
      plannedAlt: Math.round(altAt(travelled)),
      constraintAlt: point.constraintAlt,
      kind: point.kind,
    };
  });

  return {
    points: waypoints,
    distanceNm: distance,
    cruiseAlt,
    depElev,
    arrElev,
    tocNm,
    todNm,
    toc: { nm: tocNm, alt: Math.round(cruiseAlt) },
    tod: { nm: todNm, alt: Math.round(cruiseAlt) },
    totals,
    estimated: true,
  };
}

export function moveWaypoint(route, from, to) {
  const list = (route || []).slice();
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return list;
}

export function removeWaypoint(route, index) {
  return (route || []).filter((_, i) => i !== index);
}

/** Direct-to: keep the departure, drop intermediate points and keep the target. */
export function directTo(route, index) {
  const list = (route || []).slice();
  if (index <= 0 || index >= list.length) return list;
  if (list.length <= 2) return list;
  return [list[0], list[index]];
}

export function insertWaypoint(route, waypoint, index) {
  const list = (route || []).slice();
  const wp = normalizeWaypoint(waypoint);
  if (!wp) return list;
  const at = Math.max(0, Math.min(list.length, index == null ? list.length : index));
  list.splice(at, 0, wp);
  return list;
}

export function searchPlaces(items, query, limit = 10) {
  const q = String(query || '').trim().toUpperCase();
  if (!q) return [];
  const scored = [];
  for (const item of items || []) {
    const id = String(item.id || item.ident || '').toUpperCase();
    const iata = String(item.iata || item.iata_code || '').toUpperCase();
    const name = String(item.name || '').toUpperCase();
    const city = String(item.municipality || item.city || '').toUpperCase();
    let score = 0;
    if (id === q || iata === q) score = 100;
    else if (id.startsWith(q)) score = 80;
    else if (iata.startsWith(q)) score = 70;
    else if (name.startsWith(q)) score = 60;
    else if (id.includes(q)) score = 40;
    else if (name.includes(q)) score = 30;
    else if (city.includes(q)) score = 20;
    if (score) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));
  return scored.slice(0, limit).map(entry => entry.item);
}

/* ── Saved routes (pure helpers; persistence is the caller's job) ───────── */

export function createSavedRoute(name, route) {
  const points = (route || []).map(normalizeWaypoint).filter(Boolean);
  return {
    id: `route_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(name || defaultRouteName(points)).slice(0, 60),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    points,
  };
}

export function defaultRouteName(points) {
  if (!points || !points.length) return 'Untitled route';
  if (points.length === 1) return `${points[0].id} departure`;
  return `${points[0].id} → ${points[points.length - 1].id}`;
}

export function renameSavedRoute(route, name) {
  return { ...route, name: String(name || '').slice(0, 60) || route.name, updatedAt: Date.now() };
}

export function duplicateSavedRoute(route) {
  return {
    ...route,
    id: `route_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: `${route.name} copy`.slice(0, 60),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    points: (route.points || []).map(p => ({ ...p })),
  };
}

/* ── Import / export ───────────────────────────────────────────────────── */

function xesc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dms(value, positive, negative) {
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${value < 0 ? negative : positive}${d}° ${m}' ${s.toFixed(2)}"`;
}

export function exportPln(route, options = {}) {
  const points = (route || []).map(normalizeWaypoint).filter(Boolean);
  if (points.length < 2) throw new Error('A flight plan needs at least two waypoints.');
  const title = options.title || defaultRouteName(points);
  const body = points.map(p => {
    const type = p.kind === 'apt' ? 'Airport' : p.kind === 'nav' ? 'VOR' : 'User';
    const alt = Number(p.elev) || 0;
    const planned = p.constraintAlt ? `\n        <Altitude>${Number(p.constraintAlt).toFixed(2)}</Altitude>` : '';
    return `      <ATCWaypoint id="${xesc(p.id)}">
        <ATCWaypointType>${type}</ATCWaypointType>${planned}
        <WorldPosition>${dms(p.lat, 'N', 'S')},${dms(p.lon, 'E', 'W')},+${String(alt.toFixed(2)).padStart(9, '0')}</WorldPosition>
      </ATCWaypoint>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
  <FlightPlan.FlightPlan>
    <Title>${xesc(title)}</Title>
    <FPType>IFR</FPType>
    <RouteType>Direct</RouteType>
    <DepartureID>${xesc(points[0].id)}</DepartureID>
    <DestinationID>${xesc(points[points.length - 1].id)}</DestinationID>
${body}
  </FlightPlan.FlightPlan>
</SimBase.Document>`;
}

export function importPln(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.');
  if (!/<ATCWaypoint/i.test(text)) throw new Error('No ATCWaypoint entries found — this is not a supported .pln file.');
  const points = [];
  const re = /<ATCWaypoint\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/ATCWaypoint>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const id = match[1].toUpperCase().slice(0, 12);
    const inner = match[2];
    const pos = /<WorldPosition>([^<]+)<\/WorldPosition>/i.exec(inner);
    if (!pos) continue;
    const parts = pos[1].split(',');
    if (parts.length < 2) continue;
    const lat = parseDms(parts[0]);
    const lon = parseDms(parts[1]);
    if (!validLatLon(lat, lon)) continue;
    const typeMatch = /<ATCWaypointType>([^<]+)<\/ATCWaypointType>/i.exec(inner);
    const type = (typeMatch ? typeMatch[1] : '').toUpperCase();
    // MSFS plans carry the planned altitude per waypoint. Keep it: it is the
    // only altitude the file actually provides.
    const altitude = /<Altitude>\s*(-?[\d.]+)\s*<\/Altitude>/i.exec(inner);
    const constraintAlt = altitude && Number(altitude[1]) > 0 ? Math.round(Number(altitude[1])) : null;
    points.push({
      id, name: id, lat, lon, elev: 0, constraintAlt,
      kind: type.includes('AIRPORT') ? 'apt' : type.includes('VOR') || type.includes('NDB') ? 'nav' : 'fix',
    });
  }
  if (points.length < 2) throw new Error('No usable waypoints could be read from this .pln file.');
  return points;
}

function parseDms(text) {
  const raw = String(text || '').trim();
  const simple = Number(raw);
  if (Number.isFinite(simple)) return simple;
  const m = raw.match(/^([NSEW])?\s*(-?\d+(?:\.\d+)?)[°\s]+(\d+(?:\.\d+)?)?['′\s]*(\d+(?:\.\d+)?)?["″\s]*([NSEW])?$/i);
  if (!m) return NaN;
  const sign = /S|W/i.test(m[1] || m[5] || '') ? -1 : 1;
  const deg = Math.abs(Number(m[2]));
  const min = Number(m[3] || 0);
  const sec = Number(m[4] || 0);
  return sign * (deg + min / 60 + sec / 3600);
}

export function exportFms(route, options = {}) {
  const points = (route || []).map(normalizeWaypoint).filter(Boolean);
  if (points.length < 2) throw new Error('A flight plan needs at least two waypoints.');
  const lines = points.map(p => {
    const type = p.kind === 'apt' ? 1 : p.kind === 'nav' ? 3 : 11;
    const alt = Number(p.elev) || 0;
    return `${type} ${p.id} ${p.kind === 'apt' ? 'ADEP' : 'DRCT'} ${alt.toFixed(6)} ${p.lat.toFixed(6)} ${p.lon.toFixed(6)}`;
  });
  return `I
1100 Version
CYCLE ${String(options.cycle || 2601)}
ADEP ${points[0].id}
ADES ${points[points.length - 1].id}
NUMENR ${points.length}
${lines.join('\n')}
`;
}

export function importFms(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const points = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const type = Number(parts[0]);
    if (![1, 2, 3, 11, 28].includes(type)) continue;
    const id = parts[1].toUpperCase().slice(0, 12);
    const lat = Number(parts[4]);
    const lon = Number(parts[5]);
    if (!validLatLon(lat, lon)) continue;
    points.push({ id, name: id, lat, lon, elev: 0, kind: type === 1 ? 'apt' : type === 2 || type === 3 ? 'nav' : 'fix' });
  }
  if (points.length < 2) throw new Error('No usable waypoints could be read from this .fms file.');
  return points;
}

export function exportGpx(route, options = {}) {
  const points = (route || []).map(normalizeWaypoint).filter(Boolean);
  if (points.length < 2) throw new Error('A route needs at least two waypoints.');
  const name = xesc(options.title || defaultRouteName(points));
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Stratos" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name><time>${new Date().toISOString()}</time></metadata>
  <rte>
    <name>${name}</name>
${points.map(p => `    <rtept lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><name>${xesc(p.id)}</name></rtept>`).join('\n')}
  </rte>
</gpx>`;
}

export function importGpx(text) {
  if (typeof text !== 'string' || !/<gpx/i.test(text)) throw new Error('This is not a GPX file.');
  const points = [];
  const re = /<rtept\b[^>]*lat="(-?[\d.]+)"[^>]*lon="(-?[\d.]+)"[^>]*>([\s\S]*?)<\/rtept>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const lat = Number(match[1]), lon = Number(match[2]);
    if (!validLatLon(lat, lon)) continue;
    const nameMatch = /<name>([^<]*)<\/name>/i.exec(match[3]);
    const id = (nameMatch ? nameMatch[1] : `WPT${points.length + 1}`).toUpperCase().slice(0, 12);
    points.push({ id, name: id, lat, lon, elev: 0, kind: 'fix' });
  }
  if (points.length < 2) throw new Error('No route points found in this GPX file.');
  return points;
}

export function detectRouteFormat(text) {
  if (/<ATCWaypoint/i.test(text)) return 'pln';
  if (/<gpx/i.test(text)) return 'gpx';
  if (/^\s*I\s*$/m.test(text) && /NUMENR|ADEP/m.test(text)) return 'fms';
  return null;
}

export function importRoute(text) {
  const format = detectRouteFormat(text);
  if (!format) throw new Error('Unrecognised file. Supported formats: MSFS .pln, X-Plane .fms, GPX.');
  if (format === 'pln') return { format, points: importPln(text) };
  if (format === 'fms') return { format, points: importFms(text) };
  return { format, points: importGpx(text) };
}
