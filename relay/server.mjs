#!/usr/bin/env node
/**
 * Stratos phone relay.
 *
 * The desktop bridge is never exposed to the internet. Instead it pushes
 * snapshots outbound to this relay with a secret desktop token, and a phone
 * reads them with a separate read token obtained through a short-lived
 * pairing code.
 *
 *   Desktop ──POST /api/pair──────────────▶ code + desktopToken
 *   Desktop ──POST /api/ingest (Bearer)──▶ snapshot
 *   Phone   ──POST /api/claim {code}─────▶ readToken
 *   Phone   ──GET  /api/state (Bearer)───▶ snapshot
 *
 * Security properties
 *   * Tokens are random (32 bytes) and only their SHA-256 hashes are stored.
 *   * Pairing codes expire after 5 minutes and are rate limited per IP.
 *   * Read and desktop tokens are separate; revoking a phone leaves the
 *     desktop paired, revoking the session disconnects everything.
 *   * The relay accepts data only; there is no command channel back to the PC.
 *   * Session state is in memory and optionally persisted to disk. Nothing is
 *     sent to a third party.
 *
 * No dependencies. Requires Node 18+.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.RELAY_DATA_DIR || path.join(process.cwd(), 'relay', 'data');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(value => value.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const CODE_TTL_MS = 5 * 60 * 1000;
const READ_TTL_MS = Number(process.env.READ_TOKEN_DAYS || 30) * 24 * 60 * 60 * 1000;
const MAX_BODY = 256 * 1024;
const STALE_MS = Number(process.env.STALE_SECONDS || 15) * 1000;
const VERSION = '1.0.0';

/** @type {Map<string, {id:string, name:string, createdAt:number, codeHash:string, codeExpiresAt:number, desktopHash:string, reads:Map<string,{hash:string,createdAt:number,expiresAt:number,label:string}>, snapshot:object|null, updatedAt:number}>} */
const sessions = new Map();
const tokenIndex = new Map(); // sha256(token) -> {sessionId, role, readHash?}
const attempts = new Map();   // ip -> number[] timestamps

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function rateLimit(ip, bucket, limit, windowMs = 60000) {
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) throw new HttpError(429, 'Too many requests. Try again shortly.');
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) {
    for (const [key2, times] of attempts) {
      if (!times.some(t => now - t < windowMs)) attempts.delete(key2);
    }
  }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function originAllowed(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'Expected a JSON object'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'Request failed')));
  });
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token');
  const token = header.slice(7).trim();
  if (token.length < 20 || token.length > 200) throw new HttpError(401, 'Invalid token');
  return token;
}

function requireToken(req, role) {
  const token = bearer(req);
  const entry = tokenIndex.get(hash(token));
  if (!entry || entry.role !== role) throw new HttpError(401, 'Unauthorized');
  const session = sessions.get(entry.sessionId);
  if (!session) throw new HttpError(401, 'Session no longer exists');
  if (role === 'read') {
    const read = session.reads.get(entry.readHash);
    if (!read || read.expiresAt < Date.now()) throw new HttpError(401, 'This phone pairing has expired');
  }
  return { session, token, entry };
}

function validateSnapshot(payload) {
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
  const text = JSON.stringify(payload);
  if (text.length > MAX_BODY) throw new HttpError(413, 'Snapshot too large');
  return payload;
}

