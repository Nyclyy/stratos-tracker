/* EFB performance: the parts that can be calculated honestly, and nothing else.
 *
 * Two kinds of number live here and they are never mixed:
 *
 *  1. Conditions. Pressure altitude, ISA temperature and deviation, density
 *     altitude, wind components and the resulting head/cross/tail wind are
 *     physics (standard atmosphere and vector arithmetic), so they are computed
 *     for any airport and any aircraft.
 *
 *  2. Aircraft performance. V-speeds and field lengths belong to one type at one
 *     weight, flap, thrust and runway condition. Stratos has not been licensed an
 *     approved dataset, so nothing is invented here: a value is only produced
 *     from an imported dataset (the operator's own AFM extract) and only inside
 *     the range that dataset covers. Outside it, the answer is "unavailable",
 *     never an extrapolation.
 *
 * Pure functions, no DOM. Units: feet, knots, degrees, hPa, °C, kg.
 */

const P0_HPA = 1013.25;
const T0_K = 288.15;
const LAPSE_K_PER_M = 0.0065;
const ISA_EXPONENT = 5.25588; // g·M / (R·L) for the ISA troposphere
const ISA_LAPSE_C_PER_FT = 0.00198;

export const SCHEMA = 'stratos.performance/1';

/** Pressure altitude under ISA from an aerodrome elevation and the QNH. */
export function pressureAltitudeFt(elevationFt, qnhHpa = P0_HPA) {
  const elev = Number(elevationFt);
  const qnh = Number(qnhHpa);
  if (!Number.isFinite(elev) || !Number.isFinite(qnh) || qnh < 850 || qnh > 1085) return null;
  const ratio = qnh / P0_HPA;
  const metres = (T0_K / LAPSE_K_PER_M) * (1 - Math.pow(ratio, 1 / ISA_EXPONENT));
  return elev + metres * 3.280839895;
}

/** ISA temperature at an altitude, °C. */
export function isaTemperatureC(altitudeFt) {
  const alt = Number(altitudeFt);
  if (!Number.isFinite(alt)) return null;
  return 15 - ISA_LAPSE_C_PER_FT * alt;
}

/** How much warmer or colder than ISA the reported temperature is, °C. */
export function isaDeviationC(oatC, altitudeFt) {
  const isa = isaTemperatureC(altitudeFt);
  const oat = Number(oatC);
  if (isa == null || !Number.isFinite(oat)) return null;
  return oat - isa;
}

/**
 * Density altitude: the pressure altitude corrected for temperature.
 * The 118.8 ft/°C factor is the standard approximation; it is stated in the UI
 * rather than presented as a measured value.
 */
export function densityAltitudeFt(pressureAltFtValue, oatC) {
  const pa = Number(pressureAltFtValue);
  const oat = Number(oatC);
  if (!Number.isFinite(pa) || !Number.isFinite(oat)) return null;
  const isa = isaTemperatureC(pa);
  if (isa == null) return null;
  return pa + 118.8 * (oat - isa);
}

function normalizeHeading(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
}

/**
 * Wind resolved on a runway.
 * Headwind positive means on the nose, negative means tailwind.
 * Crosswind positive means from the right, negative from the left.
 */
export function windComponents(runwayHeadingDeg, windFromDeg, windKt, gustKt = null) {
  const rwy = normalizeHeading(runwayHeadingDeg);
  const from = normalizeHeading(windFromDeg);
  if (windKt === null || windKt === undefined || windKt === '' || windFromDeg === '' || runwayHeadingDeg === '') return null;
  const speed = Number(windKt);
  if (rwy == null || from == null || !Number.isFinite(speed) || speed < 0) return null;
  const delta = ((from - rwy + 540) % 360 - 180) * (Math.PI / 180);
  const gust = Number.isFinite(Number(gustKt)) && gustKt !== null && gustKt !== '' ? Math.max(speed, Number(gustKt)) : null;
  const head = speed * Math.cos(delta);
  const cross = speed * Math.sin(delta);
  return {
    runwayHeading: rwy,
    windFrom: from,
    speedKt: speed,
    gustKt: gust,
    headwindKt: round(head, 1),
    tailwindKt: round(Math.max(0, -head), 1),
    crosswindKt: round(Math.abs(cross), 1),
    crosswindSide: Math.abs(cross) < 0.5 ? 'none' : cross > 0 ? 'right' : 'left',
    gustHeadwindKt: gust == null ? null : round(gust * Math.cos(delta), 1),
    gustCrosswindKt: gust == null ? null : round(Math.abs(gust * Math.sin(delta)), 1),
  };
}

