import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  NO_DEPARTURE, addPoint, createPlan, setDeparture, setArrival, setAlternate,
  removePoint, movePoint, dedupePoints, validatePlan, stepState, routeSummary,
  procedureRoute, applyProcedure, clearProcedure, procedureTransitions,
  suggestTransitions, fuelEstimate, burnFromOfp, alternateCandidates,
  weatherFreshness, storedRoute, planFromStored, mapRoute, planDisplayName,
  runwayFromTransitionId,
} from '../app/js/lib/routeplan.js';

const CYUL = { id: 'CYUL', name: 'Montréal-Trudeau', lat: 45.47, lon: -73.741, elev: 118 };
const KEWR = { id: 'KEWR', name: 'Newark Liberty', lat: 40.692, lon: -74.169, elev: 18 };
const KJFK = { id: 'KJFK', name: 'John F Kennedy', lat: 40.64, lon: -73.779, elev: 13 };

function basePlan() {
  let plan = setDeparture(createPlan(), CYUL).plan;
  plan = addPoint(plan, { id: 'FLOSI', name: 'Flosi', lat: 44.1, lon: -73.4, kind: 'fix' }).plan;
  plan = setArrival(plan, KEWR).plan;
  return plan;
}

/* ── the departure rule ──────────────────────────────────────────────── */

