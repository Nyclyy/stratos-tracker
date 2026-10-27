/* Flight Plan Builder model.
 *
 * One ordered list of points is the plan: the departure is the first point, the
 * arrival the last, and every fix, navaid or published procedure leg sits in
 * between. The builder, the Navigator and the Flight Deck all read the same
 * stored object, so a plan built here cannot drift from the route the map draws.
 *
 * The rules this module keeps:
 *  - Nothing is invented. A waypoint comes from an airport or navaid record, a
 *    published CIFP leg, or a coordinate the pilot typed. A procedure that the
 *    navigation data does not publish is reported, never approximated.
 *  - A fuel figure names where it came from (entered, SimBrief, calculated from
 *    a stated burn rate). There is no aircraft performance model here, so an
 *    automatic estimate is only offered when a burn rate has a real source.
 *  - Step gating is a model rule, not a UI habit: no departure, no route.
 *
 * Pure functions only — no DOM, no storage, no fetch. The page owns those.
 */

import { bearingDeg, distanceNm, validLatLon } from './geo.js';
import { normalizeWaypoint, routeLegs, routeTotals } from './planner.js';
import { normalizeRunway } from './procedures.js';

/** The workflow, in order. The page renders this list, never its own copy. */
export const STEPS = [
  { id: 'departure', label: 'Departure', hint: 'Choose the departure airport first' },
  { id: 'route', label: 'Route', hint: 'Add fixes, navaids and published legs' },
  { id: 'arrival', label: 'Arrival', hint: 'Choose where the flight ends' },
  { id: 'procedures', label: 'Procedures', hint: 'SID, STAR and runways from the nav data' },
  { id: 'fuel', label: 'Fuel & alternate', hint: 'Trip fuel and a diversion' },
  { id: 'review', label: 'Review', hint: 'Check it, then send it to the map' },
];

export const STEP_IDS = STEPS.map(step => step.id);

/** The exact sentence the builder shows when a waypoint is attempted too early. */
export const NO_DEPARTURE = 'Please select a departure airport before adding waypoints to your flight plan.';

export const MAX_POINTS = 200;
export const ROUTE_KEY = 'stratos.activeRoute';
export const MAP_ROUTE_KEY = 'dl.route';

const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
};

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(length, Number.isFinite(Number(index)) ? Number(index) : length));
}

/* ── points ──────────────────────────────────────────────────────────── */

/** An airport stop, from a directory row or a bundled record. */
export function normalizeStop(value) {
  if (!value) return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  if (!validLatLon(lat, lon)) return null;
  const id = String(value.id || value.icao || '').trim().toUpperCase().slice(0, 12);
  if (!id) return null;
  return {
    id,
    name: String(value.name || id).slice(0, 80),
    lat, lon,
    elev: numOrNull(value.elev) == null ? 0 : Math.round(numOrNull(value.elev)),
    kind: 'apt',
    altFt: null,
    ss: '',
    aw: '',
    source: String(value.source || '').slice(0, 40),
  };
}

/** Any route point: airport, navaid, fix or a published procedure leg. */
export function normalizeFix(value) {
  const base = normalizeWaypoint(value);
  if (!base) return null;
  return {
    ...base,
    name: String(value.name || base.id).slice(0, 80),
    altFt: numOrNull(value.altFt) == null ? null : Math.round(numOrNull(value.altFt)),
    ss: String(value.ss || '').slice(0, 16),
    aw: String(value.aw || '').slice(0, 16),
    source: String(value.source || '').slice(0, 40),
  };
}

function prepare(points) {
  return (Array.isArray(points) ? points : []).map(normalizeFix).filter(Boolean);
}

/** Consecutive duplicates are one point, wherever they came from. */
export function dedupePoints(points) {
  const out = [];
  for (const point of prepare(points)) {
    const previous = out[out.length - 1];
    if (previous && previous.id === point.id && distanceNm(previous, point) < 0.1) continue;
    out.push(point);
  }
  return out;
}

function stripProcedure(points, kind) {
  const tag = String(kind || '').toUpperCase();
  return points.filter(point => String(point.ss || '').toUpperCase() !== tag);
}

function sync(plan) {
  const points = (plan.points || []).slice();
  const origin = points.length && points[0].kind === 'apt' ? points[0] : null;
  const destination = points.length > 1 && points[points.length - 1].kind === 'apt'
    ? points[points.length - 1]
    : null;
  // A procedure belongs to the airport it was published for. When the plan's
  // endpoints change, the record for the old airport is dropped rather than
  // shown against a field it does not belong to.
  const belongs = (record, stop) => Boolean(record && stop && String(record.airport || '').toUpperCase() === stop.id);
  return {
    ...plan,
    points,
    origin,
    destination,
    sid: belongs(plan.sid, origin) ? plan.sid : null,
    star: belongs(plan.star, destination) ? plan.star : null,
  };
}

/** Keep a name the pilot typed; drop an automatic one that no longer fits. */
function keepName(previous, next) {
  const auto = !previous.name || previous.name === planName(previous);
  return { ...next, name: auto ? '' : previous.name };
}

export function createPlan(overrides = {}) {
  return sync({
    name: '',
    savedId: null,
    dirty: false,
    points: [],
    origin: null,
    destination: null,
    alternate: null,
    departureRwy: '',
    arrivalRwy: '',
    sid: null,
    star: null,
    cruiseKts: 450,
    cruiseAlt: 35000,
    fuel: {
      mode: 'auto',
      unit: 'kg',
      burnUnit: '',
      burnPerHour: '',
      burnSource: 'plan',
      contingencyPct: 5,
      reserveMin: 30,
      taxiMin: 12,
      extra: '',
      components: {},
    },
    weather: { status: 'idle', rows: [], challenges: [], error: '', fetchedAt: 0 },
    sources: [],
    builtAt: null,
    ...overrides,
  });
}

