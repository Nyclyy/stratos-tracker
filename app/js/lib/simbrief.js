const SIMBRIEF_URL = 'https://www.simbrief.com/api/xml.fetcher.php';

// The Username / Pilot ID is saved once, so the planner and the Flight Deck
// import without asking again. Both pages read and write this same key.
export const SIMBRIEF_ID_KEY = 'stratos.simbriefId';

export function loadSimbriefId(storage) {
  try {
    return String((storage && storage.getItem(SIMBRIEF_ID_KEY)) || '').trim();
  } catch (_) {
    return '';
  }
}

export function saveSimbriefId(storage, entered) {
  const id = String(entered || '').trim();
  if (!id) return;
  try {
    if (storage) storage.setItem(SIMBRIEF_ID_KEY, id);
  } catch (_) { /* storage unavailable: the ID is simply asked for again */ }
}

export function clearSimbriefId(storage) {
  try {
    if (storage) storage.removeItem(SIMBRIEF_ID_KEY);
  } catch (_) { /* storage unavailable: nothing was saved */ }
}

/** A SimBrief Pilot ID is numeric; a username is letters, digits, dot, dash or underscore. */
export function validateSimbriefId(entered) {
  const id = String(entered || '').trim();
  if (!id) return { ok: false, error: 'Enter your SimBrief Pilot ID or username.' };
  if (id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, error: 'That does not look like a SimBrief Pilot ID. Use the number from your SimBrief account, or your username.' };
  }
  return { ok: true, id, kind: /^\d+$/.test(id) ? 'pilot' : 'username' };
}

export function simbriefQuery(entered) {
  const id = String(entered || '').trim();
  return /^\d+$/.test(id) ? `userid=${encodeURIComponent(id)}` : `username=${encodeURIComponent(id)}`;
}

function jsonFixes(data) {
  const fixes = data && data.navlog && data.navlog.fix;
  return Array.isArray(fixes) ? fixes : [];
}

function xmlFixes(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return [];
  return Array.from(doc.querySelectorAll('navlog > fix')).map(fix => {
    const text = name => (fix.querySelector(name)?.textContent ?? '').trim();
    return {
      ident: text('ident'),
      name: text('name'),
      pos_lat: text('pos_lat'),
      pos_long: text('pos_long'),
      altitude_feet: text('altitude_feet'),
      type: text('type'),
    };
  });
}

// Returns { origin, destination, general, fixes } where each fix has ident, name, pos_lat, pos_long, altitude_feet, type.
export async function fetchSimbriefPlan(entered) {
  const query = simbriefQuery(entered);
  const response = await fetch(`${SIMBRIEF_URL}?${query}&json=v2`);
  if (response.status === 400) {
    const error = new Error('SimBrief did not recognise that username or Pilot ID, or there is no flight plan saved for it. Check the number in SimBrief account settings and make sure you generated a plan.');
    error.status = 400;
    throw error;
  }
  if (!response.ok) throw new Error(`SimBrief returned HTTP ${response.status}.`);
  const data = await response.json();

  let fixes = jsonFixes(data);
  if (!fixes.length) {
    const xmlResponse = await fetch(`${SIMBRIEF_URL}?${query}`);
    if (xmlResponse.ok) fixes = xmlFixes(await xmlResponse.text());
  }
  if (!fixes.length) {
    const status = data && data.fetch && data.fetch.status ? ` SimBrief said: ${data.fetch.status}.` : '';
    throw new Error(`No waypoints found in the SimBrief plan.${status} Response fields: ${Object.keys(data || {}).join(', ') || 'none'}.`);
  }
  return {
    origin: data.origin?.icao_code || null,
    destination: data.destination?.icao_code || null,
    general: data.general || {},
    fixes,
  };
}
