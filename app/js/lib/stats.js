/* Career statistics.
   All numbers come from logged flight records. Records are deduplicated first
   so a flight imported from both the bridge and the browser is only counted
   once. Incomplete or aborted records are reported separately, never silently
   discarded. */

import { landingOfFlight } from './landing.js';
import { isFiniteNumber } from './geo.js';

export const RANKS = [
  { id: 'student', name: 'Student Pilot', hours: 0 },
  { id: 'ppl', name: 'Private Pilot', hours: 40 },
  { id: 'commercial', name: 'Commercial Pilot', hours: 200 },
  { id: 'atp', name: 'Airline Transport Pilot', hours: 500 },
  { id: 'captain', name: 'Senior Captain', hours: 1000 },
  { id: 'veteran', name: 'Veteran Captain', hours: 2500 },
  { id: 'legend', name: 'Stratos Legend', hours: 5000 },
];

function flightKey(flight) {
  return String(flight && flight.id != null ? flight.id : '');
}

/**
 * Remove duplicate records. The bridge and the browser can both record the
 * same simulator flight, so flights with different ids but the same takeoff
 * window and route are treated as one; the richer record wins.
 */
export function dedupeFlights(flights) {
  const byId = new Map();
  for (const flight of Array.isArray(flights) ? flights : []) {
    if (!flight || typeof flight !== 'object') continue;
    const key = flightKey(flight);
    if (!key) continue;
    const existing = byId.get(key);
    if (!existing || recordScore(flight) > recordScore(existing)) byId.set(key, flight);
  }
  const chosen = [];
  for (const flight of byId.values()) {
    const duplicate = chosen.findIndex(other => sameFlight(other, flight));
    if (duplicate === -1) chosen.push(flight);
    else if (recordScore(flight) > recordScore(chosen[duplicate])) chosen[duplicate] = flight;
  }
  return chosen;
}

function recordScore(flight) {
  let score = 0;
  if (flight.complete) score += 4;
  if (!flight.incomplete) score += 2;
  if (Array.isArray(flight.track)) score += Math.min(6, flight.track.length / 200);
  if (flight.landing) score += 3;
  if (flight.depAirport) score += 1;
  if (flight.arrAirport) score += 1;
  return score;
}

function sameFlight(a, b) {
  if (!a || !b) return false;
  const at = Number(a.takeoffTime || a.startTime || 0);
  const bt = Number(b.takeoffTime || b.startTime || 0);
  if (!at || !bt) return false;
  if (Math.abs(at - bt) > 3 * 60 * 1000) return false;
  if (a.depAirport && b.depAirport && a.depAirport !== b.depAirport) return false;
  if (a.arrAirport && b.arrAirport && a.arrAirport !== b.arrAirport) return false;
  return true;
}

export function flightSeconds(flight) {
  const takeoff = Number(flight && flight.takeoffTime);
  const landing = Number(flight && flight.landingTime);
  if (takeoff > 0 && landing > 0 && landing >= takeoff) return (landing - takeoff) / 1000;
  const start = Number(flight && flight.startTime);
  const end = Number(flight && (flight.endTime || flight.landingTime));
  if (start > 0 && end > 0 && end >= start) return (end - start) / 1000;
  return 0;
}

function quantity(flight) {
  const seconds = flightSeconds(flight);
  const distance = isFiniteNumber(flight.distanceNm) ? flight.distanceNm : 0;
  return { seconds, hours: seconds / 3600, distance };
}

function monthKey(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
}

