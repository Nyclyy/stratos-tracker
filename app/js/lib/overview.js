/* Flight overview header and aircraft block.
 *
 * Pure so the page and the tests build the same header. Every value is shown
 * only when a real source provides it; anything missing becomes an em dash.
 * Times are labelled by their source (scheduled from the plan, estimated from
 * the plan's estimate), and a delay or early status is given only when both a
 * scheduled and an estimated time exist.
 */

import { identifyAircraft } from './aircraft.js';

const DASH = '\u2014';

function text(value) {
  const s = value == null ? '' : String(value).trim();
  return s || DASH;
}

/** Local and UTC clock text for an epoch-second or ms timestamp; dash when absent. */
export function timeText(value, { utc = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DASH;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return DASH;
  const pad = v => String(v).padStart(2, '0');
  const hm = utc
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return hm;
}

/**
 * Delay status only from a real comparison. Returns null when either time is
 * missing, so the page never claims "early" or "delayed" without evidence.
 */
export function timingStatus(scheduled, estimated) {
  const s = Number(scheduled);
  const e = Number(estimated);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) return null;
  const diffMin = Math.round(((e < 1e12 ? e * 1000 : e) - (s < 1e12 ? s * 1000 : s)) / 60000);
  if (diffMin === 0) return { key: 'on-time', label: 'On time', diffMin };
  if (diffMin > 0) return { key: 'delayed', label: `Delayed ${diffMin} min`, diffMin };
  return { key: 'early', label: `Early ${Math.abs(diffMin)} min`, diffMin };
}

/**
 * Header model. `ofp` is the stored, normalised SimBrief plan (or null) and
 * `flight` holds the callsign and operator only when they are known.
 */
export function overviewHeader({ ofp = null, flight = {}, route = [] } = {}) {
  const general = (ofp && ofp.general) || {};
  const callsign = flight.callsign || general.icao_airline && general.flight_number
    ? `${general.icao_airline || ''}${general.flight_number || ''}`.trim()
    : '';
  const dep = (ofp && ofp.origin) || (route[0] && route[0].id) || null;
  const arr = (ofp && ofp.destination) || (route.length ? route[route.length - 1].id : null) || null;
  const scheduledOut = ofp && ofp.times ? ofp.times.scheduledOut : null;
  const estimatedOut = ofp && ofp.times ? ofp.times.estimatedOut : null;
  const scheduledIn = ofp && ofp.times ? ofp.times.scheduledIn : null;
  const estimatedIn = ofp && ofp.times ? ofp.times.estimatedIn : null;
  const alternate = ofp && ofp.alternate && ofp.alternate.icao ? ofp.alternate : null;
  return {
    alternate: alternate ? { icao: text(alternate.icao), name: text(alternate.name) } : null,
    callsign: text(callsign || null),
    operator: text(flight.operator || general.icao_airline || null),
    dep: text(dep),
    arr: text(arr),
    departure: {
      scheduled: timeText(scheduledOut),
      estimated: timeText(estimatedOut),
      status: timingStatus(scheduledOut, estimatedOut),
    },
    arrival: {
      scheduled: timeText(scheduledIn),
      estimated: timeText(estimatedIn),
      status: timingStatus(scheduledIn, estimatedIn),
    },
    // Times are shown with a zone label so a pilot never reads local as UTC.
    timeZone: 'UTC',
  };
}

/** Tabs shown in the overview. Each switches the same panel; none opens another map. */
export const OVERVIEW_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'route', label: 'Route' },
  { key: 'data', label: 'Flight data' },
  { key: 'weather', label: 'Weather' },
];

/** Only a known tab key is accepted; anything else falls back to Overview. */
export function activeTab(key) {
  return OVERVIEW_TABS.some(tab => tab.key === key) ? key : 'overview';
}

/** Aircraft block: identified type, image, and registration or livery only when reported. */
export function overviewAircraft({ simulator = null, simbrief = null, profile = null, registration = null, livery = null } = {}) {
  const found = identifyAircraft({ simulator, simbrief, profile });
  return {
    name: text(found.name),
    type: text(found.type),
    maker: found.maker || null,
    known: found.known,
    source: found.source,
    image: found.image,
    sprite: found.sprite,
    registration: text(registration),
    livery: livery ? String(livery) : null,
  };
}
