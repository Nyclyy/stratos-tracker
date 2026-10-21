import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKLIST_PROFILES, GENERIC_PROFILE, detectAircraft, profileByKey, sectionsOf, itemKey,
  progressOf, nextIncompleteSection, inferPhase, recommendSection, flightKeyFor, sanitizeChecks,
  makeState, mergeChecklistStates, allItems,
} from '../app/js/lib/checklists.js';

const REQUIRED_PHASES = [
  'dispatch', 'cockpit', 'beforeStart', 'engineStart', 'afterStart', 'taxi', 'beforeTakeoff',
  'takeoff', 'climb', 'cruise', 'descentPrep', 'approachBrief', 'approach', 'beforeLanding',
  'landing', 'afterLanding', 'taxiIn', 'parking', 'shutdown',
];

test('profiles: every profile has a unique key and the required normal phases', () => {
  const keys = new Set();
  for (const profile of [...CHECKLIST_PROFILES, GENERIC_PROFILE]) {
    assert.ok(profile.key, 'a profile has no key');
    assert.ok(!keys.has(profile.key), `duplicate profile key ${profile.key}`);
    keys.add(profile.key);
    const phases = new Set(sectionsOf(profile).map(section => section.phase));
    for (const phase of REQUIRED_PHASES) {
      assert.ok(phases.has(phase), `${profile.key} is missing the ${phase} section`);
    }
    assert.ok(sectionsOf(profile, 'emergency').length >= 1, `${profile.key} has no emergency section`);
    assert.ok(profile.disclaimer && /not|simulator/i.test(profile.disclaimer), `${profile.key} needs a disclaimer`);
    assert.ok(['community', 'generic'].includes(profile.verification));
  }
});

test('profiles: items are complete and nothing claims to be verified', () => {
  for (const profile of [...CHECKLIST_PROFILES, GENERIC_PROFILE]) {
    const items = allItems(profile);
    assert.ok(items.length >= 30, `${profile.key} has too few items (${items.length})`);
    for (const item of items) {
      assert.ok(item.action && item.action.length > 2, `${profile.key}/${item.key} has no action`);
      assert.equal(typeof item.expect, 'string');
      assert.equal(typeof item.note, 'string');
    }
    assert.ok(!/\[\s*verified\s*\]/i.test(JSON.stringify(profile)), `${profile.key} claims verification`);
  }
});

test('profiles: the A340-600 has four engines, a trim tank and memo guidance', () => {
  const profile = profileByKey('a346-toliss');
  assert.equal(profile.variant, 'A340-600');
  const text = JSON.stringify(profile.sections);
  assert.match(text, /ENG 4/);
  assert.match(text, /ENG 3/);
  assert.match(text, /TRIM TANK/);
  assert.match(text, /T TK XFRD/);
  assert.match(text, /Do not action a normal memo/);
  assert.ok(allItems(profile).length > 90, 'the A340-600 normal sequence should be complete');
});

test('detection: common add-on titles map to the right profile', () => {
  const cases = [
    ['ToLiss A340-600', 'a346-toliss'],
    ['Airbus A340-600 (ToLiss)', 'a346-toliss'],
    ['ToLiss A330-900neo', 'a339-toliss'],
    ['Airbus A319 (ToLiss)', 'a319-toliss'],
    ['Airbus A320neo', 'a320neo-toliss'],
    ['Airbus A320-214', 'a320-toliss'],
    ['ToLiss A321-200', 'a321-toliss'],
    ['Airbus A321neo', 'a321neo-toliss'],
    ['FlightFactor 777-300ER', 'b77w-ff'],
    ['Boeing 777-200LR', 'b772-ff'],
    ['FlightFactor A350-900', 'a350-ff'],
  ];
  for (const [aircraft, key] of cases) {
    const result = detectAircraft({ aircraft, src: 'X-Plane' });
    assert.equal(result.profileKey, key, `${aircraft} matched ${result.profileKey}`);
    assert.equal(result.confidence, 'high');
    assert.equal(result.simulator, 'X-Plane');
  }
});

test('detection: an unknown or missing aircraft never guesses', () => {
  const unknown = detectAircraft({ aircraft: 'Cessna 172 Skyhawk', src: 'MSFS' });
  assert.equal(unknown.profileKey, null);
  assert.equal(unknown.confidence, 'none');
  assert.match(unknown.reason, /did not match/);

  const missing = detectAircraft({ aircraft: '' });
  assert.equal(missing.profileKey, null);
  assert.equal(missing.confidence, 'none');
  assert.equal(detectAircraft({}).simulator, '');
});

test('phase: ground and airborne states produce a suggestion, not a certainty', () => {
  assert.equal(inferPhase({ onGround: true, gs: 0, agl: 0 }).key, 'parked');
  assert.equal(inferPhase({ onGround: true, gs: 18, agl: 0 }).key, 'taxi');
  assert.equal(inferPhase({ onGround: true, gs: 60, agl: 0 }).key, 'takeoff');
  assert.equal(inferPhase({ onGround: false, gs: 200, agl: 1800, vs: 1800 }).key, 'climb');
  assert.equal(inferPhase({ onGround: false, gs: 240, alt: 9000, vs: -700 }).key, 'descent');
  assert.equal(inferPhase({ onGround: false, gs: 460, alt: 36000, vs: 0 }).key, 'cruise');
  const landing = inferPhase({ onGround: true, gs: 25, agl: 0 }, 'descent');
  assert.equal(landing.key, 'afterLanding');
  assert.equal(inferPhase(null).confidence, 'none');
  for (const result of [inferPhase({ onGround: true, gs: 0 }), inferPhase({ onGround: false, vs: 900 })]) {
    assert.equal(result.confidence, 'inferred');
    assert.ok(result.reason.length > 4);
  }
});

