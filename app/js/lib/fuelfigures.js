/* EFB fuel planning: the plan's own figures, a manual sheet, and one
 * reconciliation that says whether they add up.
 *
 * SimBrief states block fuel and its components separately. Stratos never
 * silently replaces one with the other or "fixes" a plan that does not balance:
 * it shows the stated block, the sum of the stated components, the difference and
 * where every number came from. A component that the plan omits stays missing
 * rather than becoming zero, so nothing is double counted or invented.
 *
 * No DOM, no unit conversion. The caller converts for display.
 */

const num = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export const FUEL_COMPONENTS = [
  { key: 'taxi', label: 'Taxi fuel', hint: 'APU and taxi-out burn' },
  { key: 'trip', label: 'Trip fuel', hint: 'Burn from takeoff to touchdown' },
  { key: 'contingency', label: 'Contingency', hint: 'Allowance for the unexpected' },
  { key: 'alternate', label: 'Alternate fuel', hint: 'Destination to alternate' },
  { key: 'reserve', label: 'Final reserve', hint: 'Holding at 1,500 ft or as filed' },
  { key: 'extra', label: 'Extra fuel', hint: 'Discretionary fuel on board' },
];

function componentRows(values, source) {
  return FUEL_COMPONENTS.map(component => ({
    key: component.key,
    label: component.label,
    hint: component.hint,
    value: num(values && values[component.key]),
    source: num(values && values[component.key]) == null ? null : source,
  }));
}

/** Values as the imported SimBrief plan stated them. */
export function fuelFromOfp(ofp) {
  if (!ofp || !ofp.fuel) return null;
  const f = ofp.fuel;
  const rows = componentRows(f, 'ofp');
  const parts = rows.filter(row => row.value != null);
  const sum = parts.length ? parts.reduce((total, row) => total + row.value, 0) : null;
  const block = num(f.block);
  const takeoff = num(f.takeoff) ?? (block != null && num(f.taxi) != null ? block - f.taxi : null);
  const landing = num(f.landing) ?? (takeoff != null && num(f.trip) != null ? takeoff - f.trip : null);
  return {
    unit: ofp.units === 'lb' ? 'lb' : 'kg',
    source: 'ofp',
    block,
    takeoff,
    landing,
    rows,
    sum,
    difference: block != null && sum != null ? block - sum : null,
    balanced: block != null && sum != null ? Math.abs(block - sum) <= Math.max(50, block * 0.005) : null,
    notes: buildNotes(block, takeoff, landing, rows),
  };
}

/** A sheet the pilot enters, with the same shape as the plan's. */
export function manualSheet(values = {}) {
  const rows = componentRows(values, 'entered');
  const parts = rows.filter(row => row.value != null);
  const sum = parts.length ? parts.reduce((total, row) => total + row.value, 0) : null;
  const block = num(values.block) ?? sum;
  const takeoff = block != null && num(values.taxi) != null ? block - values.taxi : null;
  const landing = takeoff != null && num(values.trip) != null ? takeoff - values.trip : null;
  return {
    unit: values.unit === 'lb' ? 'lb' : 'kg',
    source: 'manual',
    block,
    takeoff,
    landing,
    rows,
    sum,
    difference: block != null && sum != null ? block - sum : null,
    balanced: block != null && sum != null ? Math.abs(block - sum) <= Math.max(50, block * 0.005) : null,
    notes: buildNotes(block, takeoff, landing, rows),
  };
}

function buildNotes(block, takeoff, landing, rows) {
  const notes = [];
  const missing = rows.filter(row => row.value == null).map(row => row.label.toLowerCase());
  if (missing.length) notes.push(`Not stated, so not included: ${missing.join(', ')}.`);
  if (block == null) notes.push('No block fuel is stated, so the sheet cannot be totalled.');
  if (landing != null && landing < 0) notes.push('The trip fuel is larger than the takeoff fuel: the plan figures disagree.');
  return notes;
}

/**
 * Fuel at destination, split into what is usable and what the plan reserved.
 * `landing` is the plan's own destination fuel; when it is absent it is derived
 * from takeoff fuel minus trip fuel and marked as calculated.
 */
export function arrivalSummary(sheet) {
  if (!sheet) return null;
  const reserve = rowValue(sheet.rows, 'reserve');
  const alternate = rowValue(sheet.rows, 'alternate');
  const landing = sheet.landing;
  return {
    landing,
    landingSource: landing == null ? null : 'sheet',
    reserve,
    alternate,
    reservePlusAlternate: reserve != null || alternate != null ? (reserve || 0) + (alternate || 0) : null,
    blocks: [
      { key: 'takeoff', label: 'Takeoff fuel', value: sheet.takeoff },
      { key: 'trip', label: 'Trip burn', value: rowValue(sheet.rows, 'trip') },
      { key: 'landing', label: 'At destination', value: landing },
      { key: 'reserve', label: 'Final reserve', value: reserve },
      { key: 'alternate', label: 'Alternate fuel', value: alternate },
    ],
  };
}

function rowValue(rows, key) {
  const row = (rows || []).find(item => item.key === key);
  return row ? row.value : null;
}

/** Endurance from fuel and burn: minutes, or null when either is missing. */
export function enduranceMinutes(fuel, burnPerHour) {
  const f = num(fuel);
  const b = num(burnPerHour);
  if (f == null || b == null || b <= 0) return null;
  return Math.round((f / b) * 60);
}
