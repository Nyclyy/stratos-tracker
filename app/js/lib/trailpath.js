/* Rounded corners for a recorded path.
 *
 * A trail is a list of timestamped positions, and drawing it as a polyline turns
 * every turn into a corner at the sample resolution: a 30-degree turn between two
 * samples looks like a kink rather than a turn. This module rounds those corners
 * with Chaikin's corner cutting, which keeps the first and last points exactly
 * where they are and never moves the line further than a quarter of one segment
 * away from the recorded path. The recorded positions themselves are untouched —
 * only the line the map draws is smoothed.
 *
 * Heights travel with the points, so an altitude-coloured trail keeps its ramp
 * after smoothing. Pure, so it can be tested without a canvas.
 */

/** Midpoint of one segment: the two points a corner is replaced with. */
function cut(a, b) {
  return [
    [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
    [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
  ];
}

/**
 * Smooth a path for drawing.
 * points: [[x, y], …] in screen or world coordinates (any unit).
 * heights: optional [h, …] aligned with points; interpolated the same way.
 * passes: corner-cutting rounds. Two is enough for a visible curve at map scale.
 * maxPoints: the result is not doubled past this, so a long trail stays cheap.
 * Returns { points, heights } with the endpoints unchanged.
 */
export function smoothPath(points, heights = null, { passes = 2, maxPoints = 4000 } = {}) {
  const source = Array.isArray(points) ? points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : [];
  if (source.length < 3) {
    return { points: source, heights: Array.isArray(heights) ? heights.slice(0, source.length) : [] };
  }
  let pts = source.map(p => [p[0], p[1]]);
  let hs = Array.isArray(heights) && heights.length ? heights.slice(0, source.length) : null;
  for (let pass = 0; pass < Math.max(0, passes); pass += 1) {
    if ((pts.length - 1) * 2 + 1 > maxPoints) break;
    const nextPoints = [pts[0]];
    const nextHeights = hs ? [hs[0]] : null;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [q, r] = cut(pts[i], pts[i + 1]);
      nextPoints.push(q, r);
      if (hs) {
        const a = Number(hs[i]) || 0;
        const b = Number(hs[i + 1]) || 0;
        nextHeights.push(a * 0.75 + b * 0.25, a * 0.25 + b * 0.75);
      }
    }
    nextPoints.push(pts[pts.length - 1]);
    if (hs) nextHeights.push(hs[hs.length - 1]);
    pts = nextPoints;
    hs = nextHeights;
  }
  return { points: pts, heights: hs || [] };
}

/**
 * Whether a new flight's first point continues the trail that is already drawn.
 *
 * A landing ends the bridge's flight record, and the next telemetry sample starts
 * a fresh one while the aircraft is still rolling out. That is the same journey,
 * so the line must not break under the aircraft when it touches down. Two
 * flights are only joined when the new one begins where the old one stopped, and
 * promptly: a flight started after a reposition or a reload elsewhere clears the
 * trail instead of drawing a line across the world.
 *
 * Points may be [lat, lon, alt, t] arrays or { lat, lon, t } objects.
 */
export function trailContinues(last, first, { maxNm = 2, maxGapMs = 30 * 60 * 1000 } = {}) {
  const a = Array.isArray(last) ? { lat: Number(last[0]), lon: Number(last[1]), t: Number(last[3]) } : (last || {});
  const b = Array.isArray(first) ? { lat: Number(first[0]), lon: Number(first[1]), t: Number(first[3]) } : (first || {});
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return false;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  const nm = 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  if (!(nm <= maxNm)) return false;
  if (Number.isFinite(a.t) && Number.isFinite(b.t)) return Math.abs(b.t - a.t) <= maxGapMs;
  return true;
}

/**
 * Append one recorded path to another, skipping a repeated position so the join
 * is a single line and not a doubling back on itself. Used when a landing ends
 * the bridge's flight record and the rollout opens a new one: the flight that
 * was flown stays on the map and the rollout continues it.
 *
 * Points are [lat, lon, alt, t] arrays, as the recorder stores them. Malformed
 * entries are dropped rather than drawn.
 */
export function appendTrack(base, add) {
  const out = Array.isArray(base) ? base.slice() : [];
  for (const point of Array.isArray(add) ? add : []) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const tail = out[out.length - 1];
    if (tail && Math.abs(tail[0] - point[0]) + Math.abs(tail[1] - point[1]) < 1e-5) continue;
    out.push(point);
  }
  return out;
}

/**
 * A cache for one trail, so a path is smoothed when it changes rather than on
 * every frame. The signature is the point count plus the last point, which is
 * exactly what a new sample changes.
 */
export function smoothPathCache(signature, points, heights, options) {
  const smoothed = smoothPath(points, heights, options);
  return { signature, ...smoothed };
}
