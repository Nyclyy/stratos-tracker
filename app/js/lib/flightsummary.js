/* Flight-plan summary model for the Flight Deck panel.

   Pure: it turns the Flight Deck route, a saved SimBrief OFP and cached METARs
   into display rows. It never fills a gap. A value the source does not supply
   stays null and renders as "not available". Every value carries its source:
   'ofp' (imported SimBrief plan), 'stratos' (calculated from the route),
   'live' (simulator) or null. */

import { bearingDeg } from './geo.js';
import { routeTotals, routeProgress, normalizeWaypoint } from './planner.js';
import { observationFrom, windComponents } from './routeweather.js';

export const OFP_STORAGE_KEY = 'stratos.ofp';
const KG_PER_LB = 0.45359237;
// Route points the app inserts itself; they are not part of an OFP fix list.
const APP_POINT_IDS = new Set(['TOD', 'TOC']);

const str = value => {
  const text = value == null ? '' : String(value).trim();
  return text ? text : null;
};
const upper = value => {
  const text = str(value);
  return text ? text.toUpperCase() : null;
};
const num = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const firstNum = (...values) => {
  for (const value of values) {
    const n = num(value);
    if (n != null) return n;
  }
  return null;
};
// SimBrief reports departure and arrival times as Unix seconds.
const epochMs = value => {
  const n = num(value);
  return n != null && n > 0 ? n * 1000 : null;
};

/** Convert a planned value between kg and lb. Null stays null. */
export function convertWeight(value, fromUnit, toUnit) {
  const n = num(value);
  if (n == null) return null;
  if (!fromUnit || !toUnit || fromUnit === toUnit) return n;
  return fromUnit === 'lb' ? n * KG_PER_LB : n / KG_PER_LB;
}

export function fmtWeight(value, unit = 'kg') {
  const n = num(value);
  if (n == null) return null;
  return `${Math.round(n).toLocaleString('en-US')} ${unit}`;
}

export function fmtAltitude(ft) {
  const n = num(ft);
  if (n == null || n <= 0) return null;
  return n >= 18000 ? `FL${String(Math.round(n / 100)).padStart(3, '0')}` : `${Math.round(n).toLocaleString('en-US')} ft`;
}

