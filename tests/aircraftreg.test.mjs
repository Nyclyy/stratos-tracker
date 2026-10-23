import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHex,
  normalizeCallsign,
  hexLookupUrl,
  callsignLookupUrl,
  registrationFromTitle,
  lookupPlan,
  registrationOutcome,
  registrationFromHexdb,
  registrationFromLive,
} from '../app/js/lib/aircraftreg.js';

test('reg: a Mode S address is six hex characters', () => {
  assert.equal(normalizeHex('4066d0'), '4066D0');
  assert.equal(normalizeHex(' ab5eb2 '), 'AB5EB2');
  for (const value of ['', null, '4066D', '4066D0A', 'ZZZZZZ', 'BAW2620']) {
    assert.equal(normalizeHex(value), '', String(value));
  }
});

test('reg: a callsign can be searched, a registration is not searched as one', () => {
  assert.equal(normalizeCallsign(' baw2620 '), 'BAW2620');
  assert.equal(normalizeCallsign('TOM2PJ'), 'TOM2PJ');
  for (const value of ['', null, 'B', 'BAW!23', 'X'.repeat(12)]) {
    assert.equal(normalizeCallsign(value), '', String(value));
  }
});

test('reg: lookup URLs name the database and encode the query', () => {
  assert.equal(hexLookupUrl('ab5eb2'), 'https://hexdb.io/api/v1/aircraft/AB5EB2');
  assert.equal(hexLookupUrl('nope'), '');
  assert.equal(callsignLookupUrl('kLM123'), 'https://api.adsb.lol/v2/callsign/KLM123');
  assert.equal(callsignLookupUrl(''), '');
});

test('reg: a hex record gives the registration, type and owner', () => {
  assert.deepEqual(registrationFromHexdb({
    ModeS: 'AB5EB2', Registration: 'n8312c', ICAOTypeCode: 'b738',
    Type: '737NG 8H4/W', RegisteredOwners: 'Southwest Airlines',
  }), { registration: 'N8312C', type: 'B738', owner: 'Southwest Airlines', via: 'hex' });
});

test('reg: a hex record without a registration is not a match', () => {
  assert.equal(registrationFromHexdb({ ModeS: 'AB5EB2' }), null);
  assert.equal(registrationFromHexdb(null), null);
  assert.equal(registrationFromHexdb({ Registration: '   ' }), null);
});

test('reg: a live search answers with the first aircraft that reports one', () => {
  const payload = { ac: [{ hex: '4066d0', flight: 'TOM2PJ', t: 'b738' }, { hex: 'abc123', r: 'g-tawi', t: 'B738' }] };
  assert.deepEqual(registrationFromLive(payload), {
    registration: 'G-TAWI', type: 'B738', owner: '', hex: 'ABC123', via: 'callsign',
  });
  assert.equal(registrationFromLive({ ac: [] }), null);
  assert.equal(registrationFromLive({ ac: [{ hex: '4066d0' }] }), null);
  assert.equal(registrationFromLive(null), null);
});

test('reg: a livery title names the airframe that is flown', () => {
  assert.equal(registrationFromTitle('Boeing 737-800 Southwest Airlines N8312C'), 'N8312C');
  assert.equal(registrationFromTitle('PMDG 737-800NGXu BW Southwest N8312C'), 'N8312C');
  assert.equal(registrationFromTitle('Airbus A320neo Eurowings D-AIZC'), 'D-AIZC');
  assert.equal(registrationFromTitle('FlightFactor A350-900 Lufthansa'), '');
  assert.equal(registrationFromTitle('Boeing 747-400 British Airways G-CIVB'), 'G-CIVB');
  assert.equal(registrationFromTitle('A320 British Airways G-EUYA'), 'G-EUYA');
  assert.equal(registrationFromTitle('Zibo 737-800X (G-TAWI)'), 'G-TAWI');
});

test('reg: a type code is not read as a registration', () => {
  for (const title of [
    'B737-800', 'A320-232', 'MD-82', 'CRJ-900', 'PA-28', 'Boeing 737-800',
    'Airbus A320neo', 'AT-72', '737-800', 'Embraer E190',
  ]) assert.equal(registrationFromTitle(title), '', title);
  assert.equal(registrationFromTitle(''), '');
  assert.equal(registrationFromTitle(null), '');
});

test('reg: the plan uses the Mode S address before the callsign', () => {
  assert.deepEqual(lookupPlan({ hex: 'ab5eb2', callsign: 'BAW2620' }), {
    kind: 'hex', value: 'AB5EB2', url: 'https://hexdb.io/api/v1/aircraft/AB5EB2',
  });
  assert.deepEqual(lookupPlan({ hex: 'BAW2620', callsign: 'BAW2620' }), {
    kind: 'callsign', value: 'BAW2620', url: 'https://api.adsb.lol/v2/callsign/BAW2620',
  });
  assert.equal(lookupPlan({}), null);
  assert.equal(lookupPlan(), null);
});

test('reg: a lookup answers with one of the three card states', () => {
  const hex = lookupPlan({ hex: 'AB5EB2' });
  assert.equal(registrationOutcome(hex, 200, { Registration: 'N8312C', ICAOTypeCode: 'B738' }).state, 'ok');
  assert.equal(registrationOutcome(hex, 200, { Registration: 'N8312C' }).registration, 'N8312C');
  assert.equal(registrationOutcome(hex, 404, { error: 'Aircraft not found.' }).state, 'none');
  assert.equal(registrationOutcome(hex, 429, null).state, 'unavailable');
  assert.equal(registrationOutcome(hex, 0, null).state, 'unavailable');
  assert.equal(registrationOutcome(hex, undefined, null).state, 'unavailable');
  assert.equal(registrationOutcome(null, 200, {}).state, 'unavailable');
  const call = lookupPlan({ callsign: 'TOM2PJ' });
  assert.equal(registrationOutcome(call, 200, { ac: [{ r: 'G-TAWI' }] }).registration, 'G-TAWI');
  assert.equal(registrationOutcome(call, 200, { ac: [], msg: 'No error' }).state, 'none');
  assert.equal(registrationOutcome(call, 502, null).state, 'unavailable');
});

test('reg: an empty search is no match, not an error', () => {
  assert.equal(registrationFromLive({ ac: [], msg: 'No error' }), null);
  assert.equal(registrationFromLive({ msg: 'No error' }), null);
});
