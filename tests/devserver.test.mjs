import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 18600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE + '/', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('dev server did not start');
}

test.before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', chunk => process.stderr.write(`[dev-server] ${chunk}`));
  await waitForServer();
});

test.after(() => { server?.kill(); });

test('dev server: serves the app shell from the app folder', async () => {
  const response = await fetch(BASE + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  const body = await response.text();
  assert.match(body, /<title>Stratos/);
});

test('dev server: serves modules with a JavaScript content type', async () => {
  const response = await fetch(BASE + '/js/lib/vatsim.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /javascript/);
  assert.match(await response.text(), /VATSIM_FEED_URL/);
});

test('dev server: the traffic proxy rejects a request with no target', async () => {
  const response = await fetch(BASE + '/api/traffic');
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unsupported traffic source/);
});

test('dev server: the traffic proxy refuses hosts outside the allowlist', async () => {
  const response = await fetch(BASE + '/api/traffic?url=' + encodeURIComponent('https://example.com/steal'));
  assert.equal(response.status, 400);
});

test('dev server: the traffic proxy refuses non-https and credential-bearing targets', async () => {
  for (const target of ['http://api.adsb.lol/v2/point/1/1/10', 'https://user:pass@api.adsb.lol/v2/point/1/1/10']) {
    const response = await fetch(BASE + '/api/traffic?url=' + encodeURIComponent(target));
    assert.equal(response.status, 400, target);
  }
});

test('dev server: the photo endpoint rejects a missing or implausible registration', async () => {
  for (const url of ['/api/photo', '/api/photo?reg=', '/api/photo?reg=BAW2620', '/api/photo?reg=1234']) {
    const response = await fetch(BASE + url);
    assert.equal(response.status, 400, url);
  }
});

test('dev server: encoded traversal cannot read files outside app', async () => {
  const response = await fetch(BASE + '/%2e%2e/package.json');
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /stratos-desktop/);
});
