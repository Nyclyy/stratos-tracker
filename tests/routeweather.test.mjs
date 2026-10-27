import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEATHER_STALE_MS, analyseRouteWeather, flightCategory, parseMetar,
  parseVisibility, pickWeatherStations, windComponents, withRouteCourses,
} from '../app/js/lib/routeweather.js';

const VFR = 'KJFK 191751Z 27012G22KT 10SM FEW045 BKN250 18/09 A3005 RMK AO2 SLP174';
const IFR = 'KJFK 191751Z 09008KT 2SM OVC008 18/09 A3005';
const LIFR = 'KJFK 191751Z 00000KT 1/2SM OVC003 18/09 A3005';
const VRB = 'KJFK 191751Z VRB03KT 10SM SKC 18/09 A3005';

test('route weather: visibility tokens decode to statute miles', () => {
  assert.equal(parseVisibility('10'), 10);
  assert.equal(parseVisibility('1/2'), 0.5);
  assert.equal(parseVisibility('1 1/2'), 1.5);
  assert.equal(parseVisibility('M1/4'), 0.25);
  assert.equal(parseVisibility('CAVOK'), null, 'CAVOK is handled by the METAR parser, not as a number');
  assert.equal(parseVisibility(''), null);
});

test('route weather: flight category follows reported visibility and ceiling', () => {
  assert.equal(flightCategory({ visibilitySm: 10, ceilingFt: 25000 }), 'VFR');
  assert.equal(flightCategory({ visibilitySm: 5, ceilingFt: null }), 'MVFR');
  assert.equal(flightCategory({ visibilitySm: 2, ceilingFt: 800 }), 'IFR');
  assert.equal(flightCategory({ visibilitySm: 0.5, ceilingFt: 300 }), 'LIFR');
  assert.equal(flightCategory({ visibilitySm: null, ceilingFt: null }), null, 'no report, no category');
});

test('route weather: METAR wind, visibility and ceiling are read from the report', () => {
  const parsed = parseMetar(VFR);
  assert.deepEqual(parsed.wind, { direction: 270, speedKt: 12, gustKt: 22 });
  assert.equal(parsed.visibilitySm, 10);
  assert.equal(parsed.ceilingFt, 25000);
  assert.equal(parsed.temperatureC, 18);
  assert.equal(parsed.flightCategory, 'VFR');
  assert.equal(parseMetar(IFR).flightCategory, 'IFR');
  assert.equal(parseMetar(LIFR).flightCategory, 'LIFR');
  assert.equal(parseMetar(VRB).wind.direction, null, 'variable wind has no direction');
  assert.equal(parseMetar(''), null);
});

test('route weather: metric visibility is converted, not dropped', () => {
  // Most of the world reports metres. "9999" is 10 km or more, not a missing field.
  const parsed = parseMetar('METAR LHBP 260030Z 24009KT 9999 FEW006 BKN040 09/08 Q1014');
  assert.equal(parsed.visibilityM, 9999);
  assert.ok(parsed.visibilitySm > 6 && parsed.visibilitySm < 6.5);
  assert.equal(parsed.flightCategory, 'VFR');

  const low = parseMetar('EPWA 260030Z 18003KT 0800 R33/1200 FG VV002 08/08 Q1007');
  assert.equal(low.visibilityM, 800);
  assert.equal(low.flightCategory, 'LIFR');

  // A station that reports statute miles keeps its own unit and no metric value.
  const imperial = parseMetar(VFR);
  assert.equal(imperial.visibilityM, null);
  assert.equal(imperial.visibilitySm, 10);
});

test('route weather: wind components use the course, with gusts when present', () => {
  assert.deepEqual(windComponents(270, 270, 20), {
    effectiveKt: 20, angleDeg: 0, headwindKt: 20, crosswindKt: 0,
  });
  assert.equal(windComponents(270, 90, 20).headwindKt, -20, 'a wind from the nose is a tailwind');
  assert.equal(windComponents(90, 360, 20).crosswindKt, -20, 'from the left is negative');
  assert.equal(windComponents(90, 180, 20).crosswindKt, 20, 'from the right is positive');
  assert.equal(windComponents(270, 270, 10, 25).headwindKt, 25, 'plan with the gust');
  assert.equal(windComponents(null, 270, 20), null, 'no course means no component');
});

