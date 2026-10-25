import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distanceNm, bearingDeg, destination, crossTrackNm, validLatLon, formatDuration, headingDelta,
} from '../app/js/lib/geo.js';
import {
  analyzeLanding, aircraftClass, classifyLanding, matchRunway, summarizeLandings, landingOfFlight,
} from '../app/js/lib/landing.js';
import { computeCareer, dedupeFlights, weeklyActivity, computeMilestones } from '../app/js/lib/stats.js';
import {
  prepareReplay, normalizeTrack, simplifyTrack, sampleAt, hasReplay, telemetryCoverage, nearestRecorded,
} from '../app/js/lib/replay.js';
import {
  parseWaypointText, validateRoute, routeTotals, exportPln, importPln, exportFms, importFms,
  exportGpx, importGpx, detectRouteFormat, importRoute, moveWaypoint, directTo, removeWaypoint,
  searchPlaces, createSavedRoute, renameSavedRoute, duplicateSavedRoute, estimateFlightTime,
} from '../app/js/lib/planner.js';
import { parseTelemetry, getResourceProfile, RESOURCE_MODES } from '../app/js/lib/telemetry.js';
import {
  fetchSimbriefPlan, simbriefQuery, validateSimbriefId, saveSimbriefId, loadSimbriefId, clearSimbriefId, SIMBRIEF_ID_KEY,
} from '../app/js/lib/simbrief.js';
import { plannedAltitudeFt } from '../app/js/flightpanel.js';

test('waypoint altitude comes from the saved SimBrief plan by identifier', () => {
  const ofp = { fixes: [{ ident: 'ABC', altFt: 34000 }, { ident: 'XYZ', altFt: 0 }] };
  assert.equal(plannedAltitudeFt(ofp, 'abc'), 34000);
  assert.equal(plannedAltitudeFt(ofp, 'XYZ'), null);
  assert.equal(plannedAltitudeFt(ofp, 'NOPE'), null);
  assert.equal(plannedAltitudeFt(null, 'ABC'), null);
});

const KSFO = { lat: 37.6188, lon: -122.3754 };
const KLAX = { lat: 33.9425, lon: -118.4081 };
const KJFK = { lat: 40.6398, lon: -73.7789 };

test('geo: distance and bearing are sane', () => {
  const nm = distanceNm(KSFO, KLAX);
  assert.ok(nm > 290 && nm < 300, `expected ~293 nm, got ${nm}`);
  const back = distanceNm(KLAX, KSFO);
  assert.ok(Math.abs(nm - back) < 0.001);
  assert.ok(Math.abs(bearingDeg(KSFO, KLAX) - 137) < 5);
  const dest = destination(KSFO, 90, 100);
  assert.ok(dest.lon > KSFO.lon);
  assert.equal(distanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }).toFixed(2), '60.04');
});

test('geo: invalid coordinates never produce numbers', () => {
  assert.equal(validLatLon(91, 0), false);
  assert.equal(validLatLon(0, 181), false);
  assert.equal(distanceNm(null, KLAX), 0);
  assert.equal(bearingDeg({ lat: NaN, lon: 0 }, KLAX), 0);
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(-1), '—');
  assert.equal(headingDelta(350, 10), 20);
});

test('landing: aircraft class heuristics', () => {
  assert.equal(aircraftClass('B738'), 'jet');
  assert.equal(aircraftClass('Airbus A320neo'), 'jet');
  assert.equal(aircraftClass('C172S'), 'piston');
  assert.equal(aircraftClass('TBM 930'), 'turboprop');
  assert.equal(aircraftClass('ASK21'), 'glider');
  assert.equal(aircraftClass('H145'), 'helicopter');
  assert.equal(aircraftClass(''), 'unknown');
});

