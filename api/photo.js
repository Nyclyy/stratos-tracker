// Stratos API: one aircraft photo by registration, from Planespotters.net.
// Their API rejects a User-Agent that is a browser's or a library's and asks for
// an application name with a contact URL, which a browser cannot send, so the
// lookup happens here. The response is the upstream JSON; the page reads the
// first photo and credits the photographer it names.
// Query: /api/photo?reg=<registration>

const TIMEOUT_MS = 8000;
const CACHE_S = 24 * 60 * 60;
const USER_AGENT = 'Stratos/2 (+https://github.com/Nyclyy/stratos-tracker)';
const ENDPOINT = 'https://api.planespotters.net/pub/photos/reg/';

/** Only a plausible registration reaches the service. */
function registration(value) {
  const reg = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,9}$/.test(reg)) return '';
  if (/^\d+$/.test(reg) || /^[A-Z]{1,4}\d{1,4}$/.test(reg)) return '';
  return reg;
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const reg = registration(req.query && req.query.reg);
  if (!reg) {
    res.status(400).json({ error: 'Unsupported registration' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(ENDPOINT + encodeURIComponent(reg), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      // A registration the service does not know is a 404, not a broken proxy.
      res.setHeader('Cache-Control', upstream.status === 404 ? `public, s-maxage=${CACHE_S}` : 'no-store');
      res.status(upstream.status === 404 ? 200 : 502).json(upstream.status === 404
        ? { photos: [] }
        : { error: `Photo source returned ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_S}, stale-while-revalidate=${CACHE_S * 7}`);
    res.status(200).json(data);
  } catch (_) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'Photo source is temporarily unreachable' });
  } finally {
    clearTimeout(timer);
  }
}
