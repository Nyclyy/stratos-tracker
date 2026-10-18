import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-relay-test-'));

let child;

async function startRelay() {
  child = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      RELAY_DATA_DIR: DATA_DIR,
      ALLOWED_ORIGINS: 'http://example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    if (output.includes('listening')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Relay did not start: ${output}`);
}

async function api(method, route, { token, body, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const response = await fetch(BASE + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

test('relay: pairing, ingest, read and revocation', async (t) => {
  await startRelay();
  t.after(async () => {
    if (child && !child.killed) child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const health = await api('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const paired = await api('POST', '/api/pair', { body: { name: 'Test PC' } });
  assert.equal(paired.status, 200);
  assert.equal(paired.json.code.length, 8);
  assert.ok(paired.json.desktopToken.length > 20);
  const { code, desktopToken } = paired.json;

  const snapshot = {
    ts: Date.now(), phase: 'AIRBORNE',
    telemetry: { lat: 37.6, lon: -122.3, alt: 35000, gs: 450, hdg: 90, vs: 0 },
    recent: [{ id: 'f1', depAirport: 'KSFO', arrAirport: 'KLAX' }],
    stats: { flights: 3, hours: 5.5 },
  };

  const unauthorized = await api('POST', '/api/ingest', { body: snapshot });
  assert.equal(unauthorized.status, 401);

  const ingesting = await api('POST', '/api/ingest', { token: desktopToken, body: snapshot });
  assert.equal(ingesting.status, 200);

  const waiting = await api('POST', '/api/claim', { body: { code: 'ZZZZZZZZ' } });
  assert.equal(waiting.status, 404);

  const claimed = await api('POST', '/api/claim', { body: { code: code.toLowerCase(), label: 'iPhone' } });
  assert.equal(claimed.status, 200);
  const readToken = claimed.json.readToken;
  assert.ok(readToken && readToken !== desktopToken);

  const state = await api('GET', '/api/state', { token: readToken });
  assert.equal(state.status, 200);
  assert.equal(state.json.snapshot.telemetry.alt, 35000);
  assert.equal(state.json.stale, false);
  assert.equal(state.json.devices.length, 1);

  const readCannotIngest = await api('POST', '/api/ingest', { token: readToken, body: snapshot });
  assert.equal(readCannotIngest.status, 401);
  const desktopCannotRead = await api('GET', '/api/state', { token: desktopToken });
  assert.equal(desktopCannotRead.status, 401);

  const invalidSnapshot = await api('POST', '/api/ingest', { token: desktopToken, body: { ts: 'not-a-number' } });
  assert.equal(invalidSnapshot.status, 400);
  const tooBig = await api('POST', '/api/ingest', {
    token: desktopToken,
    body: { ts: Date.now(), recent: Array.from({ length: 60 }, () => ({})) },
  });
  assert.equal(tooBig.status, 400);

  const revoked = await api('POST', '/api/revoke', { token: readToken });
  assert.equal(revoked.status, 200);
  const afterRevoke = await api('GET', '/api/state', { token: readToken });
  assert.equal(afterRevoke.status, 401);

  // A fresh phone can pair again while the code is still valid.
  const claimedAgain = await api('POST', '/api/claim', { body: { code } });
  assert.equal(claimedAgain.status, 200);

  const removed = await api('DELETE', '/api/session', { token: desktopToken });
  assert.equal(removed.status, 200);
  const gone = await api('GET', '/api/state', { token: claimedAgain.json.readToken });
  assert.equal(gone.status, 401);
});

test('relay: origin and rate limiting', async (t) => {
  await startRelay();
  t.after(async () => {
    if (child && !child.killed) child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const blocked = await api('POST', '/api/pair', { origin: 'https://evil.test', body: {} });
  assert.equal(blocked.status, 403);

  const allowed = await api('POST', '/api/pair', { origin: 'http://example.test', body: {} });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://example.test');

  let limited = false;
  for (let i = 0; i < 8; i++) {
    const response = await api('POST', '/api/pair', { body: {} });
    if (response.status === 429) limited = true;
  }
  assert.equal(limited, true, 'pairing should be rate limited');
});