test('landing: thresholds are per class and configurable', () => {
  const jet = classifyLanding(-170, 'B738');
  assert.equal(jet.key, 'good');
  const piston = classifyLanding(-170, 'C172');
  assert.equal(piston.key, 'firm');
  const custom = classifyLanding(-170, 'B738', { jet: { smooth: -200, good: -400, firm: -600, hard: -900 } });
  assert.equal(custom.key, 'smooth');
  assert.equal(classifyLanding(null, 'B738').key, 'unclassified');
  assert.equal(classifyLanding(-9000, 'B738').key, 'unclassified');
  const unknown = classifyLanding(-150, 'Mystery Ship');
  assert.equal(unknown.classKey, 'unknown');
  assert.match(unknown.basis, /generic/i);
});

test('landing: touchdown analysis derives VS from recorded altitude', () => {
  const t0 = 1700000000000;
  const samples = [];
  for (let i = 0; i <= 10; i++) {
    samples.push({
      lat: 37.6188 + i * 0.00002,
      lon: -122.3754,
      alt: 120 - i * 2, // 2 ft per 0.5 s = 240 fpm
      agl: 120 - i * 2,
      gs: 135 - i * 0.5,
      hdg: 284,
      vs: -240,
      t: t0 + i * 500,
    });
  }
  const result = analyzeLanding({ samples, aircraftType: 'B738' });
  assert.equal(result.available, true);
  assert.equal(result.vsSource, 'derived from recorded altitude');
  assert.ok(Math.abs(result.vsFpm + 240) <= 2, `got ${result.vsFpm}`);
  assert.ok(result.gsKt >= 130 && result.gsKt <= 140);
  assert.equal(result.runway, null);
  assert.ok(result.warnings.some(w => /Runway/.test(w)));
  assert.ok(result.sampleCount >= 10);
});

test('landing: reported VS fallback is labelled', () => {
  const result = analyzeLanding({
    samples: [{ lat: 37.6, lon: -122.3, alt: 10, gs: 120, hdg: 280, vs: -350, t: 1000 }],
    aircraftType: 'C172',
  });
  assert.equal(result.vsSource, 'last reported vertical speed');
  assert.equal(result.vsFpm, -350);
  assert.ok(result.warnings.some(w => /last value/i.test(w)));
  assert.equal(result.classification.key, 'hard');
  const severe = analyzeLanding({ samples: [{ lat: 37.6, lon: -122.3, alt: 0, gs: 100, hdg: 90, vs: -600, t: 1000 }], aircraftType: 'C172' });
  assert.equal(severe.classification.key, 'severe');
});

test('landing: representative touchdown rates at 100, 200 and 500 fpm', () => {
  // Same thresholds as bridge_logbook_addon.py (LANDING_THRESHOLDS), in fpm.
  assert.equal(classifyLanding(-100, 'B738').key, 'smooth');
  assert.equal(classifyLanding(-200, 'B738').key, 'firm');
  assert.equal(classifyLanding(-500, 'B738').key, 'hard');
  assert.equal(classifyLanding(-100, 'C172').key, 'good');
  assert.equal(classifyLanding(-200, 'C172').key, 'firm');
  assert.equal(classifyLanding(-500, 'C172').key, 'severe');
});

test('landing: runway matching uses real runway ends', () => {
  const airports = [{
    id: 'KAAA', name: 'Test Field', lat: 37.0, lon: -122.0,
    rws: [['09', '27', 37.0, -122.02, 37.0, -121.98, 8000, 150]],
  }];
  const runway = matchRunway(airports, { lat: 37.0002, lon: -122.01 }, 90);
  assert.ok(runway);
  assert.equal(runway.id, '09/27');
  assert.equal(runway.lengthFt, 8000);
  assert.ok(runway.distanceFromThresholdFt > 1000 && runway.distanceFromThresholdFt < 3000, String(runway.distanceFromThresholdFt));
  assert.equal(runway.headingAligned, true);
  const tooFar = matchRunway(airports, { lat: 37.5, lon: -122.01 }, 90);
  assert.equal(tooFar, null);
});