export function computeCareer(flights, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const unique = dedupeFlights(flights);
  const valid = unique.filter(f => f.complete && !f.incomplete);
  const incomplete = unique.filter(f => !f.complete || f.incomplete);

  let seconds = 0, distance = 0, maxAlt = 0;
  const airports = new Map();
  const aircraft = new Map();
  const routes = new Map();
  const months = new Map();
  const years = new Map();
  const landings = [];
  let longest = null, longestSeconds = 0, farthest = null, farthestNm = 0;

  for (const flight of valid) {
    const q = quantity(flight);
    seconds += q.seconds;
    distance += q.distance;
    if (q.seconds > longestSeconds) { longestSeconds = q.seconds; longest = flight; }
    if (q.distance > farthestNm) { farthestNm = q.distance; farthest = flight; }
    if (isFiniteNumber(flight.maxAlt) && flight.maxAlt > maxAlt) maxAlt = flight.maxAlt;

    for (const role of ['depAirport', 'arrAirport']) {
      const code = flight[role];
      if (!code) continue;
      if (!airports.has(code)) airports.set(code, { code, departures: 0, arrivals: 0, flights: [], last: 0 });
      const entry = airports.get(code);
      entry[role === 'depAirport' ? 'departures' : 'arrivals']++;
      entry.flights.push(flight.id);
      const at = Number(flight.startTime || flight.takeoffTime || 0);
      if (at > entry.last) entry.last = at;
    }

    const type = flight.aircraft || 'Unknown aircraft';
    if (!aircraft.has(type)) aircraft.set(type, { type, flights: 0, seconds: 0, last: 0, flightIds: [] });
    const ac = aircraft.get(type);
    ac.flights++;
    ac.seconds += q.seconds;
    ac.flightIds.push(flight.id);
    const started = Number(flight.startTime || flight.takeoffTime || 0);
    if (started > ac.last) ac.last = started;

    const route = `${flight.depAirport || '????'} → ${flight.arrAirport || '????'}`;
    if (!routes.has(route)) routes.set(route, { route, count: 0, seconds: 0, distance: 0, flightIds: [] });
    const r = routes.get(route);
    r.count++; r.seconds += q.seconds; r.distance += q.distance; r.flightIds.push(flight.id);

    const startedAt = Number(flight.startTime || flight.takeoffTime || 0);
    const key = monthKey(startedAt);
    if (key) {
      if (!months.has(key)) months.set(key, { month: key, flights: 0, seconds: 0, distance: 0 });
      const m = months.get(key);
      m.flights++; m.seconds += q.seconds; m.distance += q.distance;
    }
    const date = new Date(startedAt);
    if (!Number.isNaN(date.getTime())) {
      const y = String(date.getFullYear());
      if (!years.has(y)) years.set(y, { year: y, flights: 0, seconds: 0, distance: 0 });
      const yy = years.get(y);
      yy.flights++; yy.seconds += q.seconds; yy.distance += q.distance;
    }

    const landing = landingOfFlight(flight);
    if (landing && isFiniteNumber(landing.vsFpm)) {
      landings.push({ flightId: flight.id, vsFpm: landing.vsFpm, at: landing.at || flight.landingTime || flight.endTime });
    }
  }

  const weekStart = startOfWeek(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const windowCount = (from) => valid.filter(f => {
    const at = Number(f.startTime || f.takeoffTime || 0);
    return at >= from.getTime();
  }).length;

  const sortedAircraft = [...aircraft.values()].sort((a, b) => b.seconds - a.seconds);
  const sortedAirports = [...airports.values()].sort((a, b) =>
    (b.departures + b.arrivals) - (a.departures + a.arrivals));
  const topRoutes = [...routes.values()].sort((a, b) => b.count - a.count || b.seconds - a.seconds);
  const monthly = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const yearly = [...years.values()].sort((a, b) => a.year.localeCompare(b.year));

  const hours = seconds / 3600;
  let rank = RANKS[0];
  let nextRank = null;
  for (let i = 0; i < RANKS.length; i++) {
    if (hours >= RANKS[i].hours) rank = RANKS[i];
    else { nextRank = RANKS[i]; break; }
  }

  const bestLanding = landings.length ? landings.reduce((a, b) => (b.vsFpm > a.vsFpm ? b : a)) : null;
  const landingAverage = landings.length
    ? Math.round(landings.reduce((sum, l) => sum + l.vsFpm, 0) / landings.length) : null;

  return {
    flights: valid.length,
    incompleteFlights: incomplete.length,
    hours,
    distanceNm: distance,
    airportsVisited: airports.size,
    aircraftFlown: aircraft.size,
    averageHours: valid.length ? hours / valid.length : 0,
    averageDistanceNm: valid.length ? distance / valid.length : 0,
    longestFlight: longest,
    longestSeconds,
    farthestFlight: farthest,
    farthestNm,
    highestAltitudeFt: maxAlt || null,
    airports: sortedAirports,
    aircraft: sortedAircraft,
    topRoutes,
    monthly,
    yearly,
    recent: [...valid].sort((a, b) => Number(b.startTime || 0) - Number(a.startTime || 0)).slice(0, 8),
    windows: {
      week: windowCount(weekStart),
      month: windowCount(monthStart),
      year: windowCount(yearStart),
    },
    landings: {
      count: landings.length,
      averageFpm: landingAverage,
      best: bestLanding,
      last: landings.length ? landings.reduce((a, b) => (Number(b.at || 0) > Number(a.at || 0) ? b : a)) : null,
    },
    rank,
    nextRank,
    rankProgress: nextRank
      ? Math.max(0, Math.min(1, (hours - rank.hours) / (nextRank.hours - rank.hours)))
      : 1,
    uniqueFlightIds: unique.map(f => f.id),
    validFlightIds: valid.map(f => f.id),
    incompleteFlightIds: incomplete.map(f => f.id),
  };
}

/** Milestones are derived from real totals, never stored as fake progress. */
export function computeMilestones(career) {
  const list = [
    { id: 'first', label: 'First logged flight', value: career.flights, target: 1, unit: 'flights' },
    { id: 'ten', label: '10 flights', value: career.flights, target: 10, unit: 'flights' },
    { id: 'fifty', label: '50 flights', value: career.flights, target: 50, unit: 'flights' },
    { id: 'hours50', label: '50 flight hours', value: career.hours, target: 50, unit: 'hours' },
    { id: 'hours100', label: '100 flight hours', value: career.hours, target: 100, unit: 'hours' },
    { id: 'hours500', label: '500 flight hours', value: career.hours, target: 500, unit: 'hours' },
    { id: 'airports20', label: '20 airports visited', value: career.airportsVisited, target: 20, unit: 'airports' },
    { id: 'fleet5', label: '5 aircraft types', value: career.aircraftFlown, target: 5, unit: 'types' },
    { id: 'distance5k', label: '5,000 nm flown', value: career.distanceNm, target: 5000, unit: 'nm' },
  ];
  return list.map(item => ({
    ...item,
    progress: Math.max(0, Math.min(1, item.value / item.target)),
    reached: item.value >= item.target,
  }));
}

/** Weekly activity for the last N weeks, used by the dashboard sparkline. */
export function weeklyActivity(flights, weeks = 12, now = new Date()) {
  const buckets = [];
  const current = startOfWeek(now);
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(current);
    start.setDate(start.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    buckets.push({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), flights: 0, hours: 0 });
  }
  for (const flight of dedupeFlights(flights)) {
    if (!flight.complete || flight.incomplete) continue;
    const at = Number(flight.startTime || flight.takeoffTime || 0);
    if (!at) continue;
    const idx = buckets.findIndex(b => at >= new Date(b.start + 'T00:00:00').getTime() && at < new Date(b.end + 'T00:00:00').getTime());
    if (idx !== -1) {
      buckets[idx].flights++;
      buckets[idx].hours += quantity(flight).hours;
    }
  }
  return buckets;
}

export function flightsForAirport(flights, code) {
  return dedupeFlights(flights).filter(f => f.depAirport === code || f.arrAirport === code);
}

export function flightsForAircraft(flights, type) {
  return dedupeFlights(flights).filter(f => (f.aircraft || 'Unknown aircraft') === type);
}
