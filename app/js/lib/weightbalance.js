/* EFB weight & balance: sums, limit checks and honest centre-of-gravity handling.
 *
 * The arithmetic is plain and exact: payload is what the pilot loads, ZFW is OEW
 * plus payload, takeoff weight adds fuel, landing weight subtracts trip fuel.
 * Limits come from the imported SimBrief plan (max ZFW/TOW/LDW) or from values
 * the pilot enters from their own documentation — never from a default.
 *
 * Centre of gravity is only reported when a real figure exists (SimBrief states
 * one for the plan) or when the pilot enters one. Stratos has no station/arm
 * table for these types, so it does not compute a CG and does not pretend an
 * out-of-envelope check it cannot perform.
 *
 * Units are the plan's own weight unit throughout; the caller converts for
 * display. No DOM.
 */

const num = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Limits and OEW carried by an imported OFP, in the OFP's unit. */
export function limitsFromOfp(ofp) {
  const w = (ofp && ofp.weights) || {};
  const unit = ofp && ofp.units === 'lb' ? 'lb' : 'kg';
  return {
    unit,
    oew: num(w.oew),
    mzfw: num(w.mzfw),
    mtow: num(w.mtow),
    mlw: num(w.mlw),
    cg: parseCg(w.cg),
    pax: num(w.pax),
    cargo: num(w.cargo),
  };
}

/** SimBrief reports CG as "25.4" or "25.4% MAC"; anything else is not a number. */
export function parseCg(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n < -10 || n > 80) return null;
  return n;
}

function finiteOrNull(value) {
  const n = num(value);
  return n != null && n >= 0 ? n : null;
}

/**
 * Build the load sheet.
 * input: { oew, pax, paxWeight, crew, cargo, fuel, taxiFuel, tripFuel, limits, cg, cgEnvelope }
 * All weights in one unit; missing inputs stay null instead of defaulting to 0.
 */
export function computeLoadSheet(input = {}) {
  const oew = finiteOrNull(input.oew);
  const pax = finiteOrNull(input.pax);
  const paxWeight = finiteOrNull(input.paxWeight);
  const crew = finiteOrNull(input.crew);
  const cargo = finiteOrNull(input.cargo);
  const fuel = finiteOrNull(input.fuel);
  const taxiFuel = finiteOrNull(input.taxiFuel);
  const tripFuel = finiteOrNull(input.tripFuel);
  const limits = input.limits || {};

  const paxWeightTotal = pax != null && paxWeight != null ? pax * paxWeight : null;
  const payloadParts = [paxWeightTotal, crew, cargo].filter(v => v != null);
  const payload = payloadParts.length ? payloadParts.reduce((a, b) => a + b, 0) : null;
  const payloadComplete = paxWeightTotal != null && cargo != null;

  const zfw = oew != null && payload != null ? oew + payload : null;
  const takeoffFuel = fuel;
  const tow = zfw != null && takeoffFuel != null ? zfw + takeoffFuel : null;
  const lw = tow != null && tripFuel != null ? tow - tripFuel : null;

  const checks = [
    limitCheck('zfw', 'Zero fuel weight', zfw, limits.mzfw),
    limitCheck('tow', 'Takeoff weight', tow, limits.mtow),
    limitCheck('lw', 'Landing weight', lw, limits.mlw),
  ];

  const cg = parseCg(input.cg);
  const envelopeMin = num(input.cgEnvelope && input.cgEnvelope.min);
  const envelopeMax = num(input.cgEnvelope && input.cgEnvelope.max);
  const cgCheck = cg != null && envelopeMin != null && envelopeMax != null
    ? { value: cg, min: envelopeMin, max: envelopeMax, inside: cg >= envelopeMin && cg <= envelopeMax }
    : null;

  const notes = [];
  if (payloadComplete === false) notes.push('Payload is incomplete: enter both the passenger count and cargo weight for a ZFW.');
  if (oew == null) notes.push('No operating empty weight: import a SimBrief plan or enter the OEW from your documentation.');
  if (takeoffFuel == null) notes.push('No takeoff fuel entered, so no takeoff or landing weight can be calculated.');
  if (cg == null) notes.push('No centre of gravity is available for this plan. Stratos has no station/arm data for these types and will not estimate one.');
  if (cg != null && !cgCheck) notes.push('Enter the certified CG envelope (minimum and maximum %MAC) to have the CG checked.');
  if (limits.mzfw == null && limits.mtow == null && limits.mlw == null) notes.push('No maximum weights are loaded: check them in your documentation.');

  return {
    unit: limits.unit || input.unit || 'kg',
    oew,
    payload,
    paxWeightTotal,
    zfw,
    fuel: takeoffFuel,
    tow,
    lw,
    tripFuel,
    taxiFuel,
    cg,
    cgCheck,
    checks,
    overLimit: checks.some(c => c.over),
    complete: zfw != null && tow != null,
    notes,
    breakdown: [
      { key: 'oew', label: 'Operating empty weight', value: oew },
      { key: 'pax', label: 'Passengers', value: paxWeightTotal },
      { key: 'crew', label: 'Crew and equipment', value: crew },
      { key: 'cargo', label: 'Cargo and baggage', value: cargo },
      { key: 'fuel', label: 'Takeoff fuel', value: takeoffFuel },
    ].filter(row => row.value != null),
  };
}

/** One weight against its certified limit. A missing limit is not a pass. */
export function limitCheck(key, label, value, limit) {
  const v = num(value);
  const l = num(limit);
  if (v == null || l == null || l <= 0) {
    return { key, label, value: v, limit: l, over: false, margin: null, percent: null, checked: false };
  }
  return {
    key,
    label,
    value: v,
    limit: l,
    over: v > l,
    margin: l - v,
    percent: Math.max(0, Math.min(1, v / l)),
    checked: true,
  };
}

/** Landing weight from a plan, when the plan states both takeoff weight and trip fuel. */
export function plannedLandingWeight(ofp) {
  const w = (ofp && ofp.weights) || {};
  const f = (ofp && ofp.fuel) || {};
  const lw = num(w.lw);
  if (lw != null) return { value: lw, source: 'ofp' };
  const tow = num(w.tow);
  const trip = num(f.trip);
  if (tow != null && trip != null) return { value: tow - trip, source: 'calculated' };
  return { value: null, source: null };
}
