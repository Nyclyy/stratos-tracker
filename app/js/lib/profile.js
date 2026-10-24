/* Climb and descent along the plan the route already carries.
 *
 * TOC and TOD are positions *on the route*: this module walks the ordered
 * legs, turns a vertical distance into an along-track distance, and
 * interpolates between two fixes. It never inserts, moves or reorders a route
 * point, so the line between waypoints cannot change.
 *
 * Where the plan states a planned altitude for a fix, those altitudes are the
 * constraints and they win: the climb ends where the plan first reaches cruise
 * and the descent starts where it first leaves it. Where the plan states none,
 * a gradient is used and the result is marked as an estimate. Nothing is
 * invented beyond that — an aircraft-specific climb rate is used only when a
 * caller supplies one.
 */

import { distanceNm, interpolate, validLatLon } from './geo.js';

/** A jet-like default: 2,200 fpm at 320 kt ground speed is about 412 ft/nm. */
export const DEFAULT_CLIMB_FPM = 2200;
export const DEFAULT_CLIMB_GS_KT = 320;
/** The same default the map has always planned descents with (ft per nm). */
export const DEFAULT_DESCENT_FT_NM = 200;
/** Below this the flight is not at a cruising level the markers describe. */
export const MIN_CRUISE_FT = 10000;
/** A marker nearer than this to either end is not useful on the chart. */
export const MIN_END_CLEARANCE_NM = 4;

function altitudeOf(point) {
  const value = Number(point && (point.elev != null ? point.elev : point.altFt));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function usableRoute(route) {
  return (route || []).filter(point => point && validLatLon(Number(point.lat), Number(point.lon)));
}

/** Cumulative distance to each point, plus the total. */
export function routeDistances(route) {
  const points = usableRoute(route);
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + distanceNm(points[i - 1], points[i]));
  }
  return { points, cumulative, totalNm: cumulative.length ? cumulative[cumulative.length - 1] : 0 };
}

/**
 * The position `targetNm` along the route, interpolated inside the leg that
 * contains it. Returns null beyond the route.
 */
export function positionAlong(route, targetNm) {
  const { points, cumulative, totalNm } = routeDistances(route);
  if (points.length < 2 || !Number.isFinite(targetNm)) return null;
  const target = Math.max(0, Math.min(totalNm, targetNm));
  for (let i = 0; i < points.length - 1; i++) {
    const start = cumulative[i];
    const leg = cumulative[i + 1] - start;
    if (target <= start + leg + 1e-9 || i === points.length - 2) {
      const fraction = leg > 0 ? Math.max(0, Math.min(1, (target - start) / leg)) : 0;
      const position = interpolate(points[i], points[i + 1], fraction);
      return {
        lat: position.lat,
        lon: position.lon,
        legIndex: i,
        fraction,
        nm: target,
        totalNm,
        fromId: points[i].id || '',
        toId: points[i + 1].id || '',
      };
    }
  }
  return null;
}

/**
 * Build the vertical profile for a route.
 *
 * route:  [{ id, lat, lon, elev|altFt, k }] in flight order. `elev` is the
 *         planned altitude at a fix, or the field elevation at an airport.
 * cruiseFt: planned cruise altitude. Defaults to the highest planned altitude.
 * descentFtPerNm: measured or chosen gradient. Defaults to the planning value.
 * climbFtPerMin / climbGsKt: aircraft performance, when it is known.
 */
