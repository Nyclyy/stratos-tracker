/* Flight replay.
   Recorded tracks are the only source of truth. Points between samples are
   interpolated and explicitly labelled as such; nothing is invented for
   flights whose telemetry does not contain a track. */

import { distanceNm, isFiniteNumber, validLatLon } from './geo.js';

const MAX_RENDER_POINTS = 2500;
const MAX_PROFILE_POINTS = 600;

export function hasReplay(flight) {
  return !!(flight && Array.isArray(flight.track) && flight.track.filter(p => p && validLatLon(Number(p.lat), Number(p.lon))).length >= 2);
}

/** Clean, sort and normalise stored track points to milliseconds. */
export function normalizeTrack(track) {
  const points = [];
  for (const raw of Array.isArray(track) ? track : []) {
    if (!raw) continue;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!validLatLon(lat, lon)) continue;
    let t = Number(raw.t);
    if (!Number.isFinite(t)) continue;
    if (t < 1e11) t *= 1000; // tolerate seconds from older/third-party exporters
    points.push({
      lat, lon, t,
      alt: numberOrNull(raw.alt),
      gs: numberOrNull(raw.gs),
      hdg: numberOrNull(raw.hdg),
      vs: numberOrNull(raw.vs),
      agl: numberOrNull(raw.agl),
    });
  }
  points.sort((a, b) => a.t - b.t);
  const deduped = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last && p.t - last.t < 250) {
      // Merge bursts: keep the newest values but do not create duplicate samples.
      deduped[deduped.length - 1] = { ...last, ...p };
      continue;
    }
    deduped.push(p);
  }
  return deduped;
}

/** Douglas-Peucker simplification in a local nautical-mile projection. */
export function simplifyTrack(points, toleranceNm = 0.02, maxPoints = MAX_RENDER_POINTS) {
  if (!Array.isArray(points) || points.length <= 2) return (points || []).slice();
  if (toleranceNm <= 0) return uniformCap(points, maxPoints);
  const latRef = points[0].lat * Math.PI / 180;
  const project = p => ({
    x: p.lon * Math.cos(latRef) * 60,
    y: p.lat * 60,
  });
  const projected = points.map(project);
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    const a = projected[first], b = projected[last];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let farthest = -1, farthestDist = 0;
    for (let i = first + 1; i < last; i++) {
      const p = projected[i];
      let dist;
      if (len2 < 1e-12) dist = Math.hypot(p.x - a.x, p.y - a.y);
      else {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        dist = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      }
      if (dist > farthestDist) { farthestDist = dist; farthest = i; }
    }
    if (farthestDist > toleranceNm && farthest > 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return uniformCap(out, maxPoints);
}

function uniformCap(points, maxPoints) {
  if (points.length <= maxPoints) return points.slice();
  if (maxPoints < 2) return points.slice(0, Math.max(0, maxPoints));
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round(i * (points.length - 1) / (maxPoints - 1))]);
  }
  return out;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coverage of optional telemetry fields across the recorded track. */
export function telemetryCoverage(points) {
  const total = points.length || 1;
  const coverage = {};
  for (const field of ['alt', 'gs', 'hdg', 'vs']) {
    const present = points.filter(p => isFiniteNumber(p[field])).length;
    coverage[field] = { present, total, ratio: present / total };
  }
  return coverage;
}

function cumulativeNm(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + distanceNm(points[i - 1], points[i]));
  }
  return distances;
}

