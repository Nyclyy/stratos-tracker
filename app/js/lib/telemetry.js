/* Telemetry validation, normalisation and resource profiles.
   Input arrives from the local bridge (SSE), the relay, or stored flights —
   treat all of it as untrusted. */

import { isFiniteNumber, normalizeHeading, validLatLon } from './geo.js';

export const RESOURCE_MODES = {
  normal: {
    key: 'normal',
    name: 'Normal',
    description: 'Full visuals, 60 fps map, 5 Hz bridge stream, traffic refreshed every 6 s.',
    mapFps: 60,
    streamHz: 5,
    trafficIntervalMs: 6000,
    drawTrails: true,
    maxTrailPoints: 900,
    tileCacheSize: 600,
    animations: true,
    chartRedrawQs: 1,
  },
  low: {
    key: 'low',
    name: 'Low resource',
    description: '30 fps map, 2 Hz telemetry, no contrail re-draw when idle, smaller caches and fewer aircraft.',
    mapFps: 30,
    streamHz: 2,
    trafficIntervalMs: 12000,
    drawTrails: true,
    maxTrailPoints: 350,
    tileCacheSize: 300,
    animations: false,
    chartRedrawQs: 2,
  },
  minimal: {
    key: 'minimal',
    name: 'Minimal',
    description: '15 fps map, 1 Hz telemetry, no animations or contrails. Recording and logging stay fully active.',
    mapFps: 15,
    streamHz: 1,
    trafficIntervalMs: 20000,
    drawTrails: false,
    maxTrailPoints: 0,
    tileCacheSize: 120,
    animations: false,
    chartRedrawQs: 2,
  },
};

export function getResourceProfile(mode) {
  return RESOURCE_MODES[mode] || RESOURCE_MODES.normal;
}

export function detectResourceMode() {
  try {
    const saved = localStorage.getItem('stratos.resourceMode');
    if (saved && RESOURCE_MODES[saved]) return saved;
  } catch (_) { /* private mode */ }
  try {
    if (navigator.connection && navigator.connection.saveData) return 'minimal';
    const mem = navigator.deviceMemory;
    if (isFiniteNumber(mem) && mem <= 4) return 'low';
  } catch (_) { /* unsupported */ }
  return 'normal';
}

export function parseTelemetry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!validLatLon(lat, lon)) return null;
  const num = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    lat,
    lon,
    alt: num(raw.alt, 0),
    agl: num(raw.agl, null),
    gs: Math.max(0, num(raw.gs, 0)),
    hdg: normalizeHeading(num(raw.hdg, 0)),
    vs: num(raw.vs, 0),
    pitch: num(raw.pitch, null),
    bank: num(raw.bank, null),
    fuel: num(raw.fuel, null),
    onGround: typeof raw.onGround === 'boolean' ? raw.onGround : (num(raw.agl, 999) < 30),
    aircraft: typeof raw.aircraft === 'string' ? raw.aircraft.slice(0, 48) : '',
    registration: typeof raw.registration === 'string' ? raw.registration.slice(0, 24) : '',
    callsign: typeof raw.callsign === 'string' ? raw.callsign.slice(0, 24) : '',
    src: typeof raw.src === 'string' ? raw.src.slice(0, 32) : 'Simulator',
    t: num(raw.t, Date.now() / 1000),
    receivedAt: Date.now(),
  };
}

export function telemetryAgeMs(snapshot, now = Date.now()) {
  if (!snapshot) return Infinity;
  const received = snapshot.receivedAt || (isFiniteNumber(snapshot.t) ? snapshot.t * 1000 : 0);
  if (!received) return Infinity;
  return Math.max(0, now - received);
}

export function isLive(snapshot, now = Date.now(), maxAgeMs = 5000) {
  return !!snapshot && telemetryAgeMs(snapshot, now) <= maxAgeMs;
}

/** Bridge SSE rate: the page can ask for a slower stream without losing data. */
export function streamUrl(base, mode) {
  const profile = getResourceProfile(mode);
  const clean = String(base || '').replace(/\/+$/, '');
  return `${clean}/stream?hz=${profile.streamHz}`;
}

export function formatAltitude(altFt) {
  if (!isFiniteNumber(altFt)) return '—';
  if (altFt >= 18000) return `FL${String(Math.round(altFt / 100)).padStart(3, '0')}`;
  return `${Math.round(altFt / 10) * 10} ft`;
}

export function formatVs(vsFpm) {
  if (!isFiniteNumber(vsFpm)) return '—';
  const rounded = Math.round(vsFpm / 10) * 10;
  if (rounded > 50) return `▲ ${rounded}`;
  if (rounded < -50) return `▼ ${Math.abs(rounded)}`;
  return '■ 0';
}
