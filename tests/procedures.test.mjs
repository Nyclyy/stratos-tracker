import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  procedureEndpoint, normalizeRunway, procedureById, transitionFor,
  procedurePath, connectorFor, procedureNote,
} from '../app/js/lib/procedures.js';

const threshold = { lat: 47.463794, lon: -122.30775 };
const payload = {
  ok: true,
  airport: 'KSEA',
  source: 'X-Plane 12 CIFP',
  cycle: '2610',
  runways: { '16L': threshold, '34R': { lat: 47.431172, lon: -122.308039 } },
  procedures: {
    sid: [{
      id: 'BANGR9',
      transitions: [
        { id: 'RW16L', runway: '16L', combined: false, complete: true, skipped: 0, points: [
          { id: 'CAVOB', lat: 47.396192, lon: -122.308347, terminator: 'DF' },
          { id: 'RENBE', lat: 47.320364, lon: -122.311544, terminator: 'TF' },
          { id: 'BANGR', lat: 47.643903, lon: -122.914914, terminator: 'TF' },
        ] },
        { id: 'RW34R', runway: '34R', combined: false, complete: true, skipped: 0, points: [
          { id: 'DODVE', lat: 47.498775, lon: -122.307444, terminator: 'DF' },
        ] },
        { id: 'ARRIE', runway: '', combined: false, complete: true, skipped: 0, points: [
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
      ],
    }],
    approach: [],
  },
};

test('procedures: the request names the airport, kind and procedure', () => {
  assert.equal(procedureEndpoint('ksea', 'SID', 'bangr9'), '/procedures.json?airport=KSEA&kind=sid&id=BANGR9');
  assert.equal(procedureEndpoint('KSEA'), '/procedures.json?airport=KSEA');
  assert.equal(procedureEndpoint('K'), '', 'an airport is four characters');
  assert.equal(procedureEndpoint(''), '');
});

test('procedures: a runway designator is accepted with or without the CIFP prefix', () => {
  assert.equal(normalizeRunway('RW16L'), '16L');
  assert.equal(normalizeRunway('16l'), '16L');
  assert.equal(normalizeRunway(' 28R '), '28R');
  assert.equal(normalizeRunway('16'), '16');
  assert.equal(normalizeRunway('ABC'), '');
  assert.equal(normalizeRunway(''), '');
});

test('procedures: the exact runway transition wins, then the combined one', () => {
  const sid = procedureById(payload, 'sid', 'bangr9');
  const exact = transitionFor(sid, '16L');
  assert.equal(exact.transition.id, 'RW16L');
  assert.equal(exact.combined, false);
  const star = procedureById(payload, 'star', 'CHINS5');
  const combined = transitionFor(star, '16L');
  assert.equal(combined.transition.id, 'RW16B');
  assert.equal(combined.combined, true);
  assert.equal(transitionFor(star, '28R'), null, 'a runway it does not publish is not claimed');
  assert.equal(transitionFor(sid, ''), null);
});

test('procedures: a SID starts at the runway threshold and a STAR ends there', () => {
  const sid = procedurePath(payload, { kind: 'sid', ident: 'BANGR9', runway: '16L' });
  assert.equal(sid.ok, true);
  assert.equal(sid.points[0].id, 'RW16L');
  assert.equal(sid.points[0].lat, threshold.lat);
  assert.deepEqual(sid.points.slice(1).map(p => p.id), ['CAVOB', 'RENBE', 'BANGR']);
  assert.equal(sid.complete, true);
  assert.equal(sid.cycle, '2610');

  const star = procedurePath(payload, { kind: 'star', ident: 'CHINS5', runway: '16L' });
  assert.equal(star.ok, true);
  assert.equal(star.points[star.points.length - 1].id, 'RW16L');
  assert.equal(star.combined, true, 'the combined transition is reported as such');
  assert.equal(star.complete, false, 'a skipped leg is not hidden');
  assert.equal(star.skipped, 1);
});

test('procedures: a STAR that ends at its airport ends at the runway instead', () => {
  const ending = {
    ...payload,
    airport: 'KSEA',
    runways: { '28R': { lat: 45.58415, lon: -122.568289 } },
    procedures: {
      ...payload.procedures,
      star: [{ id: 'RW28B', transitions: [{ id: 'RW28B', runway: '28', combined: true, complete: true, skipped: 0, points: [
        { id: 'BTG', lat: 45.747811, lon: -122.591536 },
        { id: 'KSEA', lat: 47.449888, lon: -122.311777 },
      ] }] }],
    },
  };
  const path = procedurePath(ending, { kind: 'star', ident: 'RW28B', runway: '28R' });
  assert.equal(path.ok, true);
  assert.deepEqual(path.points.map(p => p.id), ['BTG', 'RW28R'], 'the airport point is replaced, not doubled');
  assert.equal(path.points[path.points.length - 1].lat, 45.58415);
});

test('procedures: missing data is reported, never filled in', () => {
  const none = procedurePath(payload, { kind: 'sid', ident: 'NOPE', runway: '16L' });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'not-in-data');
  const noRunway = procedurePath(payload, { kind: 'star', ident: 'CHINS5', runway: '28R' });
  assert.equal(noRunway.ok, false);
  assert.equal(noRunway.reason, 'no-runway-transition');
  const unavailable = procedurePath({ ok: false, error: 'No X-Plane navigation data was found on this PC.' }, { kind: 'sid', ident: 'BANGR9', runway: '16L' });
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error, /No X-Plane navigation data/);
});