/** Default route name from the current endpoints. */
export function planName(plan) {
  const origin = plan.origin && plan.origin.id;
  const destination = plan.destination && plan.destination.id;
  if (origin && destination) return `${origin} → ${destination}`;
  if (origin) return `${origin} departure`;
  return 'Untitled flight plan';
}

export function planDisplayName(plan) {
  return String(plan.name || '').trim() || planName(plan);
}

/* ── editing ─────────────────────────────────────────────────────────── */

/**
 * Set the departure airport.
 *
 * `keepRoute` is the normal case: the pilot changes the airport at the start of
 * a route they built and the fixes stay. Pass `keepRoute: false` when the plan
 * was seeded from another flight (the shared route left by the Flight Deck or a
 * SimBrief import) — that route belongs to a different origin, so keeping its
 * fixes would join, say, a Seattle departure to fixes over Greece and report a
 * 10,000 nm flight. The rest of the plan is dropped with it, including the
 * arrival, because the arrival belonged to the same abandoned route.
 */
export function setDeparture(plan, stop, { keepRoute = true } = {}) {
  const airport = normalizeStop(stop);
  if (!airport) return { ok: false, error: 'That airport has no usable coordinates.' };
  if (plan.origin && plan.origin.id === airport.id) return { ok: true, plan };
  if (!keepRoute) {
    return {
      ok: true,
      plan: sync(keepName(plan, {
        ...plan,
        points: [airport],
        sid: null,
        star: null,
        departureRwy: '',
        arrivalRwy: '',
        dirty: true,
      })),
    };
  }
  const rest = stripProcedure((plan.points || []).slice(1), 'SID');
  const next = sync(keepName(plan, {
    ...plan,
    points: [airport, ...rest],
    sid: null,
    departureRwy: '',
    dirty: true,
  }));
  return { ok: true, plan: next };
}

export function setArrival(plan, stop) {
  if (!plan.origin) return { ok: false, blocked: 'no-departure', message: NO_DEPARTURE };
  const airport = normalizeStop(stop);
  if (!airport) return { ok: false, error: 'That airport has no usable coordinates.' };
  if (plan.destination && plan.destination.id === airport.id) return { ok: true, plan };
  const points = stripProcedure((plan.points || []).slice(), 'STAR');
  if (plan.destination && points.length > 1) points[points.length - 1] = airport;
  else points.push(airport);
  return {
    ok: true,
    plan: sync(keepName(plan, { ...plan, points, star: null, arrivalRwy: '', dirty: true })),
  };
}

export function clearArrival(plan) {
  if (!plan.origin) return plan;
  return sync(keepName(plan, {
    ...plan,
    points: stripProcedure((plan.points || []).slice(0, 1), 'STAR'),
    star: null,
    arrivalRwy: '',
    dirty: true,
  }));
}

/**
 * Add a point. The rule lives here so no caller (a search result, a map tap, a
 * navaid button) can slip a waypoint into a plan that has no departure.
 */
export function addPoint(plan, raw, options = {}) {
  if (!plan.origin) return { ok: false, blocked: 'no-departure', message: NO_DEPARTURE };
  const point = normalizeFix(raw);
  if (!point) return { ok: false, error: 'That point has no usable coordinates.' };
  const points = (plan.points || []).slice();
  if (points.length >= MAX_POINTS) {
    return { ok: false, error: `Flight plans are limited to ${MAX_POINTS} route points.` };
  }
  // Between the departure and the arrival, never after the arrival.
  const limit = plan.destination ? points.length - 1 : points.length;
  const at = clampIndex(options.index, limit);
  points.splice(at, 0, point);
  // The same fix at the same place is one point in the plan. The copy that was
  // just added wins, so a repeated tap or a procedure leg already on the route
  // moves the point instead of drawing the same leg twice.
  const kept = points.filter((candidate, index) => index === at
    || !(candidate.id === point.id && distanceNm(candidate, point) < 0.1));
  const cleaned = kept.filter((candidate, index) => index === 0
    || !(candidate.id === kept[index - 1].id && distanceNm(candidate, kept[index - 1]) < 0.1));
  return { ok: true, plan: sync({ ...plan, points: cleaned, dirty: true }) };
}

export function insertPointAt(plan, index, raw) {
  return addPoint(plan, raw, { index });
}

export function removePoint(plan, index) {
  const points = (plan.points || []).slice();
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= points.length) return plan;
  if (at === 0) return plan; // the departure is a step, not a row to delete
  if (plan.destination && at === points.length - 1) return clearArrival(plan);
  const removed = points[at];
  points.splice(at, 1);
  return sync({
    ...plan,
    points,
    // Removing a leg the SID or STAR had drawn means that procedure no longer
    // matches the route; keep it selected but say it is partial.
    sid: plan.sid && String(removed.ss).toUpperCase() === 'SID' ? { ...plan.sid, partial: true } : plan.sid,
    star: plan.star && String(removed.ss).toUpperCase() === 'STAR' ? { ...plan.star, partial: true } : plan.star,
    dirty: true,
  });
}

export function movePoint(plan, from, to) {
  const points = (plan.points || []).slice();
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return plan;
  if (start < 1 || start >= points.length || end < 1 || end >= points.length) return plan;
  const [item] = points.splice(start, 1);
  points.splice(end, 0, item);
  return sync({ ...plan, points, dirty: true });
}

export function movePointPosition(plan, index, position) {
  const points = (plan.points || []).slice();
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= points.length) return plan;
  if (!position || !validLatLon(Number(position.lat), Number(position.lon))) return plan;
  points[at] = { ...points[at], lat: Number(position.lat), lon: Number(position.lon) };
  return sync({ ...plan, points, dirty: true });
}

export function setAlternate(plan, stop) {
  if (!stop) return sync({ ...plan, alternate: null, dirty: true });
  const airport = normalizeStop(stop);
  if (!airport) return plan;
  if (plan.destination && airport.id === plan.destination.id) return plan;
  return sync({ ...plan, alternate: airport, dirty: true });
}

