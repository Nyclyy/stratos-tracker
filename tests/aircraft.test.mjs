import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { identifyAircraft, normaliseType, IMAGES } from '../app/js/lib/aircraft.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('aircraft: the simulator type wins over SimBrief and the profile', () => {
  const found = identifyAircraft({ simulator: 'B738', simbrief: 'A321', profile: 'C172' });
  assert.equal(found.source, 'simulator');
  assert.equal(found.type, 'B738');
  assert.equal(found.name, 'Boeing 737-800');
});

test('aircraft: SimBrief is used when there is no simulator type, then the profile', () => {
  assert.equal(identifyAircraft({ simbrief: 'a321' }).source, 'simbrief');
  assert.equal(identifyAircraft({ simbrief: 'a321' }).name, 'Airbus A321');
  assert.equal(identifyAircraft({ profile: 'C172' }).source, 'profile');
});

test('aircraft: a type we have no picture for keeps its code and gets the generic silhouette', () => {
  const found = identifyAircraft({ simbrief: 'C550' });
  assert.equal(found.known, false);
  assert.equal(found.name, 'C550');
  assert.equal(found.image, IMAGES.generic);
});

test('aircraft: nothing reported means nothing is shown, never a guessed aircraft', () => {
  const found = identifyAircraft({});
  assert.equal(found.type, null);
  assert.equal(found.image, null);
  assert.equal(found.name, null);
});

test('aircraft: type codes are normalised before lookup', () => {
  assert.equal(normaliseType(' a-321 '), 'A321');
  assert.equal(normaliseType(null), '');
  assert.equal(identifyAircraft({ simbrief: ' b77w ' }).name, 'Boeing 777-300ER');
});

test('aircraft: common ICAO codes map to their own silhouette family', () => {
  assert.equal(identifyAircraft({ simbrief: 'A388' }).image, IMAGES.a380);
  assert.equal(identifyAircraft({ simbrief: 'A359' }).sprite.name, 'A359');
  assert.equal(identifyAircraft({ simbrief: 'B77W' }).image, IMAGES.b777);
  assert.equal(identifyAircraft({ simbrief: 'B748' }).image, IMAGES.b747);
  assert.equal(identifyAircraft({ simbrief: 'A346' }).sprite.name, 'A346');
  assert.equal(identifyAircraft({ simbrief: 'A320' }).sprite.name, 'A320');
  assert.notDeepEqual(identifyAircraft({ simbrief: 'A321' }).sprite.ids, identifyAircraft({ simbrief: 'A320' }).sprite.ids);
});

test('aircraft: every bundled image exists on disk', () => {
  for (const [key, file] of Object.entries(IMAGES)) {
    const full = path.join(root, 'app', file);
    assert.ok(fs.existsSync(full), `${key} image is missing: ${file}`);
  }
});