test('route weather: only airports are sampled, and long routes stay bounded', () => {
  const points = [
    { id: 'KJFK', kind: 'apt' }, { id: 'DIX', kind: 'fix' },
    { id: 'KORD', kind: 'apt' }, { id: 'KJFK', kind: 'apt' },
    { id: 'KBOS', kind: 'apt' }, { id: 'KDEN', kind: 'apt' }, { id: 'KLAX', kind: 'apt' },
  ];
  const picked = pickWeatherStations(points, point => point.kind === 'apt', 3);
  assert.equal(picked.length, 3);
  assert.equal(picked[0].id, 'KJFK', 'the departure is kept');
  assert.equal(picked[picked.length - 1].id, 'KLAX', 'the destination is kept');
  assert.ok(picked.every(station => station.id !== 'DIX'), 'fixes have no station weather');
  assert.equal(new Set(picked.map(station => station.id)).size, picked.length, 'no duplicate requests');
});

test('route weather: courses come from the real route order', () => {
  const points = [
    { id: 'KJFK', lat: 40.64, lon: -73.78 },
    { id: 'KORD', lat: 41.98, lon: -87.9 },
  ];
  const [departure, arrival] = withRouteCourses(points, [
    { id: 'KJFK', lat: 40.64, lon: -73.78 },
    { id: 'KORD', lat: 41.98, lon: -87.9 },
  ]);
  assert.ok(departure.courseDeg > 270 && departure.courseDeg < 300, 'the departure course points west-northwest');
  assert.ok(arrival.courseDeg > 270 && arrival.courseDeg < 300, 'the arrival uses the same inbound leg, not a zero course');
});

test('route weather: challenges come from real reports, never guesses', () => {
  const now = Date.UTC(2026, 9, 19, 18, 0, 0);
  const stations = [
    { id: 'KJFK', courseDeg: 270, metar: IFR, fetchedAt: now - 5 * 60000 },
    { id: 'KORD', courseDeg: 270, metar: null, fetchedAt: now - 5 * 60000 },
    { id: 'KBOS', courseDeg: 90, metar: VFR, fetchedAt: now - 2 * 3600000 },
    { id: 'KDEN', courseDeg: 90, metar: VRB, fetchedAt: now - 5 * 60000 },
  ];
  const result = analyseRouteWeather(stations, now);
  const kinds = result.challenges.map(challenge => challenge.kind);
  assert.ok(kinds.includes('imc'), 'IFR is reported');
  assert.ok(kinds.includes('missing'), 'a missing METAR is called out');
  assert.ok(kinds.includes('stale'), 'an old fetch is called out');
  assert.ok(result.challenges.every(challenge => challenge.text.includes(challenge.station)), 'each challenge names its station');
  assert.equal(result.stations.find(row => row.id === 'KORD').flightCategory, null, 'no category without a report');
  assert.equal(result.stations.find(row => row.id === 'KORD').components, null, 'no wind without a report');
  assert.equal(result.stations.find(row => row.id === 'KDEN').components, null, 'variable wind has no component');
  assert.ok(result.stations.find(row => row.id === 'KBOS').stale, 'the old report is marked stale');
});

test('route weather: decoded category wins and crosswinds are reported', () => {
  const now = Date.now();
  const result = analyseRouteWeather([{
    id: 'KSFO', courseDeg: 280, metar: VFR, fetchedAt: now,
    decoded: { flight_category: 'MVFR', wind_dir: 360, wind_speed_kt: 20, sky_conditions: ['BKN030'] },
  }], now);
  const row = result.stations[0];
  assert.equal(row.flightCategory, 'MVFR', 'the source category is trusted over a re-derivation');
  assert.equal(row.ceilingFt, 3000);
  assert.equal(Math.abs(row.components.crosswindKt), 20);
  assert.ok(result.challenges.some(challenge => challenge.kind === 'crosswind'));
  assert.ok(WEATHER_STALE_MS >= 60 * 60 * 1000);
});