export function setCruise(plan, { kts, altFt } = {}) {
  const speed = Number(kts);
  const altitude = Number(altFt);
  return {
    ...plan,
    cruiseKts: Number.isFinite(speed) && speed >= 60 && speed <= 700 ? Math.round(speed) : plan.cruiseKts,
    cruiseAlt: Number.isFinite(altitude) && altitude >= 1000 && altitude <= 60000 ? Math.round(altitude) : plan.cruiseAlt,
    dirty: true,
  };
}

/* ── route rows and totals ───────────────────────────────────────────── */

/** The route with leg distance, track and distance from the departure. */
export function routeRows(plan) {
  const points = prepare(plan.points);
  const legs = routeLegs(points);
  let cumulative = 0;
  return points.map((point, index) => {
    const leg = legs[index - 1];
    if (leg) cumulative += leg.distanceNm;
    return {
      ...point,
      index,
      legNm: leg ? leg.distanceNm : null,
      legTrack: leg ? leg.initialBearing : null,
      cumNm: cumulative,
      role: index === 0 ? 'departure'
        : index === points.length - 1 && points.length > 1 ? 'arrival'
          : 'route',
    };
  });
}

export function routeSummary(plan) {
  const points = prepare(plan.points);
  const totals = points.length > 1
    ? routeTotals(points, { cruiseKts: plan.cruiseKts, cruiseAlt: plan.cruiseAlt })
    : null;
  return {
    points,
    rows: routeRows(plan),
    distanceNm: totals ? totals.distanceNm : 0,
    eteMinutes: totals ? totals.eteMinutes : 0,
    cruiseAlt: plan.cruiseAlt,
    cruiseKts: plan.cruiseKts,
    estimated: Boolean(totals),
  };
}

/* ── validation and step gating ──────────────────────────────────────── */

export function validatePlan(plan) {
  const errors = [];
  const warnings = [];
  const points = prepare(plan.points);

  if (!plan.origin) {
    errors.push({ code: 'no-departure', step: 'departure', message: 'Choose a departure airport.' });
  }
  if (plan.origin && !plan.destination) {
    errors.push({ code: 'no-arrival', step: 'arrival', message: 'Choose an arrival airport.' });
  }
  if (points.length > MAX_POINTS) {
    errors.push({ code: 'too-long', step: 'route', message: `A plan is limited to ${MAX_POINTS} route points.` });
  }
  points.forEach((point, index) => {
    if (index === 0 && point.kind !== 'apt') {
      errors.push({ code: 'departure-not-airport', step: 'departure', message: 'The first point of the plan must be the departure airport.' });
    }
    if (index === points.length - 1 && points.length > 1 && point.kind !== 'apt') {
      errors.push({ code: 'arrival-not-airport', step: 'arrival', message: 'The last point of the plan must be the arrival airport.' });
    }
  });

  const legs = routeLegs(points);
  const totalNm = legs.reduce((sum, leg) => sum + leg.distanceNm, 0);
  if (points.length > 1 && totalNm < 1) {
    warnings.push({ code: 'very-short', step: 'route', message: 'The total route distance is under 1 nm.' });
  }
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous && previous.id === point.id && distanceNm(previous, point) < 0.1) {
      warnings.push({ code: 'duplicate', step: 'route', message: `${point.id} appears twice in a row.` });
    }
  });

  if (plan.sid && plan.sid.partial) {
    warnings.push({ code: 'sid-partial', step: 'procedures', message: `The route no longer carries every ${plan.sid.id} leg, so the SID is only partly in the plan.` });
  }
  if (plan.star && plan.star.partial) {
    warnings.push({ code: 'star-partial', step: 'procedures', message: `The route no longer carries every ${plan.star.id} leg, so the STAR is only partly in the plan.` });
  }
  if (plan.sid && plan.sid.complete === false) {
    warnings.push({ code: 'sid-incomplete', step: 'procedures', message: `${plan.sid.id} has legs the navigation data could not place; only the verified legs were added.` });
  }
  if (plan.star && plan.star.complete === false) {
    warnings.push({ code: 'star-incomplete', step: 'procedures', message: `${plan.star.id} has legs the navigation data could not place; only the verified legs were added.` });
  }
  if (plan.origin && plan.destination && plan.origin.id === plan.destination.id) {
    errors.push({ code: 'same-airport', step: 'arrival', message: 'The departure and the arrival are the same airport.' });
  }

  return {
    errors,
    warnings,
    points,
    totalNm,
    legs,
    canBuildRoute: Boolean(plan.origin),
    canContinueToProcedures: errors.length === 0 && Boolean(plan.origin && plan.destination) && points.length >= 2,
    canFinish: errors.length === 0 && Boolean(plan.destination) && points.length >= 2,
  };
}

/** Which steps the pilot can open, and which are done, given the plan. */
/**
 * Which steps the plan has actually finished.
 *
 * `burnPerHour` is the cruise fuel flow in use when the pilot has not typed
 * one — the builder resolves that from the loaded plan — so the fuel step is
 * only marked done when there is a flow to compute with. `burnSource: 'plan'`
 * alone says where a flow would come from, not that one exists.
 */
export function stepState(plan, { burnPerHour = null } = {}) {
  const check = validatePlan(plan);
  const hasRoute = check.points.length >= 2;
  const fuel = plan.fuel || {};
  const manualBasis = fuel.mode === 'manual'
    && (Number(fuel.block) > 0 || Object.values(fuel.components || {}).some(value => Number(value) > 0));
  const autoBasis = fuel.mode !== 'manual'
    && (Number(burnPerHour) > 0 || Number(fuel.burnPerHour) > 0);
  const done = {
    departure: Boolean(plan.origin),
    route: Boolean(plan.origin) && hasRoute,
    arrival: Boolean(plan.destination),
    procedures: Boolean(plan.sid || plan.star),
    fuel: Boolean(hasRoute && (manualBasis || autoBasis)),
    review: false,
  };
  return STEPS.map(step => ({
    ...step,
    done: Boolean(done[step.id]),
    available: step.id === 'departure'
      || (step.id === 'route' && Boolean(plan.origin))
      || (step.id === 'arrival' && Boolean(plan.origin))
      || (['procedures', 'fuel', 'review'].includes(step.id) && Boolean(plan.destination) && hasRoute),
  }));
}

