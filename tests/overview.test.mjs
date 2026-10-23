import test from 'node:test';
import assert from 'node:assert/strict';

import {
  timeText, timingStatus, overviewHeader, overviewAircraft, OVERVIEW_TABS, activeTab,
} from '../app/js/lib/overview.js';

const DASH = '\u2014';

test('overview: a missing time is a dash, never a made-up value', () => {
  assert.equal(timeText(null), DASH);
  assert.equal(timeText(0), DASH);
  assert.equal(timeText('nope'), DASH);
});

test('overview: a timestamp in seconds and in ms both format as UTC', () => {
  // 2026-10-22 14:05 UTC
  const seconds = Date.UTC(2026, 9, 22, 14, 5) / 1000;
  assert.equal(timeText(seconds), '14:05Z');
  assert.equal(timeText(seconds * 1000), '14:05Z');
});

test('overview: delay and early are computed only when both times exist', () => {
  const base = Date.UTC(2026, 9, 22, 14, 0) / 1000;
  assert.equal(timingStatus(base, null), null);
  assert.equal(timingStatus(null, base), null);
  assert.deepEqual(timingStatus(base, base).key, 'on-time');
  assert.equal(timingStatus(base, base + 600).key, 'delayed');
  assert.equal(timingStatus(base, base + 600).label, 'Delayed 10 min');
  assert.equal(timingStatus(base, base - 300).key, 'early');
  assert.equal(timingStatus(base, base - 300).label, 'Early 5 min');
});

test('overview: a header with no plan shows dashes and no timing claim', () => {
  const header = overviewHeader({});
  assert.equal(header.callsign, DASH);
  assert.equal(header.dep, DASH);
  assert.equal(header.arr, DASH);
  assert.equal(header.departure.status, null);
  assert.equal(header.arrival.status, null);
  assert.equal(header.timeZone, 'UTC');
});

test('overview: the header uses the plan endpoints and the route as a fallback', () => {
  const fromPlan = overviewHeader({ ofp: { origin: 'KSFO', destination: 'KLAX', general: { icao_airline: 'UAL', flight_number: '123' } } });
  assert.equal(fromPlan.dep, 'KSFO');
  assert.equal(fromPlan.arr, 'KLAX');
  assert.equal(fromPlan.callsign, 'UAL123');
  assert.equal(fromPlan.operator, 'UAL');

  const fromRoute = overviewHeader({ route: [{ id: 'EGLL' }, { id: 'LFPG' }] });
  assert.equal(fromRoute.dep, 'EGLL');
  assert.equal(fromRoute.arr, 'LFPG');
});

test('overview: the header reports delay from a real scheduled and estimated pair', () => {
  const sched = Date.UTC(2026, 9, 22, 14, 0) / 1000;
  const header = overviewHeader({ ofp: { origin: 'KSFO', times: { scheduledOut: sched, estimatedOut: sched + 900 } } });
  assert.equal(header.departure.status.key, 'delayed');
  assert.equal(header.departure.scheduled, '14:00Z');
  assert.equal(header.departure.estimated, '14:15Z');
  assert.equal(header.arrival.status, null);
});

test('overview: the alternate comes from the plan, or is shown as absent', () => {
  const withAlt = overviewHeader({ ofp: { origin: 'KSFO', destination: 'KLAX', alternate: { icao: 'KBUR', name: 'Burbank' } } });
  assert.deepEqual(withAlt.alternate, { icao: 'KBUR', name: 'Burbank' });
  const without = overviewHeader({ ofp: { origin: 'KSFO', destination: 'KLAX', alternate: { icao: null } } });
  assert.equal(without.alternate, null);
});

test('overview: the full flight summary renders every tab without a field clash', async () => {
  const { flightSummaryHtml } = await import('../app/js/flightpanel.js');
  const route = [{ id: 'KSFO', lat: 37.6188, lon: -122.3754, k: 'apt' }, { id: 'KLAX', lat: 33.9425, lon: -118.4081, k: 'apt' }];
  for (const tab of ['overview', 'route', 'data', 'weather']) {
    const html = flightSummaryHtml({ route, ofp: null, cruiseKts: 450, weightUnit: 'kg', metars: {}, position: null, tab });
    assert.match(html, /ov-tab/, `${tab}: the tab bar renders`);
    assert.match(html, new RegExp(`data-ov-tab="${tab}"`), `${tab}: its own tab is present`);
  }
  const overview = flightSummaryHtml({ route, ofp: null, cruiseKts: 450, weightUnit: 'kg', metars: {}, position: null, tab: 'overview' });
  assert.match(overview, /ov-head/, 'the overview tab shows the header');
});

test('overview: tabs are fixed and an unknown tab falls back to Overview', () => {
  assert.deepEqual(OVERVIEW_TABS.map(t => t.key), ['overview', 'route', 'data', 'weather']);
  assert.equal(activeTab('weather'), 'weather');
  assert.equal(activeTab('map'), 'overview');
  assert.equal(activeTab(undefined), 'overview');
});

test('overview: aircraft block uses identified type and shows dashes for unreported fields', () => {
  const block = overviewAircraft({ simbrief: 'A321' });
  assert.equal(block.name, 'Airbus A321');
  assert.equal(block.known, true);
  assert.equal(block.registration, DASH);
  assert.equal(block.livery, null, 'a livery is shown only when reported');

  const none = overviewAircraft({});
  assert.equal(none.name, DASH);
  assert.equal(none.image, null);
});
