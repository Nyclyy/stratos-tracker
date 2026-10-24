/* VATSIM online ATC, read from the public network data feed.
 *
 * Pure so the page and the tests interpret the feed the same way. A controller
 * is placed only by facts in the feed: its callsign prefix and suffix, and the
 * frequency. Coverage is reported as "confirmed" (the callsign names the
 * airport) or "inferred" (a higher-level position that covers the airport when
 * the lower ones are offline). Jurisdiction polygons are not drawn here: the
 * feed does not carry sector boundaries, and none are invented from callsigns.
 */

export const VATSIM_FEED_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
export const VATSIM_FEED_TTL_MS = 15 * 1000;

// Facility suffixes in the callsign, highest level first. Top-down coverage uses
// this order: an online CTR covers an airport when TWR, GND and APP are offline.
const FACILITY = [
  { suffix: 'CTR', kind: 'center', rank: 5, label: 'Center / Enroute' },
  { suffix: 'APP', kind: 'approach', rank: 4, label: 'Approach' },
  { suffix: 'DEP', kind: 'departure', rank: 4, label: 'Departure' },
  { suffix: 'TWR', kind: 'tower', rank: 3, label: 'Tower' },
  { suffix: 'GND', kind: 'ground', rank: 2, label: 'Ground' },
  { suffix: 'RMP', kind: 'apron', rank: 1, label: 'Apron / Ramp' },
  { suffix: 'DEL', kind: 'delivery', rank: 0, label: 'Delivery' },
  { suffix: 'ATIS', kind: 'atis', rank: 0, label: 'ATIS' },
];

const TOP_LEVEL_PREFIXES = new Set(['ZAB', 'ZAU', 'ZBW', 'ZDC', 'ZDV', 'ZFW', 'ZHU', 'ZID', 'ZJX', 'ZKC', 'ZLA', 'ZLC', 'ZMA', 'ZME', 'ZMP', 'ZNY', 'ZOA', 'ZOB', 'ZSE', 'ZTL']);

/** Facility from a callsign such as "EGLL_TWR" or "LFMM_APP". Null for anything else. */
export function facilityOf(callsign) {
  const parts = String(callsign || '').toUpperCase().split('_');
  if (parts.length < 2) return null;
  const suffix = parts[parts.length - 1];
  return FACILITY.find(facility => facility.suffix === suffix) || null;
}

/** The airport a position names: the four-letter prefix of EGLL_TWR, or null for centers. */
export function airportOf(callsign) {
  const parts = String(callsign || '').toUpperCase().split('_');
  if (parts.length < 2) return null;
  const prefix = parts[0];
  if (!/^[A-Z]{4}$/.test(prefix) || TOP_LEVEL_PREFIXES.has(prefix)) return null;
  return prefix;
}

/** Parse the feed's controller list into controllers this model can use. */
export function parseControllers(feed) {
  const list = feed && Array.isArray(feed.controllers) ? feed.controllers : [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const callsign = String(entry.callsign || '').toUpperCase();
    const facility = facilityOf(callsign);
    if (!facility) continue;
    out.push({
      callsign,
      cid: entry.cid ?? null,
      name: String(entry.name || '').trim(),
      frequency: String(entry.frequency || '').trim(),
      facility,
      airport: airportOf(callsign),
      isCenter: facility.kind === 'center',
      atis: String(entry.text_atis || '').trim(),
    });
  }
  return out;
}

/**
 * Controllers for one airport: only positions whose callsign names that airport.
 * Online centers are never listed as covering an airport, because the feed has
 * no sector boundaries to match them to one.
 */
export function airportCoverage(controllers, icao) {
  const id = String(icao || '').toUpperCase();
  const own = controllers.filter(c => c.airport === id);
  const confirmed = own
    .slice()
    .sort((a, b) => b.facility.rank - a.facility.rank)
    .map(c => ({ ...c, source: 'confirmed' }));
  return {
    icao: id,
    confirmed,
    inferred: [],
    hasCoverage: confirmed.length > 0,
  };
}

/**
 * VATSIM pilots from the same feed, shaped like the map's traffic entries.
 * Only pilots with a valid position are kept. Ground speed and altitude are
 * taken from the feed as reported; missing values stay null.
 */
export function parsePilots(feed) {
  const list = feed && Array.isArray(feed.pilots) ? feed.pilots : [];
  const out = [];
  for (const pilot of list) {
    if (!pilot || typeof pilot !== 'object') continue;
    const lat = Number(pilot.latitude);
    const lon = Number(pilot.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const callsign = String(pilot.callsign || '').toUpperCase().trim();
    if (!callsign) continue;
    const alt = Number(pilot.altitude);
    const gs = Number(pilot.groundspeed);
    const hdg = Number(pilot.heading);
    out.push({
      id: callsign,
      source: 'vatsim',
      lat,
      lon,
      alt: Number.isFinite(alt) ? alt : null,
      gs: Number.isFinite(gs) ? gs : null,
      hdg: Number.isFinite(hdg) ? hdg : 0,
      aircraft: String(pilot.flight_plan?.aircraft_short || '').trim() || null,
      dep: String(pilot.flight_plan?.departure || '').toUpperCase() || null,
      arr: String(pilot.flight_plan?.arrival || '').toUpperCase() || null,
      // The pilot filed these: the cruise level and the route text. They are
      // reported as filed, never used to claim a SID or STAR the plan does not
      // name (the feed carries no procedure identity).
      cruiseFt: Number(pilot.flight_plan?.altitude) > 0 ? Number(pilot.flight_plan.altitude) : null,
      route: String(pilot.flight_plan?.route || '').trim().slice(0, 240) || null,
    });
  }
  return out;
}

/** Online position count and every facility seen, for the list header. */
export function summarize(controllers) {
  const byKind = {};
  for (const c of controllers) byKind[c.facility.kind] = (byKind[c.facility.kind] || 0) + 1;
  return { total: controllers.length, byKind };
}
