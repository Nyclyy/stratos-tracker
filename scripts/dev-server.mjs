#!/usr/bin/env node
/* Local development server for app/.
 *
 * `python -m http.server` serves the same files, but the public ADS-B mirrors
 * (adsb.fi, adsb.one, adsb.lol, airplanes.live, OpenSky) send no CORS headers,
 * so a browser refuses to read them from a plain http origin and the ADS-B
 * traffic source dies with "unavailable". The hosted build avoids that with the
 * /api/traffic function; this server mounts that same handler, so a local
 * browser gets the identical server-side fetch and no duplicate allowlist.
 *
 * Usage: npm run dev   (then open http://127.0.0.1:8123)
 * Env:   PORT (default 8123), HOST (default 127.0.0.1)
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import traffic from '../api/traffic.js';
import photo from '../api/photo.js';
import weather from '../api/weather.js';
import winds from '../api/winds.js';
import charts from '../api/charts.js';
import chart from '../api/chart.js';
import ourairports from '../api/ourairports.js';

const ROOT = path.resolve(import.meta.dirname, '..', 'app');
const PORT = Number(process.env.PORT) || 8123;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Minimal Express-shaped shim so the Vercel handler runs unchanged. */
function adapt(handler) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);
    const shim = {
      status(code) {
        res.statusCode = code;
        return {
          json(body) {
            if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(body));
          },
          send(body) {
            if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream');
            res.end(body);
          },
        };
      },
      setHeader(name, value) { res.setHeader(name, value); },
    };
    return handler(req, shim);
  };
}

const trafficApi = adapt(traffic);
const photoApi = adapt(photo);
/* The same serverless handlers the hosted site uses, so the EFB's weather,
   charts and airport search work in a local browser too. */
const ROUTES = {
  '/api/traffic': trafficApi,
  '/api/photo': photoApi,
  '/api/weather': adapt(weather),
  '/api/winds': adapt(winds),
  '/api/charts': adapt(charts),
  '/api/chart': adapt(chart),
  '/api/ourairports': adapt(ourairports),
};

/** A path inside app/, or null when it escapes the root. */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  let target = path.resolve(ROOT, '.' + decoded);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  } catch (_) {
    if (pathname.endsWith('/')) target = path.join(target, 'index.html');
  }
  return target;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  const route = ROUTES[pathname] || null;
  if (route) {
    try {
      await route(req, res);
    } catch (_) {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Proxy failed' }));
      }
    }
    return;
  }

  const file = resolveFile(pathname);
  if (!file) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }
  let body;
  try {
    body = await fsp.readFile(file);
  } catch (_) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'HEAD') res.end();
  else res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`Stratos dev server: http://${HOST}:${PORT}/  (ADS-B via /api/traffic, photos via /api/photo)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