test('a waypoint cannot enter a plan that has no departure', () => {
  const empty = createPlan();
  const blocked = addPoint(empty, { id: 'ABC', lat: 45, lon: -73 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, 'no-departure');
  assert.equal(blocked.message, NO_DEPARTURE, 'the sentence the pilot is shown');
  assert.equal(NO_DEPARTURE, 'Please select a departure airport before adding waypoints to your flight plan.');

  const arrival = setArrival(empty, KEWR);
  assert.equal(arrival.ok, false);
  assert.equal(arrival.blocked, 'no-departure', 'the arrival cannot be set first either');

  // The guard is in the model, so every entry point — search result, chart tap
  // or procedure insert — goes through the same rule.
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  assert.match(src, /RP\.addPoint\(plan,/, 'the page adds points through the model');
  assert.match(src, /RP\.NO_DEPARTURE/, 'and shows the model’s own sentence');
});

test('the plan is one ordered list whose ends are the airports', () => {
  const plan = basePlan();
  assert.deepEqual(plan.points.map(point => point.id), ['CYUL', 'FLOSI', 'KEWR']);
  assert.equal(plan.origin.id, 'CYUL');
  assert.equal(plan.destination.id, 'KEWR');

  const rows = routeSummary(plan).rows;
  assert.equal(rows[0].role, 'departure');
  assert.equal(rows[rows.length - 1].role, 'arrival');
  assert.ok(rows[1].legNm > 0);
  assert.ok(rows[1].legTrack > 0 && rows[1].legTrack < 360, 'the leg carries its initial track');
  assert.equal(rows[1].cumNm, rows[1].legNm, 'the first leg starts at the departure');

  // A new point lands before the arrival, never after it.
  const withMore = addPoint(plan, { id: 'HABBS', lat: 43, lon: -73.1, kind: 'fix' }).plan;
  assert.deepEqual(withMore.points.map(point => point.id), ['CYUL', 'FLOSI', 'HABBS', 'KEWR']);

  const moved = movePoint(withMore, 1, 2);
  assert.deepEqual(moved.points.map(point => point.id), ['CYUL', 'HABBS', 'FLOSI', 'KEWR']);
  const removed = removePoint(moved, 2);
  assert.deepEqual(removed.points.map(point => point.id), ['CYUL', 'HABBS', 'KEWR']);
});

test('the route summary carries the flight-time estimate, not a placeholder', () => {
  const fresh = routeSummary(createPlan());
  assert.equal(fresh.estimated, false, 'one point is not a route');
  assert.equal(fresh.eteMinutes, 0);

  const summary = routeSummary(basePlan());
  assert.equal(summary.estimated, true);
  // 300-odd nm at 450 kt is inside the hour once climb and descent are counted.
  assert.ok(summary.eteMinutes > 30 && summary.eteMinutes < 70, String(summary.eteMinutes));
});

test('the same point is never stacked twice, and the endpoint survives a change', () => {
  let plan = setDeparture(createPlan(), CYUL).plan;
  plan = addPoint(plan, { id: 'FLOSI', lat: 44.1, lon: -73.4 }).plan;
  plan = addPoint(plan, { id: 'FLOSI', lat: 44.1, lon: -73.4 }).plan;
  assert.deepEqual(plan.points.map(point => point.id), ['CYUL', 'FLOSI']);
  assert.equal(dedupePoints([{ id: 'A', lat: 1, lon: 1 }, { id: 'A', lat: 1, lon: 1 }]).length, 1);

  const movedDeparture = setDeparture(plan, { id: 'CYYZ', name: 'Toronto', lat: 43.677, lon: -79.631 }).plan;
  assert.deepEqual(movedDeparture.points.map(point => point.id), ['CYYZ', 'FLOSI'], 'the route in between is kept');
});

test('a route adopted from another flight is dropped with its departure', () => {
  // The Flight Deck left a CYUL → EPWA route in the shared store. The pilot
  // builds a fresh plan from KSEA, and the Athens-area fixes of that other
  // flight must not survive: joining them to Seattle reported ~11,000 nm.
  let plan = setDeparture(createPlan(), { id: 'CYUL', name: 'Montréal', lat: 45.47, lon: -73.74 }).plan;
  plan = addPoint(plan, { id: 'IPKES', lat: 37.9, lon: 23.7 }).plan;
  plan = setArrival(plan, { id: 'EPWA', name: 'Warsaw', lat: 52.17, lon: 20.97 }).plan;
  assert.ok(validatePlan(plan).totalNm > 4000);

  const replaced = setDeparture(plan, { id: 'KSEA', name: 'Seattle', lat: 47.449, lon: -122.309 }, { keepRoute: false });
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.plan.points.map(point => point.id), ['KSEA']);
  assert.equal(replaced.plan.destination, null, 'the old arrival left with the old route');
  assert.equal(replaced.plan.star, null);
  assert.equal(validatePlan(replaced.plan).canContinueToProcedures, false);
});

test('validation gates the steps and says what is missing', () => {
  const fresh = createPlan();
  const check = validatePlan(fresh);
  assert.equal(check.canBuildRoute, false);
  assert.equal(check.canContinueToProcedures, false);
  assert.equal(check.errors[0].code, 'no-departure');

  const departingOnly = setDeparture(fresh, CYUL).plan;
  assert.equal(validatePlan(departingOnly).errors[0].code, 'no-arrival');
  assert.equal(validatePlan(departingOnly).canContinueToProcedures, false);

  const full = basePlan();
  const done = validatePlan(full);
  assert.equal(done.errors.length, 0);
  assert.equal(done.canContinueToProcedures, true);
  assert.ok(done.totalNm > 200 && done.totalNm < 400);

  const steps = stepState(full);
  const routeStep = steps.find(entry => entry.id === 'route');
  const proceduresStep = steps.find(entry => entry.id === 'procedures');
  assert.equal(routeStep.available, true);
  assert.equal(routeStep.done, true);
  assert.equal(proceduresStep.available, true);
  assert.equal(proceduresStep.done, false, 'no procedure has been selected yet');
});

test('a step is only marked done when it has what it needs, not when it merely could', () => {
  const fuelStep = (plan, options) => stepState(plan, options).find(entry => entry.id === 'fuel');

  // The default plan says its flow would come from a SimBrief plan, but no
  // plan is loaded and the route does not exist yet: nothing to compute.
  assert.equal(fuelStep(createPlan()).done, false, 'nothing is finished on a fresh plan');
  assert.equal(fuelStep(basePlan()).done, false, 'a route alone does not finish the fuel page');

  // The builder resolves the flow from the loaded plan and hands it in.
  assert.equal(fuelStep(basePlan(), { burnPerHour: 2500 }).done, true);
  assert.equal(fuelStep(basePlan(), { burnPerHour: 0 }).done, false, 'a zero flow is not a flow');

  // A typed flow finishes it without any plan at all.
  const typed = { ...basePlan(), fuel: { ...createPlan().fuel, burnSource: 'entered', burnPerHour: 2600 } };
  assert.equal(fuelStep(typed).done, true);

  // Manual entry counts once something has actually been entered.
  const manualEmpty = { ...basePlan(), fuel: { ...createPlan().fuel, mode: 'manual', components: {} } };
  assert.equal(fuelStep(manualEmpty).done, false, 'an empty manual sheet is not a planned load');
  const manual = { ...basePlan(), fuel: { ...createPlan().fuel, mode: 'manual', components: { trip: 9000 } } };
  assert.equal(fuelStep(manual).done, true);
});

/* ── procedures ──────────────────────────────────────────────────────── */

const payload = {
  ok: true,
  airport: 'KSEA',
  source: 'X-Plane 12 CIFP',
  cycle: '2610',
  runways: { '16L': { lat: 47.463794, lon: -122.30775 }, '34R': { lat: 47.431172, lon: -122.308039 } },
  procedures: {
    sid: [{
      id: 'BANGR9',
      transitions: [
        { id: 'RW16L', runway: '16L', combined: false, complete: true, skipped: 0, points: [
          { id: 'CAVOB', lat: 47.396192, lon: -122.308347 },
          { id: 'RENBE', lat: 47.320364, lon: -122.311544 },
        ] },
        { id: 'ALL', runway: '', combined: false, complete: true, skipped: 0, points: [
          { id: 'RENBE', lat: 47.320364, lon: -122.311544 },
          { id: 'BANGR', lat: 47.643903, lon: -122.914914 },
        ] },
        { id: 'ARRIE', runway: '', combined: false, complete: false, skipped: 1, points: [
          { id: 'BANGR', lat: 47.643903, lon: -122.914914 },
          { id: 'ARRIE', lat: 47.879892, lon: -123.475833 },
        ] },
      ],
    }],
    star: [{
      id: 'CHINS5',
      transitions: [
        { id: 'RW16B', runway: '16', combined: true, complete: false, skipped: 1, points: [
          { id: 'RADDY', lat: 47.4, lon: -122.5 },
          { id: 'AUBRN', lat: 47.3, lon: -122.4 },
        ] },
        { id: 'PDT', runway: '', combined: false, complete: true, skipped: 0, points: [
          { id: 'CHINS', lat: 45.9, lon: -119.5 },
          { id: 'SUNED', lat: 46.4, lon: -120.4 },
        ] },
        { id: 'ALL', runway: '', combined: false, complete: true, skipped: 0, points: [
          { id: 'SUNED', lat: 46.4, lon: -120.4 },
          { id: 'KSEA', lat: 47.464722, lon: -122.308889 },
        ] },
      ],
    }],
    approach: [],
  },
};

test('a SID is flown runway, then common legs, then the en-route transition', () => {
  const route = procedureRoute(payload, { kind: 'sid', ident: 'BANGR9', runway: '16L' });
  assert.equal(route.ok, true);
  assert.deepEqual(route.points.map(point => point.id), ['CAVOB', 'RENBE', 'BANGR']);
  assert.deepEqual(route.roles.map(role => role.role), ['runway', 'common']);
  assert.equal(route.cycle, '2610');
  assert.equal(route.complete, true);

  const partial = procedureRoute(payload, { kind: 'sid', ident: 'BANGR9', runway: '16L', enrouteTransition: 'ARRIE' });
  assert.deepEqual(partial.points.map(point => point.id), ['CAVOB', 'RENBE', 'BANGR', 'ARRIE']);
  assert.equal(partial.complete, false, 'a leg the source could not place keeps the path marked partial');
  assert.equal(partial.skipped, 1);

  // No runway transition is published for 34R: the runway threshold is joined
  // to the common legs by one connector, and the route says so.
  const connector = procedureRoute(payload, { kind: 'sid', ident: 'BANGR9', runway: '34R' });
  assert.deepEqual(connector.points.map(point => point.id), ['RW34R', 'RENBE', 'BANGR']);
  assert.equal(connector.connectorOnly, true);
  assert.equal(connector.missingRunway, true);
});

test('a STAR ends on the arrival and never runs through the field', () => {
  const route = procedureRoute(payload, { kind: 'star', ident: 'CHINS5', runway: '16L', enrouteTransition: 'PDT' });
  assert.equal(route.ok, true);
  assert.deepEqual(route.points.map(point => point.id), ['CHINS', 'SUNED', 'RADDY', 'AUBRN', 'RW16L']);
  assert.equal(route.runwayTransition, 'RW16B', 'the combined runway transition is named as such');
  assert.equal(route.complete, false);
  assert.ok(!route.points.some(point => point.id === 'KSEA'), 'the airport reference point is not in the path');

  // Without a runway transition the published common legs are used and the
  // threshold the data carries becomes the last point.
  const noRunway = procedureRoute(payload, { kind: 'star', ident: 'CHINS5', runway: '34R', enrouteTransition: 'PDT' });
  assert.deepEqual(noRunway.points.map(point => point.id), ['CHINS', 'SUNED', 'RW34R']);
  assert.equal(noRunway.missingRunway, true);
});

test('a procedure the data does not publish is reported, never approximated', () => {
  const missing = procedureRoute(payload, { kind: 'sid', ident: 'NOPE1', runway: '16L' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-in-data');
  assert.match(missing.error, /no SID NOPE1/i);

  const unavailable = procedureRoute({ ok: false, reason: 'no-navdata', error: 'No simulator data.' }, { kind: 'sid', ident: 'X' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'unavailable');
  assert.match(unavailable.error, /No simulator data/);

  // The page shows the exact sentence the brief requires when nothing is verified.
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  assert.match(src, /Verified procedure data is currently unavailable for this airport\./);
});

test('a procedure whose legs all live in its transitions asks for a transition', () => {
  // Real CIFP data publishes plenty of these: no common trunk at all, every leg
  // inside a runway or en-route transition. That is a choice to make, not a
  // missing record, and it must not read as missing data.
  const transitOnly = {
    ok: true,
    airport: 'KSEA',
    source: 'X-Plane 12 CIFP',
    cycle: '2610',
    runways: { '16L': { lat: 47.463794, lon: -122.30775 } },
    procedures: {
      sid: [{
        id: 'BANGR9',
        transitions: [
          { id: 'RW16L', runway: '16L', complete: true, skipped: 0, points: [{ id: 'CAVOB', lat: 47.396192, lon: -122.308347 }] },
          { id: 'PANGL', runway: '', complete: true, skipped: 0, points: [{ id: 'BANGR', lat: 47.643903, lon: -122.914914 }] },
        ],
      }],
      star: [], approach: [],
    },
  };

  const bare = procedureRoute(transitOnly, { kind: 'sid', ident: 'BANGR9', runway: '' });
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, 'needs-transition', 'the pilot is told to choose, not that data is missing');
  assert.match(bare.error, /inside its transitions/);

  const chosen = procedureRoute(transitOnly, { kind: 'sid', ident: 'BANGR9', runway: '', enrouteTransition: 'PANGL' });
  assert.equal(chosen.ok, true);
  assert.deepEqual(chosen.points.map(point => point.id), ['BANGR']);

  const byRunway = procedureRoute(transitOnly, { kind: 'sid', ident: 'BANGR9', runway: '16L' });
  assert.equal(byRunway.ok, true);
  assert.deepEqual(byRunway.points.map(point => point.id), ['CAVOB']);

  // A procedure with no legs anywhere still reports missing data.
  const hollow = {
    ok: true, airport: 'KSEA', source: 'X-Plane 12 CIFP', runways: {},
    procedures: { sid: [{ id: 'HOLLOW1', transitions: [{ id: 'ALL', points: [] }] }], star: [], approach: [] },
  };
  const none = procedureRoute(hollow, { kind: 'sid', ident: 'HOLLOW1', runway: '' });
  assert.equal(none.reason, 'empty');
  assert.match(none.error, /no verified legs/);
});

test('transitions are described with their role and completeness', () => {
  const sid = payload.procedures.sid[0];
  const list = procedureTransitions(sid);
  assert.deepEqual(list.map(entry => entry.role), ['runway', 'common', 'enroute']);
  assert.equal(list[0].label, 'Runway 16L');
  assert.equal(list[2].complete, false);
  assert.equal(runwayFromTransitionId('RW16L'), '16L');
  assert.equal(runwayFromTransitionId('ALL'), '');
});

test('geometry suggests a transition from the plan, and says it is a suggestion', () => {
  const suggestion = suggestTransitions(payload, {
    kind: 'sid', ident: 'BANGR9', runway: '16L', routeIds: ['CYUL', 'RENBE', 'KEWR', 'KSEA'], airport: 'KSEA',
  });
  assert.equal(suggestion.runway, 'RW16L');
  assert.equal(suggestion.enroute, '', 'the trunk starts with RENBE, which is the common leg rather than a transition');
  assert.match(suggestion.reason, /Suggested/);

  const starSuggestion = suggestTransitions(payload, {
    kind: 'star', ident: 'CHINS5', runway: '16', routeIds: ['CHINS', 'KSEA'], airport: 'KSEA',
  });
  assert.equal(starSuggestion.runway, 'RW16B');
  assert.equal(starSuggestion.enroute, 'PDT', 'the STAR begins where the planned route enters it');
});

/* ── applying and removing a procedure ───────────────────────────────── */

test('applying a procedure inserts published legs once and replaces itself', () => {
  let plan = setDeparture(createPlan(), { id: 'KSEA', name: 'Seattle', lat: 47.449, lon: -122.309, elev: 433 }).plan;
  plan = setArrival(plan, KEWR).plan;

  const sid = procedureRoute(payload, { kind: 'sid', ident: 'BANGR9', runway: '16L' });
  const first = applyProcedure(plan, 'sid', sid);
  assert.equal(first.ok, true);
  plan = first.plan;
  assert.deepEqual(plan.points.map(point => point.id), ['KSEA', 'CAVOB', 'RENBE', 'BANGR', 'KEWR']);
  assert.equal(plan.sid.id, 'BANGR9');
  assert.equal(plan.sid.airport, 'KSEA');
  assert.equal(plan.departureRwy, '16L');
  assert.ok(plan.points.slice(1, 4).every(point => point.ss === 'SID'));

  const second = applyProcedure(plan, 'sid', sid);
  assert.equal(second.ok, true);
  assert.deepEqual(second.plan.points.map(point => point.id), plan.points.map(point => point.id), 're-applying is idempotent');

  const cleared = clearProcedure(second.plan, 'sid');
  assert.deepEqual(cleared.points.map(point => point.id), ['KSEA', 'KEWR']);
  assert.equal(cleared.sid, null);
});

test('changing the departure drops the SID that belonged to the old airport', () => {
  let plan = setDeparture(createPlan(), { id: 'KSEA', name: 'Seattle', lat: 47.449, lon: -122.309 }).plan;
  plan = setArrival(plan, KEWR).plan;
  plan = applyProcedure(plan, 'sid', procedureRoute(payload, { kind: 'sid', ident: 'BANGR9', runway: '16L' })).plan;
  assert.equal(plan.sid.id, 'BANGR9');

  const moved = setDeparture(plan, CYUL).plan;
  assert.equal(moved.sid, null);
  assert.deepEqual(moved.points.map(point => point.id), ['CYUL', 'KEWR']);
});

/* ── fuel ────────────────────────────────────────────────────────────── */

test('automatic fuel refuses to invent a burn rate', () => {
  const missing = fuelEstimate({ mode: 'auto', routeNm: 600, cruiseKts: 450 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Cruise fuel flow/i);

  const ok = fuelEstimate({
    mode: 'auto', unit: 'kg', routeNm: 600, cruiseKts: 450, headwindKt: 50,
    burnPerHour: 2500, taxiMin: 10, contingencyPct: 5, reserveMin: 30, alternateNm: 40,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.groundSpeedKts, 400, 'the stated headwind reduces ground speed');
  assert.equal(ok.rows.find(row => row.key === 'trip').value, 3750);
  assert.equal(ok.rows.find(row => row.key === 'alternate').value, 250);
  assert.equal(ok.block, ok.rows.reduce((sum, row) => sum + (row.value || 0), 0));
  assert.equal(ok.landing, ok.block - 417 - 3750);
  assert.match(ok.method, /No climb, descent or aircraft performance table/);
});

test('manual fuel keeps entered values apart from anything calculated', () => {
  const sheet = fuelEstimate({ mode: 'manual', unit: 'kg', components: { trip: 3000, taxi: 200 } });
  assert.equal(sheet.ok, true);
  assert.equal(sheet.block, 3200);
  assert.equal(sheet.rows.find(row => row.key === 'trip').source, 'entered');
  assert.equal(sheet.rows.find(row => row.key === 'reserve').value, null, 'a blank component is missing, not zero');
  assert.match(sheet.notes.join(' '), /Final reserve/);
  assert.match(sheet.method, /Nothing here was calculated/);

  const empty = fuelEstimate({ mode: 'manual', components: {} });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /at least one fuel component/i);
});

test('a plan’s own burn rate is read from its fuel and time, not assumed', () => {
  const burn = burnFromOfp({
    units: 'lb',
    aircraft: { icao: 'A21N' },
    fuel: { trip: 9000 },
    times: { enrouteMin: 240 },
    flight: { callsign: 'ACA123' },
  });
  assert.equal(burn.burnPerHour, 2250);
  assert.equal(burn.unit, 'lb');
  assert.equal(burn.callsign, 'ACA123');
  assert.equal(burnFromOfp({ fuel: { trip: 9000 } }), null, 'a plan without a time has no rate');
});

/* ── alternates ──────────────────────────────────────────────────────── */

test('alternates are geometric candidates with their limits stated', () => {
  const airports = [
    { id: 'KJFK', name: 'Kennedy', lat: 40.64, lon: -73.779, elev: 13, rws: [['04L', '22R', 0, 0, 0, 0, 12000, 150]] },
    { id: 'KLGA', name: 'LaGuardia', lat: 40.777, lon: -73.874, elev: 21, rw: [4, 13], len: [7001, 7003] },
    { id: 'KEWR', name: 'Newark', lat: 40.692, lon: -74.169, elev: 18, rws: [['04L', '22R', 0, 0, 0, 0, 11000, 150]] },
    { id: 'KPHL', name: 'Philadelphia', lat: 39.872, lon: -75.241, elev: 36, rws: [['09L', '27R', 0, 0, 0, 0, 10506, 150]] },
    { id: 'KBAD', name: 'Too close', lat: 40.692, lon: -74.169, elev: 18, rw: [1], len: [3000] },
  ];
  const rows = alternateCandidates(KEWR, airports, { maxNm: 250, minRunwayFt: 6500 });
  const ids = rows.map(row => row.id);
  assert.ok(!ids.includes('KEWR'), 'the arrival is not its own alternate');
  assert.ok(!ids.includes('KBAD'), 'an airport at the same position is not a diversion');
  assert.ok(ids.includes('KJFK') && ids.includes('KLGA') && ids.includes('KPHL'));
  assert.ok(rows[0].distanceNm < rows[rows.length - 1].distanceNm + 0.001, 'sorted by distance score');

  const jfk = rows.find(row => row.id === 'KJFK');
  assert.equal(jfk.runwaySource, 'verified');
  assert.equal(jfk.longestRunwayFt, 12000);
  assert.ok(jfk.reasons.some(text => /12,000 ft longest runway/.test(text)));
  assert.ok(jfk.missing.some(text => /minima/i.test(text)), 'what is not assessed is stated');

  const shortOnly = alternateCandidates(KEWR, airports, { maxNm: 250, minRunwayFt: 14000 });
  assert.deepEqual(shortOnly.map(row => row.id), [], 'nothing meets a runway requirement it cannot meet');
});

/* ── weather ─────────────────────────────────────────────────────────── */

test('weather freshness marks an old report instead of calling it current', () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const fresh = weatherFreshness(now - 5 * 60000, now);
  assert.equal(fresh.stale, false);
  assert.match(fresh.label, /5 min ago/);

  const old = weatherFreshness(now - 3 * 3600 * 1000, now);
  assert.equal(old.stale, true);
  assert.match(old.label, /3 h ago/);

  assert.equal(weatherFreshness(null, now).stale, true, 'a report with no time is not current');
});

/* ── the shared route store ──────────────────────────────────────────── */

test('the stored plan carries what the Navigator and the Flight Deck draw', () => {
  let plan = basePlan();
  plan = { ...plan, cruiseKts: 470, cruiseAlt: 37000, departureRwy: '24L', alternate: { id: 'KJFK', name: 'Kennedy', lat: 40.64, lon: -73.779, elev: 13 } };
  plan = { ...plan, points: plan.points.map((point, index) => (index === 1 ? { ...point, altFt: 36000 } : point)) };
  plan.sid = { id: 'FLOSI4', airport: 'CYUL', label: 'FLOSI4 · RW24L', points: 3, complete: true, source: 'X-Plane 12 CIFP', cycle: '2610' };
  plan.fuel = { ...plan.fuel, burnSource: 'entered', burnPerHour: 2600, taxiMin: 12, contingencyPct: 5, reserveMin: 30 };

  const stored = storedRoute(plan);
  assert.equal(stored.name, 'CYUL → KEWR');
  assert.equal(stored.cruiseKts, 470);
  assert.equal(stored.plan.origin.id, 'CYUL');
  assert.equal(stored.plan.destination.id, 'KEWR');
  assert.equal(stored.plan.alternate.id, 'KJFK');
  assert.equal(stored.plan.sid.id, 'FLOSI4');
  assert.equal(stored.plan.departureRwy, '24L');
  assert.equal(stored.points[1].altFt, 36000, 'a planned level survives the round trip');
  assert.equal(stored.points[1].lat, Math.round(stored.points[1].lat * 1e6) / 1e6);

  const reopened = planFromStored(stored);
  assert.equal(reopened.origin.id, 'CYUL');
  assert.equal(reopened.destination.id, 'KEWR');
  assert.equal(reopened.alternate.id, 'KJFK');
  assert.equal(reopened.sid.id, 'FLOSI4');
  assert.equal(reopened.cruiseKts, 470);
  assert.equal(reopened.fuel.burnPerHour, 2600);
  assert.deepEqual(reopened.points.map(point => point.id), ['CYUL', 'FLOSI', 'KEWR']);

  const map = mapRoute(plan);
  assert.equal(map[0].k, 'apt');
  assert.equal(map[1].altFt, 36000, 'the Flight Deck keeps the planned level too');
  assert.equal(map[0].lat, Math.round(map[0].lat * 1e6) / 1e6);
  assert.equal(planDisplayName({ ...plan, name: 'Company route 12' }), 'Company route 12');
});

test('a Flight Deck route without procedure records still opens as a plan', () => {
  const opened = planFromStored({
    name: 'KSFO → KLAX',
    points: [
      { id: 'KSFO', name: 'San Francisco', lat: 37.619, lon: -122.375, kind: 'apt', elev: 13 },
      { id: 'SFO', name: 'San Francisco', lat: 37.619, lon: -122.373, kind: 'nav' },
      { id: 'KLAX', name: 'Los Angeles', lat: 33.942, lon: -118.408, kind: 'apt', elev: 128 },
    ],
  });
  assert.equal(opened.origin.id, 'KSFO');
  assert.equal(opened.destination.id, 'KLAX');
  assert.equal(opened.sid, null);
  assert.ok(opened.sources[0].detail.includes('Flight Deck'), 'it says where the route came from');
  assert.equal(planFromStored({ points: [] }), null);
});

test('the Navigator keeps a planned level instead of dropping it', async () => {
  // A tiny localStorage stand-in: common.js reads the shared key at call time.
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  store.set('stratos.activeRoute', JSON.stringify({
    name: 'CYUL → KEWR',
    cruiseKts: 460,
    cruiseAlt: 36000,
    points: [
      { id: 'CYUL', name: 'Montréal', lat: 45.47, lon: -73.741, kind: 'apt', elev: 118, altFt: null },
      { id: 'FLOSI', name: 'Flosi', lat: 44.1, lon: -73.4, kind: 'fix', elev: 0, altFt: 36000, ss: 'SID' },
      { id: 'KEWR', name: 'Newark', lat: 40.692, lon: -74.169, kind: 'apt', elev: 18, altFt: null },
    ],
  }));
  const { loadRoute, loadRouteMeta } = await import('../app/js/efb/common.js');
  const route = loadRoute();
  assert.equal(route[1].altFt, 36000);
  assert.equal(route[1].ss, 'SID');
  assert.equal(loadRouteMeta().cruiseKts, 460);
  delete globalThis.localStorage;
});

/* ── the app on the deck ─────────────────────────────────────────────── */

test('the Flight Planner is an EFB app with the chart and the real endpoints', () => {
  const shell = fs.readFileSync(new URL('../app/js/efb.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../app/efb.html', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  const minimap = fs.readFileSync(new URL('../app/js/minimap.js', import.meta.url), 'utf8');

  assert.match(shell, /id: 'flightplan'/, 'the deck has the app');
  assert.match(shell, /module: '\.\/efb\/flightplan\.js'/, 'and loads its own module');
  assert.ok(fs.existsSync(new URL('../app/js/efb/flightplan.js', import.meta.url)));
  assert.match(page, /efb-flightplan\.css/, 'the page loads the planner rules');
  assert.match(fs.readFileSync(new URL('../app/sw.js', import.meta.url), 'utf8'), /'efb-flightplan\.css'/);

  assert.match(src, /procedures\.json\?airport=/, 'procedures come from the bridge endpoint');
  assert.match(src, /navaids\.json/, 'navaids come from the bridge database');
  assert.match(src, /weatherFor\(/, 'weather uses the shared weather client');
  assert.match(src, /RP\.ROUTE_KEY/, 'the plan is written to the key the Navigator reads');
  assert.match(src, /RP\.MAP_ROUTE_KEY/, 'and the legacy copy the Flight Deck map reads');
  assert.match(src, /Load into Navigator/);
  assert.match(src, /Track on deck/);
  assert.doesNotMatch(src, /Math\.random\(\) \* 90/, 'no coordinate is generated from nothing');

  // The chart only accepts a tap when the page asks for one.
  assert.match(minimap, /this\.onPick = options\.onPick \|\| null/);
  assert.match(minimap, /if \(this\.onPick\) \{/);
});

/* ── the globe's surface, the radius and the reset ───────────────────── */

test('the globe is given real surfaces, and the readout names the one showing', () => {
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../app/efb-flightplan.css', import.meta.url), 'utf8');

  assert.match(src, /import \{[^}]*EARTH_STYLES[^}]*\} from '\.\.\/lib\/earthview\.js'/);
  assert.match(src, /data-act="globe-style"/);
  assert.match(src, /data-act="globe-reset"/);
  assert.match(src, /data-act="terrain-read"/);
  // Whichever surface is chosen, the publisher of its tiles is named.
  assert.match(src, /GIBS\.attribution/);
  assert.match(src, /TERRAIN\.attribution/);
  assert.match(src, /earth\.notes\(\)\.join/);

  // Terrain elevations are shown as elevations, with the sample size and with
  // what they may not be used for.
  assert.match(src, /'Highest'/);
  assert.match(src, /ground elevation at the centre, from the terrain tiles/);
  assert.match(src, /display only/);

  // The radius reaches far enough to see the points across a continent, and the
  // circle is off: the radius decides what is drawn, not what is painted.
  assert.match(src, /<option value="320">320 NM<\/option>/);
  assert.match(src, /layers: \{[^}]*range: false[^}]*\}/);
  assert.match(src, /showRange: false/);
  assert.match(src, /data-act="ring" aria-pressed="false"/);

  // Scripted buttons, not the browser's own: the panel has to look like the bag.
  assert.match(css, /\.map-readout-seg button\[aria-pressed='true'\]/);
  assert.match(css, /\.map-hud-btn/);
});

test('the builder resets all the way, including the route other pages read', () => {
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  assert.match(src, /data-act="reset-plan"/);
  assert.match(src, /newPlan\(\{ clearShared: true \}\)/);
  assert.match(src, /function newPlan\(\{ clearShared = false \} = \{\}\)/);
  assert.match(src, /localStorage\.removeItem\(RP\.ROUTE_KEY\)/);
  assert.match(src, /localStorage\.removeItem\(RP\.MAP_ROUTE_KEY\)/);
  assert.match(src, /localStorage\.removeItem\(DRAFT_KEY\)/);
  assert.match(src, /step = 'departure'/);
  assert.match(src, /navNear\.status = 'idle'/);
  // A reset is about the plan being built, never about the pilot's own library.
  const body = src.slice(src.indexOf('function newPlan'), src.indexOf('function paintSteps'));
  assert.doesNotMatch(body, /saveRoutes\(/);
});

/* ── the chart, the radius and the globe ─────────────────────────────── */

test('a chart tap becomes a real identifier, never a generated one', () => {
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  const navnear = fs.readFileSync(new URL('../app/js/lib/navnear.js', import.meta.url), 'utf8');

  assert.doesNotMatch(src, /WP\$\{String\(index\)/, 'the page no longer numbers its own waypoints');
  assert.doesNotMatch(src, /'Chart position'/, 'and no longer calls one a chart position');
  assert.match(src, /navIndex\.pick\(/, 'a tap is resolved against the navigation index');
  assert.match(src, /pickChooser/, 'more than one record at a tap is a question, not a guess');
  assert.match(src, /coordinateIdent\(/, 'a tap that finds nothing is named as a coordinate');
  assert.match(navnear, /export function coordinateIdent/, 'and that name comes from the shared module');
  // The departure rule is checked before anything is resolved.
  const pick = src.slice(src.indexOf('async function handleChartPick'));
  assert.ok(pick.indexOf('RP.NO_DEPARTURE') < pick.indexOf('navIndex.pick('),
    'a tap before the departure airport is refused first');
});

test('the chart reads real points inside a geodesic radius of its own centre', () => {
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  const minimap = fs.readFileSync(new URL('../app/js/minimap.js', import.meta.url), 'utf8');

  assert.match(src, /DEFAULT_RADIUS_NM/, 'the default radius is the documented 40 NM');
  assert.match(src, /data-act="radius"/, 'the pilot can change it');
  assert.match(src, /data-act="ring"/, 'and hide the ring on its own');
  assert.match(src, /map\.viewCenter\(\)/, 'the query is centred on the view, not the aircraft');
  assert.match(src, /fetchNear\(bridge, center\.lat, center\.lon, navNear\.radiusNm, \{ kinds: \['fix'\] \}\)/,
    'en-route fixes come from the simulator nav data and only that');
  assert.match(src, /navIndex\.near\(/, 'the published set is searched in the index');
  // The map layer draws the same records and knows the span in miles.
  assert.match(minimap, /setNavPoints\(points, meta = null\)/);
  assert.match(minimap, /viewSpanNm\(view = this\.fit\(\)\)/);
  assert.match(minimap, /drawNavPoints\(view\)/);
  assert.match(minimap, /drawScale\(view\)/);
  // The ring is built from real geodesic destinations, so latitude cannot flatter it.
  assert.match(minimap, /destination\(center, \(i \/ steps\) \* 360, this\.rangeNm\)/);
});

test('the readout names where every altitude comes from', () => {
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  assert.match(src, /aircraft altitude comes from the simulator/);
  assert.match(src, /nearest airport elevation/);
  assert.match(src, /no airport elevation in range/, 'a missing airport elevation is stated, not filled in');
  // Terrain elevation is real now, and the row says how to get it when there is
  // no reading yet rather than showing a number that was never measured.
  assert.match(src, /'Terrain'/);
  assert.match(src, /choose Relief or Elevation, or press Read terrain/);
  assert.match(src, /ground elevation at the centre, from the terrain tiles/);
  assert.match(src, /across'\]|\['Across'/);
});

test('the globe is the same chart with another projection', () => {
  const src = fs.readFileSync(new URL('../app/js/efb/flightplan.js', import.meta.url), 'utf8');
  const minimap = fs.readFileSync(new URL('../app/js/minimap.js', import.meta.url), 'utf8');

  assert.match(src, /data-act="globe"/, 'the pilot can switch projection');
  assert.match(src, /map\.setMode\(/, 'through the map engine');
  assert.match(minimap, /globeProject\(lat, lon\)/, 'the engine projects orthographically');
  assert.match(minimap, /globeUnproject\(x, y\)/, 'and takes a position back from a tap');
  // The projection itself moved into the shared module, so the tracker's own map
  // and this one cannot disagree about where the horizon is.
  const globe = fs.readFileSync(new URL('../app/js/lib/globeview.js', import.meta.url), 'utf8');
  assert.match(minimap, /from '\.\/lib\/globeview\.js'/, 'the geometry comes from the shared module');
  assert.match(globe, /if \(z < 0\) return null/, 'the far side of the sphere is not drawn');
  assert.match(minimap, /loadGlobeLand\(\)/, 'coastlines are loaded only when a globe is asked for');
  assert.match(minimap, /Natural Earth/, 'and the source is named');
  assert.doesNotMatch(minimap, /https?:\/\/[^'"]*(imagery|terrain)/i, 'no imagery or terrain service is invented');
});
