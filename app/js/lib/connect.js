/* Finding the PC from a phone.
 *
 * A browser cannot scan the local network: no web API enumerates hosts, and a
 * page served over HTTPS cannot fetch an HTTP LAN address (mixed content).
 * What it *can* do is follow one top-level navigation to a name the bridge
 * answers for itself over multicast DNS. So the phone taps Connect, the page
 * navigates to http://stratos.local:8765/pair/connect, and the bridge enrolls
 * the phone there and sends it to the live dashboard. Nothing is typed.
 *
 * The helpers here hold only those decisions, so they can be tested without a
 * browser: which origins to try, how a probe is judged, and what to tell the
 * user when the answer is no.
 */

export const MDNS_HOST = 'stratos.local';
export const BRIDGE_PORT = 8765;
export const PAIR_PATH = '/pair/connect';
export const BRIDGE_STORAGE_KEY = 'stratos.bridgeUrl';

/** Normalise a host or URL to the bridge origin, or an empty string. */
export function bridgeOrigin(value, port = BRIDGE_PORT) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (port && !url.port) url.port = String(port);
    return url.origin;
  } catch (_) {
    return '';
  }
}

export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === MDNS_HOST) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match = /^172\.(\d{1,2})\./.exec(host);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  if (/^169\.254\./.test(host)) return true;
  return false;
}

/** The URL the phone should open to enroll itself, without a code. */
export function phoneConnectUrl(host = MDNS_HOST, port = BRIDGE_PORT) {
  return `http://${host}:${port}${PAIR_PATH}`;
}

/**
 * Bridge origins to probe, best first. A saved origin is tried before
 * discovery, because a phone that has connected before knows where the PC is
 * even when multicast DNS is unavailable on the network.
 */
export function bridgeCandidates({ protocol, hostname, port, saved } = {}) {
  const list = [];
  const add = value => {
    const origin = bridgeOrigin(value);
    if (origin && !list.includes(origin)) list.push(origin);
  };
  add(saved);
  const onBridge = String(protocol || '') === 'http:' && String(port || '') === String(BRIDGE_PORT);
  if (onBridge && hostname) add(`http://${hostname}:${BRIDGE_PORT}`);
  if (String(protocol || '') === 'http:' && isPrivateHost(hostname)) add(`http://${hostname}:${BRIDGE_PORT}`);
  add(`http://${MDNS_HOST}:${BRIDGE_PORT}`);
  add(`http://127.0.0.1:${BRIDGE_PORT}`);
  add(`http://localhost:${BRIDGE_PORT}`);
  return list;
}

/** True when this page cannot call an HTTP bridge even if it is there. */
export function blocksLocalBridge({ protocol, hostname } = {}) {
  if (String(protocol || '') !== 'https:') return false;
  return !isPrivateHost(hostname) && hostname !== 'localhost' && hostname !== '127.0.0.1';
}

/**
 * Ask one bridge whether it is there. Returns a result rather than throwing so
 * the caller can report the first honest reason: unreachable, unauthorised or
 * a bridge with no simulator behind it.
 */
export async function probeBridge(base, { fetchImpl = globalThis.fetch, timeout = 1600 } = {}) {
  const origin = bridgeOrigin(base);
  if (!origin) return { ok: false, reason: 'bridge-offline', base: '' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'bridge-offline', base: origin };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const response = await fetchImpl(`${origin}/health`, {
      cache: 'no-store',
      credentials: 'include',
      signal: controller ? controller.signal : undefined,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized', base: origin };
    }
    if (!response.ok) return { ok: false, reason: 'bridge-offline', base: origin, status: response.status };
    let health = null;
    try { health = await response.json(); } catch (_) { health = null; }
    if (!health || !health.ok) return { ok: false, reason: 'bridge-offline', base: origin };
    return { ok: true, base: origin, health };
  } catch (_) {
    const offline = typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
    if (offline) return { ok: false, reason: 'offline', base: origin };
    // A bridge on another origin sends no CORS header, so reading /health is
    // refused even when the bridge is right there. An opaque request still
    // proves something answered; the phone then opens that origin's pairing
    // page, which is a navigation and needs no CORS at all.
    try {
      await fetchImpl(`${origin}/health`, { mode: 'no-cors', cache: 'no-store' });
      return { ok: false, reason: 'unauthorized', base: origin, opaque: true };
    } catch (_) {
      return { ok: false, reason: 'bridge-offline', base: origin };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe candidates in order and stop at the first bridge that answers. */
export async function findBridge(candidates, options = {}) {
  const tried = [];
  for (const base of candidates || []) {
    const result = await probeBridge(base, options);
    tried.push(result);
    if (result.ok) return { ...result, tried };
    if (result.reason === 'unauthorized') return { ...result, tried };
  }
  const first = tried[0] || { ok: false, reason: 'bridge-offline', base: '' };
  return { ...first, tried };
}

/** A sentence that names the next step, for each way a connection can fail. */
export function connectionHelp(reason) {
  switch (String(reason || '')) {
    case 'mixed-content':
      return 'This page runs over HTTPS, so the browser will not let it call the bridge directly. Open the bridge page on this phone — the button does it, with nothing to type.';
    case 'unauthorized':
      return 'The bridge is running but this phone is not paired with it yet. Open the bridge page once to enroll it, then this page reconnects on its own.';
    case 'no-simulator':
      return 'The bridge answered but no simulator is sending data. Start X-Plane or MSFS, load a flight, and the position arrives by itself.';
    case 'offline':
      return 'This phone is offline. Reconnect to Wi-Fi, then tap Connect again.';
    case 'bridge-offline':
      return 'No Stratos bridge answered on this network. Start Stratos on the PC, check that the phone is on the same Wi-Fi, and allow the bridge through the firewall on private networks.';
    default:
      return 'The PC could not be reached. Both devices must be on the same network; a guest Wi-Fi or VPN often keeps them apart.';
  }
}

/** The status line a phone shows while connecting, and once it is done. */
export function connectStatus(state) {
  const table = {
    idle: ['disconnected', 'Not connected'],
    searching: ['connecting', 'Looking for your PC…'],
    connecting: ['connecting', 'Connecting…'],
    connected: ['connected', 'Live'],
    reconnecting: ['connecting', 'Reconnecting…'],
    waiting: ['waiting', 'Waiting for telemetry'],
    stale: ['stale', 'PC idle'],
    disconnected: ['disconnected', 'Disconnected'],
    offline: ['offline', 'No network'],
    error: ['error', 'Connection problem'],
    unpaired: ['unpaired', 'Pairing revoked'],
  };
  const [dot, text] = table[String(state || '')] || table.disconnected;
  return { dot, text };
}