export function computeVerticalProfile({
  route = [],
  cruiseFt = null,
  descentFtPerNm = DEFAULT_DESCENT_FT_NM,
  climbFtPerMin = DEFAULT_CLIMB_FPM,
  climbGsKt = DEFAULT_CLIMB_GS_KT,
  destinationElevFt = null,
} = {}) {
  const { points, cumulative, totalNm } = routeDistances(route);
  if (points.length < 3 || !(totalNm > MIN_END_CLEARANCE_NM * 2)) {
    return { ok: false, reason: 'A profile needs at least three fixes and a route of some length.' };
  }
  const altitudes = points.map(altitudeOf);
  const highest = altitudes.reduce((best, value) => (value && value > best ? value : best), 0);
  const cruise = Number.isFinite(Number(cruiseFt)) && Number(cruiseFt) > 0 ? Number(cruiseFt) : highest;
  if (!(cruise >= MIN_CRUISE_FT)) {
    return { ok: false, reason: 'The plan has no cruising level above 10,000 ft.' };
  }
  const climbFpm = Number.isFinite(Number(climbFtPerMin)) && Number(climbFtPerMin) >= 300 ? Number(climbFtPerMin) : DEFAULT_CLIMB_FPM;
  const climbGs = Number.isFinite(Number(climbGsKt)) && Number(climbGsKt) >= 80 ? Number(climbGsKt) : DEFAULT_CLIMB_GS_KT;
  const descentGradient = Number.isFinite(Number(descentFtPerNm)) && Number(descentFtPerNm) >= 50 ? Number(descentFtPerNm) : DEFAULT_DESCENT_FT_NM;
  const climbGradient = (climbFpm / climbGs) * 60;   // ft per nm

  const departureElev = altitudes[0] || (Number(points[0].k === 'apt' ? points[0].elev : 0) || 0);
  const destinationElev = Number.isFinite(Number(destinationElevFt))
    ? Number(destinationElevFt)
    : (altitudes[points.length - 1] || 0);
  const notes = [];
  let tocSource = 'estimate';
  let todSource = 'estimate';

  // ── Top of climb ────────────────────────────────────────────────
  // The plan's own altitudes describe the climb it expects: the first fix at
  // cruise ends it, and the fix before it starts the last part of the climb.
  let tocNm = null;
  let firstCruiseIndex = -1;
  for (let i = 1; i < points.length - 1; i++) {
    if (altitudes[i] != null && altitudes[i] >= cruise - 100) { firstCruiseIndex = i; break; }
  }
  if (firstCruiseIndex > 0) {
    const beforeIndex = firstCruiseIndex - 1;
    const beforeAlt = altitudes[beforeIndex];
    const atAlt = altitudes[firstCruiseIndex];
    const legNm = cumulative[firstCruiseIndex] - cumulative[beforeIndex];
    if (beforeAlt != null && atAlt != null && atAlt > beforeAlt && legNm > 0) {
      tocNm = cumulative[beforeIndex] + legNm * Math.max(0, Math.min(1, (cruise - beforeAlt) / (atAlt - beforeAlt)));
      tocSource = 'plan';
    } else if (legNm > 0) {
      tocNm = cumulative[firstCruiseIndex];
      tocSource = 'plan';
    }
  }
  if (tocNm == null) {
    // No planned altitudes: the gradient decides, from the departure field.
    tocNm = (cruise - (departureElev || 0)) / climbGradient;
    notes.push(`Climb estimated at ${Math.round(climbFpm)} fpm and ${Math.round(climbGs)} kt (${Math.round(climbGradient)} ft/nm).`);
  }
  // A plan that reaches cruise on its second fix has no room for a marker.
  if (tocNm < MIN_END_CLEARANCE_NM || cumulative[1] < MIN_END_CLEARANCE_NM) tocNm = Math.max(tocNm, MIN_END_CLEARANCE_NM);

  // ── Top of descent ──────────────────────────────────────────────
  // The gradient says where a stable descent to the destination elevation
  // begins; the plan's own altitudes say where it actually leaves cruise. The
  // marker goes at the later of the two, so it never contradicts a constraint.
  const descentDistance = Math.max(0, cruise - (destinationElev || 0)) / descentGradient;
  const gradientTodNm = totalNm - descentDistance;
  let planTodNm = null;
  let lastCruiseIndex = -1;
  for (let i = points.length - 2; i >= 1; i--) {
    if (altitudes[i] != null && altitudes[i] >= cruise - 100) { lastCruiseIndex = i; break; }
  }
  if (lastCruiseIndex > 0) {
    const nextAlt = altitudes[lastCruiseIndex + 1];
    planTodNm = cumulative[lastCruiseIndex];
    if (nextAlt != null && nextAlt < cruise - 100) {
      const legNm = cumulative[lastCruiseIndex + 1] - cumulative[lastCruiseIndex];
      const fromAlt = altitudes[lastCruiseIndex];
      if (legNm > 0 && fromAlt != null && fromAlt > nextAlt) {
        // Where the descent would cross cruise altitude on this leg is the
        // fix itself; the marker belongs at the start of that leg.
        planTodNm = cumulative[lastCruiseIndex];
      }
    }
    todSource = 'plan';
  }
  let todNm = gradientTodNm;
  if (planTodNm != null) todNm = Math.max(gradientTodNm, planTodNm);
  if (todSource === 'plan' && planTodNm != null && gradientTodNm < planTodNm) {
    notes.push('The plan leaves cruise earlier than a straight gradient would; the marker follows the plan.');
  }
  if (todSource !== 'plan' || planTodNm == null) {
    notes.push(`Descent estimated at ${Math.round(descentGradient)} ft/nm to ${Math.round(destinationElev)} ft.`);
  }
  if (!(descentDistance > 0)) {
    return { ok: false, reason: 'The destination is not below the cruising level.' };
  }
  todNm = Math.min(totalNm - MIN_END_CLEARANCE_NM, Math.max(todNm, MIN_END_CLEARANCE_NM));

  // A descent before the climb ends is not a profile: say so instead of
  // drawing two markers on top of each other.
  if (!(todNm > tocNm)) {
    return { ok: false, reason: 'This plan has no room between top of climb and top of descent.' };
  }

  const toc = positionAlong(points, tocNm);
  const tod = positionAlong(points, todNm);
  if (!toc || !tod) return { ok: false, reason: 'The markers fall outside the route.' };

  return {
    ok: true,
    cruiseFt: Math.round(cruise),
    departureElevFt: Math.round(departureElev || 0),
    destinationElevFt: Math.round(destinationElev || 0),
    climbFtPerNm: Math.round(climbGradient),
    descentFtPerNm: Math.round(descentGradient),
    totalNm,
    toc: { ...toc, altFt: Math.round(cruise), source: tocSource },
    tod: { ...tod, altFt: Math.round(cruise), source: todSource },
    notes,
  };
}

/** Small label wording for a marker: a plan figure reads differently from an estimate. */
export function altitudeLabel(altFt, source) {
  const value = Number(altFt);
  if (!Number.isFinite(value) || value <= 0) return '';
  const text = value >= 18000 ? `FL${String(Math.round(value / 100)).padStart(3, '0')}` : `${Math.round(value)} ft`;
  return source === 'estimate' ? `≈${text}` : text;
}
