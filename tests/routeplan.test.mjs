import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceNm, bearingDeg } from '../app/js/lib/geo.js';
import {
  legDetails, magneticCourse, normalizeVariation, routeProgress, setWaypointPosition,
  normalizeWaypoint,
} from '../app/js/lib/planner.js';

const KSFO = { id: 'KSFO', lat: 37.6188, lon: -122.3754, kind: 'apt' };
const KLAX = { id: 'KLAX', lat: 33.9425, lon: -118.4081, kind: 'apt' };
const KLAS = { id: 'KLAS', lat: 36.0801, lon: -115.1522, kind: 'apt' };

test('legs: distance and true course come from the coordinates', () => {
  const legs = legDetails([KSFO, KLAX], { cruiseKts: 450 });
  assert.equal(legs.length, 1);
  const leg = legs[0];
  assert.ok(Math.abs(leg.distanceNm - distanceNm(KSFO, KLAX)) < 1e-9);
  assert.ok(Math.abs(leg.trueCourse - bearingDeg(KSFO, KLAX)) < 1e-9);
  assert.ok(leg.distanceNm > 290 && leg.distanceNm < 300);
  assert.ok(leg.trueCourse > 132 && leg.trueCourse < 142);
  assert.equal(leg.index, 1);
  assert.equal(leg.from.id, 'KSFO');
  assert.equal(leg.to.id, 'KLAX');
});

test('legs: magnetic course is null when no variation was supplied', () => {
  const [leg] = legDetails([KSFO, KLAX], { cruiseKts: 450 });
  assert.equal(leg.magneticCourse, null);
  assert.equal(leg.variationDeg, null);
  assert.equal(leg.variationSource, null);
});

test('legs: magnetic course subtracts east variation and keeps true course', () => {
  assert.equal(magneticCourse(90, 12), 78);
  assert.equal(magneticCourse(10, 15), 355);
  assert.equal(magneticCourse(350, -8), 358);
  assert.equal(magneticCourse(90, null), null);
  assert.equal(magneticCourse(90, 200), null);

  const from = { ...KSFO, magVar: 13 };
  const to = { ...KLAX, magVar: 11 };
  const [leg] = legDetails([from, to], { cruiseKts: 450 });
  assert.equal(leg.variationDeg, 12);
  assert.equal(leg.variationSource, 'mean of both waypoints');
  assert.ok(Math.abs(leg.magneticCourse - ((leg.trueCourse - 12 + 360) % 360)) < 1e-9);
  assert.ok(Math.abs(leg.trueCourse - bearingDeg(KSFO, KLAX)) < 1e-9);
});

test('legs: ETE uses the planned speed and the current ground speed when given', () => {
  const route = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }];
  const [planned] = legDetails(route, { cruiseKts: 120 });
  assert.equal(planned.groundspeedSource, 'planned cruise speed');
  assert.equal(planned.eteMinutes, 30); // 60 nm at 120 kt

  const [live] = legDetails(route, { cruiseKts: 120, groundSpeedKts: 240 });
  assert.equal(live.groundspeedSource, 'current ground speed');
  assert.equal(live.eteMinutes, 15);
  assert.equal(live.groundspeedKts, 240);
});

test('legs: a zero-length leg reports no time instead of dividing by zero', () => {
  const [leg] = legDetails([KSFO, { ...KSFO }], { cruiseKts: 450 });
  assert.equal(leg.eteMinutes, 0);
  assert.ok(Number.isFinite(leg.trueCourse));
});

test('variation: only a plausible value is kept', () => {
  assert.equal(normalizeVariation(12.5), 12.5);
  assert.equal(normalizeVariation(-18), -18);
  assert.equal(normalizeVariation(null), null);
  assert.equal(normalizeVariation(''), null);
  assert.equal(normalizeVariation('abc'), null);
  assert.equal(normalizeVariation(181), null);
  assert.equal(normalizeWaypoint({ ...KSFO, magVar: 8 }).magVar, 8);
  assert.equal(normalizeWaypoint(KSFO).magVar, null);
});

test('progress: a position on a leg gives flown and remaining distance', () => {
  const route = [KSFO, KLAX, KLAS];
  const midpoint = {
    lat: (KLAX.lat + KLAS.lat) / 2,
    lon: (KLAX.lon + KLAS.lon) / 2,
  };
  const progress = routeProgress(route, midpoint);
  assert.equal(progress.legIndex, 2);
  assert.equal(progress.onRoute, true);
  const first = distanceNm(KSFO, KLAX);
  const second = distanceNm(KLAX, KLAS);
  assert.ok(Math.abs(progress.totalNm - (first + second)) < 1e-6);
  assert.ok(Math.abs(progress.flownNm - (first + second / 2)) < 0.5);
  assert.ok(Math.abs(progress.remainingNm - second / 2) < 0.5);
});

test('progress: a position far from the route is flagged, not snapped', () => {
  const progress = routeProgress([KSFO, KLAX], { lat: 51.47, lon: -0.45 });
  assert.equal(progress.onRoute, false);
  assert.ok(progress.offTrackNm > 1000);
});

test('progress: missing or invalid input returns null', () => {
  assert.equal(routeProgress([KSFO], KSFO), null);
  assert.equal(routeProgress([KSFO, KLAX], { lat: 999, lon: 0 }), null);
  assert.equal(routeProgress([KSFO, KLAX], null), null);
});

test('drag: moving one waypoint keeps identifiers and the rest of the route', () => {
  const route = [KSFO, KLAX, KLAS];
  const next = setWaypointPosition(route, 1, { lat: 34.5, lon: -117.2 });
  assert.equal(next.length, 3);
  assert.equal(next[0].id, 'KSFO');
  assert.equal(next[2].id, 'KLAS');
  assert.equal(next[1].id, 'KLAX');
  assert.equal(next[1].lat, 34.5);
  assert.equal(next[1].lon, -117.2);
  // The original array is not mutated.
  assert.equal(route[1].lat, 33.9425);
});

test('drag: an invalid position or index is ignored', () => {
  const route = [KSFO, KLAX];
  assert.deepEqual(setWaypointPosition(route, 0, { lat: 200, lon: 0 }), route);
  assert.deepEqual(setWaypointPosition(route, 9, { lat: 10, lon: 10 }), route);
  assert.deepEqual(setWaypointPosition(route, 0, null), route);
});
