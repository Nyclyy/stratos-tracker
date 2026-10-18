const SIMBRIEF_URL = 'https://www.simbrief.com/api/xml.fetcher.php';

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
    throw new Error('SimBrief did not recognise that username or Pilot ID, or there is no flight plan saved for it. Check the number in SimBrief account settings and make sure you generated a plan.');
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
