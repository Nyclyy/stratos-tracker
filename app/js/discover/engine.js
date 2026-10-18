// Route Discovery engine.
//
// Pure and deterministic: the same airports, options and seed always produce
// the same three recommendations, which is what the tests rely on. Every claim
// a card makes is derived from the airport record (elevation, runway length,
// coordinates) or from the great-circle path crossing a coarse region box.
// Nothing is invented: no weather, no landmarks, no procedures.

import { distanceNm } from '../lib/geo.js';
import { aircraftById, categoryById, durationById } from './catalog.js';
import { REGION_ISLANDS, REGION_MOUNTAINS, REGIONS, regionsAlongPath, inBox } from './regions.js';

// Airports that sit on an island or an island group (OurAirports idents).
export const ISLAND_AIRPORTS = new Set([
  'NFFN', 'NTAA', 'NWWW', 'AGGH', 'NZAA', 'NZWN', 'NZCH', 'NZQN',
  'RJTT', 'RJAA', 'RJBB', 'RJCC', 'RJFF', 'ROAH',
  'VHHH', 'WSSS', 'WIII', 'WADD', 'RPLL', 'VCBI', 'EIDW', 'BIKF',
  'PHNL', 'PHKO', 'PHOG', 'TJSJ',
]);

// Region-specific adventure names. Used only when the path really crosses it.
// Every region offers a second name so a set of three cards never has to repeat
// a title.
const REGION_NAMES = {
  alps: ['Alpine Escape', 'Alpine Passage'],
  rockies: ['Rockies Explorer', 'Rocky Mountain Passage'],
  andes: ['Andean Traverse', 'High Andes Sector'],
  himalaya: ['Himalayan Passage', 'High Himalaya Sector'],
  scandinavia: ['Fjord Run', 'Nordic Fjord Sector'],
  iceland: ['Icelandic Circuit', 'Volcanic Coast Run'],
  caribbean: ['Caribbean Hop', 'Island Chain Run'],
  mediterranean: ['Mediterranean Run', 'Med Coast Sector'],
  japan: ['Japanese Coastline', 'Japan Island Chain'],
  hawaii: ['Hawaiian Island Hop', 'Pacific Island Run'],
  newzealand: ['Southern Alps Run', 'Kiwi Island Hop'],
  patagonia: ['Patagonian Wilds', 'Patagonian Passage'],
  seasia: ['Archipelago Hop', 'Island Chain Passage'],
  sahara: ['Desert Crossing', 'Sahara Sector'],
  australia: ['Australian Crossing', 'Great Southern Sector'],
};