test('procedures: only the runway connection the plan lacks is drawn', () => {
  const sid = procedurePath(payload, { kind: 'sid', ident: 'BANGR9', runway: '16L' });
  // The plan already draws CAVOB onward as waypoint legs.
  const withPlan = connectorFor('sid', sid.points, ['KSEA', 'CAVOB', 'RENBE', 'BANGR']);
  assert.deepEqual(withPlan.map(p => p.id), ['RW16L', 'CAVOB']);
  // A plan that starts at a later fix gets the published fixes before it too.
  const later = connectorFor('sid', sid.points, ['RENBE']);
  assert.deepEqual(later.map(p => p.id), ['RW16L', 'CAVOB', 'RENBE']);
  // A plan with no procedure fixes gets the whole verified transition.
  const alone = connectorFor('sid', sid.points, ['KSEA', 'KPDX']);
  assert.deepEqual(alone.map(p => p.id), ['RW16L', 'CAVOB', 'RENBE', 'BANGR']);

  const star = procedurePath(payload, { kind: 'star', ident: 'CHINS5', runway: '16L' });
  const starPlan = connectorFor('star', star.points, ['AUBRN']);
  assert.deepEqual(starPlan.map(p => p.id), ['AUBRN', 'RW16L']);
  const starNone = connectorFor('star', star.points, ['KSEA']);
  assert.deepEqual(starNone.map(p => p.id), ['RADDY', 'AUBRN', 'RW16L']);
});