test('landing: summarize handles legacy and missing data', () => {
  const flights = [
    { id: 'a', complete: true, aircraft: 'B738', arrAirport: 'KLAX', landingTime: 10, landing: { vsFpm: -150, at: 10, gsKt: 140 } },
    { id: 'b', complete: true, aircraft: 'C172', landingVS: -80, landingTime: 20 },
    { id: 'c', complete: true, aircraft: 'B738', landingTime: 30 },
  ];
  const summary = summarizeLandings(flights);
  assert.equal(summary.count, 2);
  assert.equal(summary.skipped.noRecord, 1);
  assert.equal(summary.best.vsFpm, -80);
  assert.equal(summary.averageFpm, -115);
  assert.ok(summary.byClass.jet.count === 1);
  assert.ok(summary.landings.find(l => l.flightId === 'b').warnings.length > 0);
  assert.equal(landingOfFlight(flights[2]), null);
});

function flight(id, start, overrides = {}) {
  return {
    id,
    complete: true,
    incomplete: false,
    startTime: start,
    takeoffTime: start + 60000,
    landingTime: start + 60000 + 2 * 3600000,
    endTime: start + 60000 + 2 * 3600000 + 120000,
    depAirport: 'KSFO',
    arrAirport: 'KLAX',
    aircraft: 'B738',
    distanceNm: 293,
    track: [{ lat: 37.6, lon: -122.3, alt: 0, t: start }, { lat: 33.9, lon: -118.4, alt: 35000, t: start + 7200000 }],
    ...overrides,
  };
}

test('stats: dedupe prevents double counting', () => {
  const a = flight('one', 1000);
  const b = flight('two', 1200); // same takeoff window, different id
  const c = flight('three', 90000000);
  const deduped = dedupeFlights([a, b, c]);
  assert.equal(deduped.length, 2);
  const career = computeCareer([a, b, c], { now: new Date(90000000) });
  assert.equal(career.flights, 2);
  assert.equal(career.hours, 4);
  assert.equal(career.incompleteFlights, 0);
});

test('stats: career totals, routes and records', () => {
  const now = new Date('2026-06-15T12:00:00Z').getTime();
  const f1 = flight('1', now - 40 * 86400000);
  const f2 = flight('2', now - 10 * 86400000, { depAirport: 'KLAX', arrAirport: 'KJFK', distanceNm: 2150, aircraft: 'B77W' });
  const f3 = flight('3', now - 2 * 86400000, { arrAirport: 'KSFO', distanceNm: 700, aircraft: 'A320' });
  const broken = flight('4', now - 5 * 86400000, { incomplete: true });
  const career = computeCareer([f1, f2, f3, broken], { now });
  assert.equal(career.flights, 3);
  assert.equal(career.incompleteFlights, 1);
  assert.equal(career.airportsVisited, 3);
  assert.equal(career.aircraftFlown, 3);
  assert.equal(career.farthestFlight.id, '2');
  assert.ok(career.topRoutes.length >= 2);
  assert.equal(career.topRoutes[0].count, 1);
  assert.equal(career.monthly.length >= 1, true);
  assert.equal(career.windows.month, 2); // f2 (10 days ago) and f3 (2 days ago) are both this month
  assert.equal(career.rank.id, 'student');
  assert.ok(career.nextRank);
  assert.equal(career.uniqueFlightIds.length, 4);
  const milestones = computeMilestones(career);
  assert.equal(milestones.find(m => m.id === 'first').reached, true);
  assert.equal(milestones.find(m => m.id === 'hours100').reached, false);
  const weekly = weeklyActivity([f1, f2, f3], 12, new Date(now));
  assert.equal(weekly.length, 12);
  assert.ok(weekly.some(w => w.flights > 0));
});

test('stats: duration uses takeoff/landing and falls back safely', () => {
  const career = computeCareer([flight('1', 1000), { id: 'x', complete: true, startTime: 0, endTime: 0 }], { now: new Date(1000) });
  assert.equal(career.hours, 2);
  assert.equal(career.flights, 2);
});