function round(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Everything the conditions panel shows, from raw input. */
export function analyseConditions({
  elevationFt = null,
  qnhHpa = P0_HPA,
  oatC = null,
  runwayHeadingDeg = null,
  windFromDeg = null,
  windKt = null,
  gustKt = null,
  runwayLengthFt = null,
  slopePct = null,
} = {}) {
  const pressureAltitude = pressureAltitudeFt(elevationFt, qnhHpa);
  const isa = isaTemperatureC(pressureAltitude);
  const deviation = isaDeviationC(oatC, pressureAltitude);
  const density = densityAltitudeFt(pressureAltitude, oatC);
  const wind = windComponents(runwayHeadingDeg, windFromDeg, windKt, gustKt);
  return {
    pressureAltitudeFt: round(pressureAltitude, 0),
    isaTemperatureC: round(isa, 1),
    isaDeviationC: round(deviation, 1),
    densityAltitudeFt: round(density, 0),
    wind,
    runwayLengthFt: Number.isFinite(Number(runwayLengthFt)) ? Number(runwayLengthFt) : null,
    slopePct: Number.isFinite(Number(slopePct)) ? Number(slopePct) : null,
  };
}

/* ── imported AFM datasets ───────────────────────────────────────────── */

const LIMITS = {
  weight: [500, 700000],
  pressureAltitudeFt: [-2000, 22000],
  oatC: [-70, 60],
};

function ascendingAxis(name, axis) {
  if (!Array.isArray(axis) || axis.length < 2) return `${name} needs at least two stops.`;
  const [min, max] = LIMITS[name];
  let previous = -Infinity;
  for (const value of axis) {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${name} contains a non-number.`;
    if (n < min || n > max) return `${name} stop ${n} is outside ${min}…${max}.`;
    if (n <= previous) return `${name} must be strictly ascending.`;
    previous = n;
  }
  return '';
}

function validateTable(name, table, axes) {
  const problems = [];
  if (!table || typeof table !== 'object') return [`${name} is missing.`];
  const shape = [axes.weight.length, axes.pressureAltitudeFt.length, axes.oatC.length];
  const values = table;
  if (!Array.isArray(values)) return [`${name} must be an array of arrays indexed [weight][pressureAltitude][oatC].`];
  if (values.length !== shape[0]) problems.push(`${name} has ${values.length} weight rows, expected ${shape[0]}.`);
  values.forEach((byAlt, i) => {
    if (!Array.isArray(byAlt) || byAlt.length !== shape[1]) {
      problems.push(`${name}[${i}] must hold ${shape[1]} pressure-altitude rows.`);
      return;
    }
    byAlt.forEach((byTemp, j) => {
      if (!Array.isArray(byTemp) || byTemp.length !== shape[2]) {
        problems.push(`${name}[${i}][${j}] must hold ${shape[2]} temperature values.`);
        return;
      }
      byTemp.forEach(value => {
        if (value === null) return; // an unpublished cell stays unavailable
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) problems.push(`${name}[${i}][${j}] has an invalid value.`);
      });
    });
  });
  return problems;
}

/**
 * Validate an imported dataset. Nothing is repaired: a dataset either passes
 * every structural check or none of its numbers are shown.
 */
export function validateDataset(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return { ok: false, problems: ['The file is not a JSON object.'] };
  if (raw.schema !== SCHEMA) problems.push(`schema must be "${SCHEMA}".`);
  const aircraft = raw.aircraft || {};
  if (!/^[A-Z0-9]{3,4}$/.test(String(aircraft.icao || '').toUpperCase())) problems.push('aircraft.icao must be a 3–4 character type designator.');
  if (!String(aircraft.variant || '').trim()) problems.push('aircraft.variant is required, e.g. "A321-200".');
  if (!String(raw.source || '').trim()) problems.push('source is required: where the numbers come from.');
  if (!String(raw.revision || '').trim()) problems.push('revision is required: the dataset date or version.');
  if (typeof raw.approved !== 'boolean') problems.push('approved must be true or false.');
  if (!['simulation', 'operational'].includes(raw.mode)) problems.push('mode must be "simulation" or "operational".');

  const axes = raw.axes || {};
  for (const [name, label] of [['weight', 'axes.weight'], ['pressureAltitudeFt', 'axes.pressureAltitudeFt'], ['oatC', 'axes.oatC']]) {
    const problem = ascendingAxis(name, axes[name]);
    if (problem) problems.push(problem.replace(name, label));
  }
  const hasTakeoff = raw.takeoff && typeof raw.takeoff === 'object';
  const hasLanding = raw.landing && typeof raw.landing === 'object';
  if (!hasTakeoff && !hasLanding) problems.push('Provide a takeoff table, a landing table, or both.');
  if (!problems.length) {
    for (const [key, table] of Object.entries(raw.takeoff || {})) {
      problems.push(...validateTable(`takeoff.${key}`, table, axes));
    }
    for (const [key, table] of Object.entries(raw.landing || {})) {
      problems.push(...validateTable(`landing.${key}`, table, axes));
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, problems: [], dataset: raw };
}

class OutOfRange extends Error {
  constructor(message) { super(message); this.name = 'OutOfRange'; }
}

function bracket(axis, value, label) {
  if (value < axis[0] || value > axis[axis.length - 1]) {
    throw new OutOfRange(`${label} ${Math.round(value)} is outside the dataset (${axis[0]}…${axis[axis.length - 1]}).`);
  }
  let i = 0;
  while (i < axis.length - 2 && value > axis[i + 1]) i += 1;
  const span = axis[i + 1] - axis[i];
  return { i, f: span > 0 ? (value - axis[i]) / span : 0 };
}

function mix(a, b, f) {
  if (a == null || b == null) return null;
  return a + (b - a) * f;
}

/**
 * Trilinear interpolation inside the dataset, refusing to extrapolate.
 * Returns null when any corner of the cell is unpublished.
 */
export function interpolateTable(table, axes, { weight, pressureAltitudeFt: pa, oatC }) {
  const w = Number(weight);
  const p = Number(pa);
  const t = Number(oatC);
  if (!Number.isFinite(w) || !Number.isFinite(p) || !Number.isFinite(t)) return null;
  const wi = bracket(axes.weight, w, 'Weight');
  const pi = bracket(axes.pressureAltitudeFt, p, 'Pressure altitude');
  const ti = bracket(axes.oatC, t, 'Temperature');
  const at = (i, j, k) => {
    const value = table[i] && table[i][j] ? table[i][j][k] : null;
    return value == null ? null : Number(value);
  };
  const corners = [];
  for (const [di, fi] of [[0, wi.f], [1, wi.f]]) {
    for (const [dj, fj] of [[0, pi.f], [1, pi.f]]) {
      const low = mix(at(wi.i + di, pi.i + dj, ti.i), at(wi.i + di, pi.i + dj, ti.i + 1), ti.f);
      corners.push({ value: low, w: (di ? fi : 1 - fi) * (dj ? fj : 1 - fj) });
    }
  }
  if (corners.some(c => c.value == null)) return null;
  const sum = corners.reduce((total, c) => total + c.value * c.w, 0);
  return round(sum, 0);
}

/**
 * Look up every performance figure the dataset publishes for one case.
 * Each key is { value } or { unavailable: reason } — never a silent zero.
 */
export function lookupPerformance(dataset, phase, inputs) {
  const result = {};
  if (!dataset) return result;
  const table = dataset[phase] || {};
  for (const [key, values] of Object.entries(table)) {
    try {
      const value = interpolateTable(values, dataset.axes, inputs);
      result[key] = value == null
        ? { unavailable: 'The dataset does not publish this cell of the table.' }
        : { value };
    } catch (error) {
      result[key] = { unavailable: error.message };
    }
  }
  return result;
}

/** Dataset headline, for the source line under a calculation. */
export function datasetLabel(dataset) {
  if (!dataset) return null;
  const aircraft = dataset.aircraft || {};
  const mode = dataset.mode === 'operational' ? 'operational' : 'simulation';
  return `${aircraft.icao} ${aircraft.variant} · ${dataset.source} · revision ${dataset.revision} · ${mode}${dataset.approved ? '' : ' · unapproved'}`;
}

export { OutOfRange };