test('procedures: the shipped dataset carries the real legs from the runway to the terminal fix', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../navdata/cifp/${name}.json`, import.meta.url), 'utf8'));
  const ksea = read('KSEA');
  const sid = procedurePath(ksea, { kind: 'sid', ident: 'BANGR9', runway: '16L' });
  assert.equal(sid.ok, true);
  assert.equal(sid.points[0].id, 'RW16L', 'the SID starts at the threshold, not at the airport centre');
  assert.ok(Math.abs(sid.points[0].lat - ksea.runways['16L'].lat) < 1e-6);
  assert.deepEqual(sid.points.slice(1).map(p => p.id), ['CAVOB', 'RENBE', 'RICHR', 'TOMRE', 'BANGR']);
  assert.equal(sid.complete, true);
  assert.match(sid.source, /FAA CIFP/);
  assert.match(procedureNote(sid), /FAA CIFP dataset/, 'the card names the provider');
  // The plan draws the fixes itself, so only the runway connection is added.
  const connector = connectorFor('sid', sid.points, ['KSEA', 'CAVOB', 'RENBE', 'RICHR', 'TOMRE', 'BANGR']);
  assert.deepEqual(connector.map(p => p.id), ['RW16L', 'CAVOB']);

  const kpdx = read('KPDX');
  const star = procedurePath(kpdx, { kind: 'star', ident: 'HELNS6', runway: '10L' });
  assert.equal(star.ok, true);
  assert.equal(star.points[0].id, 'BTG');
  assert.equal(star.points[star.points.length - 1].id, 'RW10L', 'the procedure ends on the assigned runway');
  assert.equal(star.combined, true);
});

test('procedures: a procedure with no runway transition still draws its verified legs', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../navdata/cifp/${name}.json`, import.meta.url), 'utf8'));
  const klax = read('KLAX');
  // The FAA file publishes ANJLL4 as en-route transitions plus an ALL trunk and
  // no runway leg at all. The trunk is the geometry, and the runway is not
  // joined to it by a line the source never published.
  const star = procedurePath(klax, {
    kind: 'star', ident: 'ANJLL4', runway: '24R',
    routeIds: ['KLAX', 'HAKMN', 'SHTNR', 'SMASH', 'SALYY', 'GLESN', 'ANJLL'],
  });
  assert.equal(star.ok, true);
  assert.equal(star.runway, '', 'no runway is claimed');
  assert.equal(star.runwayConnector, false);
  assert.equal(star.transition, 'HAKMN+ALL', 'the branch the plan flies joins the shared trunk');
  assert.deepEqual(star.points.map(p => p.id), ['HAKMN', 'SHTNR', 'SMASH', 'SALYY', 'GLESN', 'ANJLL', 'CAANN', 'BOYEL', 'CRCUS']);
  assert.equal(star.points.some(p => String(p.id).startsWith('RW')), false, 'no threshold is invented');
  assert.match(procedureNote(star), /publishes no runway leg/);
  // The plan already draws its own STAR fixes, so only the trunk beyond them is added.
  const connector = connectorFor('star', star.points, ['KLAX', 'HAKMN', 'SHTNR', 'SMASH', 'SALYY', 'GLESN', 'ANJLL']);
  assert.deepEqual(connector.map(p => p.id), ['ANJLL', 'CAANN', 'BOYEL', 'CRCUS']);

  // Without the plan's fixes the shared trunk alone is still honest geometry.
  const trunkOnly = procedurePath(klax, { kind: 'star', ident: 'ANJLL4', runway: '24R' });
  assert.equal(trunkOnly.ok, true);
  assert.deepEqual(trunkOnly.points.map(p => p.id), ['ANJLL', 'CAANN', 'BOYEL', 'CRCUS']);

  // A SID is trunk first, then its en-route branch, and again no runway leg.
  const sid = procedurePath(klax, { kind: 'sid', ident: 'CHATY5', runway: '24R', routeIds: ['KLAX', 'CHATY', 'JOSUL', 'CASTA', 'GMN'] });
  assert.equal(sid.ok, true);
  assert.equal(sid.runwayConnector, false);
  assert.deepEqual(sid.points.map(p => p.id), ['CHATY', 'JOSUL', 'CASTA', 'GMN']);
  assert.deepEqual(connectorFor('sid', sid.points, ['KLAX', 'CHATY', 'JOSUL', 'CASTA', 'GMN']).map(p => p.id), ['CHATY'], 'a plan that draws the SID adds nothing');

  // A single trunk fix cannot make a line, so the fallback refuses instead.
  const unusable = procedurePath(klax, { kind: 'sid', ident: 'CHATY5', runway: '24R' });
  assert.equal(unusable.ok, false);
  assert.equal(unusable.reason, 'no-runway-transition');
});

test('procedures: the note states the source cycle and any missing legs', () => {
  const star = procedurePath(payload, { kind: 'star', ident: 'CHINS5', runway: '16L' });
  const note = procedureNote(star);
  assert.match(note, /CHINS5 16L transition/);
  assert.match(note, /AIRAC 2610/);
  assert.doesNotMatch(note, /FAA CIFP/, 'a simulator file is not labelled a dataset');
  assert.match(note, /combined runway transition/);
  assert.match(note, /1 leg not in the data/);
  assert.match(procedureNote({ ok: false, reason: 'no-runway-transition' }), /No published runway transition/);
});
