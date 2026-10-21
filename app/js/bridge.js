/* Client for the local Stratos bridge.
   The bridge only listens on the local machine or LAN and requires its access
   token for remote requests. A hosted HTTPS page cannot call an HTTP LAN
   address (mixed content), so hosted pages use the relay for live telemetry. */

import { getResourceProfile, parseTelemetry, streamUrl } from './lib/telemetry.js';
import { mergeFlights } from './lib/store.js';

export class BridgeAuthError extends Error {
  constructor(message = 'The bridge needs its access token.') { super(message); this.name = 'BridgeAuthError'; }
}

export function defaultBridgeBase() {
  try {
    const url = new URL(window.location.href);
    if (url.protocol === 'file:') return 'http://127.0.0.1:8765';
    if (url.port === '8765') return url.origin;
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return 'http://127.0.0.1:8765';
    if (url.protocol === 'http:' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) return url.origin;
  } catch (_) {}
  return 'http://127.0.0.1:8765';
}

export function isHostedPage() {
  return location.protocol === 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
}

async function readJsonResponse(response) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (response.status === 401 || response.status === 403) throw new BridgeAuthError();
    throw new Error(`Bridge returned ${response.status} (${type || 'unknown content'}).`);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data && data.error ? data.error : `Bridge returned ${response.status}.`);
  return data;
}

