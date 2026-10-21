import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeNegativeTemp, decodeTemp, decodeWind, legWinds, parseWindsAloft, utcStampNear, windAt,
  windsAreStale,
} from '../app/js/lib/windsaloft.js';
import { bearingDeg } from '../app/js/lib/geo.js';

// Rows copied verbatim from https://aviationweather.gov/api/data/windtemp?region=us&level=low&fcst=06
const SAMPLE = [
  'FBUS31 KWNO 200200',
  'FD1US1',
  'DATA BASED ON 200000Z',
  'VALID 200600Z   FOR USE 0200-0900Z. TEMPS NEG ABV 24000',
  '',
  'FT  3000    6000    9000   12000   18000   24000  30000  34000  39000',
  'ABI      2108+14 2405+11 9900+07 2212-09 2619-20 274034 274840 273949',
  'ABR 1823 1918+07 2012+07 2311+02 2414-13 2316-26 271542 262748 273649',
  'ACY 0338 0433+11 0427+05 0418+01 0217-12 0213-25 251038 211047 990054',
].join('\n');

// 20 Oct 2026 03:00 UTC: inside the 0200-0900Z window of the sample.
const INSIDE = Date.UTC(2026, 9, 20, 3, 0);
// 20 Oct 2026 10:00 UTC: after the window closes at 0900Z.
const AFTER = Date.UTC(2026, 9, 20, 10, 0);

test('winds: wind groups decode to direction and speed', () => {
  assert.deepEqual(decodeWind('2108'), { variable: false, dirDeg: 210, speedKt: 8 });
  assert.deepEqual(decodeWind('9900'), { variable: true, dirDeg: null, speedKt: 0 });
  assert.equal(decodeWind('    '), null);
  // Speeds of 100 kt and above add 50 to the direction group (synthetic rule check).
  assert.deepEqual(decodeWind('7710'), { variable: false, dirDeg: 270, speedKt: 110 });
  assert.throws(() => decodeWind('21A8'), /Bad wind group/);
});

test('winds: temperatures are signed below 24000 ft and always negative above', () => {
  assert.equal(decodeTemp('+14'), 14);
  assert.equal(decodeTemp('-09'), -9);
  assert.equal(decodeNegativeTemp('34'), -34);
  assert.equal(decodeNegativeTemp('00'), 0);
  assert.throws(() => decodeTemp('14'), /Bad temperature/);
});

test('winds: sample rows decode to the reported levels', () => {
  const parsed = parseWindsAloft(SAMPLE, INSIDE);
  assert.deepEqual(Object.keys(parsed.stations).sort(), ['ABI', 'ABR', 'ACY']);

  // ABI: 6000 ft 210 at 8 kt, +14 C.
  assert.deepEqual(windAt(parsed, 'ABI', 6000),
    { ft: 6000, dirDeg: 210, speedKt: 8, variable: false, tempC: 14 });
  // ABI: 12000 ft light and variable, +7 C.
  assert.deepEqual(windAt(parsed, 'ABI', 12000),
    { ft: 12000, dirDeg: null, speedKt: 0, variable: true, tempC: 7 });
  // ABI: 30000 ft 270 at 40 kt, temperature -34 C (unsigned, negative).
  assert.deepEqual(windAt(parsed, 'ABI', 30000),
    { ft: 30000, dirDeg: 270, speedKt: 40, variable: false, tempC: -34 });
  // ABR: 3000 ft has wind only, no temperature.
  assert.deepEqual(windAt(parsed, 'ABR', 3000),
    { ft: 3000, dirDeg: 180, speedKt: 23, variable: false, tempC: null });
  // ACY: 39000 ft light and variable, -54 C.
  assert.deepEqual(windAt(parsed, 'ACY', 39000),
    { ft: 39000, dirDeg: null, speedKt: 0, variable: true, tempC: -54 });
});

test('winds: a request is answered by the nearest reported level', () => {
  const parsed = parseWindsAloft(SAMPLE, INSIDE);
  assert.equal(windAt(parsed, 'ABI', 10000).ft, 9000);
  assert.equal(windAt(parsed, 'ABI', 35000).ft, 34000);
  assert.equal(windAt(parsed, 'ZZZ', 6000), null);
});

test('winds: validity window and stale detection', () => {
  const parsed = parseWindsAloft(SAMPLE, INSIDE);
  assert.equal(parsed.validMs, Date.UTC(2026, 9, 20, 6, 0));
  assert.equal(parsed.validUntilMs, Date.UTC(2026, 9, 20, 9, 0));
  assert.equal(parsed.issuedMs, Date.UTC(2026, 9, 20, 0, 0));
  assert.equal(parsed.stale, false);
  assert.equal(parseWindsAloft(SAMPLE, AFTER).stale, true);
  // A table cached before the window closes must read as stale when rendered later.
  const cached = parseWindsAloft(SAMPLE, INSIDE);
  assert.equal(windsAreStale(cached, INSIDE), false);
  assert.equal(windsAreStale(cached, AFTER), true);
});

test('winds: a month-end stamp resolves into the next month', () => {
  assert.equal(
    utcStampNear('010000Z', Date.UTC(2026, 9, 31, 23, 0)),
    Date.UTC(2026, 10, 1, 0, 0),
  );
  assert.equal(utcStampNear('bad', INSIDE), null);
});

test('winds: a route leg uses the nearest station and the cruise level', () => {
  const parsed = parseWindsAloft(SAMPLE, INSIDE);
  const stations = [
    { code: 'ABI', lat: 32.41, lon: -99.68 },
    { code: 'ACY', lat: 39.46, lon: -74.58 },
  ];
  const from = { id: 'KABI', lat: 32.41, lon: -99.68 };
  const to = { id: 'KXYZ', lat: 33.0, lon: -100.5 };
  const bearing = bearingDeg(from, to);
  const [row] = legWinds({ parsed, legs: [{ from, to, initialBearing: bearing }], stations, cruiseFt: 30000 });
  assert.equal(row.station, 'ABI');
  assert.equal(row.ft, 30000);
  assert.equal(row.dirDeg, 270);
  assert.equal(row.speedKt, 40);
  assert.equal(row.tempC, -34);
  // Head component = speed x cos(wind-from minus course), rounded as routeweather does.
  const expected = Math.round(40 * Math.cos(((270 - bearing) * Math.PI) / 180));
  assert.ok(Math.abs(row.headwindKt - expected) <= 1, `headwind ${row.headwindKt} vs ${expected}`);
  assert.equal(row.reason, null);
});

test('winds: a leg with no station nearby says so instead of inventing winds', () => {
  const parsed = parseWindsAloft(SAMPLE, INSIDE);
  const from = { id: 'EGLL', lat: 51.47, lon: -0.45 };
  const to = { id: 'LFPG', lat: 49.01, lon: 2.55 };
  const [row] = legWinds({
    parsed, legs: [{ from, to, initialBearing: bearingDeg(from, to) }],
    stations: [{ code: 'ABI', lat: 32.41, lon: -99.68 }], cruiseFt: 30000,
  });
  assert.equal(row.station, null);
  assert.equal(row.speedKt, null);
  assert.match(row.reason, /No winds-aloft station/);
});

test('winds: a changed level layout or non-table text is rejected', () => {
  const changed = SAMPLE.replace('18000   24000', '18000   21000');
  assert.throws(() => parseWindsAloft(changed, INSIDE), /layout has changed/);
  assert.throws(() => parseWindsAloft('<html>maintenance</html>', INSIDE), /not the expected/);
});