test('replay: normalizes seconds and drops duplicates', () => {
  const points = normalizeTrack([
    { lat: 37.6, lon: -122.3, alt: 100, t: 1700000000 },
    { lat: 37.61, lon: -122.3, alt: 200, t: 1700000001 },
    { lat: 37.62, lon: -122.3, alt: 300, t: 1700000002 },
    { lat: 37.62, lon: -122.3, alt: 350, t: 1700000003 },
  ]);
  assert.equal(points.length, 4);
  assert.ok(points[0].t > 1e12);
  assert.equal(points[3].alt, 350);
  assert.equal(normalizeTrack([{ lat: 999, lon: 0, t: 1 }]).length, 0);
});

test('replay: simplification keeps endpoints and shape', () => {
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push({ lat: 37 + i * 0.001, lon: -122 + Math.sin(i / 20) * 0.01, t: i * 1000 });
  const simplified = simplifyTrack(pts, 0.02, 2500);
  assert.ok(simplified.length < pts.length);
  assert.deepEqual(simplified[0], pts[0]);
  assert.deepEqual(simplified[simplified.length - 1], pts[pts.length - 1]);
  const capped = simplifyTrack(pts, 0, 50);
  assert.equal(capped.length, 50);
});

test('replay: sampleAt interpolates and labels it', () => {
  const start = 1700000000000;
  const track = [];
  for (let i = 0; i <= 60; i++) {
    track.push({ lat: 37 + i * 0.01, lon: -122, alt: i * 100, gs: 250, hdg: 90, vs: 500, t: start + i * 1000 });
  }
  const replay = prepareReplay({ id: 'f', track });
  assert.equal(replay.available, true);
  assert.equal(replay.durationMs, 60000);
  const exact = sampleAt(replay, start + 10000);
  assert.equal(exact.recorded, true);
  const between = sampleAt(replay, start + 10500);
  assert.equal(between.recorded, false);
  assert.equal(between.interpolated, true);
  assert.ok(between.alt > 1000 && between.alt < 1100);
  assert.equal(between.fieldInterpolated.alt, true);
  const before = sampleAt(replay, start - 5000);
  assert.equal(before.progress, 0);
  const after = sampleAt(replay, start + 999999);
  assert.equal(after.progress, 1);
  const nearest = nearestRecorded(replay, start + 10400);
  assert.equal(nearest.t, start + 10000);
  assert.ok(telemetryCoverage(replay.track).alt.ratio === 1);
});

test('replay: unavailable without a usable track', () => {
  assert.equal(hasReplay({}), false);
  const replay = prepareReplay({ id: 'x' });
  assert.equal(replay.available, false);
  assert.match(replay.reason, /no recorded position track/i);
  assert.equal(sampleAt(replay, 0), null);
});

test('planner: waypoint parsing and validation', () => {
  assert.equal(parseWaypointText('ksfo').id, 'KSFO');
  assert.equal(parseWaypointText('37.62,-122.38').lat, 37.62);
  assert.match(parseWaypointText('95,200').error, /latitude, longitude/i);
  assert.match(parseWaypointText('a').error, /2-8 character/i);
  const valid = validateRoute([
    { id: 'KSFO', lat: 37.6188, lon: -122.3754 },
    { id: 'KLAX', lat: 33.9425, lon: -118.4081 },
  ]);
  assert.equal(valid.valid, true);
  assert.equal(valid.points.length, 2);
  const invalid = validateRoute([{ id: 'X', lat: 999, lon: 0 }]);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length >= 2);
});

test('planner: totals are labelled estimates', () => {
  const route = [
    { id: 'KSFO', lat: 37.6188, lon: -122.3754, elev: 13 },
    { id: 'KLAX', lat: 33.9425, lon: -118.4081, elev: 128 },
  ];
  const totals = routeTotals(route, { cruiseKts: 450, cruiseAlt: 35000 });
  assert.ok(totals.distanceNm > 290 && totals.distanceNm < 300);
  assert.ok(totals.eteMinutes >= 44 && totals.eteMinutes <= 50, String(totals.eteMinutes));
  assert.equal(totals.estimated, true);
  assert.match(totals.method, /No wind/);
  const short = estimateFlightTime(50, { cruiseTas: 120, cruiseAlt: 8000, climbFpm: 700, descentFpm: 500 });
  assert.ok(short.airborneMinutes > 20 && short.airborneMinutes < 40);
  assert.equal(estimateFlightTime(0).totalMinutes, 0);
});

