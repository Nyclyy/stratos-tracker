/* Aircraft the EFB knows how to name.
 *
 * This registry deliberately holds no performance numbers. V-speeds, field
 * lengths and gradients belong to a specific type, weight, flap, thrust and
 * runway condition, and they come from the operator's AFM/POH. Stratos has not
 * been licensed an approved performance dataset, so inventing numbers here
 * would be worse than saying "no data". The performance app imports a dataset
 * the operator is entitled to use and records its source and revision; see
 * docs/EFB-PERFORMANCE-DATA.md.
 *
 * `icao` values are the standard type designators used by flight plans, which
 * is how the EFB matches the imported SimBrief aircraft to this list.
 */

export const EFB_AIRCRAFT = [
  {
    key: 'a340-600',
    icao: 'A346',
    name: 'Airbus A340-600',
    family: 'Airbus A340',
    variants: [{ icao: 'A346', label: 'A340-600' }],
    notes: 'Four-engine long-haul Airbus. Takeoff and landing data are only shown when an A340-600 dataset is imported.',
  },
  {
    key: 'a321',
    icao: 'A321',
    name: 'Airbus A321',
    family: 'Airbus A320 family',
    variants: [
      { icao: 'A321', label: 'A321-200 (ceo)' },
      { icao: 'A21N', label: 'A321neo' },
    ],
    notes: 'ceo and neo are different types with different limits and performance. They are kept separate here and must not share a dataset.',
  },
  {
    key: 'b777',
    icao: 'B77W',
    name: 'Boeing 777',
    family: 'Boeing 777',
    variants: [
      { icao: 'B772', label: '777-200ER' },
      { icao: 'B77L', label: '777-200LR' },
      { icao: 'B77W', label: '777-300ER' },
    ],
    notes: 'Engine fit and weights differ between 777 variants, so each variant needs its own dataset.',
  },
];

const BY_ICAO = new Map();
for (const type of EFB_AIRCRAFT) {
  for (const variant of type.variants) BY_ICAO.set(variant.icao, { ...type, variant });
}

export function aircraftByIcao(icao) {
  return BY_ICAO.get(String(icao || '').trim().toUpperCase()) || null;
}

export function aircraftLabel(icao) {
  const hit = aircraftByIcao(icao);
  if (!hit) return String(icao || '').trim() || 'Unknown type';
  return hit.family === hit.variant.label ? hit.name : `${hit.name} · ${hit.variant.label}`;
}

export function allVariantIcaos() {
  return [...BY_ICAO.keys()];
}
