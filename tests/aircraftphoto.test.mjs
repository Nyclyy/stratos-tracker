import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRegistration,
  photoRequest,
  photoHexRequest,
  photoUpstreamUrl,
  photoFromPayload,
  photoOutcome,
  photoCredit,
  typeCode,
  representativeQuery,
  representativeCandidates,
} from '../app/js/lib/aircraftphoto.js';

const payload = {
  photos: [{
    id: '939588',
    thumbnail: { src: 'https://t.plnspttrs.net/27404/939588_t.jpg', size: { width: 200, height: 133 } },
    thumbnail_large: { src: 'https://t.plnspttrs.net/27404/939588_280.jpg', size: { width: 420, height: 280 } },
    link: 'https://www.planespotters.net/photo/939588/a7-aga-qatar-airways?utm_source=api',
    photographer: ' Suparat Chairatprasert ',
  }],
};

test('photo: a registration is normalised, not guessed', () => {
  assert.equal(normalizeRegistration(' a7-aga '), 'A7-AGA');
  assert.equal(normalizeRegistration('n602ux'), 'N602UX');
  assert.equal(normalizeRegistration('G-TAWV'), 'G-TAWV');
  assert.equal(normalizeRegistration('D-AIMA'), 'D-AIMA');
});

test('photo: an N-number that resembles a type code is still a tail number', () => {
  for (const value of ['N123', 'N1234', 'N737SW', 'N8312C', 'n8642e']) {
    assert.equal(normalizeRegistration(value), value.toUpperCase(), value);
  }
});

test('photo: a callsign, a type code or junk is not a registration', () => {
  for (const value of ['', null, undefined, '1234', 'BAW2620', 'SWA3691', 'B738', 'A320', 'N!', 'X'.repeat(20)]) {
    assert.equal(normalizeRegistration(value), '', String(value));
  }
});

test('photo: the request names the app endpoint and encodes the airframe', () => {
  assert.equal(photoRequest('a7-aga'), '/api/photo?reg=A7-AGA');
  assert.equal(photoRequest('BAW2620'), '');
  assert.equal(photoHexRequest('ab5eb2'), '/api/photo?hex=AB5EB2');
  assert.equal(photoHexRequest('ZZZZZZ'), '');
  assert.equal(photoHexRequest(''), '');
});

test('photo: the service URL is registration first, then Mode S', () => {
  assert.equal(photoUpstreamUrl({ registration: 'n8312c' }), 'https://api.planespotters.net/pub/photos/reg/N8312C');
  assert.equal(photoUpstreamUrl({ hex: 'ab5eb2' }), 'https://api.planespotters.net/pub/photos/hex/AB5EB2');
  assert.equal(
    photoUpstreamUrl({ registration: 'N8312C', hex: 'AB5EB2' }),
    'https://api.planespotters.net/pub/photos/reg/N8312C',
    'an exact registration is preferred over the address',
  );
  assert.equal(photoUpstreamUrl(), '');
});

test('photo: the first published photo is used, with its credit and unchanged page link', () => {
  const photo = photoFromPayload(payload);
  assert.equal(photo.src, 'https://t.plnspttrs.net/27404/939588_280.jpg');
  assert.equal(photo.width, 420);
  assert.equal(photo.height, 280);
  assert.equal(photo.link, payload.photos[0].link, 'the API URL is not rewritten');
  assert.equal(photo.photographer, 'Suparat Chairatprasert');
  assert.equal(photoCredit(photo), 'Planespotters © Suparat Chairatprasert');
});

test('photo: no photo is reported as none', () => {
  assert.equal(photoFromPayload({ photos: [] }), null);
  assert.equal(photoFromPayload({}), null);
  assert.equal(photoFromPayload(null), null);
  assert.equal(photoCredit(null), '');
});

test('representative: a callsign operator and ICAO type form a backup query', () => {
  assert.equal(typeCode(' b738 '), 'B738');
  assert.equal(typeCode('A 320'), 'A320');
  assert.equal(typeCode('Airbus A350-900'), 'A359');
  assert.equal(typeCode('Boeing 737-800'), 'B738');
  assert.equal(typeCode('B737-800'), 'B738');
  assert.equal(typeCode('A320neo'), 'A20N');
  assert.equal(typeCode('Boeing 777-300ER'), 'B77W');
  for (const value of ['', null, '1234', 'Boeing', 'A']) {
    assert.equal(typeCode(value), '', String(value));
  }
  assert.deepEqual(representativeQuery({ callsign: ' SWA 1234 ', type: 'b738' }), {
    designator: 'SWA', type: 'B738', key: 'SWA|B738', url: 'https://api.adsb.lol/v2/type/B738',
  });
  assert.equal(representativeQuery({ callsign: 'N8312C', type: 'B738' }), null, 'a registration is not a callsign');
  assert.equal(representativeQuery({ callsign: 'SWA1234', type: 'Boeing 737-800' }).type, 'B738', 'a marketing name is mapped to its ICAO designator');
  assert.equal(representativeQuery({ callsign: 'SWA1234' }), null);
});

