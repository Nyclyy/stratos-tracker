/* Landing analytics.
   Everything here is derived from telemetry the simulator bridge actually
   records. Where a value is inferred (for example a runway match from a
   position fix) the result says so instead of presenting it as measured. */

import { crossTrackNm, distanceNm, headingDelta, isFiniteNumber, validLatLon } from './geo.js';

/** Configurable, transparent guideline thresholds in feet per minute.
 *  They are defaults for a *rating*, not airworthiness limits. */
export const DEFAULT_THRESHOLDS = {
  jet:        { smooth: -100, good: -180, firm: -300, hard: -600 },
  turboprop:  { smooth: -90,  good: -160, firm: -260, hard: -500 },
  piston:     { smooth: -80,  good: -140, firm: -220, hard: -400 },
  glider:     { smooth: -50,  good: -90,  firm: -150, hard: -250 },
  helicopter: { smooth: -60,  good: -110, firm: -200, hard: -350 },
  unknown:    { smooth: -100, good: -180, firm: -300, hard: -600 },
};

export const LANDING_GRADES = {
  smooth: { label: 'Smooth', tone: 'good', description: 'Well inside a comfortable touchdown rate.' },
  good: { label: 'Good', tone: 'good', description: 'Normal firm-but-comfortable touchdown.' },
  firm: { label: 'Firm', tone: 'warn', description: 'Firm arrival; within typical training limits for this class.' },
  hard: { label: 'Hard', tone: 'bad', description: 'High sink rate at touchdown. Worth reviewing the approach.' },
  severe: { label: 'Very hard', tone: 'bad', description: 'Touchdown rate is well beyond the configured guideline.' },
  unclassified: { label: 'Unclassified', tone: 'muted', description: 'No usable vertical-speed sample at touchdown.' },
};

/** Best-effort aircraft category from a free-text type/name. */
export function aircraftClass(type) {
  const raw = String(type || '').toUpperCase();
  if (!raw.trim()) return 'unknown';
  if (/(HELI|H125|H135|H145|R22|R44|R66|UH-60|A109|AW139|EC135)/.test(raw)) return 'helicopter';
  if (/(GLIDER|ASK21|DG-?1000|LS8|DUO DISCUS|VENTUS|C101|TG-16)/.test(raw)) return 'glider';
  if (/(TBM|PC-?12|C208|CARAVAN|ATR|Q400|DASH ?8|KING ?AIR|C90|B200|BE20|PC-?24|METRO|SAAB ?340|EMB ?120|SF50|VISION JET)/.test(raw)) return 'turboprop';
  if (/(B7[3-9]|A3[123][0-9]|A38[0-9]|A35[0-9]|A33[0-9]|A32[0-9]|B78[0-9]|B75[0-9]|B76[0-9]|B74[0-9]|B71[0-9]|MD-?11|MD-?8[0-9]|E1[79][0-9]|E2[0-9][0-9]|CRJ|RJ85|RJ100|CONCORDE|GLEX|GLF|CL30|CL60|CITATION|C25|C56X|C68|C70|FALCON|FA[0-9]|LEARJET|LJ[0-9]|PHENOM|E55P|HDJT|PC-?24)/.test(raw)) return 'jet';
  if (/(C1[5-9][0-9]|C2[0-9][0-9]|PA-?2[0-9]|PA-?3[0-9]|PA-?4[0-9]|SR2[0-9]|DA4[0-9]|DA62|M20|BE3[0-9]|BE5[0-9]|BONANZA|BARON|CIRRUS|ARCHER|SKYHAWK|TOMAHAWK|WARRIOR|MOONEY|A36|T182|C42|VL3|RV-?[0-9])/.test(raw)) return 'piston';
  return 'unknown';
}

export function thresholdsFor(aircraftTypeOrClass, overrides = {}) {
  const key = DEFAULT_THRESHOLDS[aircraftTypeOrClass]
    ? aircraftTypeOrClass
    : aircraftClass(aircraftTypeOrClass);
  const base = { ...DEFAULT_THRESHOLDS[key], ...(overrides[key] || {}) };
  return { classKey: key, thresholds: base };
}

