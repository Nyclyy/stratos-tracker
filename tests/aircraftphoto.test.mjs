import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRegistration,
  photoRequest,
  photoFromPayload,
  photoCredit,
} from '../app/js/lib/aircraftphoto.js';

const payload = {
  photos: [{
    id: '939588',
    thumbnail: { src: 'https://t.plnspttrs.net/27404/939588_t.jpg', size: { width: 200, height: 133 } },
    thumbnail_large: { src: 'https://t.plnspttrs.net/27404/939588_280.jpg', size: { width: 420, height: 280 } },
    link: 'https://www.planespotters.net/photo/939588/a7-aga-qatar-airways',
    photographer: ' Suparat Chairatprasert ',
  }],
};

test('photo: a registration is normalised, not guessed', () => {
  assert.equal(normalizeRegistration(' a7-aga '), 'A7-AGA');
  assert.equal(normalizeRegistration('n602ux'), 'N602UX');
  assert.equal(normalizeRegistration('G-TAWV'), 'G-TAWV');
  assert.equal(normalizeRegistration('D-AIMA'), 'D-AIMA');
});

test('photo: a callsign, a type code or junk is not a registration', () => {
  for (const value of ['', null, undefined, '1234', 'BAW2620', 'SWA3691', 'B738', 'N!', 'X'.repeat(20)]) {
    assert.equal(normalizeRegistration(value), '', String(value));
  }
});

test('photo: the request names the app endpoint and encodes the registration', () => {
  assert.equal(photoRequest('a7-aga'), '/api/photo?reg=A7-AGA');
  assert.equal(photoRequest('BAW2620'), '');
});

test('photo: the first published photo is used, with its credit and page link', () => {
  const photo = photoFromPayload(payload);
  assert.equal(photo.src, 'https://t.plnspttrs.net/27404/939588_280.jpg');
  assert.equal(photo.width, 420);
  assert.equal(photo.height, 280);
  assert.match(photo.link, /planespotters\.net\/photo/);
  assert.equal(photo.photographer, 'Suparat Chairatprasert');
  assert.equal(photoCredit(photo), 'Planespotters © Suparat Chairatprasert');
});

test('photo: no photo is reported as none', () => {
  assert.equal(photoFromPayload({ photos: [] }), null);
  assert.equal(photoFromPayload({}), null);
  assert.equal(photoFromPayload(null), null);
  assert.equal(photoCredit(null), '');
});

test('photo: only an https image is accepted, and a thumbnail is the fallback', () => {
  assert.equal(photoFromPayload({ photos: [{ thumbnail_large: { src: 'http://insecure/x.jpg' } }] }), null);
  const small = photoFromPayload({ photos: [{ thumbnail: { src: 'https://t.plnspttrs.net/small.jpg' } }] });
  assert.equal(small.src, 'https://t.plnspttrs.net/small.jpg');
  assert.equal(small.photographer, '');
  assert.equal(photoCredit(small), 'Planespotters.net');
});
