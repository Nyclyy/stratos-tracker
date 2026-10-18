// Geographic regions used to describe a route honestly.
//
// A card may only say "crosses the Alps" if the great-circle path really enters
// that box. The boxes are deliberately coarse: they exist to describe terrain
// the route plausibly flies over, not to be a precise orographic model. Each is
// [west, south, east, north] in degrees.

export const REGIONS = [
  { id: 'alps', name: 'the Alps', box: [5, 44, 17, 48], phrase: 'dramatic alpine terrain' },
  { id: 'rockies', name: 'the Rockies', box: [-119.5, 34, -105, 53.5], phrase: 'the Rocky Mountain chain' },
  { id: 'andes', name: 'the Andes', box: [-80, -40, -62, 10], phrase: 'the Andean spine' },
  { id: 'himalaya', name: 'the Himalaya', box: [70, 26, 98, 36], phrase: 'high Himalayan terrain' },
  { id: 'scandinavia', name: 'Scandinavia', box: [4, 58, 30, 71], phrase: 'Scandinavian fjord country' },
  { id: 'iceland', name: 'Iceland', box: [-25, 63, -13, 67], phrase: 'Icelandic volcanic coast' },
  { id: 'caribbean', name: 'the Caribbean', box: [-85, 10, -60, 27], phrase: 'a Caribbean island chain' },
  { id: 'mediterranean', name: 'the Mediterranean', box: [-6, 30, 36, 46], phrase: 'the Mediterranean coast', claim: false },
  { id: 'japan', name: 'Japan', box: [129, 30, 146, 46], phrase: 'the Japanese archipelago' },
  { id: 'hawaii', name: 'Hawaii', box: [-161, 18, -154, 23], phrase: 'the Hawaiian islands' },
  { id: 'newzealand', name: 'New Zealand', box: [166, -48, 179, -34], phrase: 'two main islands with a volcanic plateau' },
  { id: 'patagonia', name: 'Patagonia', box: [-76, -55, -62, -38], phrase: 'Patagonian wilderness' },
  { id: 'seasia', name: 'Southeast Asia', box: [95, -10, 141, 20], phrase: 'the Southeast Asian peninsula and islands' },
  { id: 'sahara', name: 'North Africa', box: [-17, 15, 35, 32], phrase: 'the North African interior' },
  { id: 'australia', name: 'Australia', box: [113, -44, 154, -10], phrase: 'the Australian landmass' },
];

export const REGION_MOUNTAINS = new Set(['alps', 'rockies', 'andes', 'himalaya', 'scandinavia', 'newzealand', 'patagonia', 'iceland']);
export const REGION_ISLANDS = new Set(['caribbean', 'hawaii', 'japan', 'seasia', 'iceland', 'newzealand']);

export function inBox(lat, lon, box) {
  const [west, south, east, north] = box;
  const lonOk = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return lat >= south && lat <= north && lonOk;
}

const toRad = degrees => degrees * Math.PI / 180;
const toDeg = radians => radians * 180 / Math.PI;

/**
 * Point at `fraction` along the great circle from a to b.
 *
 * Linear latitude/longitude interpolation is wrong the moment a route crosses
 * the antimeridian — a straight lon blend from Auckland (174E) to Oakland
 * (122W) travels east across Europe instead of over the Pacific, which would
 * let the app claim terrain the aircraft never overflies.
 */
export function greatCirclePoint(a, b, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  const p1 = toRad(a.lat);
  const l1 = toRad(a.lon);
  const p2 = toRad(b.lat);
  const l2 = toRad(b.lon);
  const dp = p2 - p1;
  const dl = l2 - l1;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const delta = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  if (!Number.isFinite(delta) || delta < 1e-9) return { lat: Number(a.lat), lon: Number(a.lon) };
  const A = Math.sin((1 - f) * delta) / Math.sin(delta);
  const B = Math.sin(f * delta) / Math.sin(delta);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) };
}

/**
 * Regions a great-circle path actually passes through, most-visited first.
 * Sampling 40 points is enough to notice a 500 nm crossing without pretending
 * to know the exact ground track. A region seen only once on the path is not a
 * crossing (a climb-out or a final approach), so it is not claimed.
 */
export function regionsAlongPath(a, b, limit = 3) {
  if (!a || !b) return [];
  const counts = new Map();
  const steps = 40;
  for (let i = 1; i < steps; i++) {
    const point = greatCirclePoint(a, b, i / steps);
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    for (const region of REGIONS) {
      if (!inBox(point.lat, point.lon, region.box)) continue;
      counts.set(region.id, (counts.get(region.id) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([id]) => REGIONS.find(region => region.id === id));
}
