import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchSimbriefPlan, simbriefQuery, validateSimbriefId } from '../app/js/lib/simbrief.js';

// The payload shape the SimBrief json=v2 endpoint returns, trimmed to the fields
// the planner and the tracking card read.
function payload() {
  return {
    general: { icao_airline: 'ASA', flight_number: '123', cruise_altitude: '35000', cruise_tas: '452', route: 'SUMMA2 SUMMA J523 BLUIT HRMNS3' },
    origin: { icao_code: 'KSEA', name: 'Seattle-Tacoma Intl', plan_rwy: '16L', sid_ident: 'SUMMA2', sid_trans: '' },
    destination: { icao_code: 'KPDX', name: 'Portland Intl', plan_rwy: '28R', star_ident: 'HRMNS3', star_trans: '', approach_ident: 'ILS28R', approach_rwy: '28R' },
    aircraft: { icaocode: 'B738', name: 'Boeing 737-800', reg: 'N8312C' },
    times: { sched_out: '1792789000', sched_in: '1792795000', est_time_enroute: '4200' },
    navlog: {
      fix: [
        { ident: 'KSEA', name: 'KSEA', pos_lat: '47.449', pos_long: '-122.309', altitude_feet: '433', type: 'apt', is_sid_star: '1', stage: 'CLB' },
        { ident: 'SUMMA', name: 'SUMMA', pos_lat: '47.2583', pos_long: '-122.4125', altitude_feet: '9000', type: 'wpt', is_sid_star: '1', stage: 'CLB' },
        { ident: 'BLUIT', name: 'BLUIT', pos_lat: '46.5', pos_long: '-121.9', altitude_feet: '35000', type: 'wpt', is_sid_star: '0', via_airway: 'J523' },
        { ident: 'KPDX', name: 'KPDX', pos_lat: '45.5898', pos_long: '-122.5951', altitude_feet: '31', type: 'apt' },
      ],
    },
  };
}

test('simbrief: the plan carries the procedures and runways the card shows', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => payload() };
  };
  try {
    const plan = await fetchSimbriefPlan('123456');
    assert.equal(plan.origin, 'KSEA');
    assert.equal(plan.destination, 'KPDX');
    assert.equal(plan.fixes.length, 4);
    assert.ok(plan.ofp, 'the normalised OFP is returned so the Flight Deck can store it');
    assert.equal(plan.ofp.origin.sid, 'SUMMA2');
    assert.equal(plan.ofp.origin.rwy, '16L');
    assert.equal(plan.ofp.destination.star, 'HRMNS3');
    assert.equal(plan.ofp.destination.rwy, '28R');
    assert.equal(plan.ofp.flight.cruiseFt, 35000);
    assert.equal(plan.ofp.aircraft.reg, 'N8312C');
    assert.match(calls[0], /userid=123456/, 'a numeric id is asked for as a Pilot ID');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('simbrief: a username query and id validation stay strict', () => {
  assert.equal(simbriefQuery('pilot.name'), 'username=pilot.name');
  assert.equal(validateSimbriefId('abc def').ok, false);
  assert.equal(validateSimbriefId('123456').kind, 'pilot');
});

test('simbrief: a plan with no fixes is an error, not an empty route', async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    // The first request is the JSON plan; the XML fallback is refused so the
    // error is the missing fixes, not a parser difference in this runtime.
    if (call === 1) return { ok: true, status: 200, json: async () => ({ general: {}, navlog: { fix: [] } }) };
    return { ok: false, status: 400 };
  };
  try {
    await assert.rejects(() => fetchSimbriefPlan('123456'), /No waypoints found/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
