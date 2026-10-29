/* Performance calculation engine.
 *
 * Pure functions, no DOM. Two kinds of number live here and are never mixed:
 *
 *  1. Atmosphere. Pressure altitude, ISA, density altitude and wind components
 *     are physics and are computed exactly from the inputs.
 *
 *  2. Aircraft performance. A limit or a field length belongs to one type at
 *     one weight, configuration and runway condition. It is only produced from
 *     a profile in the bundled database and, for a field length, only from a
 *     licensed table. Outside the table's axes the answer is unavailable, never
 *     an extrapolation. A missing input is null, never zero.
 *
 * Canonical units: kilograms, feet, knots, degrees Celsius, hPa.
 */

const P0_HPA = 1013.25;
const T0_K = 288.15;
const LAPSE_K_PER_M = 0.0065;
const ISA_EXPONENT = 5.25588;
const ISA_LAPSE_C_PER_FT = 0.00198;
const LB_TO_KG = 0.45359237;
const M_TO_FT = 3.280839895;

export const ENGINE_VERSION = 'stratos.performance-engine/1';

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* ── units ───────────────────────────────────────────────────────────── */

export function convertWeight(value, from = 'kg', to = 'kg') {
  const number = toNumber(value);
  const factors = { kg: 1, lb: LB_TO_KG };
  if (number == null || !factors[from] || !factors[to]) return null;
  return number * factors[from] / factors[to];
}

export function convertDistance(value, from = 'ft', to = 'ft') {
  const number = toNumber(value);
  const factors = { ft: 1, m: M_TO_FT };
  if (number == null || !factors[from] || !factors[to]) return null;
  return number * factors[from] / factors[to];
}

/* ── atmosphere ──────────────────────────────────────────────────────── */

/** Pressure altitude under ISA from an aerodrome elevation and the QNH. */
export function pressureAltitudeFt(elevationFt, qnhHpa = P0_HPA) {
  const elevation = toNumber(elevationFt);
  const qnh = toNumber(qnhHpa);
  if (elevation == null || qnh == null || qnh < 850 || qnh > 1085) return null;
  const ratio = qnh / P0_HPA;
  const metres = (T0_K / LAPSE_K_PER_M) * (1 - Math.pow(ratio, 1 / ISA_EXPONENT));
  return elevation + metres * M_TO_FT;
}

/** ISA temperature at an altitude, °C. */
export function isaTemperatureC(altitudeFt) {
  const altitude = toNumber(altitudeFt);
  if (altitude == null) return null;
  return 15 - ISA_LAPSE_C_PER_FT * altitude;
}

/** How much warmer or colder than ISA the reported temperature is, °C. */
export function isaDeviationC(oatC, altitudeFt) {
  const isa = isaTemperatureC(altitudeFt);
  const oat = toNumber(oatC);
  if (isa == null || oat == null) return null;
  return oat - isa;
}

/** Density altitude from pressure altitude and temperature. */
export function densityAltitudeFt(pressureAltFtValue, oatC) {
  const pressure = toNumber(pressureAltFtValue);
  const oat = toNumber(oatC);
  if (pressure == null || oat == null) return null;
  const isa = isaTemperatureC(pressure);
  if (isa == null) return null;
  return pressure + 118.8 * (oat - isa);
}

function normalizeHeading(value) {
  const number = toNumber(value);
  if (number == null) return null;
  return ((number % 360) + 360) % 360;
}

/**
 * Wind resolved on a runway. Headwind positive is on the nose; crosswind
 * positive is from the right.
 */
export function windComponents(runwayHeadingDeg, windFromDeg, windKt, gustKt = null) {
  const runway = normalizeHeading(runwayHeadingDeg);
  const from = normalizeHeading(windFromDeg);
  const speed = toNumber(windKt);
  if (runway == null || from == null || speed == null || speed < 0) return null;
  const gust = toNumber(gustKt);
  const delta = ((from - runway + 540) % 360 - 180) * (Math.PI / 180);
  const head = speed * Math.cos(delta);
  const cross = speed * Math.sin(delta);
  const gustSpeed = gust != null ? Math.max(speed, gust) : null;
  return {
    runwayHeading: runway,
    windFrom: from,
    speedKt: speed,
    gustKt: gustSpeed,
    headwindKt: round(head, 1),
    tailwindKt: round(Math.max(0, -head), 1),
    crosswindKt: round(Math.abs(cross), 1),
    crosswindSide: Math.abs(cross) < 0.5 ? 'none' : cross > 0 ? 'right' : 'left',
    gustHeadwindKt: gustSpeed == null ? null : round(gustSpeed * Math.cos(delta), 1),
    gustCrosswindKt: gustSpeed == null ? null : round(Math.abs(gustSpeed * Math.sin(delta)), 1),
  };
}