/* ── procedures ──────────────────────────────────────────────────────── */

export function procedureList(payload, kind) {
  const list = payload && payload.procedures && payload.procedures[String(kind || '').toLowerCase()];
  return Array.isArray(list) ? list : [];
}

function findProcedure(payload, kind, ident) {
  const wanted = String(ident || '').trim().toUpperCase();
  return procedureList(payload, kind).find(procedure => String(procedure.id || '').toUpperCase() === wanted) || null;
}

function isTrunkTransition(transition) {
  const id = String((transition && transition.id) || '').toUpperCase();
  return id === '' || id === 'ALL';
}

/** Published pavement for the airport, from the CIFP runway records. */
export function runwaysFromPayload(payload) {
  const runways = (payload && payload.runways) || {};
  return Object.entries(runways)
    .filter(([, record]) => record && Number.isFinite(Number(record.lat)) && Number.isFinite(Number(record.lon)))
    .map(([id, record]) => ({ id, lat: Number(record.lat), lon: Number(record.lon) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const ROLE_RANK = { runway: 0, common: 1, enroute: 2 };

/** The runway a published transition belongs to, or an empty string. */
export function runwayFromTransitionId(id) {
  return normalizeRunway(id);
}

/** Every transition one procedure publishes, with the role it plays. */
export function procedureTransitions(procedure) {
  const list = Array.isArray(procedure && procedure.transitions) ? procedure.transitions : [];
  return list.map(transition => {
    const id = String(transition.id || '');
    const points = Array.isArray(transition.points) ? transition.points : [];
    const runway = normalizeRunway(transition.runway || (id.toUpperCase().startsWith('RW') ? id : ''));
    const role = isTrunkTransition(transition) ? 'common' : runway ? 'runway' : 'enroute';
    return {
      id,
      role,
      runway,
      combined: Boolean(transition.combined),
      points: points.length,
      complete: transition.complete !== false,
      skipped: Number(transition.skipped) || 0,
      first: points[0] ? String(points[0].id || '') : '',
      last: points[points.length - 1] ? String(points[points.length - 1].id || '') : '',
      label: role === 'common' ? 'Common legs'
        : role === 'runway' ? `Runway ${runway || id.replace(/^RW/i, '')}`
          : id,
    };
  }).sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.id.localeCompare(b.id));
}

function transitionById(procedure, id) {
  const wanted = String(id || '').toUpperCase();
  if (!wanted) return null;
  const list = Array.isArray(procedure && procedure.transitions) ? procedure.transitions : [];
  return list.find(transition => String(transition.id || '').toUpperCase() === wanted) || null;
}

function runwayTransitionFor(procedure, runway) {
  const rwy = normalizeRunway(runway);
  if (!procedure || !rwy) return null;
  const list = Array.isArray(procedure.transitions) ? procedure.transitions : [];
  return list.find(transition => String(transition.id || '').toUpperCase() === 'RW' + rwy)
    || list.find(transition => String(transition.id || '').toUpperCase() === `RW${rwy.slice(0, 2)}B`)
    || null;
}

function usablePoints(transition) {
  return (Array.isArray(transition && transition.points) ? transition.points : [])
    .filter(point => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)))
    .map(point => ({ id: String(point.id || ''), lat: Number(point.lat), lon: Number(point.lon), runway: Boolean(point.runway) }));
}

function joinParts(parts) {
  const out = [];
  for (const part of parts) {
    for (const point of part) {
      const previous = out[out.length - 1];
      if (previous && String(previous.id).toUpperCase() === String(point.id).toUpperCase()
        && Math.abs(previous.lat - point.lat) < 1e-5 && Math.abs(previous.lon - point.lon) < 1e-5) continue;
      out.push(point);
    }
  }
  return out;
}

/**
 * The verified geometry of one procedure as it belongs in this plan.
 *
 * ARINC 424 splits a terminal procedure into a runway transition, a common
 * trunk and en-route transitions. This joins only those pieces, in the order
 * the procedure is actually flown, and reports which pieces are missing rather
 * than drawing over the gap.
 */
export function procedureRoute(payload, options = {}) {
  const kind = String(options.kind || '').toLowerCase();
  if (!['sid', 'star'].includes(kind)) return { ok: false, reason: 'bad-request', error: 'A procedure is a SID or a STAR.' };
  if (!payload || !payload.ok) {
    return {
      ok: false,
      reason: 'unavailable',
      error: (payload && payload.error) || 'The navigation data is not available for this airport.',
    };
  }
  const procedure = findProcedure(payload, kind, options.ident);
  if (!procedure) {
    return { ok: false, reason: 'not-in-data', error: `The navigation data has no ${kind.toUpperCase()} ${String(options.ident || '').toUpperCase()} at ${payload.airport || 'this airport'}.` };
  }

  const runway = normalizeRunway(options.runway);
  const explicitRunway = options.runwayTransition == null ? null : transitionById(procedure, options.runwayTransition);
  const runwayTransition = explicitRunway || (runway ? runwayTransitionFor(procedure, runway) : null);
  const enrouteTransition = options.enrouteTransition ? transitionById(procedure, options.enrouteTransition) : null;
  const trunk = (procedure.transitions || []).find(isTrunkTransition) || null;

  const chosenRunwayId = runwayTransition ? String(runwayTransition.id || '') : '';
  const chosenEnrouteId = enrouteTransition ? String(enrouteTransition.id || '') : '';
  const threshold = runway && payload.runways && payload.runways[runway] ? payload.runways[runway] : null;
  const airport = String(payload.airport || '').toUpperCase();
  const runwayPoint = threshold && Number.isFinite(Number(threshold.lat)) && Number.isFinite(Number(threshold.lon))
    ? { id: 'RW' + runway, lat: Number(threshold.lat), lon: Number(threshold.lon), runway: true }
    : null;

  const pieces = [];
  const roles = [];
  const addPiece = (transition, role) => {
    if (!transition) return;
    const points = usablePoints(transition);
    if (!points.length) return;
    pieces.push(points);
    roles.push({ role, id: String(transition.id || ''), points: points.length, complete: transition.complete !== false, skipped: Number(transition.skipped) || 0 });
  };

  if (kind === 'sid') {
    if (runwayTransition) {
      addPiece(runwayTransition, 'runway');
    } else if (runwayPoint) {
      pieces.push([runwayPoint]);
      roles.push({ role: 'runway', id: runwayPoint.id, points: 1, complete: true, skipped: 0 });
    }
    addPiece(trunk, 'common');
    addPiece(enrouteTransition, 'enroute');
  } else {
    addPiece(enrouteTransition, 'enroute');
    addPiece(trunk, 'common');
    addPiece(runwayTransition, 'runway');
  }

  // The airport itself is the plan's own stop, so a procedure never repeats it;
  // the approach wants vectors to the field, and carrying that point here would
  // draw the route into the middle of the airport and back out again.
  const withoutAirport = parts => parts.filter(point => String(point.id).toUpperCase() !== airport);
  let points = withoutAirport(joinParts(pieces));
  if (!points.length) {
    // Plenty of real procedures carry no common trunk at all: every leg lives
    // inside a runway or en-route transition. That is a choice still to be
    // made, not missing data, and it is said that way.
    const transitionLegs = (procedure.transitions || []).some(transition => usablePoints(transition).length);
    return {
      ok: false,
      reason: transitionLegs ? 'needs-transition' : 'empty',
      error: transitionLegs
        ? `${procedure.id} publishes its legs inside its transitions. Choose a transition and its published legs are placed in the plan.`
        : `${procedure.id} has no verified legs in this data.`,
    };
  }

  const startsOnRunway = runwayPoint && String(points[0].id).toUpperCase() === runwayPoint.id;
  const endsOnRunway = runwayPoint && String(points[points.length - 1].id).toUpperCase() === runwayPoint.id;
  if (kind === 'sid') {
    // A SID starts on the runway. When the source published no runway legs the
    // threshold the data carries is joined to the first fix by one connector.
    if (!chosenRunwayId && runwayPoint && !startsOnRunway) points = [runwayPoint, ...points];
  } else if (runwayPoint && !endsOnRunway) {
    // A STAR ends on the runway the plan names, not on the airport reference
    // point; the threshold is the last published coordinate of the arrival.
    points = [...points, runwayPoint];
  }

  const missingRunway = Boolean(runway) && !chosenRunwayId;
  const complete = roles.every(role => role.complete);
  const identity = roles.filter(role => role.role !== 'common' && role.id).map(role => role.id);
  return {
    ok: true,
    kind,
    id: procedure.id,
    airport,
    runway,
    runwayTransition: chosenRunwayId,
    enrouteTransition: chosenEnrouteId,
    points,
    roles,
    complete,
    skipped: roles.reduce((sum, role) => sum + (role.complete ? 0 : role.skipped), 0),
    source: String(payload.source || ''),
    cycle: String(payload.cycle || ''),
    missingRunway,
    connectorOnly: missingRunway && Boolean(runwayPoint),
    label: identity.length ? `${procedure.id} · ${identity.join(' + ')}` : procedure.id,
  };
}

/**
 * Which transition best fits what the pilot has already planned: the runway
 * transition for the chosen runway, and the en-route transition whose published
 * end sits on a planned fix. A suggestion, never a clearance.
 */
export function suggestTransitions(payload, { kind, ident, runway, routeIds = [], airport = '' } = {}) {
  const procedure = findProcedure(payload, kind, ident);
  if (!procedure) return { runway: '', enroute: '', reason: '' };
  const published = procedureTransitions(procedure);
  const rwy = normalizeRunway(runway);
  const recommendedRunway = rwy
    ? published.find(entry => entry.role === 'runway' && entry.runway === rwy) || null
    : null;
  const fixIds = new Set((routeIds || []).map(id => String(id || '').toUpperCase()).filter(Boolean));
  const others = published.filter(entry => entry.role === 'enroute' && !fixIds.has(entry.id.toUpperCase()));
  const startFix = String(airport || '').toUpperCase();
  let enroute = null;
  // A SID's en-route transition ends on the fix the flight continues from; a
  // STAR's begins on the fix the flight arrives from. Match the end that the
  // planned route actually touches.
  if (kind === 'sid') {
    enroute = others.find(entry => fixIds.has(entry.last.toUpperCase())) || null;
  } else {
    enroute = others.find(entry => fixIds.has(entry.first.toUpperCase())) || null;
  }
  const reasons = [];
  if (recommendedRunway) reasons.push(`runway ${rwy} transition`);
  if (enroute) reasons.push(`${enroute.id} meets the planned route`);
  return {
    runway: recommendedRunway ? recommendedRunway.id : '',
    enroute: enroute ? enroute.id : '',
    reason: reasons.length ? `Suggested from ${reasons.join(' and ')}` : `No transition could be matched to the plan${startFix ? ` for ${startFix}` : ''}`,
  };
}

/**
 * Insert a procedure's verified points into the plan. Points the plan already
 * carries stay where they are; the rest are added at the airport end they
 * belong to, and a previous selection of the same kind is replaced rather than
 * stacked on top, so re-applying a SID cannot duplicate the route.
 */
export function applyProcedure(plan, kind, route) {
  const tag = String(kind || '').toLowerCase() === 'star' ? 'STAR' : 'SID';
  if (!route || !route.ok) return { ok: false, error: (route && route.error) || 'That procedure is not available.' };
  if (tag === 'SID' && !plan.origin) return { ok: false, blocked: 'no-departure', message: NO_DEPARTURE };
  if (tag === 'STAR' && !plan.destination) return { ok: false, blocked: 'no-arrival', message: 'Select an arrival airport before adding a STAR.' };

  const anchor = tag === 'SID' ? plan.origin.id : plan.destination.id;
  let base = stripProcedure((plan.points || []).slice(), tag);
  const points = [];
  for (const point of route.points) {
    const id = String(point.id || '').toUpperCase();
    if (!id || id === anchor) continue;
    const previous = points[points.length - 1];
    if (previous && previous.id === id && distanceNm(previous, point) < 0.1) continue;
    points.push({
      id,
      name: id,
      lat: Number(point.lat),
      lon: Number(point.lon),
      elev: 0,
      kind: 'fix',
      altFt: null,
      ss: tag,
      aw: '',
      source: 'procedure',
    });
  }
  if (!points.length) {
    return { ok: false, error: `${route.id} publishes no leg that can be added to this plan.` };
  }

  let next;
  if (tag === 'SID') {
    // After the departure, before anything the pilot added.
    const tail = base.slice(1);
    next = [base[0], ...points, ...tail.filter(point => !points.some(added => added.id === point.id && distanceNm(added, point) < 0.1))];
  } else {
    const head = base.slice(0, -1);
    next = [...head.filter(point => !points.some(added => added.id === point.id && distanceNm(added, point) < 0.1)), ...points, base[base.length - 1]];
  }
  const record = {
    id: route.id,
    airport: String(route.airport || anchor),
    runway: route.runway || '',
    runwayTransition: route.runwayTransition || '',
    enrouteTransition: route.enrouteTransition || '',
    label: route.label || route.id,
    points: points.length,
    complete: route.complete !== false,
    connectorOnly: Boolean(route.connectorOnly),
    missingRunway: Boolean(route.missingRunway),
    source: route.source || '',
    cycle: route.cycle || '',
    appliedAt: Date.now(),
    partial: false,
  };
  const patched = tag === 'SID'
    ? { ...plan, points: next, sid: record, departureRwy: route.runway || plan.departureRwy }
    : { ...plan, points: next, star: record, arrivalRwy: route.runway || plan.arrivalRwy };
  return { ok: true, plan: sync({ ...patched, dirty: true }) };
}

export function clearProcedure(plan, kind) {
  const tag = String(kind || '').toLowerCase() === 'star' ? 'STAR' : 'SID';
  const points = stripProcedure(plan.points || [], tag);
  return sync({
    ...plan,
    points,
    sid: tag === 'SID' ? null : plan.sid,
    star: tag === 'STAR' ? null : plan.star,
    dirty: true,
  });
}

/* ── fuel ────────────────────────────────────────────────────────────── */

export const FUEL_ROWS = [
  { key: 'taxi', label: 'Taxi fuel' },
  { key: 'trip', label: 'Trip fuel' },
  { key: 'contingency', label: 'Contingency' },
  { key: 'alternate', label: 'Alternate fuel' },
  { key: 'reserve', label: 'Final reserve' },
  { key: 'extra', label: 'Extra fuel' },
];

/** Average cruise burn a plan itself implies: trip fuel over enroute time. */
export function burnFromOfp(ofp) {
  const fuel = ofp && ofp.fuel;
  const times = ofp && ofp.times;
  const trip = Number(fuel && fuel.trip);
  const minutes = Number(times && times.enrouteMin);
  if (!Number.isFinite(trip) || trip <= 0 || !Number.isFinite(minutes) || minutes <= 0) return null;
  return {
    burnPerHour: round((trip / minutes) * 60, 0),
    unit: ofp.units === 'lb' ? 'lb' : 'kg',
    aircraft: [ofp.aircraft && ofp.aircraft.icao, ofp.aircraft && ofp.aircraft.variant].filter(Boolean).join(' '),
    callsign: (ofp.flight && ofp.flight.callsign) || '',
  };
}

/**
 * Fuel breakdown. Every row states whether it was entered, taken from the plan
 * or calculated here, and an input the pilot has not supplied stays missing.
 */
export function fuelEstimate(options = {}) {
  const unit = options.unit === 'lb' ? 'lb' : 'kg';
  const mode = options.mode === 'manual' ? 'manual' : 'auto';
  const notes = [];

  if (mode === 'manual') {
    const entered = options.components || {};
    const rows = FUEL_ROWS.map(row => {
      const value = numOrNull(entered[row.key]);
      return { ...row, value: value == null ? null : Math.max(0, value), source: value == null ? null : 'entered' };
    });
    const parts = rows.filter(row => row.value != null);
    const sum = parts.length ? parts.reduce((total, row) => total + row.value, 0) : null;
    const override = numOrNull(options.block);
    const block = override != null ? Math.max(0, override) : sum;
    const taxi = rows.find(row => row.key === 'taxi');
    const trip = rows.find(row => row.key === 'trip');
    const takeoff = block != null && taxi && taxi.value != null ? block - taxi.value : null;
    const landing = takeoff != null && trip && trip.value != null ? takeoff - trip.value : null;
    const missing = rows.filter(row => row.value == null).map(row => row.label);
    if (!parts.length) {
      return { ok: false, mode, unit, error: 'Enter at least one fuel component, or switch to the automatic estimate.' };
    }
    if (missing.length) notes.push(`Not entered: ${missing.join(', ')}. Those are left out of the total, not treated as zero.`);
    return {
      ok: true,
      mode,
      unit,
      rows,
      block,
      takeoff,
      landing,
      sum,
      difference: block != null && sum != null ? block - sum : null,
      method: 'Manual entry. Nothing here was calculated from a route or an aircraft model.',
      notes,
      missing,
    };
  }

  const routeNm = Number(options.routeNm);
  const burnPerHour = Number(options.burnPerHour);
  const tas = Number(options.cruiseKts);
  const headwind = Number(options.headwindKt) || 0;
  const missing = [];
  if (!(routeNm > 0)) missing.push('Route distance');
  if (!(burnPerHour > 0)) missing.push('Cruise fuel flow');
  if (!(tas > 0)) missing.push('Cruise speed');
  if (missing.length) {
    return {
      ok: false,
      mode,
      unit,
      error: `An automatic estimate needs ${missing.join(', ').toLowerCase()}. ${
        burnPerHour > 0 ? '' : 'Load a SimBrief plan, or enter the burn your aircraft shows at cruise. '}Nothing is assumed on your behalf.`,
      missing,
    };
  }
  // Ground speed from the planned TAS and the wind component the pilot stated.
  // No wind is imported, so a positive number is a headwind the pilot entered.
  const groundSpeed = Math.max(60, tas - headwind);
  const tripHours = routeNm / groundSpeed;
  const trip = burnPerHour * tripHours;
  const taxiMin = Math.max(0, Number(options.taxiMin) || 0);
  const taxi = burnPerHour * (taxiMin / 60);
  const contingencyPct = Math.max(0, Math.min(50, Number(options.contingencyPct) || 0));
  const contingency = trip * (contingencyPct / 100);
  const alternateNm = Math.max(0, Number(options.alternateNm) || 0);
  const alternate = alternateNm > 0 ? burnPerHour * (alternateNm / groundSpeed) : null;
  const reserveMin = Math.max(0, Number(options.reserveMin) || 0);
  const reserve = burnPerHour * (reserveMin / 60);
  const extra = numOrNull(options.extra);

  const rows = [
    { key: 'taxi', label: 'Taxi fuel', value: round(taxi), source: 'calculated', basis: `${taxiMin} min at ${round(burnPerHour)} ${unit}/h` },
    { key: 'trip', label: 'Trip fuel', value: round(trip), source: 'calculated', basis: `${round(routeNm)} nm at ${round(groundSpeed)} kt` },
    { key: 'contingency', label: 'Contingency', value: round(contingency), source: 'calculated', basis: `${round(contingencyPct, 1)}% of trip` },
    { key: 'alternate', label: 'Alternate fuel', value: alternate == null ? null : round(alternate), source: alternate == null ? null : 'calculated', basis: alternate == null ? 'No alternate selected' : `${round(alternateNm)} nm at ${round(groundSpeed)} kt` },
    { key: 'reserve', label: 'Final reserve', value: round(reserve), source: 'calculated', basis: `${reserveMin} min at ${round(burnPerHour)} ${unit}/h` },
    { key: 'extra', label: 'Extra fuel', value: extra == null ? null : Math.max(0, extra), source: extra == null ? null : 'entered', basis: extra == null ? 'None entered' : 'Entered' },
  ];
  const block = rows.reduce((total, row) => total + (row.value || 0), 0);
  const takeoff = block - taxi;
  const landing = takeoff - trip;
  notes.push(`Ground speed ${round(groundSpeed)} kt from ${round(tas)} kt cruise${headwind ? ` and ${round(Math.abs(headwind))} kt ${headwind > 0 ? 'headwind' : 'tailwind'}` : ' with no wind applied'}.`);
  if (contingencyPct) notes.push(`Contingency ${round(contingencyPct, 1)}% and the ${reserveMin} min reserve are the assumptions on this page, not a company fuel policy.`);
  if (!alternateNm) notes.push('No alternate fuel is included: no alternate airport is selected.');
  return {
    ok: true,
    mode,
    unit,
    rows,
    block: round(block),
    takeoff: round(takeoff),
    landing: round(landing),
    sum: round(block),
    difference: 0,
    trip: round(trip),
    groundSpeedKts: round(groundSpeed),
    method: 'Estimated from the route distance, the cruise speed you set and a burn rate with a stated source. No climb, descent or aircraft performance table is applied.',
    notes,
    missing: [],
  };
}

/* ── alternates ──────────────────────────────────────────────────────── */

function longestRunwayFt(airport) {
  const verified = Array.isArray(airport && airport.rws) ? airport.rws : [];
  const verifiedLength = verified
    .map(row => (Array.isArray(row) ? Number(row[6]) : 0))
    .filter(value => Number.isFinite(value) && value > 0);
  if (verifiedLength.length) return { lengthFt: Math.max(...verifiedLength), source: 'verified' };
  const designator = Array.isArray(airport && airport.len) ? airport.len : [];
  const designatorLength = designator.map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (designatorLength.length) return { lengthFt: Math.max(...designatorLength), source: 'designator' };
  return { lengthFt: null, source: 'unknown' };
}

/**
 * Airports near the arrival that could serve as an alternate. A candidate is a
 * geometric fact plus the runway length the data actually states; suitability
 * also needs weather, minima and the operator's policy, so the caller is told
 * what is missing instead of receiving a verdict.
 */
export function alternateCandidates(destination, airports, options = {}) {
  if (!destination || !validLatLon(Number(destination.lat), Number(destination.lon))) return [];
  const maxNm = Number(options.maxNm) > 0 ? Number(options.maxNm) : 250;
  const minRunwayFt = Number(options.minRunwayFt) > 0 ? Number(options.minRunwayFt) : 0;
  const seen = new Set([String(destination.id || '').toUpperCase()]);
  const candidates = [];
  for (const airport of Array.isArray(airports) ? airports : []) {
    if (!airport) continue;
    const id = String(airport.id || airport.icao || '').toUpperCase();
    if (!id || seen.has(id)) continue;
    const lat = Number(airport.lat);
    const lon = Number(airport.lon);
    if (!validLatLon(lat, lon)) continue;
    const distance = distanceNm(destination, { lat, lon });
    if (!(distance > 0.5) || distance > maxNm) continue;
    const runway = longestRunwayFt(airport);
    if (minRunwayFt && (!runway.lengthFt || runway.lengthFt < minRunwayFt)) continue;
    seen.add(id);
    const reasons = [];
    const missing = [];
    reasons.push(`${round(distance)} nm from ${destination.id}`);
    if (runway.lengthFt && runway.source === 'verified') {
      reasons.push(`${Math.round(runway.lengthFt).toLocaleString('en-US')} ft longest runway (threshold data)`);
    } else if (runway.lengthFt) {
      reasons.push(`about ${Math.round(runway.lengthFt).toLocaleString('en-US')} ft longest runway (airport record, not a threshold survey)`);
    } else {
      missing.push('Runway lengths are not in the airport data');
    }
    missing.push('Approach minima and aircraft performance are not assessed');
    missing.push('No weather is fetched until the alternate is checked');
    candidates.push({
      id,
      name: String(airport.name || id),
      lat, lon,
      elev: Number(airport.elev) || 0,
      distanceNm: distance,
      bearing: bearingDeg(destination, { lat, lon }),
      longestRunwayFt: runway.lengthFt,
      runwaySource: runway.source,
      source: String(airport.source || ''),
      reasons,
      missing,
      score: distance - Math.min(120, (runway.lengthFt || 0) / 100),
    });
  }
  return candidates.sort((a, b) => a.score - b.score);
}

/* ── weather freshness ───────────────────────────────────────────────── */

export const WEATHER_STALE_MS = 60 * 60 * 1000;

export function weatherFreshness(fetchedAt, now = Date.now()) {
  const at = Number(fetchedAt);
  if (!Number.isFinite(at) || at <= 0) return { fetchedAt: null, ageMs: null, stale: true, label: 'No observation fetched' };
  const ageMs = Math.max(0, now - at);
  const minutes = Math.round(ageMs / 60000);
  const label = minutes < 1 ? 'fetched just now'
    : minutes < 60 ? `fetched ${minutes} min ago`
      : `fetched ${Math.round(minutes / 60)} h ago`;
  return { fetchedAt: at, ageMs, stale: ageMs > WEATHER_STALE_MS, label };
}

/* ── storage ─────────────────────────────────────────────────────────── */

/** The object both the Navigator and the Flight Deck read. */
export function storedRoute(plan) {
  const points = prepare(plan.points).map(point => ({
    id: point.id,
    name: point.name || point.id,
    lat: round(point.lat, 6),
    lon: round(point.lon, 6),
    kind: point.kind,
    elev: Math.round(point.elev || 0),
    altFt: point.altFt == null ? null : Math.round(point.altFt),
    ss: point.ss || '',
    aw: point.aw || '',
  }));
  return {
    id: plan.savedId || null,
    name: planDisplayName(plan),
    points,
    cruiseKts: plan.cruiseKts,
    cruiseAlt: plan.cruiseAlt,
    dirty: Boolean(plan.dirty),
    plan: {
      version: 1,
      builtAt: Date.now(),
      origin: plan.origin ? normalizeStop(plan.origin) : null,
      destination: plan.destination ? normalizeStop(plan.destination) : null,
      alternate: plan.alternate ? normalizeStop(plan.alternate) : null,
      departureRwy: plan.departureRwy || '',
      arrivalRwy: plan.arrivalRwy || '',
      sid: plan.sid || null,
      star: plan.star || null,
      fuel: { ...plan.fuel, components: { ...(plan.fuel && plan.fuel.components) } },
      sources: plan.sources || [],
    },
  };
}

/** The legacy map copy, kept in step for older builds and the map's own panel. */
export function mapRoute(plan) {
  return prepare(plan.points).map(point => ({
    id: point.id,
    name: point.name || point.id,
    lat: round(point.lat, 6),
    lon: round(point.lon, 6),
    k: point.kind,
    elev: Math.round(point.elev || 0),
    altFt: point.altFt == null ? null : Math.round(point.altFt),
    ss: point.ss || '',
    aw: point.aw || '',
  }));
}

/**
 * Reopen a stored plan. A plan this builder wrote restores in full; a route
 * from the Flight Deck (points only) becomes a plan with its endpoints read
 * from the first and last airports, and says the procedures are unknown.
 */
export function planFromStored(raw) {
  if (!raw || !Array.isArray(raw.points) || raw.points.length < 1) return null;
  const points = dedupePoints(raw.points);
  if (!points.length) return null;
  const saved = raw.plan && typeof raw.plan === 'object' ? raw.plan : null;
  const base = createPlan({
    name: String(raw.name || '').slice(0, 60),
    savedId: raw.id || null,
    dirty: Boolean(raw.dirty),
    points,
    cruiseKts: Number(raw.cruiseKts) > 0 ? Number(raw.cruiseKts) : 450,
    cruiseAlt: Number(raw.cruiseAlt) > 0 ? Number(raw.cruiseAlt) : 35000,
  });
  if (!saved) {
    return sync({
      ...base,
      sources: [{ label: 'Route', detail: 'Reopened from the Flight Deck route store; procedure records are not part of it.' }],
    });
  }
  return sync({
    ...base,
    alternate: saved.alternate ? normalizeStop(saved.alternate) : null,
    departureRwy: String(saved.departureRwy || ''),
    arrivalRwy: String(saved.arrivalRwy || ''),
    sid: saved.sid || null,
    star: saved.star || null,
    fuel: { ...base.fuel, ...(saved.fuel || {}), components: { ...((saved.fuel && saved.fuel.components) || {}) } },
    sources: Array.isArray(saved.sources) ? saved.sources : [],
  });
}