test('planner: PLN/FMS/GPX round trip', () => {
  const route = [
    { id: 'KSFO', name: 'San Francisco', lat: 37.6188, lon: -122.3754, elev: 13, kind: 'apt' },
    { id: 'SFO', name: 'VOR', lat: 37.619, lon: -122.373, elev: 0, kind: 'nav' },
    { id: 'KLAX', name: 'Los Angeles', lat: 33.9425, lon: -118.4081, elev: 128, kind: 'apt' },
  ];
  const pln = exportPln(route);
  assert.match(pln, /<ATCWaypoint id="KSFO">/);
  const plnBack = importPln(pln);
  assert.equal(plnBack.length, 3);
  assert.ok(Math.abs(plnBack[2].lat - 33.9425) < 0.001);
  const fms = exportFms(route);
  const fmsBack = importFms(fms);
  assert.equal(fmsBack.length, 3);
  assert.equal(fmsBack[0].kind, 'apt');
  const gpx = exportGpx(route);
  const gpxBack = importGpx(gpx);
  assert.equal(gpxBack.length, 3);
  assert.equal(detectRouteFormat(pln), 'pln');
  assert.equal(detectRouteFormat(gpx), 'gpx');
  assert.equal(detectRouteFormat(fms), 'fms');
  assert.equal(importRoute(fms).format, 'fms');
  assert.throws(() => importRoute('hello'), /Unrecognised/);
  assert.throws(() => exportPln([route[0]]), /two waypoints/);
});

test('planner: editing helpers and saved routes', () => {
  const route = [
    { id: 'A', lat: 0, lon: 0 }, { id: 'B', lat: 1, lon: 1 }, { id: 'C', lat: 2, lon: 2 },
  ];
  assert.deepEqual(moveWaypoint(route, 2, 1).map(p => p.id), ['A', 'C', 'B']);
  assert.deepEqual(removeWaypoint(route, 1).map(p => p.id), ['A', 'C']);
  assert.deepEqual(directTo(route, 1).map(p => p.id), ['A', 'B']);
  const saved = createSavedRoute('', route);
  assert.equal(saved.name, 'A → C');
  assert.equal(renameSavedRoute(saved, 'Coast run').name, 'Coast run');
  const copy = duplicateSavedRoute(saved);
  assert.notEqual(copy.id, saved.id);
  assert.equal(copy.points.length, 3);
  const results = searchPlaces([
    { id: 'KSFO', name: 'San Francisco Intl', iata: 'SFO' },
    { id: 'KLAX', name: 'Los Angeles Intl', iata: 'LAX' },
  ], 'lax');
  assert.equal(results[0].id, 'KLAX');
});

test('telemetry: rejects bad packets and clamps values', () => {
  assert.equal(parseTelemetry(null), null);
  assert.equal(parseTelemetry({ lat: 200, lon: 0 }), null);
  const t = parseTelemetry({ lat: '37.6', lon: '-122.3', alt: '3500', gs: -12, hdg: 370, vs: '-800', agl: 0 });
  assert.equal(t.lat, 37.6);
  assert.equal(t.gs, 0);
  assert.equal(t.hdg, 10);
  assert.equal(t.vs, -800);
  assert.equal(t.onGround, true);
  assert.equal(t.receivedAt > 0, true);
});

test('resource profiles expose consistent keys', () => {
  for (const key of Object.keys(RESOURCE_MODES)) {
    const profile = getResourceProfile(key);
    assert.equal(profile.key, key);
    assert.ok(profile.mapFps > 0 && profile.streamHz > 0 && profile.trafficIntervalMs >= 1000);
  }
  assert.equal(getResourceProfile('nope').key, 'normal');
});

