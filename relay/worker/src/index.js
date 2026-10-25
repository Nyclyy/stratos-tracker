/**
 * Stratos phone relay — Cloudflare Workers port of ../server.mjs.
 *
 * Same HTTP contract, so the desktop bridge, the phone PWA and the existing
 * tests do not change:
 *
 *   Desktop ──POST /api/pair──────────────▶ code + desktopToken
 *   Desktop ──POST /api/ingest (Bearer)──▶ snapshot
 *   Phone   ──POST /api/claim {code}─────▶ readToken
 *   Phone   ──GET  /api/state (Bearer)───▶ snapshot
 *
 * Why a Worker: a free always-on host for this relay no longer exists elsewhere
 * (Fly, Heroku and Railway dropped their free tiers; Render and Koyeb sleep and
 * wipe memory, which would destroy the pairing). A Worker has no cold start to
 * speak of and Durable Object storage survives eviction, so a paired phone stays
 * paired.
 *
 * Security properties, unchanged from the Node relay:
 *   * Tokens are random (32 bytes) and only their SHA-256 hashes are stored.
 *   * Pairing codes expire after 5 minutes and are rate limited per IP.
 *   * Read and desktop tokens are separate; revoking a phone leaves the desktop
 *     paired, revoking the session disconnects everything.
 *   * The relay accepts data only; there is no command channel back to the PC.
 */

const VERSION = '1.2.0';
const CODE_TTL_MS = 5 * 60 * 1000;
const READ_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_MS = 15 * 1000;
const MAX_BODY = 256 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Traffic the bridge has observed. It expires in minutes, so it is kept in the
// Durable Object's memory and never written to storage.
const TRAFFIC_RETENTION_MS = 2700 * 1000;
const TRAFFIC_MAX_POINTS = 360;
const TRAFFIC_MAX_AIRCRAFT = 400;
const TRAFFIC_LIST_MAX = 60;
const TRAFFIC_BODY_MAX = 128 * 1024;

const PERSIST_DELAY_MS = 5000;
const CLEANUP_EVERY_MS = 60 * 1000;
const ALLOW_HEADER = 'x-stratos-allow-origins';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

function newCode() {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return [...random].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function newToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** An aircraft key: a hex address or a callsign, reduced to a safe token. */
function trafficKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/**
 * Merge one bridge post: a current list and any new trail samples.
 * Points are [[key, lat, lon, altFt, tMs], …], oldest first per aircraft. A
 * position that repeats the last one, a (0, 0) "no position" sentinel, a clock
 * ahead of ours and a sample that would rewind a trail are all refused, with the
 * same rules the bridge applies to what it stores locally.
 */
function storeTraffic(store, body, now) {
  let added = 0;
  const list = Array.isArray(body.list) ? body.list : [];
  const cleanList = [];
  for (const entry of list.slice(0, TRAFFIC_LIST_MAX)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '').trim().toUpperCase().slice(0, 12);
    const lat = Number(entry.lat);
    const lon = Number(entry.lon);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) continue;
    const num = value => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null);
    cleanList.push({ id, lat, lon, alt: num(entry.alt), gs: num(entry.gs), hdg: num(entry.hdg) });
  }
  if (cleanList.length) {
    store.list = cleanList;
    store.at = now;
  }
  const points = Array.isArray(body.points) ? body.points : [];
  for (const raw of points) {
    if (!Array.isArray(raw) || raw.length < 4) continue;
    const key = trafficKey(raw[0]);
    if (!key) continue;
    const lat = Number(raw[1]);
    const lon = Number(raw[2]);
    const alt = Number(raw[3] || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) continue;
    let stamp = Number(raw[4]);
    if (!Number.isFinite(stamp) || stamp <= 0) stamp = now;
    stamp = Math.min(stamp, now);
    // A sample already outside the window would be dropped by the next prune;
    // refusing it keeps "added" honest.
    if (stamp < now - TRAFFIC_RETENTION_MS) continue;
    const trail = store.trails.get(key) || [];
    const last = trail[trail.length - 1];
    if (last) {
      if (Math.abs(last[0] - lat) < 1e-5 && Math.abs(last[1] - lon) < 1e-5) continue;
      if (stamp < last[3]) continue;
      if (stamp === last[3]) stamp = last[3] + 1;
    }
    trail.push([
      Math.round(lat * 1e6) / 1e6,
      Math.round(lon * 1e6) / 1e6,
      Math.round(alt * 10) / 10,
      Math.round(stamp),
    ]);
    store.trails.set(key, trail);
    added++;
  }
  pruneTrails(store, now);
  return added;
}

