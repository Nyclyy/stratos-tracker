import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANNOUNCEMENTS, AUTO_EVENTS, CABIN_GLYPHS, CABIN_PHASES, DEFAULT_CABIN_SETTINGS,
  TOKEN_LABELS, announcementById, cabinContext, cabinEvents, fillAnnouncement,
  loadCabinSettings, newCabinState, outputForPhase, profileName, saveCabinSettings,
} from '../app/js/lib/cabin.js';

const PHASE_COUNTS = { preboarding: 11, departure: 12, taxi: 6, climb: 11, descent: 12, arrival: 10, special: 10 };

const sample = (over = {}) => ({
  callsign: 'DLH505', alt: 0, agl: null, vs: 0, gs: 0, receivedAt: Date.now(), ...over,
});

/* One step of the simulator: returns the announcement ids the sample justified. */
function step(state, snapshot, phase) {
  return cabinEvents({ snapshot, phase, state, now: Date.now() });
}

const OFP = {
  flight: { callsign: 'DLH505', cruiseFt: 35000 },
  origin: { icao: 'KSEA' },
  destination: { icao: 'EDDF' },
  times: { enrouteMin: 585, arrUtc: Date.UTC(2026, 9, 31, 14, 35) },
};

test('the library carries every announcement the request lists, once each', () => {
  assert.equal(ANNOUNCEMENTS.length, 72);
  for (const phase of CABIN_PHASES) {
    const items = ANNOUNCEMENTS.filter(item => item.phase === phase.id);
    assert.equal(items.length, PHASE_COUNTS[phase.id], `${phase.id} count`);
  }
  const ids = new Set();
  for (const item of ANNOUNCEMENTS) {
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
    assert.ok(item.title && item.script && item.note, `${item.id} is complete`);
    assert.ok(CABIN_GLYPHS[item.icon], `${item.id} draws a known icon`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(item.title + item.script), `${item.id} uses no emoji`);
    assert.ok(item.kind === 'captain' || item.kind === 'crew', `${item.id} has a voice role`);
  }
});

test('an automatic claim is only made for an event the telemetry witnesses', () => {
  for (const item of ANNOUNCEMENTS) {
    if (item.auto) {
      assert.ok(AUTO_EVENTS[item.auto], `${item.id} names a known event`);
    } else {
      assert.ok(item.autoWhy, `${item.id} says why it cannot be automatic`);
    }
  }
  // The seatbelt sign and boarding are the two the UDP feed cannot see; a rule
  // for either would have to invent an event.
  const autoIds = ANNOUNCEMENTS.filter(item => item.auto).map(item => item.id);
  assert.ok(!autoIds.includes('climb.belts-off'));
  assert.ok(!autoIds.some(id => id.startsWith('pre.')));
});

test('missing plan values are reported, never filled with a guess', () => {
  const welcome = announcementById('dep.captain-welcome');
  const bare = fillAnnouncement(welcome, { partOfDay: 'morning' });
  assert.equal(bare.ready, false);
  assert.deepEqual(bare.missing.map(entry => entry.token).sort(), ['airline', 'destination', 'flight']);
  assert.match(bare.text, /\{airline\}/, 'the token is left visible rather than replaced');
  assert.ok(TOKEN_LABELS.airline);

  const context = cabinContext({ ofp: OFP, airlineName: 'Lufthansa', now: new Date(2026, 9, 31, 9, 0).getTime() });
  assert.equal(context.partOfDay, 'morning');
  const filled = fillAnnouncement(welcome, context);
  assert.equal(filled.ready, true);
  assert.equal(filled.text, 'Good morning. This is your captain speaking. Welcome aboard Lufthansa flight DLH505 to EDDF.');
});

test('the context speaks the plan, not an invention', () => {
  const context = cabinContext({ ofp: OFP, airlineName: 'Lufthansa', now: Date.UTC(2026, 9, 31, 9, 0) });
  assert.equal(context.flight, 'DLH505');
  assert.equal(context.origin, 'KSEA');
  assert.equal(context.destination, 'EDDF');
  assert.equal(context.duration, '9 hours 45 minutes');
  assert.equal(context.arrival, '14:35Z');
  assert.equal(context.altitude, 'flight level 350');
  assert.equal(context.localTime, null, 'no time zone in the plan means no local time');

  const fixed = Date.UTC(2026, 9, 31, 9, 0);
  const zoned = cabinContext({ ofp: { ...OFP, destination: { icao: 'EDDF', timezone: 2 } }, now: fixed });
  assert.equal(zoned.localTime, '11:00');
});

