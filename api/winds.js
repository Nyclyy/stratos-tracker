// Stratos API: low-level winds aloft from the NOAA Aviation Weather Center.
// Public-domain NWS data, no API key. Query: /api/winds?fcst=06 (06, 12 or 24 hour).
// The text is checked with the app's parser before it is cached or served, so a
// changed or error page from upstream answers 502 rather than being shown as winds.
import { parseWindsAloft } from '../app/js/lib/windsaloft.js';

const CACHE_MS = 30 * 60 * 1000;
const FORECASTS = new Set(['06', '12', '24']);
const cache = new Map(); // fcst -> { at, text }

function upstreamUrl(fcst) {
  return `https://aviationweather.gov/api/data/windtemp?region=us&level=low&fcst=${fcst}`;
}

async function fetchTable(fcst) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(upstreamUrl(fcst), {
      headers: { Accept: 'text/plain', 'User-Agent': 'Stratos/2 (flight simulation companion)' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NOAA returned ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const fcst = String((req.query && req.query.fcst) || '06');
  if (!FORECASTS.has(fcst)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: 'fcst must be 06, 12 or 24.' });
    return;
  }

  const hit = cache.get(fcst);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    serve(res, hit.text, 's-maxage=1800, stale-while-revalidate=600');
    return;
  }

  try {
    const text = await fetchTable(fcst);
    parseWindsAloft(text); // throws when the format is not the expected table
    cache.set(fcst, { at: Date.now(), text });
    serve(res, text, 's-maxage=1800, stale-while-revalidate=600');
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({
      error: 'upstream',
      message: 'Winds aloft are unavailable right now. Try again later.',
      detail: error && error.message ? String(error.message).slice(0, 160) : 'unknown',
    });
  }
}

function serve(res, text, cacheControl) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Data-Source', 'NOAA Aviation Weather Center');
  res.setHeader('Cache-Control', `public, ${cacheControl}`);
  res.status(200).send(text);
}