function pruneTrails(store, now) {
  const cutoff = now - TRAFFIC_RETENTION_MS;
  for (const [key, trail] of store.trails) {
    const kept = trail.filter(point => point[3] >= cutoff);
    if (kept.length) store.trails.set(key, kept.slice(-TRAFFIC_MAX_POINTS));
    else store.trails.delete(key);
  }
  if (store.trails.size > TRAFFIC_MAX_AIRCRAFT) {
    const keep = [...store.trails.entries()]
      .sort((a, b) => b[1][b[1].length - 1][3] - a[1][a[1].length - 1][3])
      .slice(0, TRAFFIC_MAX_AIRCRAFT);
    store.trails = new Map(keep);
  }
}

function validateSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) {
    throw new HttpError(400, 'Snapshot needs a numeric ts');
  }
  if (payload.telemetry != null && (typeof payload.telemetry !== 'object' || Array.isArray(payload.telemetry))) {
    throw new HttpError(400, 'telemetry must be an object');
  }
  if (payload.recent != null && !Array.isArray(payload.recent)) {
    throw new HttpError(400, 'recent must be an array');
  }
  if (Array.isArray(payload.recent) && payload.recent.length > 50) {
    throw new HttpError(400, 'recent is too large');
  }
  if (JSON.stringify(payload).length > MAX_BODY) throw new HttpError(413, 'Snapshot too large');
  return payload;
}

function publicSession(session) {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stale: !session.updatedAt || Date.now() - session.updatedAt > STALE_MS,
    devices: [...session.reads.values()].map(read => ({
      label: read.label, createdAt: read.createdAt, expiresAt: read.expiresAt,
    })),
    snapshot: session.snapshot,
  };
}

/**
 * Every relay request lands on this one object. One user's bridge and phone are
 * a handful of requests a second, so a single serialized instance is not a
 * bottleneck, and it keeps the in-memory model of the Node relay intact.
 */