function profilePoints(points) {
  if (points.length <= MAX_PROFILE_POINTS) return points.slice();
  const stride = Math.ceil(points.length / MAX_PROFILE_POINTS);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/**
 * Prepare a flight for playback.
 * @returns {{available:boolean, reason?:string, ...}}
 */
export function prepareReplay(flight, options = {}) {
  if (!flight) return { available: false, reason: 'No flight selected.' };
  if (!hasReplay(flight)) {
    return {
      available: false,
      reason: 'This flight has no recorded position track. Replay is available for flights recorded after telemetry logging was enabled.',
      recordedPoints: 0,
    };
  }
  const track = normalizeTrack(flight.track);
  if (track.length < 2) {
    return { available: false, reason: 'The recorded track has fewer than two usable samples.', recordedPoints: track.length };
  }
  const cumulative = cumulativeNm(track);
  const enriched = track.map((p, i) => ({ ...p, alongNm: cumulative[i] }));
  const tolerance = options.toleranceNm ?? 0.012;
  const renderPoints = simplifyTrack(enriched, tolerance, options.maxPoints || MAX_RENDER_POINTS);
  const profile = profilePoints(enriched);
  const coverage = telemetryCoverage(track);
  const start = track[0].t;
  const end = track[track.length - 1].t;
  const durationMs = Math.max(0, end - start);
  const last = track[track.length - 1];
  return {
    available: true,
    flightId: flight.id,
    track: enriched,
    renderPoints,
    profile,
    coverage,
    start,
    end,
    durationMs,
    totalNm: cumulative[cumulative.length - 1],
    recordedPoints: track.length,
    simplifiedPoints: renderPoints.length,
    startPoint: track[0],
    endPoint: last,
    hasProfile: coverage.alt.ratio > 0.2,
    smoothProfile: coverage.alt.ratio > 0.9,
    warnings: [
      coverage.alt.ratio === 0 ? 'Altitude was not recorded for this flight.' : null,
      coverage.gs.ratio === 0 ? 'Ground speed was not recorded for this flight.' : null,
      coverage.vs.ratio === 0 ? 'Vertical speed was not recorded for this flight.' : null,
    ].filter(Boolean),
  };
}

function lowerBound(points, t) {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function interpolateField(a, b, fraction, field) {
  const av = a[field], bv = b[field];
  if (isFiniteNumber(av) && isFiniteNumber(bv)) {
    return { value: av + (bv - av) * fraction, interpolated: true };
  }
  if (isFiniteNumber(av)) return { value: av, interpolated: false };
  if (isFiniteNumber(bv)) return { value: bv, interpolated: false };
  return { value: null, interpolated: false };
}

function interpolateHeading(a, b, fraction) {
  if (!isFiniteNumber(a.hdg) || !isFiniteNumber(b.hdg)) {
    return { value: isFiniteNumber(a.hdg) ? a.hdg : (isFiniteNumber(b.hdg) ? b.hdg : null), interpolated: false };
  }
  let delta = ((b.hdg - a.hdg + 540) % 360) - 180;
  return { value: ((a.hdg + delta * fraction) % 360 + 360) % 360, interpolated: true };
}

/** Sample the replay at an absolute timestamp (ms). */
export function sampleAt(replay, timestamp) {
  if (!replay || !replay.available) return null;
  const pts = replay.track;
  const t = Math.max(replay.start, Math.min(replay.end, Number(timestamp) || replay.start));
  const idx = lowerBound(pts, t);
  if (idx <= 0) return { ...pts[0], recorded: true, interpolated: false, progress: 0, elapsedMs: 0 };
  if (idx >= pts.length) {
    const p = pts[pts.length - 1];
    return { ...p, recorded: true, interpolated: false, progress: 1, elapsedMs: replay.durationMs };
  }
  const a = pts[idx - 1];
  const b = pts[idx];
  if (b.t === t) return { ...b, recorded: true, interpolated: false, progress: progressOf(replay, b.t), elapsedMs: b.t - replay.start };
  const span = b.t - a.t || 1;
  const fraction = (t - a.t) / span;
  const lat = a.lat + (b.lat - a.lat) * fraction;
  const lon = a.lon + (b.lon - a.lon) * fraction;
  const alt = interpolateField(a, b, fraction, 'alt');
  const gs = interpolateField(a, b, fraction, 'gs');
  const vs = interpolateField(a, b, fraction, 'vs');
  const hdg = interpolateHeading(a, b, fraction);
  const among = a.alongNm + (b.alongNm - a.alongNm) * fraction;
  return {
    lat, lon, t,
    alt: alt.value, gs: gs.value, vs: vs.value, hdg: hdg.value,
    alongNm: among,
    recorded: false,
    interpolated: true,
    fieldInterpolated: { alt: alt.interpolated, gs: gs.interpolated, vs: vs.interpolated, hdg: hdg.interpolated },
    progress: replay.totalNm ? Math.max(0, Math.min(1, among / replay.totalNm)) : progressOf(replay, t),
    elapsedMs: t - replay.start,
    between: { from: a.t, to: b.t },
  };
}

function progressOf(replay, t) {
  if (!replay.durationMs) return 0;
  return Math.max(0, Math.min(1, (t - replay.start) / replay.durationMs));
}

/** Nearest recorded sample to a timestamp, used for "jump to recorded data". */
export function nearestRecorded(replay, timestamp) {
  if (!replay || !replay.available) return null;
  const pts = replay.track;
  const idx = lowerBound(pts, Number(timestamp) || replay.start);
  if (idx <= 0) return pts[0];
  if (idx >= pts.length) return pts[pts.length - 1];
  return (Number(timestamp) - pts[idx - 1].t <= pts[idx].t - Number(timestamp)) ? pts[idx - 1] : pts[idx];
}

export function stepTime(replay, currentMs, deltaMs) {
  return Math.max(replay.start, Math.min(replay.end, currentMs + deltaMs));
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
