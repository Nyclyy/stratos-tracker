import test from 'node:test';
import assert from 'node:assert/strict';

import { routeProgress } from '../app/js/lib/planner.js';
import { buildSummary } from '../app/js/lib/flightsummary.js';

const route = [
  { id: 'KSFO', lat: 37.6188, lon: -122.3754 },
  { id: 'KLAX', lat: 33.9425, lon: -118.4081 },
];

test('live progress: a position on the leg splits the route into flown and remaining', () => {
  const midpoint = { lat: (37.6188 + 33.9425) / 2, lon: (-122.3754 + -118.4081) / 2 };
  const progress = routeProgress(route, midpoint);
  assert.ok(progress, 'a usable position gives progress');
  assert.ok(progress.flownNm > 100 && progress.flownNm < 200, `flown ${progress.flownNm}`);
  assert.ok(Math.abs(progress.flownNm + progress.remainingNm - progress.totalNm) < 0.5);
  assert.equal(progress.onRoute, true);
  assert.ok(progress.offTrackNm < 8);
});

test('live progress: a position far from the route is flagged off route, not forced onto it', () => {
  const far = { lat: 45.0, lon: -100.0 };
  const progress = routeProgress(route, far);
  assert.ok(progress);
  assert.equal(progress.onRoute, false);
  assert.ok(progress.offTrackNm > 100);
});

test('live progress: no position or an invalid one gives no progress at all', () => {
  assert.equal(routeProgress(route, null), null);
  assert.equal(routeProgress(route, { lat: 200, lon: 0 }), null);
  assert.equal(routeProgress([route[0]], route[0]), null, 'a single point is not a route');
});

test('live progress: the summary reports progress only when a live position is supplied', () => {
  const withoutBridge = buildSummary({ route, ofp: null, cruiseKts: 450, weightUnit: 'kg', metars: {}, position: null, now: Date.now() });
  assert.equal(withoutBridge.route.progress, null, 'no bridge, no invented progress');

  const midpoint = { lat: (37.6188 + 33.9425) / 2, lon: (-122.3754 + -118.4081) / 2 };
  const withBridge = buildSummary({ route, ofp: null, cruiseKts: 450, weightUnit: 'kg', metars: {}, position: midpoint, now: Date.now() });
  assert.ok(withBridge.route.progress, 'a live position gives progress');
  assert.ok(withBridge.route.progress.remainingNm > 0);
});