const MAX_POOL = 900;
const SCORING_MOUNTAINS = new Set(['alps', 'rockies', 'andes', 'himalaya', 'patagonia', 'scandinavia']);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(...parts) {
  let hash = 2166136261;
  for (const part of parts) {
    const text = String(part ?? '');
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

export function shortestRunway(airport) {
  const lengths = Array.isArray(airport.len) ? airport.len.filter(n => Number.isFinite(n) && n > 0) : [];
  return lengths.length ? Math.min(...lengths) : null;
}

export function longestRunway(airport) {
  const lengths = Array.isArray(airport.len) ? airport.len.filter(n => Number.isFinite(n) && n > 0) : [];
  return lengths.length ? Math.max(...lengths) : null;
}

function validAirport(airport) {
  return airport
    && typeof airport.id === 'string'
    && airport.id.length >= 3
    && Number.isFinite(Number(airport.lat))
    && Number.isFinite(Number(airport.lon))
    && Math.abs(Number(airport.lat)) <= 90
    && Math.abs(Number(airport.lon)) <= 180;
}

/** Duration estimate: cruise at the type's speed plus fixed ground/approach time. */
export function estimateHours(distance, kt, stops = 0) {
  if (!Number.isFinite(distance) || !Number.isFinite(kt) || kt <= 0) return null;
  return distance / kt + 0.2 + 0.1 * stops;
}

function defaultAircraftFor(band) {
  if (band.id === 'short') return 'ga';
  if (band.id === 'medium') return 'turboprop';
  if (band.id === 'long') return 'narrowbody';
  if (band.id === 'extra') return 'narrowbody';
  return 'widebody';
}

function isIsland(airport) {
  // Bounding boxes cannot tell a Caribbean island from Caracas on the coast, so
  // island membership comes from the curated ident list only.
  return ISLAND_AIRPORTS.has(airport.id);
}

function regionOf(airport) {
  return REGIONS.find(region => inBox(Number(airport.lat), Number(airport.lon), region.box)) || null;
}

function difficultyOf(destination) {
  const reasons = [];
  const elev = Number(destination.elev) || 0;
  const shortest = shortestRunway(destination);
  if (elev >= 4000) reasons.push(`field elevation ${elev.toLocaleString()} ft`);
  else if (elev >= 1500) reasons.push(`elevated field at ${elev.toLocaleString()} ft`);
  if (shortest !== null && shortest < 4000) reasons.push(`shortest runway ${shortest.toLocaleString()} ft`);
  else if (shortest !== null && shortest < 5500) reasons.push(`runway ${shortest.toLocaleString()} ft`);
  const level = reasons.length >= 2 ? 'demanding' : reasons.length === 1 ? 'moderate' : 'easy';
  return { level, reasons };
}

function poolFor(airports, options, rand) {
  const seen = new Set();
  const pool = [];
  for (const airport of airports || []) {
    if (!validAirport(airport)) continue;
    const id = String(airport.id).toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    pool.push({
      id,
      name: String(airport.name || id),
      lat: Number(airport.lat),
      lon: Number(airport.lon),
      elev: Number(airport.elev) || 0,
      len: Array.isArray(airport.len) ? airport.len.map(Number).filter(n => Number.isFinite(n) && n > 0) : [],
    });
  }
  const departure = String(options.departure || '').toUpperCase();
  if (departure && !pool.some(a => a.id === departure)) {
    const extra = (airports || []).find(a => String(a.id).toUpperCase() === departure && validAirport(a));
    if (extra) pool.push({ ...extra, id: departure, lat: Number(extra.lat), lon: Number(extra.lon), elev: Number(extra.elev) || 0 });
  }
  if (pool.length <= MAX_POOL) return pool;
  // Large bridge databases: keep a deterministic sample plus the requested field.
  const fixed = pool.filter(a => a.id === departure);
  const rest = pool.filter(a => a.id !== departure);
  const shuffled = rest.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return fixed.concat(shuffled.slice(0, MAX_POOL - fixed.length));
}

function scoreCandidate(categoryId, origin, destination, regions, band, nm) {
  let score = 0;
  const island = isIsland(origin) || isIsland(destination);
  // Mountain categories want ranges, not merely mountainous countries whose
  // airports sit on the flats.
  const mountains = regions.some(region => SCORING_MOUNTAINS.has(region.id));
  const elevation = Number(destination.elev) || 0;
  const shortest = shortestRunway(destination);

  switch (categoryId) {
    case 'scenic':
      score += regions.length * 4;
      score += mountains ? 3 : 0;
      score += island ? 2 : 0;
      break;
    case 'storm':
      score += regions.length * 3;
      score += mountains ? 2 : 0;
      break;
    case 'challenging':
      // Only fields that actually ask something of the crew: height or a short
      // runway. Otherwise the card would be an ordinary sector wearing a
      // "demanding" badge.
      if (elevation < 1500 && !(shortest !== null && shortest < 5500)) return -Infinity;
      score += elevation >= 4000 ? 6 : elevation >= 1500 ? 4 : 0;
      score += shortest !== null && shortest < 4000 ? 5 : shortest !== null && shortest < 5500 ? 2 : 0;
      score += mountains ? 3 : 0;
      break;
    case 'islands':
      // Single long legs across water are not island hopping. Require both ends
      // on known islands and keep the leg short enough for a visual sector; the
      // multi-stop chains are built separately by islandChains().
      if (!island || !isIsland(origin) || !isIsland(destination)) return -Infinity;
      if (nm > 520) return -Infinity;
      score += 6;
      score += regions.length * 2;
      break;
    case 'mountain':
      // High plateaus alone are not mountain flying; require the track to cross
      // mapped mountain country or a properly high destination.
      if (!mountains && elevation < 3000) return -Infinity;
      score += mountains ? 8 : 0;
      score += elevation >= 3000 ? 4 : 0;
      break;
    case 'longhaul':
      // "Long haul" is about legs that actually last, so a 50 nm hop cannot
      // qualify however the duration slider is set.
      if (nm < 500) return -Infinity;
      score += Math.min(8, Math.round(band.min * 2));
      score += nm >= 1500 ? 3 : 0;
      break;
    case 'short':
      score += regions.length * 2;
      score += island ? 1 : 0;
      break;
    case 'bush':
      // A bush strip has to be an actual short field. Runway length is the only
      // verified signal in the airport record, so a missing length disqualifies
      // the airport rather than being guessed at.
      if (shortest === null || shortest > 5000) return -Infinity;
      score += shortest <= 3500 ? 8 : 5;
      score += elevation > 2000 ? 1 : 0;
      break;
    case 'night':
      score += (longestRunway(destination) || 0) >= 7000 ? 3 : 0;
      score += regions.length * 2;
      break;
    default:
      break;
  }
  return score;
}

// Only this many pairs get the expensive great-circle region sampling. A full
// worldwide pool is ~800k ordered pairs, and sampling 40 points across 15 regions
// for each would freeze the page; endpoint terrain is a good enough first pass.
const REGION_SHORTLIST = 240;

function refineScore(score, level, options) {
  let value = score;
  if (options.difficulty === 'harder') value += level === 'demanding' ? 7 : level === 'moderate' ? 3 : -2;
  if (options.difficulty === 'easier') value += level === 'easy' ? 6 : level === 'moderate' ? 0 : -4;
  return value;
}

function pairPool(pool, band, kt, categoryId, options, rand) {
  const { min, max } = band;
  const originList = options.departure
    ? pool.filter(a => a.id === String(options.departure).toUpperCase())
    : pool;
  if (!originList.length) return [];

  const regionFilter = options.regionId ? REGIONS.find(entry => entry.id === options.regionId) : null;
  if (options.regionId && !regionFilter) return [];

  // Endpoint terrain, computed once per airport rather than once per pair.
  const homeRegions = new Map();
  for (const airport of pool) {
    homeRegions.set(airport.id, REGIONS.filter(region => inBox(airport.lat, airport.lon, region.box)));
  }

  const out = [];
  for (const origin of originList) {
    for (const destination of pool) {
      if (origin.id === destination.id) continue;
      const nm = distanceNm(origin, destination);
      // Below ~40 nm this is a pattern lap, not an adventure worth a card.
      if (!Number.isFinite(nm) || nm < 40) continue;
      const hours = estimateHours(nm, kt, 0);
      if (!Number.isFinite(hours) || hours < min || hours > max) continue;
      if (regionFilter
        && !inBox(origin.lat, origin.lon, regionFilter.box)
        && !inBox(destination.lat, destination.lon, regionFilter.box)) continue;

      const rough = [...homeRegions.get(origin.id), ...homeRegions.get(destination.id)]
        .filter((region, index, list) => list.findIndex(entry => entry.id === region.id) === index)
        .slice(0, 3);
      let score = scoreCandidate(categoryId, origin, destination, rough, band, nm);
      // A category may need the real path (a range crossed between two low
      // fields). Keep those in the running at the cheapest score so the second
      // pass can judge them instead of discarding them unseen.
      if (!Number.isFinite(score)) score = 0;
      if (score <= 0) score = 0.01;
      const level = difficultyOf(destination).level;
      out.push({ origin, destination, nm, hours, regions: rough, score: refineScore(score, level, options), level, jitter: rand() });
    }
  }

  out.sort((a, b) => (b.score - a.score) || (a.jitter - b.jitter));
  const shortlist = out.length > REGION_SHORTLIST ? out.slice(0, REGION_SHORTLIST) : out;
  const refined = [];
  for (const candidate of shortlist) {
    const regions = regionsAlongPath(candidate.origin, candidate.destination);
    const score = scoreCandidate(categoryId, candidate.origin, candidate.destination, regions, band, candidate.nm);
    if (!Number.isFinite(score) || score <= 0) continue;
    refined.push({
      ...candidate,
      regions,
      score: refineScore(score, candidate.level, options),
    });
  }
  return refined;
}

const MAX_LEG_NM = 400;
const MIN_LEG_NM = 40;

/** Nearest island fields reachable in one short leg, nearest first. */
function nextHops(from, islandPool, used) {
  return islandPool
    .filter(a => a.id !== from.id && !used.has(a.id))
    .map(a => ({ a, nm: distanceNm(from, a) }))
    .filter(entry => entry.nm >= MIN_LEG_NM && entry.nm <= MAX_LEG_NM)
    .sort((x, y) => x.nm - y.nm)
    .slice(0, 6);
}

/** Regions crossed by the whole chain, not just the first-to-last chord. */
function regionsAlongLegs(stops) {
  const seen = new Set();
  const out = [];
  for (let i = 1; i < stops.length; i++) {
    for (const region of regionsAlongPath(stops[i - 1], stops[i])) {
      if (seen.has(region.id)) continue;
      seen.add(region.id);
      out.push(region);
    }
  }
  return out.slice(0, 3);
}

/**
 * Multi-stop island hops: one to three short legs between island fields.
 * Longer durations simply get more legs, which is how island chains are
 * actually flown, instead of one long over-water sector.
 */
function islandChains(pool, band, kt, options, rand) {
  const islandPool = pool.filter(isIsland);
  if (islandPool.length < 3) return [];
  const chains = [];
  const origins = options.departure
    ? islandPool.filter(a => a.id === String(options.departure).toUpperCase())
    : islandPool;

  for (const origin of origins) {
    const walk = (stops, total, used) => {
      if (chains.length > 80) return;
      const legs = stops.length - 1;
      const hours = estimateHours(total, kt, legs - 1);
      // Landing back where you started is not an island hop.
      const returnsHome = legs >= 2 && distanceNm(stops[stops.length - 1], stops[0]) < 60;
      if (legs >= 2 && !returnsHome && hours >= band.min && hours <= band.max) {
        chains.push({
          origin: stops[0], destination: stops[stops.length - 1], via: stops.slice(1, -1),
          nm: total, hours, regions: regionsAlongLegs(stops),
          score: 13 + regionsAlongLegs(stops).length + legs,
          jitter: rand(),
        });
      }
      if (legs >= 3 || hours > band.max) return;
      const last = stops[stops.length - 1];
      for (const hop of nextHops(last, islandPool, used)) {
        const nextTotal = total + hop.nm;
        if (estimateHours(nextTotal, kt, legs) > band.max * 1.05) continue;
        walk(stops.concat(hop.a), nextTotal, new Set([...used, hop.a.id]));
      }
    };
    walk([origin], 0, new Set([origin.id]));
  }
  return chains;
}

function difficultyLabel(difficulty) {
  if (!difficulty || !difficulty.level) return null;
  return difficulty.level;
}

// Which regions may title a card for a given category. A Caribbean crossing on
// a Mountain Flying request should not be called "Island Chain Run".
function regionFitsCategory(categoryId, regionId) {
  if (!regionId) return false;
  if (categoryId === 'mountain' || categoryId === 'challenging') return REGION_MOUNTAINS.has(regionId);
  if (categoryId === 'islands') return REGION_ISLANDS.has(regionId);
  return true;
}

function nameFor(categoryId, stops, regions, rand, effectiveCategory, used = new Set()) {
  const destination = stops[stops.length - 1];
  const optionsFor = {};
  const primary = regions.find(region => REGION_NAMES[region.id] && regionFitsCategory(effectiveCategory, region.id));
  if (primary && categoryId === effectiveCategory) {
    const names = REGION_NAMES[primary.id];
    // Mountain and demanding cards take the range-first name, never the
    // island-flavoured alternate ("Kiwi Island Hop" on a mountain request).
    const terrain = effectiveCategory === 'mountain' || effectiveCategory === 'challenging';
    const start = terrain ? 0 : Math.floor(rand() * names.length);
    optionsFor.region = [names[start], names[(start + 1) % names.length]];
  }
  const suffixes = {
    scenic: ['Scenic Run', 'Viewpoint Leg', 'Panorama'],
    storm: ['Storm Scenario', 'Weather Run'],
    challenging: ['Terrain Approach', 'Demanding Sector'],
    islands: ['Island Hopper', 'Coastal Hops'],
    mountain: ['Mountain Sector', 'High Country'],
    longhaul: ['Long Haul', 'Continental Sector', 'Overnight Sector'],
    short: ['Quick Hop', 'Short Sector'],
    bush: ['Bush Strip', 'Backcountry Leg'],
    night: ['Night Run', 'Evening Sector'],
    random: ['Adventure', 'Wildcard'],
  };
  const pool = suffixes[effectiveCategory] || suffixes[categoryId] || ['Adventure'];
  const start = Math.floor(rand() * pool.length);
  const candidates = [
    ...(optionsFor.region || []),
    ...[pool[start], pool[(start + 1) % pool.length]].map(suffix => `${destination.name} ${suffix}`),
  ];
  const fresh = candidates.find(name => !used.has(name));
  if (fresh) return fresh;
  // Airports are never reused inside one set, so this is only a guard.
  let n = 2;
  let fallback = `${candidates[0]} · ${stops[0].id}`;
  while (used.has(fallback)) fallback = `${candidates[0]} · ${stops[0].id} ${n++}`;
  return fallback;
}

function explain(reco) {
  const { stops, legs, regions, aircraft } = reco;
  const categoryId = reco.flavourCategory || reco.categoryId;
  const origin = stops[0];
  const destination = stops[stops.length - 1];
  const via = stops.slice(1, -1);
  const parts = [];

  parts.push(
    stops.length > 2
      ? `${origin.name} (${origin.id}) to ${destination.name} (${destination.id}) over ${legs.length} legs via ${via.map(a => `${a.id}`).join(', ')}, ${Math.round(reco.nm)} nm total.`
      : `${origin.name} (${origin.id}) to ${destination.name} (${destination.id}) is a ${Math.round(reco.nm)} nm direct leg.`,
  );

  if (regions.length) {
    const names = regions.map(region => region.name);
    const last = names.pop();
    parts.push(`The track runs through ${names.length ? `${names.join(', ')} and ${last}` : last} — ${regions[regions.length - 1].phrase}.`);
  } else {
    parts.push({
      short: 'Nothing dramatic under the track — the appeal is the pair itself and a sector short enough to fly in one sitting.',
      night: 'The draw is the arrival: a large, well-lit field and city lights on the approach.',
      longhaul: 'A long, steady sector; the appeal is the length of the flight and the arrival at the far end.',
      challenging: 'The work is in the arrival rather than the cruise, so plan the descent before you brief the approach.',
      islands: 'Coastal water between the two fields rather than a chain of islands.',
    }[categoryId] || 'No mapped mountain or island region sits under this track, so the appeal is the airport pair and the airspace between them.');
  }

  if (Number(destination.elev) >= 1500) parts.push(`The destination sits at ${Number(destination.elev).toLocaleString()} ft.`);
  const shortest = shortestRunway(destination);
  if (shortest !== null && shortest < 5500) parts.push(`Its shortest paved runway is ${shortest.toLocaleString()} ft.`);

  if (categoryId === 'storm') parts.push('Storm Chasing is a simulated weather scenario: no live storm data is used and this is not real-world weather advice.');
  if (categoryId === 'night') parts.push('Best flown after sunset; lighting and city scenery depend on your simulator.');
  if (categoryId === 'islands') parts.push('Each leg is short enough to fly visually between departures and arrivals.');
  if (categoryId === 'bush') parts.push('Only fields with real runway data in the airport database are suggested.');
  if (categoryId === 'longhaul') parts.push(`Planned around ${aircraft.label.toLowerCase()} cruise speeds; add fuel stops if your sim model needs them.`);
  if (reco.difficulty && reco.difficultyReasons?.length) parts.push(`Rated ${reco.difficulty} because of ${reco.difficultyReasons.join(' and ')}.`);

  return parts.join(' ');
}

function highlightsFor(reco) {
  const list = [];
  const destination = reco.stops[reco.stops.length - 1];
  const flavour = reco.flavourCategory || reco.categoryId;
  if (reco.regions.some(region => REGION_MOUNTAINS.has(region.id))) list.push('Mountain terrain');
  if (reco.regions.some(region => REGION_ISLANDS.has(region.id))) list.push('Island scenery');
  if (reco.stops.some(isIsland)) list.push('Island destination');
  if (Number(destination.elev) >= 1500) list.push(`Elevated field · ${Number(destination.elev).toLocaleString()} ft`);
  const shortest = shortestRunway(destination);
  if (shortest !== null && shortest < 4000) list.push('Short field');
  if ((longestRunway(destination) || 0) >= 10000) list.push('Long runway');
  if (reco.stops.length > 2) list.push(`${reco.stops.length - 1} stops`);
  if (flavour === 'night') list.push('Night operations');
  if (flavour === 'storm') list.push('Simulated weather');
  return [...new Set(list)].slice(0, 4);
}

function compose(candidate, options) {
  const stops = [candidate.origin, ...(candidate.via || []), candidate.destination];
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    legs.push({ from: stops[i - 1], to: stops[i], nm: distanceNm(stops[i - 1], stops[i]) });
  }
  const nm = legs.reduce((sum, leg) => sum + leg.nm, 0);
  const difficulty = difficultyOf(candidate.destination);
  if (candidate.level) difficulty.level = candidate.level;
  const hours = estimateHours(nm, options.kt, Math.max(0, stops.length - 2));
  const reco = {
    id: `${options.categoryId}:${stops.map(a => a.id).join('-')}:${options.seedTag}`,
    categoryId: options.categoryId,
    // The category whose rules actually produced this card. It differs when a
    // category cannot be supported by the data (bush flying without strips).
    flavourCategory: options.scoringCategory || options.categoryId,
    name: '',
    stops,
    legs,
    nm,
    hours,
    // True when the real estimate fits the duration the user asked for. Cards
    // outside the window say so instead of pretending to match.
    withinWindow: !options.band || (hours >= options.band.min && hours <= options.band.max),
    aircraft: { id: options.aircraft.id, label: options.aircraft.label, kt: options.kt },
    difficulty: difficulty.level,
    difficultyReasons: difficulty.reasons,
    regions: candidate.regions.filter(region => region.claim !== false).map(region => ({ id: region.id, name: region.name, phrase: region.phrase })),
    estimate: true,
    weather: options.categoryId === 'storm' ? 'simulated' : null,
  };
  reco.explanation = explain(reco);
  reco.highlights = highlightsFor(reco);
  return reco;
}

function pickDistinct(candidates, count, recent, seedPicked = []) {
  const recentIds = new Set(recent || []);
  const remaining = candidates.filter(c => !recentIds.has(`${c.origin.id}-${c.destination.id}`));
  const picked = [];
  const usedAirports = new Set();
  const usedRegions = new Set();
  for (const item of seedPicked) {
    picked.push(item);
    [item.origin.id, item.destination.id, ...(item.via || []).map(a => a.id)].forEach(id => usedAirports.add(id));
    (item.regions || []).forEach(region => usedRegions.add(region.id));
  }

  const idsOf = candidate => [candidate.origin.id, candidate.destination.id, ...(candidate.via || []).map(a => a.id)];
  const repeatedRegions = candidate => candidate.regions.filter(region => usedRegions.has(region.id)).length;

  while (picked.length < count && remaining.length) {
    let bestIndex = -1;
    let bestKey = -Infinity;
    remaining.forEach((candidate, index) => {
      if (idsOf(candidate).some(id => usedAirports.has(id))) return;
      // Fresh terrain is worth more than a slightly better raw score, so three
      // cards do not all cross the same mountain range.
      const repeats = repeatedRegions(candidate);
      const key = candidate.score * 100 + (repeats ? 0 : 250) - repeats * 60 + candidate.jitter * 5;
      if (key > bestKey) {
        bestKey = key;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) break;
    const chosen = remaining.splice(bestIndex, 1)[0];
    picked.push(chosen);
    idsOf(chosen).forEach(id => usedAirports.add(id));
    chosen.regions.forEach(region => usedRegions.add(region.id));
  }
  return picked;
}

const RANDOM_POOL = ['scenic', 'challenging', 'islands', 'mountain', 'bush', 'short', 'night', 'longhaul'];

/**
 * Build three route recommendations.
 *
 * options: { category, duration, aircraft, departure, seed, recent }
 * Returns { recommendations, limitations, aircraft, resolvedCategory }.
 */
export function discoverRoutes(airports, options = {}) {
  const band = durationById(options.duration);
  const requested = categoryById(options.category);
  const seed = Number(options.seed) || 1;
  const rand = mulberry32(seedFrom(seed, requested.id, band.id, options.aircraft, options.departure));

  // Random Adventure picks a real category first, so it inherits every rule.
  const resolvedCategory = requested.id === 'random'
    ? RANDOM_POOL[Math.floor(rand() * RANDOM_POOL.length)]
    : requested.id;

  const aircraft = aircraftById(options.aircraft && options.aircraft !== 'any'
    ? options.aircraft
    // Long Haul implies an airliner even when the window is short; a 125 kt
    // trainer would turn every idea into a fuel-stop expedition.
    : resolvedCategory === 'longhaul' ? 'narrowbody' : defaultAircraftFor(band));
  const kt = aircraft.kt;
  const limitations = [];
  const pool = poolFor(airports, options, rand);

  if (pool.length < 6) {
    return {
      recommendations: [],
      limitations: ['The airport database did not return enough usable airports. Connect the Stratos bridge so the full worldwide list is available.'],
      aircraft, resolvedCategory,
    };
  }

  if (resolvedCategory === 'bush' && pool.filter(a => shortestRunway(a) !== null).length < 20) {
    limitations.push('Only a few airports in the current database include runway lengths, so bush strips are limited to those fields.');
  }
  if (resolvedCategory === 'islands' && pool.filter(isIsland).length < 4) {
    limitations.push('Too few island airports are available in this database; the closest coastal alternatives are shown instead.');
  }
  if ((resolvedCategory === 'longhaul') && band.max < 2) {
    limitations.push('Long Haul needs at least a 2–4 hour window, so this is the closest longer option inside your duration.');
  }

  // Bush Flying needs short fields with published runway lengths. If the
  // database cannot supply them, say so once and search with the closest
  // supportable rule set instead of labelling airliners as bush strips.
  let scoringCategory = resolvedCategory;
  if (resolvedCategory === 'bush') {
    const shortFields = pool.filter(a => {
      const length = shortestRunway(a);
      return length !== null && length <= 5000;
    });
    if (shortFields.length < 3) {
      scoringCategory = 'challenging';
      limitations.push(`Only ${shortFields.length === 0 ? 'no' : shortFields.length} airport${shortFields.length === 1 ? '' : 's'} in the current database has a runway of 5,000 ft or less, which is too few for genuine bush flying. These are demanding-terrain alternatives instead; connect the Stratos bridge for the worldwide field list.`);
    }
  }

  // Island requests only ever search island fields, which is both correct and
  // far cheaper than filtering a worldwide pool pair by pair.
  const islandPool = resolvedCategory === 'islands' ? pool.filter(isIsland) : pool;
  const islandPairs = (list, range) => islandChains(list, range, kt, options, rand)
    .concat(pairPool(list, range, kt, 'islands', options, rand));

  let candidates = resolvedCategory === 'islands'
    ? islandPairs(islandPool, band)
    : pairPool(pool, band, kt, scoringCategory, options, rand);

  let picked = pickDistinct(candidates, 3, options.recent);

  // Honest fallback: widen the duration window before dropping the category's
  // own rules, so a bush route still lands on a strip with published runway data.
  if (picked.length < 3) {
    // Island databases are sparse: hops are allowed to stretch further rather
    // than dropping island rules, and the card still reports the real duration.
    const widened = resolvedCategory === 'islands'
      ? { min: Math.max(0.25, band.min * 0.5), max: Math.max(3, band.max * 3) }
      : resolvedCategory === 'longhaul'
        ? { min: Math.max(1.5, band.min), max: Math.max(6, band.max * 3) }
        : { min: Math.max(0.15, band.min * 0.6), max: band.max * 1.6 };
    const relaxed = resolvedCategory === 'islands'
      ? islandPairs(islandPool, widened)
      : pairPool(pool, widened, kt, scoringCategory, options, rand);
    const already = new Set(picked.map(c => `${c.origin.id}-${c.destination.id}`));
    const extra = relaxed.filter(c => !already.has(`${c.origin.id}-${c.destination.id}`));
    // Seeded so airport-level reuse (a route flown backwards) stays blocked.
    picked = pickDistinct(extra, 3, options.recent, picked);
    if (picked.length > 0) {
      limitations.push(`Few routes in this database match "${requested.label}" inside ${band.label}, so the search window was widened to fill three ideas.`);
    }
  }
  // Sparse island data: keep looking island-wide rather than showing one card.
  if (resolvedCategory === 'islands' && picked.length > 0 && picked.length < 3) {
    picked = pickDistinct(islandPairs(islandPool, { min: 0.2, max: 24 }), 3, options.recent, picked);
  }
  if (!picked.length) {
    // Last resort keeps the category's own rules where they can still be met:
    // an island request gets island fields, not a 7,000 nm wide-body sector.
    const anywhere = resolvedCategory === 'islands'
      ? islandPairs(islandPool, { min: 0.2, max: 24 })
      : pairPool(pool, { min: 0.2, max: 24 }, kt, scoringCategory, options, rand);
    picked = pickDistinct(anywhere, 3, options.recent);
    limitations.push(`No route in this database matches "${requested.label}". These are varied alternatives from the same airport set.`);
  }

  const seedTag = seed.toString(36);
  // Card titles must be distinguishable; two "Island Hopper" cards side by side
  // read like a bug, so names are drawn from the region's alternates, then the
  // destination's own pool, before any suffix is repeated.
  const usedNames = new Set();
  const recommendations = picked.map(candidate => {
    const reco = compose(candidate, {
      categoryId: resolvedCategory, scoringCategory, aircraft, kt, rand, seedTag, band,
    });
    reco.name = nameFor(reco.categoryId, reco.stops, candidate.regions, rand, reco.flavourCategory, usedNames);
    usedNames.add(reco.name);
    return reco;
  });

  const stretched = recommendations.filter(reco => !reco.withinWindow).length;
  if (stretched) {
    limitations.push(`${stretched === 1 ? 'One card' : `${stretched} cards`} sits outside ${band.label} because the current airport database has nothing closer for this category. Each card shows its real estimated duration.`);
  }

  return {
    recommendations,
    limitations,
    aircraft,
    resolvedCategory,
    band: { id: band.id, label: band.label, min: band.min, max: band.max },
    poolSize: pool.length,
    generatedAt: Date.now(),
  };
}

/** Convert a recommendation into waypoints the existing route planner accepts. */
export function toWaypoints(recommendation) {
  return recommendation.stops.map(stop => ({
    id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon,
    elev: Number(stop.elev) || 0, kind: 'apt',
  }));
}

export { CATEGORIES, DURATIONS } from './catalog.js';
export { REGION_MOUNTAINS };
