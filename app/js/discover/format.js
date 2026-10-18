// Presentation helpers for Route Discovery, kept free of DOM so they can be
// unit tested directly.

/** 1.4 -> "1 h 24 m", 0.6 -> "36 m". */
export function hoursText(hours) {
  const total = Math.round((Number(hours) || 0) * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} m`;
  return m ? `${h} h ${m} m` : `${h} h`;
}

export function nmText(nm) {
  const value = Number(nm);
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString()} nm`;
}

export const DIFFICULTY_LABELS = {
  easy: 'Easy',
  moderate: 'Moderate',
  demanding: 'Demanding',
};

export function difficultyText(level) {
  return DIFFICULTY_LABELS[level] || 'Not rated';
}

/**
 * Pull an ICAO-looking token out of whatever the user typed, so both "EGLL"
 * and "EGLL — London Heathrow" work in the departure box.
 */
export function extractIcao(text) {
  const match = String(text || '').toUpperCase().match(/[A-Z]{4}/);
  return match ? match[0] : '';
}

/** "LSZH → LOWI" plus "via EDDF" for multi-leg routes. */
export function routeLabel(recommandation) {
  const stops = recommandation?.stops || [];
  if (!stops.length) return '';
  if (stops.length === 2) return `${stops[0].id} → ${stops[1].id}`;
  return `${stops[0].id} → ${stops.slice(1, -1).map(stop => stop.id).join(', ')} → ${stops[stops.length - 1].id}`;
}

export function stopsText(stops) {
  const count = (stops?.length || 0) - 2;
  if (count <= 0) return 'Direct';
  return `${count} stop${count === 1 ? '' : 's'}`;
}