/**
 * Classify a touchdown rate. `vsFpm` is negative for a descent.
 * Ratings are guidelines for the aircraft class and are fully configurable.
 */
export function classifyLanding(vsFpm, aircraftType, overrides = {}) {
  if (!isFiniteNumber(vsFpm) || vsFpm > 500 || vsFpm < -6000) {
    return { key: 'unclassified', ...LANDING_GRADES.unclassified, vsFpm: null, basis: 'no usable sample' };
  }
  const { classKey, thresholds } = thresholdsFor(aircraftType, overrides);
  const rate = Math.abs(vsFpm);
  let key = 'severe';
  if (rate <= Math.abs(thresholds.smooth)) key = 'smooth';
  else if (rate <= Math.abs(thresholds.good)) key = 'good';
  else if (rate <= Math.abs(thresholds.firm)) key = 'firm';
  else if (rate <= Math.abs(thresholds.hard)) key = 'hard';
  const grade = LANDING_GRADES[key];
  return {
    key,
    label: grade.label,
    tone: grade.tone,
    description: grade.description,
    vsFpm: Math.round(vsFpm),
    classKey,
    thresholds,
    basis: classKey === 'unknown'
      ? 'Aircraft type unknown — generic thresholds applied'
      : `Thresholds for ${classKey} aircraft`,
  };
}

/** Find the most likely runway under a touchdown point. */
export function matchRunway(airports, point, heading) {
  if (!Array.isArray(airports) || !point || !validLatLon(point.lat, point.lon)) return null;
  let best = null;
  for (const airport of airports) {
    if (!airport || !validLatLon(Number(airport.lat), Number(airport.lon))) continue;
    const ap = { lat: Number(airport.lat), lon: Number(airport.lon) };
    const toAirport = distanceNm(point, ap);
    if (toAirport > 8) continue;
    const runways = Array.isArray(airport.rws) ? airport.rws : [];
    for (const rw of runways) {
      if (!Array.isArray(rw) || rw.length < 6) continue;
      const ends = [
        { name: String(rw[0]), lat: Number(rw[2]), lon: Number(rw[3]), other: String(rw[1]) },
        { name: String(rw[1]), lat: Number(rw[4]), lon: Number(rw[5]), other: String(rw[0]) },
      ].filter(e => validLatLon(e.lat, e.lon));
      if (ends.length !== 2) continue;
      const lengthFt = Number(rw[6]) || Math.round(distanceNm(ends[0], ends[1]) * 6076.12);
      const widthFt = Number(rw[7]) || null;
      for (let i = 0; i < 2; i++) {
        const threshold = ends[i];
        const far = ends[1 - i];
        const along = crossTrackNm(point, threshold, far);
        if (along.distance > 0.35) continue; // ~650 m either side of the centreline
        if (along.fraction < -0.08 || along.fraction > 1.08) continue;
        const runwayHeading = headingFromTo(threshold, far);
        const headingError = isFiniteNumber(heading) ? headingDelta(heading, runwayHeading) : 0;
        const score = along.distance * 10 + along.fraction * 0.2 + (i === 0 ? 0 : 0.05);
        if (!best || score < best.score) {
          best = {
            score,
            airport: airport.id || airport.ident || '',
            airportName: airport.name || '',
            id: `${threshold.name}/${far.name}`.replace(/^\/|\/$/g, ''),
            threshold: threshold.name,
            farEnd: far.name,
            lengthFt,
            widthFt,
            distanceFromThresholdFt: Math.max(0, Math.round(along.fraction * lengthFt)),
            remainingFt: Math.max(0, Math.round((1 - along.fraction) * lengthFt)),
            offsetFt: Math.round(along.distance * 6076.12),
            runwayHeading: Math.round(runwayHeading),
            headingError: Math.round(headingError),
            headingAligned: !isFiniteNumber(heading) ? null : headingError <= 35,
            estimated: true,
          };
        }
      }
    }
  }
  return best;
}

