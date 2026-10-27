import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NavPointIndex, DEFAULT_RADIUS_NM, MAX_RADIUS_NM, coordinateIdent, formatRadius, coverageText,
} from '../app/js/lib/navnear.js';
import { distanceNm } from '../app/js/lib/geo.js';

const KSEA = { id: 'KSEA', name: 'Seattle-Tacoma', lat: 47.449, lon: -122.309, elev: 433 };
const KPDX = { id: 'KPDX', name: 'Portland', lat: 45.589, lon: -122.595, elev: 31 };
const KOLM = { id: 'OLM', name: 'Olympia', type: 'VORTAC', lat: 46.9716, lon: -122.902, freq: '113.40 MHz' };
const KBTG = { id: 'BTG', name: 'Battle Ground', type: 'VORTAC', lat: 45.7478, lon: -122.592, freq: '116.60 MHz' };
const KYKM = { id: 'KYKM', name: 'Yakima', lat: 46.568, lon: -120.544, elev: 1099 };  // ~90 NM from KSEA

function index() {
  const points = new NavPointIndex();
  points.setPublished([KSEA, KPDX, KYKM], [KOLM, KBTG]);
  return points;
}

test('a point exactly one layout apart is not merged, and bad rows are dropped', () => {
  const points = new NavPointIndex();
  const kept = points.setPublished(
    [KSEA, { id: 'KSEA', name: 'dup', lat: 47.449, lon: -122.309 }, { id: 'XX', lat: 999, lon: 0 }, { id: '', lat: 47, lon: -122 }],
    [],
  );
  assert.equal(kept, 2, 'the same airport twice is two rows here; the query dedupes by place');
  assert.equal(points.near(47.449, -122.309, 5).count, 1, 'one place, not two records');
});

test('the radius is a real great-circle distance, not a cell or a pixel count', () => {
  const points = index();
  const answer = points.near(KSEA.lat, KSEA.lon, DEFAULT_RADIUS_NM);
  assert.equal(answer.ok, true);
  assert.equal(answer.radiusNm, 40);
  for (const row of answer.points) {
    const truth = distanceNm({ lat: KSEA.lat, lon: KSEA.lon }, row);
    assert.ok(row.distanceNm <= 40.0001, `${row.id} came back at ${row.distanceNm} NM`);
    assert.ok(Math.abs(truth - row.distanceNm) < 0.01, 'the reported distance is the geodesic one');
  }
  assert.ok(answer.points.some(row => row.id === 'OLM'), 'a navaid 30 NM away is inside the ring');
  assert.ok(!answer.points.some(row => row.id === 'KYKM'), 'an airport 90 NM away is outside it');
  assert.equal(answer.points[0].id, 'KSEA', 'nearest first');
});

test('the ring is the same real size at a high latitude', () => {
  const points = new NavPointIndex();
  // Two points 30 NM apart at 70 N, where a degree of longitude is a third of
  // what it is at the equator: a pixel- or cell-based radius would miss one.
  const north = { id: 'NRTH', name: 'North', lat: 70, lon: 20 };
  const east = { id: 'EAST', name: 'East', lat: 70, lon: 20 + 30 / (60 * Math.cos(70 * Math.PI / 180)) };
  points.setPublished([north, east], []);
  const answer = points.near(70, 20, 40);
  assert.equal(answer.count, 2, 'both points are inside a 40 NM ring');
  assert.ok(answer.points.some(row => row.id === 'EAST'));
  assert.ok(Math.abs(answer.points.find(row => row.id === 'EAST').distanceNm - 30) < 0.5);
});

test('kinds filter the answer without inventing anything', () => {
  const points = index();
  assert.equal(points.near(KSEA.lat, KSEA.lon, 40, { kinds: ['apt'] }).points.every(row => row.kind === 'apt'), true);
  assert.ok(points.near(KSEA.lat, KSEA.lon, 40, { kinds: ['nav'] }).points.some(row => row.id === 'OLM'));
  assert.equal(points.near(KSEA.lat, KSEA.lon, 40, { kinds: ['fix'] }).count, 0, 'no fix source loaded is an empty answer');
});