test('simbrief: query uses userid for numeric Pilot IDs and username otherwise', () => {
  assert.equal(simbriefQuery('123456'), 'userid=123456');
  assert.equal(simbriefQuery(' pilot 1 '), 'username=pilot%201');
});

test('simbrief: the saved Pilot ID is validated, stored once, and can be disconnected', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  assert.equal(validateSimbriefId('').ok, false);
  assert.equal(validateSimbriefId('  ').ok, false);
  assert.equal(validateSimbriefId('abc def').ok, false);
  assert.equal(validateSimbriefId('x'.repeat(65)).ok, false);
  assert.deepEqual(validateSimbriefId(' 123456 '), { ok: true, id: '123456', kind: 'pilot' });
  assert.equal(validateSimbriefId('jane.doe_1').kind, 'username');
  assert.equal(loadSimbriefId(storage), '');
  saveSimbriefId(storage, ' 123456 ');
  assert.equal(store.get(SIMBRIEF_ID_KEY), '123456');
  assert.equal(loadSimbriefId(storage), '123456');
  clearSimbriefId(storage);
  assert.equal(loadSimbriefId(storage), '');
});

test('simbrief: reads navlog fixes from JSON and rejects a plan with no waypoints', async () => {
  const realFetch = globalThis.fetch;
  const respond = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  try {
    globalThis.fetch = async () => respond({ origin: { icao_code: 'KSFO' }, destination: { icao_code: 'KLAX' }, navlog: { fix: [{ ident: 'SADDE', pos_lat: '37.6', pos_long: '-122.4', type: 'fix' }] } });
    const plan = await fetchSimbriefPlan('pilot');
    assert.equal(plan.origin, 'KSFO');
    assert.equal(plan.fixes[0].ident, 'SADDE');

    const { DOMParser: LinkedDOMParser } = await import('linkedom');
    globalThis.DOMParser ??= LinkedDOMParser;
    const xml = '<OFP><navlog><fix><ident>DCT1</ident><pos_lat>40.1</pos_lat><pos_long>-75.2</pos_long><type>fix</type></fix></navlog></OFP>';
    globalThis.fetch = async (url) => (url.includes('json=v2')
      ? respond({ fetch: { status: 'Error: nothing' } })
      : { ok: true, status: 200, json: async () => ({}), text: async () => xml });
    const fromXml = await fetchSimbriefPlan('pilot');
    assert.equal(fromXml.fixes[0].ident, 'DCT1');
    assert.equal(fromXml.fixes[0].pos_lat, '40.1');

    globalThis.fetch = async () => respond({ fetch: { status: 'Error: nothing' } });
    await assert.rejects(fetchSimbriefPlan('pilot'), /No waypoints found.*Error: nothing/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('trail colours: white on the ground, a ramp in between, magenta at the top', async () => {
  const { trailInk, TRAIL_RAMP, trailGradient } = await import('../app/js/lib/trailcolor.js');
  assert.equal(trailInk(0), 'rgb(255,255,255)', 'the aircraft on the ground is white');
  assert.equal(trailInk(-50), 'rgb(255,255,255)', 'a negative height is still the ground');
  assert.equal(trailInk(42000), 'rgb(216,72,240)', 'the top of the ramp is magenta');
  assert.equal(trailInk(90000), trailInk(42000), 'above the last stop the top colour holds');
  assert.notEqual(trailInk(12000), trailInk(20000), 'the colour keeps changing with height');
  for (const [height, hex] of TRAIL_RAMP) {
    const ink = trailInk(height).match(/\d+/g).map(Number);
    const stated = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    // Channels are quantised in steps of 8 so a long climb strokes in runs.
    ink.forEach((value, index) => assert.ok(Math.abs(value - stated[index]) <= 8, `stop ${height} ft matches ${hex}`));
    assert.ok(ink.every(channel => channel >= 0 && channel <= 255), 'no channel leaves the byte range');
  }
  assert.match(trailGradient(), /^#ffffff 0%/, 'the legend starts at white');
});

test('a drawn trail rounds its corners without moving the recorded path', async () => {
  const { smoothPath } = await import('../app/js/lib/trailpath.js');
  // A right-angle turn: the drawn line must bend through it, not meet it in a point.
  const corner = [[0, 0], [100, 0], [100, 100]];
  const { points, heights } = smoothPath(corner, [0, 1000, 2000]);
  assert.deepEqual(points[0], [0, 0], 'the first recorded point is where the line starts');
  assert.deepEqual(points[points.length - 1], [100, 100], 'and the last one is where it ends');
  assert.ok(points.length > corner.length, 'the corner is replaced with a curve');
  assert.equal(heights.length, points.length, 'every drawn point keeps a height');
  assert.equal(heights[0], 0);
  assert.equal(heights[heights.length - 1], 2000);
  // Nothing bulges away from the recorded legs: the midpoint of the turn stays
  // inside the corner the samples make, a quarter-segment at most.
  const mid = points[Math.floor(points.length / 2)];
  assert.ok(mid[0] <= 100.001 && mid[1] <= 100.001 && mid[1] >= 0, 'the curve stays inside the turn');
  assert.ok(points.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 100), 'and inside the recorded bounds');
  // A short or empty trail is returned untouched instead of being reshaped.
  assert.deepEqual(smoothPath([[1, 2], [3, 4]]).points, [[1, 2], [3, 4]]);
  assert.deepEqual(smoothPath([]).points, []);
  // A very long trail stops subdividing, so a full flight stays cheap to draw.
  const long = Array.from({ length: 900 }, (_, i) => [i, Math.sin(i / 20) * 40]);
  const bounded = smoothPath(long, null, { passes: 2, maxPoints: 1200 });
  assert.ok(bounded.points.length <= 1300, 'the drawn path is capped');
});

test('a trail survives the landing that ends the bridge flight record', async () => {
  const { trailContinues } = await import('../app/js/lib/trailpath.js');
  const now = Date.now();
  const touchdown = [51.4700, -0.4543, 83, now];
  // The rollout starts a new flight record a second later at the same place.
  assert.equal(trailContinues(touchdown, [51.4701, -0.4544, 83, now + 1000]), true,
    'a new record where the old one stopped is the same journey');
  // Same place after a long pause is a new session, not a continuation.
  assert.equal(trailContinues(touchdown, [51.4700, -0.4543, 83, now + 3600000]), false,
    'a stale start is not joined to the old line');
  // A flight started at another airport must not draw a line across the world.
  assert.equal(trailContinues(touchdown, [40.6413, -73.7781, 13, now + 1000]), false,
    'a reposition clears the trail');
  // Object points and missing timestamps are handled without throwing.
  assert.equal(trailContinues({ lat: 1, lon: 1 }, { lat: 1.001, lon: 1.001 }), true);
  assert.equal(trailContinues([1, 1], [2, 2]), false);
  assert.equal(trailContinues(null, [1, 1]), false);
});

test('a rollout recording is appended to the flight instead of replacing it', async () => {
  const { appendTrack } = await import('../app/js/lib/trailpath.js');
  const now = Date.now();
  const flown = [[51.46, -0.45, 4000, now - 60000], [51.47, -0.4543, 83, now]];
  const rollout = [[51.47, -0.4543, 83, now + 1000], [51.472, -0.4520, 80, now + 9000]];
  const joined = appendTrack(flown, rollout);
  assert.equal(joined.length, 3, 'the repeated touchdown point is not drawn twice');
  assert.deepEqual(joined[0], flown[0], 'the flight already flown keeps its departure end');
  assert.deepEqual(joined[2], rollout[1], 'the rollout continues the line');
  assert.equal(flown.length, 2, 'the recorded path passed in is not mutated');
  // Nothing to append keeps the path as it is; malformed points are dropped.
  assert.deepEqual(appendTrack(flown, []), flown);
  assert.deepEqual(appendTrack(flown, [[null, null, 0, now]]), flown);
  assert.equal(appendTrack(null, rollout).length, 2, 'a first recording needs no base');
});
