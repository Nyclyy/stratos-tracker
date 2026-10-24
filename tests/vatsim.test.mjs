import test from 'node:test';
import assert from 'node:assert/strict';

import {
  facilityOf, airportOf, parseControllers, airportCoverage, summarize, parsePilots,
} from '../app/js/lib/vatsim.js';

const feed = {
  controllers: [
    { callsign: 'EGLL_TWR', cid: 1, name: 'A', frequency: '118.500', text_atis: '' },
    { callsign: 'EGLL_APP', cid: 2, name: 'B', frequency: '119.725', text_atis: '' },
    { callsign: 'LFMM_GND', cid: 3, name: 'C', frequency: '121.775', text_atis: '' },
    { callsign: 'LON_CTR', cid: 4, name: 'D', frequency: '132.600', text_atis: '' },
    { callsign: 'ZNY_CTR', cid: 5, name: 'E', frequency: '134.200', text_atis: '' },
    { callsign: 'EGKK_TWR', cid: 6, name: 'F', frequency: '118.000', text_atis: '' },
    { callsign: 'JUNK', cid: 7, name: 'G', frequency: '', text_atis: '' },
    null,
  ],
};

test('vatsim: facility comes from the callsign suffix only', () => {
  assert.equal(facilityOf('EGLL_TWR').kind, 'tower');
  assert.equal(facilityOf('LFMM_APP').kind, 'approach');
  assert.equal(facilityOf('LON_CTR').kind, 'center');
  assert.equal(facilityOf('EGLL_DEP').kind, 'departure');
  assert.equal(facilityOf('EGLL_DEL').kind, 'delivery');
  assert.equal(facilityOf('EGLL_RMP').kind, 'apron');
  assert.equal(facilityOf('EGLL_ATIS').kind, 'atis');
  assert.equal(facilityOf('EGLL_XXX'), null);
  assert.equal(facilityOf('JUNK'), null);
});

test('vatsim: a callsign names an airport only when its prefix is a four-letter ICAO', () => {
  assert.equal(airportOf('EGLL_TWR'), 'EGLL');
  assert.equal(airportOf('LON_CTR'), null, 'a center prefix is not an airport');
  assert.equal(airportOf('ZNY_CTR'), null);
  assert.equal(airportOf('EGL_TWR'), null);
});

test('vatsim: unknown or malformed entries are dropped, not guessed', () => {
  const controllers = parseControllers(feed);
  assert.equal(controllers.length, 6);
  assert.ok(!controllers.some(c => c.callsign === 'JUNK'));
  assert.deepEqual(parseControllers(null), []);
  assert.deepEqual(parseControllers({ controllers: 'nope' }), []);
});

test('vatsim: a position at its own airport is a confirmed match, highest level first', () => {
  const controllers = parseControllers(feed);
  const coverage = airportCoverage(controllers, 'egll');
  assert.equal(coverage.icao, 'EGLL');
  assert.deepEqual(coverage.confirmed.map(c => c.facility.kind), ['approach', 'tower']);
  assert.ok(coverage.confirmed.every(c => c.source === 'confirmed'));
  assert.deepEqual(coverage.inferred, []);
  assert.equal(coverage.hasCoverage, true);
});

test('vatsim: with the airport offline, online centers are NOT listed for it', () => {
  const controllers = parseControllers(feed);
  const offline = airportCoverage(controllers.filter(c => c.airport !== 'EGLL'), 'EGLL');
  assert.deepEqual(offline.confirmed, []);
  assert.deepEqual(offline.inferred, [], 'centers are not matched to an airport without sector data');
  assert.equal(offline.hasCoverage, false);
});

test('vatsim: an airport with nothing online reports no coverage instead of inventing it', () => {
  const controllers = parseControllers({ controllers: [{ callsign: 'EGLL_TWR' }] });
  const coverage = airportCoverage(controllers, 'KJFK');
  assert.equal(coverage.hasCoverage, false);
  assert.deepEqual(coverage.confirmed, []);
  assert.deepEqual(coverage.inferred, []);
});

test('vatsim: pilots need a valid position and a callsign; missing speed or altitude stay null', () => {
  const pilots = parsePilots({
    pilots: [
      { callsign: 'baw123', latitude: 51.47, longitude: -0.45, altitude: 3000, groundspeed: 180, heading: 270, flight_plan: { aircraft_short: 'A320', departure: 'egll', arrival: 'lfpg' } },
      { callsign: 'NOPOS', latitude: 'x', longitude: 10 },
      { callsign: '', latitude: 10, longitude: 10 },
      { callsign: 'OUTOFRANGE', latitude: 95, longitude: 10 },
      { callsign: 'SPARSE', latitude: 10, longitude: 10 },
      null,
    ],
  });
  assert.equal(pilots.length, 2);
  assert.equal(pilots[0].id, 'BAW123');
  assert.equal(pilots[0].source, 'vatsim');
  assert.equal(pilots[0].dep, 'EGLL');
  assert.equal(pilots[1].alt, null, 'a missing altitude is not invented');
  assert.equal(pilots[1].gs, null);
  assert.deepEqual(parsePilots(null), []);
});

test('vatsim: a pilot\'s filed cruise level and route are kept, and nothing is invented', () => {
  const [withPlan, withoutPlan] = parsePilots({
    pilots: [
      { callsign: 'ASA123', latitude: 47, longitude: -122, altitude: 35000, groundspeed: 400, heading: 180, flight_plan: { aircraft_short: 'B738', departure: 'KSEA', arrival: 'KPDX', altitude: '36000', route: 'SUMMA2 SUMMA J523 BLUIT' } },
      { callsign: 'N123AB', latitude: 47, longitude: -122, altitude: 4000, groundspeed: 120, heading: 90 },
    ],
  });
  assert.equal(withPlan.cruiseFt, 36000);
  assert.equal(withPlan.route, 'SUMMA2 SUMMA J523 BLUIT');
  assert.equal(withoutPlan.cruiseFt, null, 'no flight plan means no cruise level');
  assert.equal(withoutPlan.route, null);
  assert.equal(withoutPlan.dep, null);
});

test('vatsim: summary counts positions by facility', () => {
  const summary = summarize(parseControllers(feed));
  assert.equal(summary.total, 6);
  assert.equal(summary.byKind.tower, 2);
  assert.equal(summary.byKind.center, 2);
});
