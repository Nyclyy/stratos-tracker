import test from 'node:test';
import assert from 'node:assert/strict';

import {
  altitudeLabel, computeVerticalProfile, DEFAULT_CLIMB_FPM, DEFAULT_CLIMB_GS_KT,
  DEFAULT_DESCENT_FT_NM, positionAlong, routeDistances,
} from '../app/js/lib/profile.js';

// A west-to-east route long enough for a jet profile: 5 degrees of longitude
// at 40°N is about 230 nm, then a descent to the destination.
const PLANNED = [
  { id: 'KDEP', lat: 40, lon: -120, elev: 100, k: 'apt' },
  { id: 'FIX1', lat: 40, lon: -118, elev: 12000 },
  { id: 'FIX2', lat: 40, lon: -116, elev: 24000 },
  { id: 'CRZ1', lat: 40, lon: -114, elev: 35000 },
  { id: 'CRZ2', lat: 40, lon: -112, elev: 35000 },
  { id: 'FIX3', lat: 40, lon: -110, elev: 12000 },
  { id: 'KARR', lat: 40, lon: -108, elev: 60, k: 'apt' },
];

function copy(route) { return route.map(point => ({ ...point })); }

test('the planned altitudes decide where the climb ends and the descent starts', () => {
  const before = copy(PLANNED);
  const profile = computeVerticalProfile({ route: PLANNED });
  assert.equal(profile.ok, true);
  assert.equal(profile.cruiseFt, 35000);
  assert.equal(profile.toc.source, 'plan');
  assert.equal(profile.tod.source, 'plan');

  const { cumulative } = routeDistances(PLANNED);
  // TOC lies on the leg that reaches cruise, and TOD on the last leg at cruise.
  assert.ok(profile.toc.nm >= cumulative[2] && profile.toc.nm <= cumulative[3], 'TOC is between FIX2 and CRZ1');
  assert.ok(profile.tod.nm >= cumulative[4] && profile.tod.nm <= cumulative[5], 'TOD is between CRZ2 and FIX3');
  assert.ok(profile.toc.nm < profile.tod.nm, 'climb ends before the descent begins');
  assert.equal(profile.toc.lat, 40);
  assert.ok(profile.toc.lon > -116 && profile.toc.lon <= -114, 'the marker is interpolated along the leg');
  assert.deepEqual(PLANNED, before, 'the route is never modified');
});

test('a plan with no altitudes gets an honest gradient estimate', () => {
  const flat = PLANNED.map(point => ({ ...point, elev: point.k === 'apt' ? 100 : 0 }));
  const profile = computeVerticalProfile({ route: flat, cruiseFt: 35000 });
  assert.equal(profile.ok, true);
  assert.equal(profile.toc.source, 'estimate');
  assert.equal(profile.tod.source, 'estimate');
  const { totalNm } = routeDistances(flat);
  const gradient = (DEFAULT_CLIMB_FPM / DEFAULT_CLIMB_GS_KT) * 60;
  assert.ok(Math.abs(profile.toc.nm - (35000 - 100) / gradient) < 0.5, 'TOC follows the climb gradient');
  assert.ok(Math.abs(profile.tod.nm - (totalNm - (35000 - 60) / DEFAULT_DESCENT_FT_NM)) < 0.5, 'TOD follows the descent gradient');
  assert.ok(profile.notes.some(note => /estimated/i.test(note)), 'the estimate says so');
});

test('a higher cruise moves the climb later and the descent earlier', () => {
  // Compare like with like: both levels are ones the plan's own altitudes
  // describe, so the same rule places both markers.
  const low = computeVerticalProfile({ route: PLANNED, cruiseFt: 30000 });
  const high = computeVerticalProfile({ route: PLANNED, cruiseFt: 35000 });
  assert.equal(low.ok && high.ok, true);
  assert.ok(high.toc.nm >= low.toc.nm, 'climbing higher takes longer');
  assert.ok(high.tod.nm <= low.tod.nm, 'descending from higher starts earlier');

  // With no planned altitudes the gradient places both, and the same holds.
  const flat = PLANNED.map(point => ({ ...point, elev: point.k === 'apt' ? 0 : 0 }));
  const lowEstimate = computeVerticalProfile({ route: flat, cruiseFt: 30000 });
  const highEstimate = computeVerticalProfile({ route: flat, cruiseFt: 35000 });
  assert.ok(highEstimate.toc.nm > lowEstimate.toc.nm);
  assert.ok(highEstimate.tod.nm < lowEstimate.tod.nm);
});

test('a measured descent gradient moves the descent, not the climb', () => {
  const shallow = computeVerticalProfile({ route: PLANNED, descentFtPerNm: 150 });
  const steep = computeVerticalProfile({ route: PLANNED, descentFtPerNm: 350 });
  assert.equal(shallow.ok && steep.ok, true);
  assert.ok(shallow.tod.nm < steep.tod.nm, 'a shallow descent starts further out');
  assert.equal(shallow.toc.nm, steep.toc.nm, 'the climb is unaffected');
});

test('the same plan always produces the same markers', () => {
  const first = computeVerticalProfile({ route: PLANNED });
  const second = computeVerticalProfile({ route: copy(PLANNED) });
  assert.deepEqual(second.toc, first.toc);
  assert.deepEqual(second.tod, first.tod);
});

test('markers stay inside the route and never collapse onto each other', () => {
  const profile = computeVerticalProfile({ route: PLANNED, descentFtPerNm: 500 });
  assert.equal(profile.ok, true);
  assert.ok(profile.toc.nm > 0 && profile.tod.nm < profile.totalNm);
  assert.ok(profile.tod.nm - profile.toc.nm > 0);
});

test('a plan without a cruising level says why it has no profile', () => {
  const short = PLANNED.slice(0, 2);
  assert.equal(computeVerticalProfile({ route: short }).ok, false);
  const low = computeVerticalProfile({ route: PLANNED.map(p => ({ ...p, elev: 3000 })) });
  assert.equal(low.ok, false);
  assert.match(low.reason, /10,000 ft|room|outside/);
});

test('position along the route is interpolated, not snapped to a fix', () => {
  const { cumulative } = routeDistances(PLANNED);
  const middle = positionAlong(PLANNED, (cumulative[1] + cumulative[2]) / 2);
  assert.equal(middle.legIndex, 1);
  assert.ok(Math.abs(middle.fraction - 0.5) < 0.01);
  assert.ok(middle.lon > -118 && middle.lon < -116);
  const start = positionAlong(PLANNED, 0);
  assert.equal(start.fraction, 0);
  const end = positionAlong(PLANNED, 1e6);
  assert.equal(end.legIndex, PLANNED.length - 2);
  assert.equal(end.fraction, 1);
  assert.equal(positionAlong([PLANNED[0]], 10), null);
});

test('a plan figure and an estimate read differently on the chart', () => {
  assert.equal(altitudeLabel(35000, 'plan'), 'FL350');
  assert.equal(altitudeLabel(35000, 'estimate'), '≈FL350');
  assert.equal(altitudeLabel(8000, 'plan'), '8000 ft');
  assert.equal(altitudeLabel(null, 'plan'), '');
});