/** Everything the conditions panel shows, independently missing where blank. */
export function analyseConditions({
  elevationFt = null,
  qnhHpa = null,
  oatC = null,
  runwayHeadingDeg = null,
  windFromDeg = null,
  windKt = null,
  gustKt = null,
} = {}) {
  const elevation = toNumber(elevationFt);
  const qnh = toNumber(qnhHpa) ?? (qnhHpa === null || qnhHpa === undefined ? P0_HPA : null);
  const oat = toNumber(oatC);
  const pressure = elevation != null && qnh != null ? pressureAltitudeFt(elevation, qnh) : null;
  const isa = pressure != null ? isaTemperatureC(pressure) : null;
  return {
    pressureAltitudeFt: round(pressure, 0),
    isaTemperatureC: round(isa, 1),
    isaDeviationC: pressure != null && oat != null ? round(oat - isa, 1) : null,
    densityAltitudeFt: round(densityAltitudeFt(pressure, oat), 0),
    wind: windComponents(runwayHeadingDeg, windFromDeg, windKt, gustKt),
  };
}

/* ── licensed table interpolation ────────────────────────────────────── */

class OutOfRange extends Error {
  constructor(message) { super(message); this.name = 'OutOfRange'; }
}

function bracket(axis, value, label) {
  if (!Array.isArray(axis) || axis.length < 2) throw new OutOfRange(`${label} axis is missing.`);
  if (value < axis[0] || value > axis[axis.length - 1]) {
    throw new OutOfRange(`${label} ${Math.round(value)} is outside the published table (${axis[0]}…${axis[axis.length - 1]}).`);
  }
  let index = 0;
  while (index < axis.length - 2 && value > axis[index + 1]) index += 1;
  const span = axis[index + 1] - axis[index];
  return { index, fraction: span > 0 ? (value - axis[index]) / span : 0 };
}

function mix(a, b, fraction) {
  if (a == null || b == null) return null;
  return a + (b - a) * fraction;
}

/**
 * Trilinear interpolation inside a published table. Returns null when a corner
 * is unpublished or the values are outside the axes; it never extrapolates.
 */
export function interpolateTable(table, axes, { weightKg, pressureAltitudeFt: pressure, oatC }) {
  const weight = toNumber(weightKg);
  const altitude = toNumber(pressure);
  const temperature = toNumber(oatC);
  if (!table || !axes || weight == null || altitude == null || temperature == null) return null;
  const wi = bracket(axes.weightKg, weight, 'Weight');
  const pi = bracket(axes.pressureAltitudeFt, altitude, 'Pressure altitude');
  const ti = bracket(axes.oatC, temperature, 'Temperature');
  const at = (i, j, k) => {
    const value = table[i] && table[i][j] ? table[i][j][k] : null;
    return value == null ? null : toNumber(value);
  };
  const corners = [];
  for (const [di, fi] of [[0, wi.fraction], [1, wi.fraction]]) {
    for (const [dj, fj] of [[0, pi.fraction], [1, pi.fraction]]) {
      const low = mix(at(wi.index + di, pi.index + dj, ti.index), at(wi.index + di, pi.index + dj, ti.index + 1), ti.fraction);
      corners.push({ value: low, weight: (di ? fi : 1 - fi) * (dj ? fj : 1 - fj) });
    }
  }
  if (corners.some(corner => corner.value == null)) return null;
  return round(corners.reduce((total, corner) => total + corner.value * corner.weight, 0), 0);
}

function lookup(table, key, axes, inputs, reason) {
  if (!table || table[key] === undefined) {
    return { value: null, status: 'unavailable', note: reason };
  }
  try {
    const value = interpolateTable(table[key], axes, inputs);
    return value == null
      ? { value: null, status: 'unavailable', note: 'The table does not publish this cell.' }
      : { value, status: 'interpolated', note: 'Interpolated between the published points; not extrapolated.' };
  } catch (error) {
    return { value: null, status: 'unavailable', note: error.message };
  }
}