export class RelaySessions {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.tokenIndex = new Map(); // sha256(token) -> { sessionId, role, readHash? }
    this.attempts = new Map();   // ip:bucket -> timestamps
    this.trafficBySession = new Map();
    this.loading = null;
    this.persistPending = false;
    this.lastCleanup = Date.now();
  }

  async ensureLoaded() {
    if (!this.loading) {
      this.loading = (async () => {
        const saved = await this.state.storage.get('sessions');
        for (const row of (saved && saved.sessions) || []) {
          const session = { ...row, reads: new Map(row.reads || []) };
          this.sessions.set(session.id, session);
          this.tokenIndex.set(session.desktopHash, { sessionId: session.id, role: 'desktop' });
          for (const [readHash] of session.reads) {
            this.tokenIndex.set(readHash, { sessionId: session.id, role: 'read', readHash });
          }
        }
      })();
    }
    return this.loading;
  }

  async persistNow() {
    const rows = [...this.sessions.values()].map(session => ({
      ...session,
      reads: [...session.reads.entries()],
    }));
    await this.state.storage.put('sessions', { version: 1, sessions: rows });
  }

  /** One write per few seconds at most: ingest runs every second while flying. */
  async persistSoon() {
    if (this.persistPending) return;
    this.persistPending = true;
    try {
      await this.state.storage.setAlarm(Date.now() + PERSIST_DELAY_MS);
    } catch (_) {
      this.persistPending = false;
    }
  }

  async alarm() {
    this.persistPending = false;
    this.cleanup(Date.now());
    await this.persistNow();
    if (this.sessions.size) await this.state.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
  }

  cleanup(now) {
    for (const [id, session] of this.sessions) {
      for (const [readHash, read] of session.reads) {
        if (read.expiresAt < now) {
          session.reads.delete(readHash);
          this.tokenIndex.delete(readHash);
        }
      }
      if (!session.reads.size && now - session.createdAt > READ_TTL_MS * 2) {
        this.sessions.delete(id);
        this.tokenIndex.delete(session.desktopHash);
        this.trafficBySession.delete(id);
      }
      const store = this.trafficBySession.get(id);
      if (store) {
        pruneTrails(store, now);
        if (!store.trails.size && !store.list.length) this.trafficBySession.delete(id);
      }
    }
    if (this.attempts.size > 5000) {
      for (const [key, times] of this.attempts) {
        if (!times.some(stamp => now - stamp < 60000)) this.attempts.delete(key);
      }
    }
  }

  rateLimit(ip, bucket, limit, windowMs = 60000) {
    const key = `${ip}:${bucket}`;
    const now = Date.now();
    const list = (this.attempts.get(key) || []).filter(stamp => now - stamp < windowMs);
    if (list.length >= limit) throw new HttpError(429, 'Too many requests. Try again shortly.');
    list.push(now);
    this.attempts.set(key, list);
  }

  trafficStore(sessionId) {
    let store = this.trafficBySession.get(sessionId);
    if (!store) {
      store = { at: 0, list: [], trails: new Map() };
      this.trafficBySession.set(sessionId, store);
    }
    return store;
  }

  async body(request, limit = MAX_BODY) {
    const text = await request.text();
    if (text.length > limit) throw new HttpError(413, 'Request body too large');
    if (!text.trim()) return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Expected a JSON object');
    }
    return parsed;
  }

  async requireToken(request, role) {
    const header = String(request.headers.get('authorization') || '');
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token');
    const token = header.slice(7).trim();
    if (token.length < 20 || token.length > 200) throw new HttpError(401, 'Invalid token');
    const entry = this.tokenIndex.get(await hash(token));
    if (!entry || entry.role !== role) throw new HttpError(401, 'Unauthorized');
    const session = this.sessions.get(entry.sessionId);
    if (!session) throw new HttpError(401, 'Session no longer exists');
    if (role === 'read') {
      const read = session.reads.get(entry.readHash);
      if (!read || read.expiresAt < Date.now()) throw new HttpError(401, 'This phone pairing has expired');
    }
    return { session, token, entry };
  }

  async handle(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const key = `${method} ${url.pathname}`;
    const now = Date.now();
    this.cleanup(now);

    if (method === 'GET' && url.pathname === '/health') {
      return {
        ok: true, service: 'stratos-relay', runtime: 'cloudflare-workers', version: VERSION,
        sessions: this.sessions.size, time: now,
      };
    }

    if (method === 'POST' && url.pathname === '/api/pair') {
      this.rateLimit(clientIp(request), 'pair', 5);
      const body = await this.body(request, 4096);
      const name = String(body.name || 'Stratos PC').replace(/[^\w ._-]/g, '').slice(0, 60) || 'Stratos PC';
      const id = bytesToHex(crypto.getRandomValues(new Uint8Array(9)));
      const desktopToken = newToken();
      const code = newCode();
      const session = {
        id, name,
        createdAt: now,
        updatedAt: 0,
        codeHash: await hash(code),
        codeExpiresAt: now + CODE_TTL_MS,
        desktopHash: await hash(desktopToken),
        reads: new Map(),
        snapshot: null,
      };
      this.sessions.set(id, session);
      this.tokenIndex.set(session.desktopHash, { sessionId: id, role: 'desktop' });
      await this.persistNow();
      await this.state.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
      return {
        ok: true, sessionId: id, code,
        expiresAt: session.codeExpiresAt,
        desktopToken,
        ingestUrl: '/api/ingest',
      };
    }

    if (method === 'POST' && url.pathname === '/api/claim') {
      this.rateLimit(clientIp(request), 'claim', 15);
      const body = await this.body(request, 4096);
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 6) throw new HttpError(400, 'Enter the pairing code shown on your PC.');
      const codeHash = await hash(code);
      let match = null;
      for (const session of this.sessions.values()) {
        if (session.codeHash === codeHash && session.codeExpiresAt > now) { match = session; break; }
      }
      if (!match) throw new HttpError(404, 'That code is invalid or has expired. Generate a new one on the PC.');
      const readToken = newToken();
      const readHash = await hash(readToken);
      const read = {
        hash: readHash,
        createdAt: now,
        expiresAt: now + READ_TTL_MS,
        label: String(body.label || 'iPhone').replace(/[^\w .()-]/g, '').slice(0, 40) || 'iPhone',
      };
      match.reads.set(readHash, read);
      this.tokenIndex.set(readHash, { sessionId: match.id, role: 'read', readHash });
      await this.persistNow();
      return { ok: true, readToken, name: match.name, expiresAt: read.expiresAt, sessionId: match.id };
    }

    if (method === 'POST' && url.pathname === '/api/ingest') {
      this.rateLimit(clientIp(request), 'ingest', 200);
      const { session } = await this.requireToken(request, 'desktop');
      const payload = validateSnapshot(await this.body(request));
      session.snapshot = payload;
      session.updatedAt = Date.now();
      await this.persistSoon();
      return { ok: true, updatedAt: session.updatedAt };
    }

    if (method === 'GET' && url.pathname === '/api/state') {
      this.rateLimit(clientIp(request), 'state', 240);
      const { session } = await this.requireToken(request, 'read');
      const state = publicSession(session);
      return state.snapshot ? state : { ...state, snapshot: null, waiting: true };
    }

    if (method === 'POST' && url.pathname === '/api/traffic') {
      this.rateLimit(clientIp(request), 'traffic', 120);
      const { session } = await this.requireToken(request, 'desktop');
      const body = await this.body(request, TRAFFIC_BODY_MAX);
      const store = this.trafficStore(session.id);
      const added = storeTraffic(store, body, Date.now());
      return {
        ok: true, added, at: store.at,
        aircraft: store.trails.size, retentionSeconds: Math.round(TRAFFIC_RETENTION_MS / 1000),
      };
    }

    if (method === 'GET' && url.pathname === '/api/traffic') {
      this.rateLimit(clientIp(request), 'state', 240);
      const { session } = await this.requireToken(request, 'read');
      const store = this.trafficBySession.get(session.id) || { at: 0, list: [], trails: new Map() };
      const aircraft = trafficKey(url.searchParams.get('hex') || '');
      if (aircraft) {
        return {
          ok: true, hex: aircraft, points: store.trails.get(aircraft) || [],
          retentionSeconds: Math.round(TRAFFIC_RETENTION_MS / 1000),
        };
      }
      return {
        ok: true, at: store.at, stale: !store.at || Date.now() - store.at > STALE_MS * 4,
        list: store.list, retentionSeconds: Math.round(TRAFFIC_RETENTION_MS / 1000),
      };
    }

    if (method === 'GET' && url.pathname === '/api/devices') {
      this.rateLimit(clientIp(request), 'state', 240);
      // A read token sees its own session; the desktop token manages devices.
      let role = 'read';
      try { await this.requireToken(request, 'read'); } catch { role = 'desktop'; }
      const { session } = await this.requireToken(request, role);
      return {
        ok: true,
        devices: [...session.reads.entries()].map(([readHash, read]) => ({
          id: readHash.slice(0, 12),
          label: read.label,
          createdAt: read.createdAt,
          expiresAt: read.expiresAt,
        })),
      };
    }

    if (method === 'POST' && url.pathname === '/api/devices/revoke') {
      this.rateLimit(clientIp(request), 'revoke', 60);
      const { session } = await this.requireToken(request, 'desktop');
      const body = await this.body(request, 2048);
      const id = String(body.id || '');
      let removed = false;
      for (const [readHash] of session.reads) {
        if (readHash.startsWith(id)) {
          session.reads.delete(readHash);
          this.tokenIndex.delete(readHash);
          removed = true;
        }
      }
      if (!removed) throw new HttpError(404, 'Device not found');
      await this.persistNow();
      return { ok: true };
    }

    if (method === 'POST' && url.pathname === '/api/revoke') {
      this.rateLimit(clientIp(request), 'revoke', 30);
      const { session, entry } = await this.requireToken(request, 'read');
      session.reads.delete(entry.readHash);
      this.tokenIndex.delete(entry.readHash);
      await this.persistNow();
      return { ok: true };
    }

    if (method === 'DELETE' && url.pathname === '/api/session') {
      this.rateLimit(clientIp(request), 'revoke', 30);
      const { session } = await this.requireToken(request, 'desktop');
      for (const [readHash] of session.reads) this.tokenIndex.delete(readHash);
      this.tokenIndex.delete(session.desktopHash);
      this.sessions.delete(session.id);
      this.trafficBySession.delete(session.id);
      await this.persistNow();
      return { ok: true };
    }

    throw new HttpError(404, `Not found: ${key}`);
  }

  async fetch(request) {
    const origin = request.headers.get('origin');
    // The outer Worker copies its ALLOWED_ORIGINS onto the forwarded request.
    const allow = request.headers.get(ALLOW_HEADER) || '*';
    const headers = corsHeaders(allow, origin);
    if (request.method.toUpperCase() === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (!originAllowed(allow, origin)) {
      return json(403, { ok: false, error: 'Origin not allowed' }, headers);
    }
    try {
      const payload = await this.handle(request);
      return json(200, payload, headers);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error('relay error:', error && error.stack ? error.stack : error);
      return json(status, { ok: false, error: (error && error.message) || 'Relay error' }, headers);
    }
  }
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

function allowedOrigins(allow) {
  return String(allow || '*')
    .split(',').map(value => value.trim()).filter(Boolean);
}

function originAllowed(allow, origin) {
  if (!origin) return true;
  const allowed = allowedOrigins(allow);
  return allowed.includes('*') || allowed.includes(origin);
}

function corsHeaders(allow, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (origin) {
    const allowed = allowedOrigins(allow);
    if (allowed.includes('*') || allowed.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = allowed.includes('*') ? '*' : origin;
      headers.Vary = 'Origin';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
      headers['Access-Control-Max-Age'] = '600';
    }
  }
  return headers;
}

function json(status, payload, headers) {
  return new Response(JSON.stringify(payload), { status, headers });
}

/**
 * The public entry point. Every request is forwarded to the single relay object,
 * which owns all session state; nothing is stored in the Worker itself.
 */
export default {
  async fetch(request, env) {
    const id = env.RELAY.idFromName('stratos-relay');
    const stub = env.RELAY.get(id);
    // Env is not visible inside the Durable Object, so the CORS allow-list
    // travels with the forwarded request. A client's own copy is always dropped.
    const headers = new Headers(request.headers);
    headers.delete(ALLOW_HEADER);
    headers.set(ALLOW_HEADER, env.ALLOWED_ORIGINS || '*');
    const init = { method: request.method, headers };
    // Buffering the body keeps a route that answers without reading it (a 404,
    // a 401) from leaving an unread request stream behind, which workerd treats
    // as an error. The payloads here are a few kilobytes at most.
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      init.body = await request.arrayBuffer();
    }
    return stub.fetch(new Request(request.url, init));
  },
};
