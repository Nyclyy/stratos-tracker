// Stratos API: proxy for public live-traffic feeds (ADS-B aggregators and OpenSky).
// Those services do not send CORS headers for the Stratos origin, so the browser
// cannot read them directly. This function fetches them server-side and returns
// the upstream JSON. Only the hosts below are allowed; no other target is reachable.
// Query: /api/traffic?url=<encoded upstream https URL>

const CACHE_S = 10;
const TIMEOUT_MS = 8000;
const ALLOWED_HOSTS = new Set([
  'opendata.adsb.fi',
  'api.adsb.one',
  'api.adsb.lol',
  'api.airplanes.live',
  'opensky-network.org',
]);

function allowedTarget(value) {
  let target;
  try {
    target = new URL(String(value || ''));
  } catch (_) {
    return null;
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) return null;
  if (target.username || target.password || target.port) return null;
  return target;
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const target = allowedTarget(req.query && req.query.url);
  if (!target) {
    res.status(400).json({ error: 'Unsupported traffic source' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Stratos/2 (flight simulation companion)',
      },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: `Traffic source returned ${upstream.status}`, source: target.hostname });
      return;
    }
    const data = await upstream.json();
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_S}, stale-while-revalidate=${CACHE_S}`);
    res.status(200).json(data);
  } catch (_) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'Traffic source is temporarily unreachable', source: target.hostname });
  } finally {
    clearTimeout(timer);
  }
}