/* ── evaluation ──────────────────────────────────────────────────────── */

function sourceLabel(profile) {
  const source = profile.source || {};
  return `${source.name || 'Bundled profile'} · ${source.record || profile.name} · ${source.release || 'version not stated'}`;
}

function result(id, label, value, unit, status, source, note) {
  return { id, label, value: value == null ? null : value, unit: unit || '', status, source: source || '', note: note || '' };
}

function unavailable(id, label, unit, reason, source = '') {
  return result(id, label, null, unit, 'unavailable', source, reason);
}

/**
 * Evaluate one phase for one profile.
 *
 * @param {object} profile bundled profile
 * @param {'takeoff'|'landing'} phase
 * @param {object} inputs weight, elevationFt, qnhHpa, oatC, windFromDeg, windKt,
 *   gustKt, runwayHeadingDeg, runwayLengthFt, units { weight, distance }
 */
export function evaluatePhase(profile, phase, inputs = {}) {
  if (!profile) throw new Error('A performance profile is required.');
  if (phase !== 'takeoff' && phase !== 'landing') throw new Error(`Unknown phase ${phase}.`);

  const units = inputs.units || {};
  const weightKg = convertWeight(inputs.weight, units.weight || 'kg', 'kg');
  const elevationFt = toNumber(inputs.elevationFt);
  const qnhHpa = toNumber(inputs.qnhHpa);
  const oatC = toNumber(inputs.oatC);
  const runwayLengthFt = convertDistance(inputs.runwayLengthFt, units.distance || 'ft', 'ft');
  const conditions = analyseConditions({
    elevationFt,
    qnhHpa,
    oatC,
    runwayHeadingDeg: inputs.runwayHeadingDeg,
    windFromDeg: inputs.windFromDeg,
    windKt: inputs.windKt,
    gustKt: inputs.gustKt,
  });

  const takeoff = phase === 'takeoff';
  const weightUnit = units.weight === 'lb' ? 'lb' : 'kg';
  const weightText = kg => Math.round(weightUnit === 'lb' ? convertWeight(kg, 'kg', 'lb') : kg);
  const limitKg = takeoff ? profile.limits.mtowKg : profile.limits.mlwKg;
  const limitLabel = takeoff ? 'MTOW' : 'MLW';
  const part = profile[phase] || {};
  const phaseLabel = takeoff ? 'Takeoff' : 'Landing';
  const source = sourceLabel(profile);
  const results = [];
  const warnings = [];

  results.push(result(
    takeoff ? 'mtow' : 'mlw',
    limitLabel,
    limitKg,
    'kg',
    'verified',
    `${profile.source.name} · ${profile.source.record} · ${profile.source.release}`,
    `Published ${takeoff ? 'maximum takeoff' : 'maximum landing'} weight. Profile verification: ${profile.verification}.`,
  ));

  if (profile.limits && profile.limits[`${phase}WeightNote`]) {
    // Reserved for a future licensed limit; no shipped profile sets it.
    results[results.length - 1].note = profile.limits[`${phase}WeightNote`];
  }

  if (weightKg == null) {
    results.push(unavailable('margin', 'Weight margin', 'kg', 'Enter the aircraft weight to compare it with the limit.', source));
  } else {
    const margin = round(limitKg - weightKg, 0);
    results.push(result(
      'margin',
      'Weight margin',
      margin,
      'kg',
      'verified',
      source,
      margin >= 0 ? 'Published limit minus the entered weight.' : 'The entered weight exceeds the published limit.',
    ));
    if (margin < 0) warnings.push(`${phaseLabel} weight is ${weightText(Math.abs(margin)).toLocaleString('en-US')} ${weightUnit} above the published ${limitLabel}.`);
  }

  if (!takeoff) {
    results.push(toNumber(part.vrefKt) != null
      ? result('vref', 'VREF', toNumber(part.vrefKt), 'kt', 'verified', source, part.vrefBasis || 'Published approach speed.')
      : unavailable('vref', 'VREF', 'kt', 'No VREF is published for this profile.', source));
  }

  const fieldLabels = takeoff
    ? [['groundRollFt', 'Ground roll'], ['distanceFt', 'Total distance over 35 ft'], ['requiredRunwayFt', 'Required runway']]
    : [['distanceFt', 'Landing distance'], ['requiredRunwayFt', 'Required runway']];
  const fieldInputs = { weightKg, pressureAltitudeFt: conditions.pressureAltitudeFt, oatC };
  const axesReady = conditions.pressureAltitudeFt != null && oatC != null && weightKg != null;

  for (const [key, label] of fieldLabels) {
    if (part.status !== 'supported' || !part.table) {
      results.push(unavailable(key, label, 'ft', part.reason || `No licensed ${phase} field-length table is bundled for this type.`, source));
      continue;
    }
    if (!axesReady) {
      results.push(unavailable(key, label, 'ft', 'Weight, pressure altitude and OAT are needed for the table lookup.', source));
      continue;
    }
    const entry = lookup(part.table, key, part.table.axes, fieldInputs, `The table does not publish ${label.toLowerCase()}.`);
    results.push(result(key, label, entry.value, 'ft', entry.status, source, entry.note));
  }

  if (takeoff) {
    const speedKeys = [['v1Kt', 'V1'], ['vrKt', 'VR'], ['v2Kt', 'V2']];
    for (const [key, label] of speedKeys) {
      if (!part.table || part.table[key] === undefined) {
        results.push(unavailable(key, label, 'kt', part.reason || `No licensed ${label} table is bundled for this type.`, source));
        continue;
      }
      if (!axesReady) {
        results.push(unavailable(key, label, 'kt', 'Weight, pressure altitude and OAT are needed for the table lookup.', source));
        continue;
      }
      const entry = lookup(part.table, key, part.table.axes, fieldInputs, `The table does not publish ${label}.`);
      results.push(result(key, label, entry.value, 'kt', entry.status, source, entry.note));
    }
  }

  const required = results.find(item => item.id === 'requiredRunwayFt' && item.value != null);
  if (required && runwayLengthFt != null) {
    const margin = round(runwayLengthFt - required.value, 0);
    results.push(result(
      'runwayMargin',
      'Runway margin',
      margin,
      'ft',
      required.status,
      required.source,
      margin >= 0 ? 'Available runway minus the required distance.' : 'The required distance exceeds the available runway.',
    ));
    if (margin < 0) warnings.push(`Required ${phase} distance exceeds the available ${Math.round(runwayLengthFt).toLocaleString('en-US')} ft by ${Math.abs(margin).toLocaleString('en-US')} ft.`);
  } else if (runwayLengthFt == null) {
    results.push(unavailable('runwayMargin', 'Runway margin', 'ft', 'Enter the available runway length to compare it with the required distance.', source));
  }

  if (conditions.densityAltitudeFt != null && conditions.densityAltitudeFt > elevationFt + 2000) {
    warnings.push('Density altitude is more than 2,000 ft above field elevation.');
  }
  if (conditions.wind && conditions.wind.tailwindKt > 0) {
    warnings.push(`Tailwind of ${conditions.wind.tailwindKt} kt.`);
  }
  if (conditions.wind && conditions.wind.crosswindKt >= 20) {
    warnings.push(`Crosswind ${conditions.wind.crosswindKt} kt: check the type's demonstrated crosswind.`);
  }

  const range = profile.operatingRange || {};
  const outside = [];
  if (weightKg != null && range.weightKg && (weightKg < range.weightKg[0] || weightKg > range.weightKg[1])) outside.push('weight');
  if (conditions.pressureAltitudeFt != null && range.pressureAltitudeFt
    && (conditions.pressureAltitudeFt < range.pressureAltitudeFt[0] || conditions.pressureAltitudeFt > range.pressureAltitudeFt[1])) outside.push('pressure altitude');
  if (oatC != null && range.oatC && (oatC < range.oatC[0] || oatC > range.oatC[1])) outside.push('temperature');
  if (outside.length) warnings.push(`Outside the profile's stated input window: ${outside.join(', ')}.`);

  return {
    engine: ENGINE_VERSION,
    profile: profile.id,
    phase,
    source,
    verification: profile.verification,
    units: { weight: 'kg', distance: 'ft', speed: 'kt' },
    conditions,
    inputs: {
      weightKg,
      elevationFt,
      qnhHpa,
      oatC,
      runwayLengthFt,
    },
    results,
    warnings,
    supported: part.status === 'supported' && Boolean(part.table),
    note: profile.operatingRange && profile.operatingRange.basis || '',
  };
}