test('progress: counts, percentages and section completion', () => {
  const profile = profileByKey('a320-toliss');
  const beforeStart = sectionsOf(profile).find(section => section.key === 'beforeStart');
  const checks = {};
  checks[itemKey('beforeStart', 0)] = true;
  checks[itemKey('beforeStart', 1)] = true;
  const progress = progressOf(profile, checks);
  assert.equal(progress.done, 2);
  assert.equal(progress.remaining, progress.total - 2);
  assert.ok(progress.percent > 0 && progress.percent < 100);
  const row = progress.bySection.find(item => item.key === 'beforeStart');
  assert.equal(row.done, 2);
  assert.equal(row.total, beforeStart.items.length);
  assert.equal(row.complete, beforeStart.items.length === 2);
  assert.equal(progress.emergency.length, 1);
});

test('progress: the next section is the next one with open items', () => {
  const profile = profileByKey('a320-toliss');
  const checks = {};
  for (const section of sectionsOf(profile)) {
    if (section.key === 'cockpit') continue;
    section.items.forEach((_, index) => { checks[itemKey(section.key, index)] = true; });
  }
  const progress = progressOf(profile, checks);
  assert.equal(progress.bySection.find(row => row.key === 'cockpit').done, 0);
  const next = nextIncompleteSection(profile, checks, 'cockpit');
  assert.equal(next.section.key, 'cockpit');
  assert.equal(next.itemIndex, 0);
});

test('recommendation: follows the phase and skips completed sections', () => {
  const profile = profileByKey('a320-toliss');
  const checks = {};
  const taxi = sectionsOf(profile).find(section => section.key === 'taxi');
  taxi.items.forEach((_, index) => { checks[itemKey('taxi', index)] = true; });
  const recommendation = recommendSection(profile, { onGround: true, gs: 20, agl: 0 }, checks);
  assert.ok(recommendation);
  assert.equal(recommendation.key, 'beforeTakeoff');
  assert.match(recommendation.reason, /taxi/i);
});

test('flight keys: a new flight id never inherits the previous progress', () => {
  const a = flightKeyFor({ flightId: 'flight-1', profileKey: 'a320-toliss', now: 1 });
  const b = flightKeyFor({ flightId: 'flight-2', profileKey: 'a320-toliss', now: 1 });
  assert.notEqual(a, b);
  assert.equal(a, flightKeyFor({ flightId: 'flight-1', profileKey: 'a320-toliss', now: 99 }));
  const day1 = flightKeyFor({ profileKey: 'a320-toliss', now: Date.UTC(2026, 9, 20, 8) });
  const day2 = flightKeyFor({ profileKey: 'a320-toliss', now: Date.UTC(2026, 9, 21, 8) });
  assert.notEqual(day1, day2);
  assert.match(day1, /^ground:a320-toliss:2026-10-20$/);
});

test('storage: stored checks are sanitised', () => {
  const raw = { 'a.1': true, 'a.2': false, 'a.3': 'yes', 'a.4': 1, x: true };
  assert.deepEqual(sanitizeChecks(raw), { 'a.1': true, x: true });
  assert.deepEqual(sanitizeChecks(null), {});
  assert.deepEqual(sanitizeChecks('nope'), {});
  const limited = {};
  for (let i = 0; i < 20; i++) limited[`k${i}`] = true;
  assert.equal(Object.keys(sanitizeChecks(limited, 5)).length, 5);
});

test('sync: a higher revision wins and a different flight starts clean', () => {
  const local = makeState({ profileKey: 'a320-toliss', flightKey: 'f1', checks: { 'a.1': true }, revision: 2, updatedAt: 100 });
  const remote = makeState({ profileKey: 'a320-toliss', flightKey: 'f1', checks: { 'a.2': true }, revision: 3, updatedAt: 90 });
  const merged = mergeChecklistStates(local, remote);
  assert.equal(merged.source, 'remote');
  assert.deepEqual(merged.state.checks, { 'a.2': true });

  // The older revision never overwrites the newer one, whichever side it is.
  const stale = mergeChecklistStates(remote, local);
  assert.equal(stale.source, 'local');
  assert.equal(stale.state.revision, 3);

  const nextFlight = makeState({ profileKey: 'a346-toliss', flightKey: 'f2', checks: {}, revision: 0, updatedAt: 200 });
  const switched = mergeChecklistStates(local, nextFlight);
  assert.equal(switched.source, 'remote');
  assert.equal(switched.state.flightKey, 'f2');

  const tie = mergeChecklistStates({ ...local, revision: 3, updatedAt: 50 }, remote);
  assert.equal(tie.source, 'remote');
});
