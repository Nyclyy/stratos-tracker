import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_PORT, blocksLocalBridge, bridgeCandidates, bridgeOrigin, connectionHelp,
  connectStatus, findBridge, isPrivateHost, phoneConnectUrl, probeBridge,
} from '../app/js/lib/connect.js';

test('a phone on a hosted page is given the bridge name, not a loopback address', () => {
  const candidates = bridgeCandidates({ protocol: 'https:', hostname: 'stratos.app', port: '', saved: '' });
  assert.equal(candidates[0], `http://stratos.local:${BRIDGE_PORT}`);
  assert.ok(!candidates[0].includes('127.0.0.1'), 'a loopback address on a phone is the phone itself');
  assert.ok(candidates.includes('http://127.0.0.1:8765'), 'the desktop still gets its own bridge option');
});

test('a saved bridge is tried before discovery, and candidates never repeat', () => {
  const candidates = bridgeCandidates({
    protocol: 'https:', hostname: 'stratos.app', port: '', saved: 'http://192.168.0.42:8765/',
  });
  assert.equal(candidates[0], 'http://192.168.0.42:8765');
  assert.equal(new Set(candidates).size, candidates.length);
});

test('a page the bridge itself serves probes its own origin first', () => {
  const candidates = bridgeCandidates({ protocol: 'http:', hostname: 'stratos.local', port: '8765' });
  assert.equal(candidates[0], 'http://stratos.local:8765');
});

test('origins are normalised, and nonsense is refused', () => {
  assert.equal(bridgeOrigin('192.168.1.9'), 'http://192.168.1.9:8765');
  assert.equal(bridgeOrigin('http://192.168.1.9:9000/health'), 'http://192.168.1.9:9000');
  assert.equal(bridgeOrigin(''), '');
  assert.equal(bridgeOrigin('not a host:'), '');
});

test('private networks are recognised, public ones are not', () => {
  for (const host of ['stratos.local', 'localhost', '127.0.0.1', '10.1.2.3', '192.168.1.20', '172.16.0.9', '172.31.5.4', '169.254.10.1']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['stratos.app', '8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.9']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('an HTTPS page cannot call an HTTP bridge, and says so', () => {
  assert.equal(blocksLocalBridge({ protocol: 'https:', hostname: 'stratos.app' }), true);
  assert.equal(blocksLocalBridge({ protocol: 'http:', hostname: 'stratos.local' }), false);
  assert.equal(blocksLocalBridge({ protocol: 'https:', hostname: 'localhost' }), false);
  assert.equal(phoneConnectUrl(), 'http://stratos.local:8765/pair/connect');
});

test('a healthy bridge is found, and the first answer wins', async () => {
  const asked = [];
  const fetchImpl = async url => {
    asked.push(url);
    if (!url.startsWith('http://192.168.1.9:8765')) throw new Error('unreachable');
    return { ok: true, status: 200, json: async () => ({ ok: true, version: '2.1.20' }) };
  };
  const found = await findBridge(['http://10.0.0.2:8765', 'http://192.168.1.9:8765'], { fetchImpl, timeout: 50 });
  assert.equal(found.ok, true);
  assert.equal(found.base, 'http://192.168.1.9:8765');
  assert.equal(found.health.version, '2.1.20');
  assert.equal(asked[0], 'http://10.0.0.2:8765/health', 'the first candidate is tried first');
  assert.ok(asked.indexOf('http://192.168.1.9:8765/health') > 0, 'the second is tried after the first fails');
  assert.ok(asked.every(url => /8765\/health$/.test(url)), 'only health is probed, nothing else');
});

test('a bridge on another origin is found through an opaque request', async () => {
  // The bridge sends no CORS header, so the readable request is refused; the
  // opaque one still proves it answered, and the phone then navigates to it.
  const result = await probeBridge('http://192.168.1.9:8765', {
    fetchImpl: async (url, options) => {
      if (options && options.mode === 'no-cors') return { type: 'opaque', ok: false, status: 0 };
      throw new TypeError('Failed to fetch');
    },
    timeout: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthorized');
  assert.equal(result.opaque, true);
  assert.equal(result.base, 'http://192.168.1.9:8765');
});

test('a bridge that answers 401 is reported as needing pairing, not as absent', async () => {
  const result = await probeBridge('http://192.168.1.9:8765', {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    timeout: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthorized');
  const found = await findBridge(['http://192.168.1.9:8765', 'http://stratos.local:8765'], {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    timeout: 50,
  });
  assert.equal(found.reason, 'unauthorized', 'the phone must open that bridge to enroll, not skip it');
});

test('nothing answering is a reachable answer too', async () => {
  const result = await probeBridge('http://stratos.local:8765', {
    fetchImpl: async () => { throw new Error('failed to fetch'); },
    timeout: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bridge-offline');
  assert.equal(bridgeOrigin(result.base), 'http://stratos.local:8765');
});

test('every failure has a next step, not just an error', () => {
  for (const reason of ['mixed-content', 'unauthorized', 'no-simulator', 'offline', 'bridge-offline', 'anything-else']) {
    const text = connectionHelp(reason);
    assert.ok(text.length > 40, reason);
    assert.doesNotMatch(text, /undefined|\[object/i);
  }
  assert.match(connectionHelp('bridge-offline'), /firewall/i);
  assert.match(connectionHelp('mixed-content'), /HTTPS/);
});

test('the status line covers the states a phone actually shows', () => {
  assert.deepEqual(connectStatus('connecting'), { dot: 'connecting', text: 'Connecting…' });
  assert.deepEqual(connectStatus('connected'), { dot: 'connected', text: 'Live' });
  assert.deepEqual(connectStatus('reconnecting'), { dot: 'connecting', text: 'Reconnecting…' });
  assert.deepEqual(connectStatus('disconnected'), { dot: 'disconnected', text: 'Disconnected' });
  assert.equal(connectStatus('nonsense').text, 'Disconnected');
});