function persist() {
  if (process.env.RELAY_PERSIST === '0') return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const rows = [...sessions.values()].map(session => ({
      ...session,
      reads: [...session.reads.entries()],
    }));
    const tmp = `${SESSION_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: rows }), { mode: 0o600 });
    fs.renameSync(tmp, SESSION_FILE);
  } catch (error) {
    console.error('Could not persist relay sessions:', error.message);
  }
}

function loadPersisted() {
  if (process.env.RELAY_PERSIST === '0') return;
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const row of parsed.sessions || []) {
      const session = { ...row, reads: new Map(row.reads || []) };
      sessions.set(session.id, session);
      tokenIndex.set(session.desktopHash, { sessionId: session.id, role: 'desktop' });
      for (const [readHash] of session.reads) {
        tokenIndex.set(readHash, { sessionId: session.id, role: 'read', readHash });
      }
    }
    console.log(`Loaded ${sessions.size} relay session(s)`);
  } catch {
    /* first run */
  }
}

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    let changed = false;
    for (const [readHash, read] of session.reads) {
      if (read.expiresAt < now) { session.reads.delete(readHash); tokenIndex.delete(readHash); changed = true; }
    }
    if (!session.reads.size && now - session.createdAt > READ_TTL_MS * 2) {
      sessions.delete(id);
      tokenIndex.delete(session.desktopHash);
      changed = true;
    }
    if (changed) persist();
  }
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

const routes = {
  'GET /health': async (req, res) => {
    send(res, 200, {
      ok: true, service: 'stratos-relay', version: VERSION,
      sessions: sessions.size, uptimeSeconds: Math.round(process.uptime()),
      time: Date.now(),
    });
  },

  'POST /api/pair': async (req, res) => {
    rateLimit(clientIp(req), 'pair', 5);
    const body = await readBody(req, 4096);
    const name = String(body.name || 'Stratos PC').replace(/[^\w ._-]/g, '').slice(0, 60) || 'Stratos PC';
    const id = crypto.randomBytes(9).toString('hex');
    const desktopToken = newToken();
    const code = newCode();
    const session = {
      id, name,
      createdAt: Date.now(),
      updatedAt: 0,
      codeHash: hash(code),
      codeExpiresAt: Date.now() + CODE_TTL_MS,
      desktopHash: hash(desktopToken),
      reads: new Map(),
      snapshot: null,
    };
    sessions.set(id, session);
    tokenIndex.set(session.desktopHash, { sessionId: id, role: 'desktop' });
    persist();
    send(res, 200, {
      ok: true, sessionId: id, code,
      expiresAt: session.codeExpiresAt,
      desktopToken,
      ingestUrl: '/api/ingest',
    });
  },

  'POST /api/claim': async (req, res) => {
    rateLimit(clientIp(req), 'claim', 15);
    const body = await readBody(req, 4096);
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) throw new HttpError(400, 'Enter the pairing code shown on your PC.');
    let match = null;
    for (const session of sessions.values()) {
      if (session.codeHash === hash(code) && session.codeExpiresAt > Date.now()) { match = session; break; }
    }
    if (!match) throw new HttpError(404, 'That code is invalid or has expired. Generate a new one on the PC.');
    const readToken = newToken();
    const readHash = hash(readToken);
    const read = {
      hash: readHash,
      createdAt: Date.now(),
      expiresAt: Date.now() + READ_TTL_MS,
      label: String(body.label || 'iPhone').replace(/[^\w .()-]/g, '').slice(0, 40) || 'iPhone',
    };
    match.reads.set(readHash, read);
    tokenIndex.set(readHash, { sessionId: match.id, role: 'read', readHash });
    persist();
    send(res, 200, {
      ok: true, readToken, name: match.name,
      expiresAt: read.expiresAt, sessionId: match.id,
    });
  },

  'POST /api/ingest': async (req, res) => {
    rateLimit(clientIp(req), 'ingest', 200);
    const { session } = requireToken(req, 'desktop');
    const payload = validateSnapshot(await readBody(req));
    session.snapshot = payload;
    session.updatedAt = Date.now();
    persist();
    send(res, 200, { ok: true, updatedAt: session.updatedAt });
  },

  'GET /api/state': async (req, res) => {
    rateLimit(clientIp(req), 'state', 240);
    const { session } = requireToken(req, 'read');
    const state = publicSession(session);
    send(res, 200, state.snapshot ? state : { ...state, snapshot: null, waiting: true });
  },

  'GET /api/devices': async (req, res) => {
    rateLimit(clientIp(req), 'state', 240);
    // Read tokens see their own session; the desktop token manages devices.
    let role = 'read';
    try { requireToken(req, 'read'); } catch { role = 'desktop'; }
    const { session } = requireToken(req, role);
    send(res, 200, {
      ok: true,
      devices: [...session.reads.entries()].map(([hash, read]) => ({
        id: hash.slice(0, 12),
        label: read.label,
        createdAt: read.createdAt,
        expiresAt: read.expiresAt,
      })),
    });
  },

  'POST /api/devices/revoke': async (req, res) => {
    rateLimit(clientIp(req), 'revoke', 60);
    const { session } = requireToken(req, 'desktop');
    const body = await readBody(req, 2048);
    const id = String(body.id || '');
    let removed = false;
    for (const [hash] of session.reads) {
      if (hash.startsWith(id)) {
        session.reads.delete(hash);
        tokenIndex.delete(hash);
        removed = true;
      }
    }
    if (!removed) throw new HttpError(404, 'Device not found');
    persist();
    send(res, 200, { ok: true });
  },

  'POST /api/revoke': async (req, res) => {
    rateLimit(clientIp(req), 'revoke', 30);
    const { session, entry } = requireToken(req, 'read');
    session.reads.delete(entry.readHash);
    tokenIndex.delete(entry.readHash);
    persist();
    send(res, 200, { ok: true });
  },

  'DELETE /api/session': async (req, res) => {
    rateLimit(clientIp(req), 'revoke', 30);
    const { session } = requireToken(req, 'desktop');
    for (const [readHash] of session.reads) tokenIndex.delete(readHash);
    tokenIndex.delete(session.desktopHash);
    sessions.delete(session.id);
    persist();
    send(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    res.end();
    return;
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!originAllowed(req.headers.origin)) {
    send(res, 403, { ok: false, error: 'Origin not allowed' });
    return;
  }
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  try {
    if (!handler) throw new HttpError(404, 'Not found');
    await handler(req, res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('relay error:', error);
    if (!res.headersSent) send(res, status, { ok: false, error: error.message || 'Relay error' });
    else res.end();
  } finally {
    if (url.pathname !== '/health' && Date.now() - started > 2000) {
      console.warn(`slow request ${key}: ${Date.now() - started} ms`);
    }
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.listen(PORT, HOST, () => {
  console.log(`Stratos relay ${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(ALLOWED_ORIGINS.includes('*')
    ? 'CORS: any origin (bearer tokens required; no cookies)'
    : `CORS: ${ALLOWED_ORIGINS.join(', ')}`);
});

loadPersisted();
setInterval(cleanup, 60 * 1000).unref();

export { server, sessions };
