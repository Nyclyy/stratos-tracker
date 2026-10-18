import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTTP_PORT = 18000 + Math.floor(Math.random() * 500);
const UDP_PORT = 50000 + Math.floor(Math.random() * 1000);
const RELAY_PORT = 19500 + Math.floor(Math.random() * 300);
const BRIDGE = `http://127.0.0.1:${HTTP_PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-bridge-it-'));
const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-relay-it-'));
const children = [];
let bridge;
let relay;

function python() {
  return process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

async function waitFor(fn, timeoutMs = 30000, interval = 300) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw lastError || new Error('Timed out waiting for condition');
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

test.before(async () => {
  bridge = spawn(python(), [path.join(ROOT, 'stratos_bridge.py')], {
    cwd: ROOT,
    env: {
      ...process.env,
      STRATOS_HTTP_PORT: String(HTTP_PORT),
      STRATOS_UDP_PORT: String(UDP_PORT),
      STRATOS_HOST: '127.0.0.1',
      STRATOS_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(bridge);
  bridge.stdout.on('data', () => {});
  bridge.stderr.on('data', chunk => { process.stderr.write(`[bridge] ${chunk}`); });
  relay = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(RELAY_PORT),
      HOST: '127.0.0.1',
      RELAY_DATA_DIR: relayDir,
      ALLOWED_ORIGINS: '*',
      RELAY_PERSIST: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(relay);
  relay.stdout.on('data', () => {});
  relay.stderr.on('data', chunk => { process.stderr.write(`[relay] ${chunk}`); });
  await waitFor(async () => (await getJson(`${BRIDGE}/health`)).body?.ok, 30000);
  await waitFor(async () => (await getJson(`${RELAY}/health`)).body?.ok, 15000);
});

test.after(async () => {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  await Promise.race([
    Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit') : null)),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(relayDir, { recursive: true, force: true });
});

test('bridge serves health, the app shell and the SSE stream', async () => {
  const health = (await getJson(`${BRIDGE}/health`)).body;
  assert.equal(health.ok, true);
  assert.ok(health.version);
  assert.equal(health.ports.http, HTTP_PORT);
  assert.equal(health.auth.remoteTokenRequired, true);

  const page = await fetch(`${BRIDGE}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  const html = await page.text();
  assert.match(html, /Stratos/);
  assert.match(html, /id="map"/);
  assert.doesNotMatch(html, /app\/icon-192\.png/);

  const css = await fetch(`${BRIDGE}/pilot.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);

  const controller = new AbortController();
  const stream = await fetch(`${BRIDGE}/stream?hz=2`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
  const reader = stream.body.getReader();
  const chunk = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timed out')), 8000)),
  ]);
  controller.abort();
  const text = new TextDecoder().decode(chunk.value || new Uint8Array());
  assert.match(text, /^data: \{/);
  const payload = JSON.parse(text.replace(/^data: /, '').trim());
  assert.equal(typeof payload.flightPhase, 'string');
});

test('bridge pairing reaches the relay and delivers a real snapshot to a phone token', async () => {
  const pair = await getJson(`${BRIDGE}/relay/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: RELAY, name: 'Integration bridge' }),
  });
  assert.equal(pair.response.status, 200, JSON.stringify(pair.body));
  assert.equal(pair.body.ok, true);
  assert.equal(pair.body.code.length, 8);

  const claim = await getJson(`${RELAY}/api/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pair.body.code, label: 'Integration iPhone' }),
  });
  assert.equal(claim.response.status, 200, JSON.stringify(claim.body));
  assert.ok(claim.body.readToken);

  const state = await waitFor(async () => {
    const result = await getJson(`${RELAY}/api/state`, {
      headers: { Authorization: `Bearer ${claim.body.readToken}` },
    });
    return result.body?.snapshot ? result.body : null;
  }, 25000);
  assert.ok(state.snapshot.ts);
  assert.ok(state.snapshot.bridgeVersion);
  assert.ok(Array.isArray(state.snapshot.recent));
  assert.equal(state.stale, false);

  const revoked = await getJson(`${RELAY}/api/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${claim.body.readToken}` },
  });
  assert.equal(revoked.response.status, 200);

  const rejected = await fetch(`${RELAY}/api/state`, {
    headers: { Authorization: `Bearer ${claim.body.readToken}` },
  });
  assert.equal(rejected.status, 401);
});