test('representative: only a live aircraft of the operator and type with a registration is offered', () => {
  const query = representativeQuery({ callsign: 'SWA1234', type: 'B738' });
  const list = representativeCandidates([
    { flight: 'UAL123', r: 'N1UA', t: 'B738' },
    { flight: 'SWA123', t: 'B738' },
    { flight: 'SWA274', r: 'n8317m', t: 'B738' },
    { flight: 'SWA275', r: 'N8318M', t: 'B739' },
  ], query);
  assert.deepEqual(list, [{
    registration: 'N8317M', callsign: 'SWA274', type: 'B738', designator: 'SWA', key: 'SWA|B738',
  }]);
  assert.deepEqual(representativeCandidates([{ id: 'SWA274', reg: 'N8317M', type: 'B738' }], query), [{
    registration: 'N8317M', callsign: 'SWA274', type: 'B738', designator: 'SWA', key: 'SWA|B738',
  }]);
});

test('representative: a raw ADS-B record reads the airframe type from t', () => {
  const query = representativeQuery({ callsign: 'DLH505', type: 'A350-900' });
  assert.equal(query.type, 'A359');
  const list = representativeCandidates([
    { flight: 'DLH458  ', r: 'D-AIXJ', t: 'A359', type: 'adsb_icao' },
    { flight: 'DLH505  ', r: 'D-AIXF', t: 'A359', type: 'adsb_icao' },
  ], query);
  assert.deepEqual(list.map(item => item.registration), ['D-AIXJ', 'D-AIXF'], 'the message type is not the airframe type');
});

test('representative: every distinct matching registration is offered for the random pick', () => {
  const query = representativeQuery({ callsign: 'SWA1234', type: 'B738' });
  const list = representativeCandidates([
    { flight: 'SWA274', r: 'N8317M', t: 'B738' },
    { flight: 'SWA275', r: 'n8317m', t: 'B738' },
    { flight: 'SWA276', r: 'N8318M', t: 'B738' },
    { flight: 'SWA277', r: 'N8319M', t: 'B739' },
    { flight: 'UAL274', r: 'N1UA', t: 'B738' },
  ], query);
  assert.deepEqual(list.map(item => item.registration), ['N8317M', 'N8318M'], 'one entry per real aircraft');
});

test('representative: another operator, another type or no registration is not a backup', () => {
  const query = representativeQuery({ callsign: 'SWA1234', type: 'B738' });
  for (const records of [
    [],
    null,
    [{ flight: 'UAL274', r: 'N8317M', t: 'B738' }],
    [{ flight: 'SWA274', r: 'N8317M', t: 'B739' }],
    [{ flight: 'SWA274', t: 'B738' }],
    [{ flight: 'SWAT274', r: 'N8317M', t: 'B738' }],
  ]) {
    assert.deepEqual(representativeCandidates(records, query), [], JSON.stringify(records));
  }
  assert.deepEqual(representativeCandidates([{ flight: 'SWA274', r: 'N8317M', t: 'B738' }], null), []);
});

test('photo: a missing route is not the same answer as a missing photo', () => {
  assert.equal(photoOutcome(404, null).state, 'unavailable');
  assert.equal(photoOutcome(502, null).state, 'unavailable');
  assert.equal(photoOutcome(0, null).state, 'unavailable');
  assert.equal(photoOutcome(200, { photos: [] }).state, 'none');
  const found = photoOutcome(200, payload);
  assert.equal(found.state, 'ok');
  assert.match(found.photo.src, /plnspttrs\.net/);
});

test('photo: only an https image is accepted, and a thumbnail is the fallback', () => {
  const link = 'https://www.planespotters.net/photo/1/x';
  assert.equal(photoFromPayload({ photos: [{ thumbnail_large: { src: 'http://insecure/x.jpg' }, link }] }), null);
  const small = photoFromPayload({ photos: [{ thumbnail: { src: 'https://t.plnspttrs.net/small.jpg' }, link }] });
  assert.equal(small.src, 'https://t.plnspttrs.net/small.jpg');
  assert.equal(small.photographer, '');
  assert.equal(photoCredit(small), 'Planespotters.net');
});

test('photo: a photo without a Planespotters page is not shown at all', () => {
  for (const link of ['javascript:alert(1)', 'https://example.com/photo/1', 'http://www.planespotters.net/photo/1', '']) {
    assert.equal(photoFromPayload({ photos: [{ thumbnail_large: { src: 'https://t.plnspttrs.net/x.jpg' }, link }] }), null, link);
  }
  const shown = photoFromPayload({ photos: [{ thumbnail_large: { src: 'https://t.plnspttrs.net/x.jpg' }, link: 'https://planespotters.net/photo/1' }] });
  assert.equal(shown.link, 'https://planespotters.net/photo/1');
});