function headingFromTo(a, b) {
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function slopeFpm(samples) {
  if (samples.length < 3) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (!(dt >= 0.8) || dt > 12) return null;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    if (!isFiniteNumber(s.alt)) return null;
    const x = (s.t - first.t) / 1000;
    const y = s.alt;
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom; // ft per second
  if (!isFiniteNumber(slope)) return null;
  return slope * 60;
}

/**
 * Analyse a touchdown.
 * @param {object} input
 * @param {Array} input.samples telemetry samples around touchdown: {lat,lon,alt,agl,gs,hdg,vs,t}
 * @param {Array} [input.airports] airports with .rws arrays (OurAirports layout)
 * @param {string} [input.aircraftType]
 * @param {object} [input.thresholds] per-class overrides
 * @param {boolean} [input.expectTouchdown] true when the state machine detected ground contact
 */
export function analyzeLanding(input = {}) {
  const samples = (Array.isArray(input.samples) ? input.samples : [])
    .filter(s => s && validLatLon(Number(s.lat), Number(s.lon)) && isFiniteNumber(Number(s.t)))
    .map(s => ({
      lat: Number(s.lat), lon: Number(s.lon), alt: numberOrNull(s.alt), agl: numberOrNull(s.agl),
      gs: numberOrNull(s.gs), hdg: numberOrNull(s.hdg), vs: numberOrNull(s.vs), t: Number(s.t),
    }))
    .sort((a, b) => a.t - b.t)
    .slice(-30);
  const warnings = [];
  if (!samples.length) {
    return {
      available: false, reason: 'No position samples were recorded around touchdown.',
      warnings, classification: classifyLanding(null, input.aircraftType, input.thresholds),
    };
  }
  const touchdown = samples[samples.length - 1];
  const recent = samples.filter(s => touchdown.t - s.t <= 5000);
  const derivedVs = slopeFpm(recent);
  let vsFpm = derivedVs;
  let vsSource = 'derived from recorded altitude';
  if (!isFiniteNumber(vsFpm)) {
    const reported = touchdown.vs;
    if (isFiniteNumber(reported) && reported < 0) {
      vsFpm = reported;
      vsSource = 'last reported vertical speed';
      warnings.push('Vertical speed is the last value the simulator reported, not a touchown-window measurement.');
    }
  }
  if (isFiniteNumber(vsFpm) && vsFpm > 0) {
    warnings.push('Descent rate was positive in the touchdown window; value not used.');
    vsFpm = null;
  }
  if (!isFiniteNumber(vsFpm)) {
    vsSource = 'unavailable';
    warnings.push('The simulator bridge did not provide a usable vertical-speed sample at touchdown.');
  }
  const gs = isFiniteNumber(touchdown.gs) ? touchdown.gs : null;
  const runway = input.airports ? matchRunway(input.airports, touchdown, touchdown.hdg) : null;
  if (!runway) warnings.push('Runway could not be matched from the recorded position; touchdown distance is unavailable.');
  const classification = classifyLanding(vsFpm, input.aircraftType, input.thresholds);
  return {
    available: true,
    vsFpm: isFiniteNumber(vsFpm) ? Math.round(vsFpm) : null,
    vsSource,
    gsKt: gs != null ? Math.round(gs) : null,
    lat: touchdown.lat,
    lon: touchdown.lon,
    heading: touchdown.hdg,
    at: touchdown.t,
    runway,
    classification,
    peakSinkFpm: recent.length > 2 ? Math.round(Math.min(...recent.map(s => (isFiniteNumber(s.vs) ? s.vs : Infinity)))) : null,
    sampleCount: recent.length,
    warnings,
    estimated: {
      vs: vsSource !== 'derived from recorded altitude',
      runway: !!runway,
      touchdownPoint: true,
    },
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function landingOfFlight(flight) {
  if (!flight) return null;
  if (flight.landing && typeof flight.landing === 'object') return flight.landing;
  if (isFiniteNumber(flight.landingVS)) {
    return {
      available: true, vsFpm: Math.round(flight.landingVS),
      vsSource: 'legacy record (last reported vertical speed)', gsKt: null,
      lat: null, lon: null, runway: null,
      classification: classifyLanding(flight.landingVS, flight.aircraft),
      warnings: ['Recorded before detailed landing analytics were enabled.'],
      estimated: { vs: true, runway: false, touchdownPoint: false },
    };
  }
  return null;
}

/** Build a landing-centric view of the logbook without changing the records. */
export function summarizeLandings(flights, options = {}) {
  const list = [];
  const skipped = { noRecord: 0, noVerticalSpeed: 0 };
  for (const flight of flights || []) {
    const landing = landingOfFlight(flight);
    if (!landing) { skipped.noRecord++; continue; }
    if (!isFiniteNumber(landing.vsFpm)) { skipped.noVerticalSpeed++; continue; }
    const classification = landing.classification ||
      classifyLanding(landing.vsFpm, flight.aircraft, options.thresholds);
    list.push({
      flightId: flight.id,
      at: landing.at || flight.landingTime || flight.endTime || flight.startTime,
      vsFpm: landing.vsFpm,
      gsKt: landing.gsKt,
      runway: landing.runway || null,
      classification,
      airport: (landing.runway && landing.runway.airport) || flight.arrAirport || null,
      aircraft: flight.aircraft || 'Unknown',
      departure: flight.depAirport || null,
      sim: flight.sim || '',
      estimated: landing.estimated || {},
      warnings: landing.warnings || [],
    });
  }
  list.sort((a, b) => (b.at || 0) - (a.at || 0));

  const byClass = {};
  for (const item of list) {
    const c = item.classification.classKey || 'unknown';
    if (!byClass[c]) byClass[c] = { count: 0, sum: 0, best: null, worst: null };
    const bucket = byClass[c];
    bucket.count++;
    bucket.sum += item.vsFpm;
    if (bucket.best === null || item.vsFpm > bucket.best) bucket.best = item.vsFpm;
    if (bucket.worst === null || item.vsFpm < bucket.worst) bucket.worst = item.vsFpm;
  }
  for (const c of Object.keys(byClass)) {
    byClass[c].average = Math.round(byClass[c].sum / byClass[c].count);
    delete byClass[c].sum;
  }

  const monthly = {};
  for (const item of list) {
    if (!item.at) continue;
    const d = new Date(item.at);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthly[key]) monthly[key] = { count: 0, sum: 0 };
    monthly[key].count++;
    monthly[key].sum += item.vsFpm;
  }
  const trend = Object.keys(monthly).sort().slice(-12).map(key => ({
    month: key, count: monthly[key].count, averageFpm: Math.round(monthly[key].sum / monthly[key].count),
  }));

  return {
    landings: list,
    count: list.length,
    skipped,
    byClass,
    trend,
    best: list.length ? list.reduce((a, b) => (b.vsFpm > a.vsFpm ? b : a)) : null,
    worst: list.length ? list.reduce((a, b) => (b.vsFpm < a.vsFpm ? b : a)) : null,
    averageFpm: list.length ? Math.round(list.reduce((sum, l) => sum + l.vsFpm, 0) / list.length) : null,
    byAirport: countBy(list, l => l.airport).slice(0, 10),
    byRunway: countBy(list, l => (l.runway ? `${l.runway.airport || ''} ${l.runway.id}`.trim() : null)).slice(0, 10),
  };
}

function countBy(list, selector) {
  const map = new Map();
  for (const item of list) {
    const key = selector(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

export function loadThresholdOverrides() {
  try {
    const raw = localStorage.getItem('stratos.landingThresholds');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function saveThresholdOverrides(overrides) {
  try { localStorage.setItem('stratos.landingThresholds', JSON.stringify(overrides || {})); } catch (_) {}
}