export function fmtUtc(ms) {
  const n = num(ms);
  if (n == null) return null;
  const d = new Date(n);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

export function fmtMinutes(minutes) {
  const n = num(minutes);
  if (n == null || n < 0) return null;
  const total = Math.round(n);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} h`;
}

/** Runway heading from a designator such as "27L" (magnetic, rounded to 10 degrees). */
export function runwayHeading(designator) {
  const match = /^(\d{1,2})[LRC]?$/.exec(String(designator || '').trim().toUpperCase());
  if (!match) return null;
  const n = Number(match[1]);
  if (n < 1 || n > 36) return null;
  return n * 10;
}

/* ── SID and STAR from SimBrief ───────────────────────────────────────
   SimBrief names the filed procedures in `general.sid_ident` and
   `general.star_ident`, not in the airport blocks, so those are read first and
   the older `origin.sid_ident` / `destination.star_ident` fields are kept as a
   fallback. SimBrief is known to shorten procedure idents by one character in
   the OFP text (OBOKA4G becomes OBOK4G, LITKU2X becomes LITK2X); the same plan
   carries the full ident at the start and end of `general.route_ifps`, and the
   full name is restored from it only when removing exactly one character
   rebuilds the filed name. Nothing is guessed: a name is used only when the
   plan itself states it. */

// A procedure ident at the end of a written route: at least four letters and a
// version digit (LITKU2X, LOGDA6N, SUMMA2). An airway (Y301, UL984) or a plain
// fix (KALIF) cannot match, so neither is ever mistaken for a procedure.
const PROCEDURE_IDENT = /^[A-Z]{4,}[A-Z0-9]*\d[A-Z0-9]*$/;

/** The procedure idents written at the start and end of a filed route. */
export function routeProcedures(routeText) {
  const tokens = String(routeText || '').toUpperCase().split(/\s+/)
    .filter(token => token && !token.includes('/'));
  const usable = token => Boolean(token) && token !== 'DCT' && PROCEDURE_IDENT.test(token);
  const first = tokens.find(token => token !== 'DCT') || null;
  let last = null;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i] !== 'DCT') { last = tokens[i]; break; }
  }
  return {
    sid: usable(first) ? first : null,
    star: usable(last) && last !== first ? last : null,
  };
}

/** The full ident SimBrief shortened, only when one removed character restores it. */
function restoredIdent(full, stated) {
  if (!full || !stated || full === stated) return null;
  if (full.length !== stated.length + 1) return null;
  for (let i = 0; i < full.length; i += 1) {
    if (full.slice(0, i) + full.slice(i + 1) === stated) return full;
  }
  return null;
}

/**
 * The SID, STAR and transitions a plan states, from its own fields and route.
 * `ofp` is the normalised shape so an already-stored plan is handled as well.
 */
export function planProcedures(ofp) {
  const flight = (ofp && ofp.flight) || {};
  const origin = (ofp && ofp.origin) || {};
  const destination = (ofp && ofp.destination) || {};
  const ifps = routeProcedures(flight.routeIfps);
  const written = routeProcedures(flight.routeText);
  return {
    sid: restoredIdent(ifps.sid, origin.sid) || restoredIdent(written.sid, origin.sid) || origin.sid || ifps.sid || written.sid || null,
    star: restoredIdent(ifps.star, destination.star) || restoredIdent(written.star, destination.star) || destination.star || ifps.star || written.star || null,
    sidTrans: origin.sidTrans || null,
    starTrans: destination.starTrans || null,
  };
}

/* The published OFP is a PDF SimBrief lists under `files`; its `link` is a file
   name relative to `files.directory`. Both are needed, and neither is guessed. */
function ofpDocument(files) {
  const directory = str(files && files.directory);
  const pdf = files && files.pdf && typeof files.pdf === 'object' ? files.pdf : null;
  const link = pdf ? str(pdf.link) : null;
  if (!link || /^javascript:/i.test(link)) return null;
  if (/^https?:\/\//i.test(link)) return link;
  if (!directory) return null;
  return `${directory.replace(/\/?$/, '/')}${link.replace(/^\//, '')}`;
}

/* SimBrief also returns the OFP as formatted HTML. When no PDF is published it
   is the only real document there is, so it is kept as text (never rendered as
   HTML) and capped so a stored plan stays small. */
function ofpTextOf(text) {
  const html = text && typeof text === 'object' ? str(text.plan_html) : null;
  if (!html) return null;
  const plain = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:pre|div|p|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain ? plain.slice(0, 20000) : null;
}

/**
 * Normalise a raw SimBrief OFP (the json=v2 response) into a compact, JSON-safe
 * record. Missing fields come back null; nothing is derived to fill them.
 */
export function parseOfp(json, fetchedAt = Date.now()) {
  if (!json || typeof json !== 'object') return null;
  const general = json.general || {};
  const origin = json.origin || {};
  const dest = json.destination || {};
  const alt = json.alternate || {};
  const aircraft = json.aircraft || {};
  const fuel = json.fuel || {};
  const weights = json.weights || {};
  const times = json.times || {};
  const params = json.params || {};
  const navFixes = json.navlog && Array.isArray(json.navlog.fix) ? json.navlog.fix : [];
  const units = /lb/i.test(String(params.units || general.units || '')) ? 'lb' : 'kg';
  const airline = upper(general.icao_airline);
  const flightNumber = str(general.flight_number);
  const documentUrl = ofpDocument(json.files);

  const ofp = {
    fetchedAt,
    units,
    flight: {
      callsign: airline && flightNumber ? `${airline}${flightNumber}` : null,
      flightNumber,
      airline,
      // `cruise_altitude` is not in every response; the initial cruise level
      // (`initial_altitude`, e.g. 36000) is what SimBrief always plans with.
      cruiseFt: firstNum(general.cruise_altitude, general.initial_altitude),
      cruiseMach: str(general.cruise_mach),
      cruiseTasKt: firstNum(general.cruise_tas),
      costIndex: firstNum(general.costindex),
      // Both written routes are kept: the plain one names the procedures as
      // SimBrief prints them, the IFPS one usually carries the full ident.
      routeText: str(general.route),
      routeIfps: str(general.route_ifps),
    },
    origin: {
      icao: upper(origin.icao_code),
      name: str(origin.name),
      rwy: upper(origin.plan_rwy),
      sid: upper(general.sid_ident || origin.sid_ident),
      sidTrans: upper(general.sid_trans || origin.sid_trans),
    },
    destination: {
      icao: upper(dest.icao_code),
      name: str(dest.name),
      rwy: upper(dest.plan_rwy),
      star: upper(general.star_ident || dest.star_ident),
      starTrans: upper(general.star_trans || dest.star_trans),
      approach: upper(dest.approach_ident),
      approachRwy: upper(dest.approach_rwy),
    },
    alternate: { icao: upper(alt.icao_code), name: str(alt.name) },
    aircraft: {
      icao: upper(aircraft.icaocode || aircraft.icao_code),
      name: str(aircraft.name),
      variant: str(aircraft.name_internal),
      reg: upper(aircraft.reg),
    },
    times: {
      depUtc: epochMs(times.sched_out),
      arrUtc: epochMs(times.sched_in),
      blockMin: firstNum(times.est_block) != null ? firstNum(times.est_block) / 60 : null,
      enrouteMin: firstNum(times.est_time_enroute) != null ? firstNum(times.est_time_enroute) / 60 : null,
    },
    distanceNm: firstNum(general.route_distance),
    // The real Operational Flight Plan SimBrief generated for this plan: a PDF
    // link when it published one, and the OFP text when it did not.
    documentUrl,
    text: documentUrl ? null : ofpTextOf(json.text),
    fuel: {
      block: firstNum(fuel.plan_ramp),
      taxi: firstNum(fuel.taxi),
      trip: firstNum(fuel.enroute_burn),
      takeoff: firstNum(fuel.plan_takeoff),
      landing: firstNum(fuel.plan_landing),
      reserve: firstNum(fuel.reserve),
      alternate: firstNum(fuel.alternate_burn),
      extra: firstNum(fuel.extra),
      contingency: firstNum(fuel.contingency),
    },
    weights: {
      oew: firstNum(weights.oew),
      payload: firstNum(weights.payload),
      zfw: firstNum(weights.est_zfw),
      mzfw: firstNum(weights.max_zfw),
      tow: firstNum(weights.est_tow),
      mtow: firstNum(weights.max_tow),
      lw: firstNum(weights.est_ldw),
      mlw: firstNum(weights.max_ldw),
      cg: str(weights.cg),
      pax: firstNum(weights.pax_count),
      cargo: firstNum(weights.cargo),
    },
    fixes: navFixes.map(fix => ({
      ident: upper(fix.ident) || 'WPT',
      name: str(fix.name),
      lat: num(fix.pos_lat),
      lon: num(fix.pos_long),
      altFt: num(fix.altitude_feet),
      // SimBrief states the point type (apt, vor, ndb, wpt); it is kept as
      // published so a map can choose a symbol without inferring it from the
      // identifier.
      type: str(fix.type).toLowerCase(),
    })),
  };
  // The procedures are taken from the plan's own fields and route, including a
  // full ident that SimBrief shortened, so the card and the procedure lookups
  // use the name the navigation data actually publishes.
  const procedures = planProcedures(ofp);
  ofp.origin.sid = procedures.sid;
  ofp.origin.sidTrans = procedures.sidTrans;
  ofp.destination.star = procedures.star;
  ofp.destination.starTrans = procedures.starTrans;
  return ofp;
}

/** Save the parsed OFP (not the raw response) with the SimBrief id that produced it. */
export function saveOfp(storage, ofp, simbriefId) {
  if (!storage || !ofp) return false;
  try {
    storage.setItem(OFP_STORAGE_KEY, JSON.stringify({ simbriefId: str(simbriefId), ofp }));
    return true;
  } catch (_) {
    return false;
  }
}

/** Returns { simbriefId, ofp } or null. Corrupt stored data is ignored, never shown. */
export function loadOfp(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(OFP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ofp || typeof parsed.ofp !== 'object') return null;
    // A plan stored before the procedures were read from `general` still names
    // them in its route text, so the card and the map get them without a
    // re-import. The stored record is left untouched.
    const ofp = parsed.ofp;
    const procedures = planProcedures(ofp);
    ofp.origin = { ...(ofp.origin || {}), sid: procedures.sid, sidTrans: procedures.sidTrans };
    ofp.destination = { ...(ofp.destination || {}), star: procedures.star, starTrans: procedures.starTrans };
    return { simbriefId: str(parsed.simbriefId), ofp };
  } catch (_) {
    return null;
  }
}

export function clearOfp(storage) {
  try {
    if (storage) storage.removeItem(OFP_STORAGE_KEY);
  } catch (_) { /* storage unavailable: nothing to clear */ }
}

function routeIdents(route) {
  return (route || [])
    .map(point => String((point && point.id) || '').toUpperCase())
    .filter(id => id && !APP_POINT_IDS.has(id));
}

/**
 * Whether the loaded route still matches the imported OFP.
 * 'match' - same waypoint sequence; 'changed' - the route was edited after import;
 * 'unknown' - the OFP carries no navlog to compare against.
 */
export function compareRouteWithOfp(route, ofp) {
  if (!ofp || !Array.isArray(ofp.fixes) || !ofp.fixes.length) return 'unknown';
  const planned = ofp.fixes.map(fix => fix.ident).filter(id => !APP_POINT_IDS.has(id));
  const current = routeIdents(route);
  if (!current.length) return 'changed';
  return planned.length === current.length && planned.every((id, i) => id === current[i]) ? 'match' : 'changed';
}

function airportLabel(icao, name) {
  if (!icao) return null;
  return name ? `${icao} · ${name}` : icao;
}

function procedureText(ident, trans) {
  if (!ident) return null;
  return trans ? `${ident} (${trans})` : ident;
}

function row(key, label, value, source, extra = {}) {
  return { key, label, value: value == null || value === '' ? null : value, source: value == null ? null : source, ...extra };
}

/** Weight row: value is converted to the display unit and checked against the OFP limit. */
function weightRow(key, label, value, limit, fromUnit, unit) {
  const shown = convertWeight(value, fromUnit, unit);
  const max = convertWeight(limit, fromUnit, unit);
  const over = shown != null && max != null && shown > max;
  return {
    key,
    label,
    value: shown,
    text: fmtWeight(shown, unit),
    limit: max,
    limitText: max != null ? fmtWeight(max, unit) : null,
    over,
    source: shown != null ? 'ofp' : null,
  };
}

/** Waypoint details: heading, leg distance, cumulative distance and estimated time. */
function waypointRows(points, totals, ofp, stale) {
  if (!points.length) return [];
  const ofpFixes = !stale && ofp && Array.isArray(ofp.fixes) ? ofp.fixes.filter(f => !APP_POINT_IDS.has(f.ident)) : [];
  const legs = totals ? totals.legs : [];
  const totalNm = totals ? totals.distanceNm : 0;
  let cumNm = 0;
  return points.map((point, index) => {
    const leg = index > 0 ? legs[index - 1] : null;
    if (leg) cumNm += leg.distanceNm;
    const next = points[index + 1];
    const fixMatch = ofpFixes[index] && ofpFixes[index].ident === point.id ? ofpFixes[index] : null;
    return {
      index,
      id: point.id,
      name: point.name || '',
      lat: point.lat,
      lon: point.lon,
      kind: point.kind,
      courseDeg: next ? Math.round(bearingDeg(point, next)) : null,
      legNm: leg ? leg.distanceNm : null,
      cumNm,
      estMin: totals && totalNm > 0 ? (cumNm / totalNm) * totals.airborneMinutes : null,
      altFt: fixMatch && fixMatch.altFt > 0 ? fixMatch.altFt : null,
    };
  });
}

/**
 * Build everything the panel shows.
 * input: { route, ofp, metars, position, cruiseAltFt, cruiseKts, weightUnit, live, now }
 *   metars: { [ICAO]: { metar, decoded, fetchedAt, source } }
 */
export function buildSummary(input = {}) {
  const now = input.now ?? Date.now();
  const ofp = input.ofp || null;
  const unit = input.weightUnit === 'lb' ? 'lb' : 'kg';
  const ofpUnit = ofp ? ofp.units : unit;
  const cruiseKts = num(input.cruiseKts) ?? (ofp ? ofp.flight.cruiseTasKt : null);
  const cruiseAltFt = num(input.cruiseAltFt) ?? (ofp ? ofp.flight.cruiseFt : null);

  const points = (input.route || [])
    .map(normalizeWaypoint)
    .filter(Boolean);
  const totals = points.length > 1
    ? routeTotals(points, { cruiseKts: cruiseKts || undefined, cruiseAlt: cruiseAltFt || undefined })
    : null;

  const ofpStatus = ofp ? compareRouteWithOfp(input.route, ofp) : 'none';
  const stale = ofpStatus === 'changed';
  const useOfp = Boolean(ofp) && !stale;
  const planSource = useOfp ? 'ofp' : 'stratos';

  const originIcao = (useOfp && ofp.origin.icao) || (points[0] && points[0].kind === 'apt' ? points[0].id : null);
  const destIcao = (useOfp && ofp.destination.icao) || (points.length > 1 && points[points.length - 1].kind === 'apt' ? points[points.length - 1].id : null);
  const originName = useOfp ? ofp.origin.name : (points[0] ? points[0].name : null);
  const destName = useOfp ? ofp.destination.name : (points.length > 1 ? points[points.length - 1].name : null);

  const departureRwy = useOfp ? ofp.origin.rwy : null;
  const arrivalRwy = useOfp ? ofp.destination.rwy : null;
  const approachRwy = useOfp ? (ofp.destination.approachRwy || null) : null;

  const distanceNm = totals ? totals.distanceNm : (useOfp ? ofp.distanceNm : null);
  const eteMinutes = useOfp && ofp.times.enrouteMin != null ? ofp.times.enrouteMin : (totals ? totals.airborneMinutes : null);
  const eteSource = useOfp && ofp.times.enrouteMin != null ? 'ofp' : (totals ? 'stratos' : null);

  const overview = [
    row('departure', 'Departure', airportLabel(originIcao, originName), originIcao ? planSource : null, { icao: originIcao }),
    row('destination', 'Destination', airportLabel(destIcao, destName), destIcao ? planSource : null, { icao: destIcao }),
    row('alternate', 'Alternate', useOfp && ofp.alternate ? airportLabel(ofp.alternate.icao, ofp.alternate.name) : null, 'ofp', { icao: useOfp && ofp.alternate ? ofp.alternate.icao : null }),
    row('aircraft', 'Aircraft', useOfp ? [ofp.aircraft.icao, ofp.aircraft.variant || ofp.aircraft.name].filter(Boolean).join(' · ') || null : null, 'ofp'),
    row('callsign', 'Callsign', useOfp ? ofp.flight.callsign : null, 'ofp'),
    row('distance', 'Distance', distanceNm != null ? `${Math.round(distanceNm).toLocaleString('en-US')} nm` : null, distanceNm != null ? planSource : null),
    row('ete', 'Flight time', fmtMinutes(eteMinutes), eteSource),
    row('cruise', 'Cruise', fmtAltitude(cruiseAltFt), cruiseAltFt ? (useOfp && ofp.flight.cruiseFt ? 'ofp' : 'stratos') : null),
    row('depTime', 'Departure time', useOfp ? fmtUtc(ofp.times.depUtc) : null, 'ofp'),
    row('arrTime', 'Arrival time', useOfp ? fmtUtc(ofp.times.arrUtc) : null, 'ofp'),
  ];

  const procedures = [
    row('depRwy', 'Departure runway', departureRwy, 'ofp', { rwy: departureRwy, heading: runwayHeading(departureRwy), selected: Boolean(departureRwy) }),
    row('sid', 'SID', useOfp ? procedureText(ofp.origin.sid, ofp.origin.sidTrans) : null, 'ofp', { selected: Boolean(useOfp && ofp.origin.sid) }),
    row('star', 'STAR', useOfp ? procedureText(ofp.destination.star, ofp.destination.starTrans) : null, 'ofp', { selected: Boolean(useOfp && ofp.destination.star) }),
    row('approach', 'Approach', useOfp ? ofp.destination.approach : null, 'ofp', { selected: Boolean(useOfp && ofp.destination.approach) }),
    row('arrRwy', 'Arrival runway', arrivalRwy || approachRwy, 'ofp', { rwy: arrivalRwy || approachRwy, heading: runwayHeading(arrivalRwy || approachRwy), selected: Boolean(arrivalRwy || approachRwy) }),
  ];

  const route = {
    source: planSource,
    totalNm: distanceNm,
    greatCircleNm: totals ? totals.greatCircleNm : null,
    waypoints: waypointRows(points, totals, ofp, stale),
    progress: null,
  };
  if (input.position && points.length > 1) {
    const progress = routeProgress(input.route, input.position);
    if (progress) {
      route.progress = {
        flownNm: progress.flownNm,
        remainingNm: progress.remainingNm,
        totalNm: progress.totalNm,
        onRoute: progress.onRoute,
        legIndex: progress.legIndex,
        source: 'live',
      };
    }
  }

  const weights = [];
  if (useOfp) {
    const w = ofp.weights;
    weights.push(
      weightRow('oew', 'Operating weight (OEW)', w.oew, null, ofpUnit, unit),
      weightRow('payload', 'Payload', w.payload, null, ofpUnit, unit),
      weightRow('zfw', 'Zero fuel weight (ZFW)', w.zfw, w.mzfw, ofpUnit, unit),
      weightRow('tow', 'Takeoff weight (TOW)', w.tow, w.mtow, ofpUnit, unit),
      weightRow('lw', 'Landing weight (LW)', w.lw, w.mlw, ofpUnit, unit),
    );
    if (w.pax != null) weights.push({ key: 'pax', label: 'Passengers', value: w.pax, text: String(Math.round(w.pax)), limit: null, limitText: null, over: false, source: 'ofp' });
    if (w.cargo != null) weights.push(weightRow('cargo', 'Cargo', w.cargo, null, ofpUnit, unit));
    if (w.cg) weights.push({ key: 'cg', label: 'Centre of gravity', value: null, text: w.cg, limit: null, limitText: null, over: false, source: 'ofp' });
  }

  const fuel = [];
  if (useOfp) {
    const f = ofp.fuel;
    const fuelRows = [
      ['block', 'Block fuel', f.block],
      ['taxi', 'Taxi fuel', f.taxi],
      ['trip', 'Trip fuel', f.trip],
      ['takeoff', 'Takeoff fuel', f.takeoff],
      ['landing', 'Landing fuel', f.landing],
      ['alternate', 'Alternate fuel', f.alternate],
      ['reserve', 'Final reserve', f.reserve],
      ['contingency', 'Contingency', f.contingency],
      ['extra', 'Extra fuel', f.extra],
    ];
    for (const [key, label, value] of fuelRows) {
      const shown = convertWeight(value, ofpUnit, unit);
      fuel.push({ key, label, value: shown, text: fmtWeight(shown, unit), source: shown != null ? 'ofp' : null });
    }
  }

  const weather = buildWeather({ originIcao, destIcao, altIcao: useOfp && ofp.alternate ? ofp.alternate.icao : null, arrivalRwy: arrivalRwy || approachRwy, departureRwy, points, metars: input.metars || {}, now });

  const notes = [];
  if (!ofp) notes.push('No SimBrief flight plan loaded. Weights, fuel and procedures are not available until you import one.');
  if (ofp && stale) notes.push('The route was edited after the OFP was imported. Plan figures are hidden until you refresh the OFP.');
  if (ofp && ofpStatus === 'unknown') notes.push('The imported OFP has no waypoint list, so the route could not be checked against it.');
  if (ofp && (!ofp.weights.mtow && !ofp.weights.mlw && !ofp.weights.mzfw)) notes.push('SimBrief did not report aircraft weight limits for this plan.');

  return {
    hasOfp: Boolean(ofp),
    ofpStatus,
    ofpFetchedAt: ofp ? ofp.fetchedAt : null,
    ofpDocumentUrl: useOfp ? ofp.documentUrl || null : null,
    ofpText: useOfp ? ofp.text || null : null,
    units: { weight: unit },
    overview,
    procedures,
    route,
    weights,
    fuel,
    fuelAtDestination: useOfp && ofp.fuel.landing != null ? { value: convertWeight(ofp.fuel.landing, ofpUnit, unit), text: fmtWeight(convertWeight(ofp.fuel.landing, ofpUnit, unit), unit), source: 'ofp' } : null,
    weather,
    notes,
  };
}

function buildWeather({ originIcao, destIcao, altIcao, arrivalRwy, departureRwy, points, metars, now }) {
  const roles = [
    ['departure', originIcao, departureRwy],
    ['destination', destIcao, arrivalRwy],
    ['alternate', altIcao, null],
  ];
  const courseFor = icao => {
    const index = points.findIndex(p => p.id === icao);
    if (index === -1) return null;
    if (index < points.length - 1) return bearingDeg(points[index], points[index + 1]);
    return index > 0 ? bearingDeg(points[index - 1], points[index]) : null;
  };
  const stations = roles.filter(([, icao]) => icao).map(([role, icao, rwy]) => {
    const record = metars[icao] || null;
    const obs = record ? observationFrom(record) : null;
    const runwayHdg = runwayHeading(rwy);
    const wind = obs && obs.wind ? windComponents(runwayHdg, obs.wind.direction, obs.wind.speedKt, obs.wind.gustKt) : null;
    const age = record && num(record.fetchedAt) != null ? Math.max(0, Math.round((now - record.fetchedAt) / 60000)) : null;
    return {
      role,
      icao,
      status: !record ? 'missing' : obs && obs.hasObservation ? 'ok' : 'empty',
      category: obs ? obs.flightCategory : null,
      metar: record ? str(record.metar) : null,
      wind: obs && obs.wind ? obs.wind : null,
      visibilitySm: obs ? obs.visibilitySm : null,
      ceilingFt: obs ? obs.ceilingFt : null,
      runway: rwy || null,
      runwayComponents: wind,
      fetchedAt: record ? num(record.fetchedAt) : null,
      ageMin: age,
      source: record ? str(record.source) || 'METAR' : null,
      courseDeg: courseFor(icao),
    };
  });
  return { stations };
}