async function request(base, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 4000);
  try {
    const response = await fetch(String(base).replace(/\/+$/, '') + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: location.protocol === 'file:' ? 'omit' : 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    return await readJsonResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The bridge did not answer in time. Is it running?');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function bridgeHealth(base = defaultBridgeBase(), timeout = 2500) {
  return request(base, '/health', { timeout });
}

export async function syncLogbook(base = defaultBridgeBase()) {
  const flights = await request(base, '/logbook.json', { timeout: 8000 });
  if (!Array.isArray(flights)) throw new Error('The bridge returned an unexpected logbook.');
  const result = await mergeFlights(flights);
  return { ...result, remoteCount: flights.length };
}

export async function relayStatus(base = defaultBridgeBase()) {
  return request(base, '/relay/status', { timeout: 3000 });
}

export async function pairRelay(url, name, base = defaultBridgeBase()) {
  return request(base, '/relay/pair', { method: 'POST', body: { url, name }, timeout: 20000 });
}

/* ── Local phone pairing ──────────────────────────────────────────
   /pair/new is loopback-only: the QR code is created on the PC and the phone
   exchanges its short-lived token for the bridge cookie. */

export async function newPairing(base = defaultBridgeBase()) {
  return request(base, '/pair/new', { timeout: 8000 });
}

export async function pairingStatus(base = defaultBridgeBase()) {
  return request(base, '/pair/status', { timeout: 5000 });
}

export async function revokePairing(base = defaultBridgeBase()) {
  return request(base, '/pair/revoke', { method: 'POST', body: {}, timeout: 8000 });
}

export async function forgetPairedPhone(id, base = defaultBridgeBase()) {
  return request(base, '/pair/forget-client', { method: 'POST', body: { id }, timeout: 8000 });
}

/** Used by the phone: removes this phone's pairing and clears its cookie. */
export async function forgetThisPhone(base = defaultBridgeBase()) {
  return request(base, '/pair/self-revoke', { method: 'POST', body: {}, timeout: 8000 });
}

export async function pushChecklist(state, base = defaultBridgeBase()) {
  return request(base, '/checklist', { method: 'POST', body: state, timeout: 5000 });
}

export async function unpairRelay(base = defaultBridgeBase()) {
  return request(base, '/relay/revoke', { method: 'POST', body: {}, timeout: 10000 });
}

export async function relayDevices(base = defaultBridgeBase()) {
  return request(base, '/relay/devices', { timeout: 12000 });
}

export async function revokeRelayDevice(id, base = defaultBridgeBase()) {
  return request(base, '/relay/devices/revoke', { method: 'POST', body: { id }, timeout: 12000 });
}

export async function saveAircraftIdentity(identity, base = defaultBridgeBase()) {
  return request(base, '/config', { method: 'POST', body: identity, timeout: 4000 });
}

/** EventSource wrapper with explicit states and a bounded reconnect backoff. */
export class TelemetryClient {
  constructor({ base = defaultBridgeBase(), mode = 'normal', onTelemetry, onStatus } = {}) {
    this.base = base;
    this.mode = mode;
    this.onTelemetry = onTelemetry || (() => {});
    this.onStatus = onStatus || (() => {});
    this.source = null;
    this.state = 'disconnected';
    this.retry = 0;
    this.timer = null;
    this.lastData = null;
    this.closed = false;
    this.onVisibility = () => {
      if (document.hidden) this.pause();
      else this.resume();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setStatus(state, detail = '') {
    this.state = state;
    this.onStatus({ state, detail, lastData: this.lastData });
  }

  connect() {
    this.closed = false;
    if (isHostedPage()) {
      // An HTTPS page cannot open an HTTP connection to 127.0.0.1. Do not
      // create a mixed-content retry loop; the relay is the supported path.
      this.setStatus('disconnected', 'A hosted page cannot reach the local bridge. Pair a phone through the relay.');
      return;
    }
    this.open();
  }

  open() {
    if (this.closed) return;
    if (isHostedPage()) {
      this.setStatus('disconnected', 'A hosted page cannot reach the local bridge. Pair a phone through the relay.');
      return;
    }
    this.closeSource();
    this.setStatus('connecting');
    const profile = getResourceProfile(this.mode);
    try {
      this.source = new EventSource(streamUrl(this.base, this.mode));
    } catch (error) {
      this.setStatus('error', error.message);
      this.scheduleReconnect();
      return;
    }
    this.source.onopen = () => {
      this.retry = 0;
      this.setStatus('connected');
    };
    this.source.onmessage = event => {
      let raw;
      try { raw = JSON.parse(event.data); } catch (_) { return; }
      this.lastData = raw;
      const telemetry = parseTelemetry(raw);
      this.onTelemetry({ raw, telemetry, phase: raw.flightPhase, currentFlight: raw.currentFlight });
    };
    this.source.onerror = () => {
      this.closeSource();
      this.setStatus(navigator.onLine ? 'reconnecting' : 'offline');
      this.scheduleReconnect();
    };
    // Fallback poll rate hint: EventSource sends at the bridge rate; if the
    // bridge predates the hz parameter it will still work at its default rate.
    void profile;
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    if (this.closed) return;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.retry++, 4));
    this.timer = setTimeout(() => this.open(), delay);
  }

  closeSource() {
    if (this.source) {
      this.source.onopen = null;
      this.source.onmessage = null;
      this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
  }

  pause() {
    this.closeSource();
    this.setStatus('paused');
  }

  resume() {
    if (!this.closed && this.state === 'paused') this.open();
  }

  setMode(mode) {
    this.mode = mode;
    if (!this.closed) this.open();
  }

  disconnect() {
    this.closed = true;
    clearTimeout(this.timer);
    this.closeSource();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.setStatus('disconnected');
  }
}

/** Poll a relay for a paired phone. */
export class RelayClient {
  constructor({ url, token, onState, onStatus, intervalMs = 3000 } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = token;
    this.onState = onState || (() => {});
    this.onStatus = onStatus || (() => {});
    this.intervalMs = intervalMs;
    this.timer = null;
    this.failures = 0;
    this.closed = false;
  }

  async poll() {
    if (this.closed) return;
    const timerStart = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${this.url}/api/state`, {
        headers: { Authorization: `Bearer ${this.token}` },
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.status === 401) {
        this.onStatus({ state: 'unpaired', detail: 'Pairing expired or was revoked.' });
        this.stop();
        return;
      }
      if (!response.ok) throw new Error(`Relay returned ${response.status}.`);
      const state = await response.json();
      this.failures = 0;
      this.onState(state);
      this.onStatus({
        state: state.waiting ? 'waiting' : state.stale ? 'stale' : 'connected',
        detail: state.stale ? 'The desktop has not sent new telemetry recently.' : '',
      });
    } catch (error) {
      this.failures++;
      this.onStatus({
        state: navigator.onLine ? 'error' : 'offline',
        detail: error.name === 'AbortError' ? 'Relay timed out.' : error.message,
      });
    } finally {
      if (!this.closed) {
        const elapsed = Date.now() - timerStart;
        this.timer = setTimeout(() => this.poll(), Math.max(1200, this.intervalMs - elapsed));
      }
    }
  }

  start() {
    this.closed = false;
    this.onStatus({ state: 'connecting' });
    this.poll();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

export async function claimRelay(url, code, label) {
  const response = await fetch(String(url).replace(/\/+$/, '') + '/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Relay returned ${response.status}.`);
  return data;
}