test('phase transitions fire once, in order, and only from the simulator', () => {
  let state = newCabinState();
  let result = step(state, sample({ gs: 0 }), 'PARKED');
  state = result.state;
  assert.deepEqual(result.ids, [], 'the first sample only establishes a starting point');

  result = step(state, sample({ gs: 12 }), 'TAXI');
  state = result.state;
  assert.deepEqual(result.ids, ['taxi.crew-prepare']);

  result = step(state, sample({ gs: 14 }), 'TAXI');
  state = result.state;
  assert.deepEqual(result.ids, [], 'still taxiing is not a new event');

  result = step(state, sample({ gs: 160, agl: 320, alt: 400 }), 'AIRBORNE');
  state = result.state;
  assert.deepEqual(result.ids, ['taxi.after-takeoff']);

  result = step(state, sample({ alt: 9000, vs: 1800 }), 'AIRBORNE');
  state = result.state;
  assert.deepEqual(result.ids, []);

  result = step(state, sample({ alt: 10500, vs: 1500 }), 'AIRBORNE');
  state = result.state;
  assert.deepEqual(result.ids, ['taxi.seatbelt-sign']);

  result = step(state, sample({ alt: 20000, vs: 0 }), 'AIRBORNE');
  state = result.state;
  assert.deepEqual(result.ids, ['climb.reaching-altitude']);

  result = step(state, sample({ alt: 17500, agl: 17000, vs: -900 }), 'AIRBORNE');
  state = result.state;
  assert.deepEqual(result.ids, ['desc.begin']);

  result = step(state, sample({ alt: 2500, agl: 2500, vs: -700 }), 'AIRBORNE');
  state = result.state;
  assert.deepEqual(result.ids, ['desc.final-approach']);

  result = step(state, sample({ alt: 0, agl: 0, vs: 0, gs: 40 }), 'LANDED');
  state = result.state;
  assert.deepEqual(result.ids, ['arr.welcome']);

  result = step(state, sample({ alt: 0, agl: 0, vs: 0, gs: 0 }), 'PARKED');
  assert.deepEqual(result.ids, ['arr.disembark']);
  assert.deepEqual(result.state.done, {}, 'the next flight may announce again');
});

test('stale telemetry cannot trigger anything', () => {
  const state = newCabinState();
  const first = step(state, sample({ gs: 0, receivedAt: Date.now() - 6000 }), 'PARKED');
  assert.deepEqual(first.ids, []);
  const late = step(first.state, sample({ gs: 12, receivedAt: Date.now() - 6000 }), 'TAXI');
  assert.deepEqual(late.ids, []);
});

test('a new callsign starts a clean flight', () => {
  let result = step(newCabinState(), sample({ gs: 0 }), 'PARKED');
  result = step(result.state, sample({ gs: 12 }), 'TAXI');
  assert.deepEqual(result.ids, ['taxi.crew-prepare']);
  result = step(result.state, sample({ gs: 0, callsign: 'UAL99' }), 'PARKED');
  assert.equal(result.state.done.taxiStart, undefined);
});

test('each phase chooses its own audio output, defaulting to X-Plane', () => {
  const storage = {
    value: null,
    getItem() { return this.value; },
    setItem(_key, next) { this.value = next; },
  };
  assert.equal(outputForPhase(loadCabinSettings(storage), 'arrival'), 'xplane');
  saveCabinSettings({ outputs: { ...loadCabinSettings(storage).outputs, arrival: 'efb' } }, storage);
  const saved = loadCabinSettings(storage);
  assert.equal(outputForPhase(saved, 'arrival'), 'efb');
  assert.equal(outputForPhase(saved, 'preboarding'), 'xplane');
  assert.equal(outputForPhase({ outputs: { arrival: 'bogus' } }, 'arrival'), 'xplane');
});

test('settings round-trip and a custom profile speaks its own name', () => {
  const storage = {
    value: null,
    getItem() { return this.value; },
    setItem(_key, next) { this.value = next; },
  };
  assert.deepEqual(loadCabinSettings(storage).voices, DEFAULT_CABIN_SETTINGS.voices);
  const saved = saveCabinSettings({ airline: 'custom', customName: 'Oceanic Air', auto: true }, storage);
  assert.equal(saved.airline, 'custom');
  assert.equal(profileName(saved), 'Oceanic Air');
  assert.equal(loadCabinSettings(storage).customName, 'Oceanic Air');
  assert.equal(profileName({ airline: 'lufthansa' }), 'Lufthansa');
  assert.equal(profileName({ airline: '' }), '');
});