test('the simulator set is replaced, never accumulated across a pan', () => {
  const points = index();
  points.setSimulator([
    { id: 'CAVOB', name: 'CAVOB', kind: 'fix', lat: 47.4, lon: -122.3, source: 'X-Plane 12 CIFP' },
    { id: 'KSEA', name: 'KSEA', kind: 'apt', lat: 47.449889, lon: -122.311778, source: 'Simulator airport data' },
  ]);
  // The airport the published set already holds is not duplicated.
  assert.equal(points.near(47.449, -122.309, 40).points.filter(row => row.id === 'KSEA').length, 1);
  assert.equal(points.near(47.449, -122.309, 40).points.find(row => row.id === 'CAVOB').source, 'X-Plane 12 CIFP');

  points.setSimulator([{ id: 'SUNED', name: 'SUNED', kind: 'fix', lat: 47.2, lon: -122.4, source: 'X-Plane 12 CIFP' }]);
  const after = points.near(47.449, -122.309, 40).points.map(row => row.id);
  assert.ok(after.includes('SUNED'));
  assert.ok(!after.includes('CAVOB'), "the previous place's fix is gone");
});

test('a click resolves to the real record, and offers the choice when several are close', () => {
  const points = new NavPointIndex();
  points.setPublished([KSEA], [KOLM]);
  points.setSimulator([
    { id: 'DODVE', kind: 'fix', lat: 47.44, lon: -122.31, source: 'X-Plane 12 CIFP' },
    { id: 'RYBKA', kind: 'fix', lat: 47.4375, lon: -122.311, source: 'X-Plane 12 CIFP' },
  ]);

  const single = points.pick(46.9716, -122.902, 5);
  assert.equal(single.ok, true);
  assert.equal(single.point.id, 'OLM', 'the click names the real station');
  assert.equal(single.point.type, 'VORTAC');

  const crowded = points.pick(47.4385, -122.3105, 1);
  assert.equal(crowded.ok, true);
  assert.ok(crowded.options.length > 1, 'two records that close have to be chosen between');
  assert.ok(crowded.options.some(row => row.id === 'DODVE'));
  assert.ok(crowded.options.some(row => row.id === 'RYBKA'));
});

test('a click with no verified point within reach says so instead of inventing one', () => {
  const points = new NavPointIndex();
  points.setPublished([KSEA], []);
  const empty = points.pick(-60, 100, 5);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'nothing-nearby');
  assert.deepEqual(empty.options, []);
  assert.equal(empty.radiusNm, 5);

  // And with no data at all the answer still states its coverage rather than
  // returning a placeholder point.
  const bare = new NavPointIndex();
  const none = bare.near(47.449, -122.309, 40);
  assert.equal(none.count, 0);
  assert.equal(none.points.length, 0);
  assert.match(none.coverage.note, /No navigation data is loaded/);
});

test('bad input is refused, not guessed at', () => {
  const points = index();
  assert.equal(points.near(91, 0, 40).ok, false);
  assert.equal(points.near(47, -122, 0).ok, false);
  assert.equal(points.near(47, -122, MAX_RADIUS_NM + 500).radiusNm, MAX_RADIUS_NM, 'the cap is stated back');
  assert.equal(formatRadius(40), '40 NM');
  assert.equal(formatRadius(2.5), '2.5 NM');
  assert.equal(coverageText(null), 'No navigation data loaded.');
  assert.match(coverageText(points.coverage), /airports/);
});

test('a boundary of the grid at the antimeridian still finds its neighbours', () => {
  const points = new NavPointIndex();
  points.setPublished([
    { id: 'WEST', name: 'West', lat: 0, lon: 179.8 },
    { id: 'EAST', name: 'East', lat: 0, lon: -179.9 },
  ], []);
  const answer = points.near(0, 179.95, 40);
  assert.equal(answer.count, 2, 'both sides of the date line are in range');
  assert.ok(answer.points.every(row => row.distanceNm < 40));
});

test('a tapped position is named the way a pilot reads it, never as a generated ident', () => {
  assert.equal(coordinateIdent(47.449, -122.309), '4727N12219W');
  assert.equal(coordinateIdent(-33.94, 151.18), '3356S15111E');
  // Minute rounding carries into the degree instead of printing 60.
  assert.equal(coordinateIdent(47.9999, 8.0), '4800N0800E');
  assert.equal(coordinateIdent(91, 0), '', 'an impossible position has no name');
  // The shape is a coordinate, not something that reads like a published fix.
  assert.match(coordinateIdent(40.6413, -73.7781), /^\d{4}[NS]\d{4,5}[EW]$/);
  assert.doesNotMatch(coordinateIdent(40.6413, -73.7781), /^WP/);
});
