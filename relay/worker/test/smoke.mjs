/**
 * The Worker relay, exercised in plain Node against the same HTTP contract as
 * relay/server.mjs. Run with: node relay/worker/test/smoke.mjs
 *
 * Node 18+ provides Request, Response, crypto.subtle and btoa, so the Durable
 * Object class can be driven directly with a storage stub — no Wrangler, no
 * wrangler dev, no network.
 */
import assert from 'node:assert/strict';

const { RelaySessions } = await import('../src/index.js');

function storageStub() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, value); },
    async setAlarm() {},
  };
}

const base = 'https://relay.test';
const relay = new RelaySessions({ storage: storageStub() }, { ALLOWED_ORIGINS: '*' });

async function call(method, path, { body, token, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  if (token) init.headers.authorization = `Bearer ${token}`;
  const response = await relay.fetch(new Request(base + path, init));
  const payload = await response.json();
  return { status: response.status, payload, headers: response.headers };
}

// 1. Health says what service this is.
const health = await call('GET', '/health');
assert.equal(health.status, 200);
assert.equal(health.payload.service, 'stratos-relay');
assert.equal(health.payload.runtime, 'cloudflare-workers');

// 2. A desktop pairs, then nobody can read without a token.
const pair = await call('POST', '/api/pair', { body: { name: 'PC' } });
assert.equal(pair.status, 200);
assert.match(pair.payload.code, /^[A-HJ-NP-Z2-9]{8}$/);
assert.ok(pair.payload.desktopToken.length >= 40);
const { code, desktopToken } = pair.payload;

assert.equal((await call('GET', '/api/state')).status, 401, 'no token is refused');
assert.equal((await call('GET', '/api/state', { token: desktopToken })).status, 401, 'a desktop token cannot read as a phone');

// 3. The desktop pushes a snapshot; the phone claims the code and reads it.
const snapshot = {
  ts: Date.now(),
  telemetry: { lat: 45.4701, lon: -73.7401, alt: 35000, gs: 452, hdg: 270 },
  flight: { phase: 'cruise' },
};
const ingest = await call('POST', '/api/ingest', { body: snapshot, token: desktopToken });
assert.equal(ingest.status, 200);

const claim = await call('POST', '/api/claim', { body: { code, label: 'iPhone' } });
assert.equal(claim.status, 200);
const readToken = claim.payload.readToken;
assert.ok(readToken && readToken !== desktopToken);

const state = await call('GET', '/api/state', { token: readToken });
assert.equal(state.status, 200);
assert.equal(state.payload.snapshot.telemetry.alt, 35000);
assert.equal(state.payload.stale, false);
assert.equal(state.payload.devices.length, 1);

// A second claim of the same code is allowed while it is valid (the PC shows the
// same code until it expires), but a read token cannot ingest.
assert.equal((await call('POST', '/api/ingest', { body: snapshot, token: readToken })).status, 401);

// 4. Traffic: list and per-aircraft trail, with the bridge's dedupe rules.
const now = Date.now();
const traffic = await call('POST', '/api/traffic', {
  token: desktopToken,
  body: {
    list: [{ id: 'A1B2C3', lat: 45.5, lon: -73.6, alt: 12000, gs: 300, hdg: 90 }],
    points: [
      ['A1B2C3', 45.50, -73.60, 12000, now - 4000],
      ['A1B2C3', 45.51, -73.59, 13000, now - 2000],
      ['A1B2C3', 45.51, -73.59, 13000, now - 1000],
    ],
  },
});
assert.equal(traffic.status, 200);
assert.equal(traffic.payload.added, 2, 'the repeated position is not stored twice');
assert.equal(traffic.payload.aircraft, 1);

const list = await call('GET', '/api/traffic', { token: readToken });
assert.equal(list.payload.list.length, 1);
assert.equal(list.payload.stale, false);
const trail = await call('GET', '/api/traffic?hex=a1b2c3', { token: readToken });
assert.equal(trail.payload.hex, 'A1B2C3');
assert.equal(trail.payload.points.length, 2);

// 5. Devices and revocation.
const devices = await call('GET', '/api/devices', { token: desktopToken });
assert.equal(devices.payload.devices.length, 1);
const deviceId = devices.payload.devices[0].id;
assert.equal((await call('POST', '/api/devices/revoke', { body: { id: deviceId }, token: desktopToken })).status, 200);
assert.equal((await call('GET', '/api/state', { token: readToken })).status, 401, 'a revoked phone loses access immediately');

// 6. Session revoke disconnects the desktop too.
const pair2 = await call('POST', '/api/pair', { body: { name: 'PC 2' } });
assert.equal((await call('DELETE', '/api/session', { token: pair2.payload.desktopToken })).status, 200);
assert.equal((await call('POST', '/api/ingest', { body: snapshot, token: pair2.payload.desktopToken })).status, 401);

// 7. Bad input is refused, not stored.
const pair3 = await call('POST', '/api/pair', { body: { name: 'PC 3' } });
assert.equal((await call('POST', '/api/ingest', { body: { telemetry: {} }, token: pair3.payload.desktopToken })).status, 400);
assert.equal((await call('POST', '/api/claim', { body: { code: 'ZZZZZZZZ' } })).status, 404);
assert.equal((await call('GET', '/nope')).status, 404);

// 8. Pairing state survives a reload of the object (what storage is for).
const reloaded = new RelaySessions({ storage: relay.state.storage }, { ALLOWED_ORIGINS: '*' });
const afterReload = await reloaded.fetch(new Request(base + '/api/state', {
  headers: { authorization: 'Bearer ' + pair.payload.desktopToken },
}));
assert.equal(afterReload.status, 401, 'a desktop token still cannot read as a phone');
const devicesAfterReload = await reloaded.fetch(new Request(base + '/api/devices', {
  headers: { authorization: 'Bearer ' + pair.payload.desktopToken },
}));
const devicesPayload = await devicesAfterReload.json();
assert.equal(devicesPayload.ok, true, 'the desktop token was restored from storage');

console.log('worker relay smoke: all checks passed');
