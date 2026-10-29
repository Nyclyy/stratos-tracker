// Stratos API: one aircraft photo by registration or Mode S address, from
// Planespotters.net.
// Their API rejects a User-Agent that is a browser's or a library's and asks for
// an application name with a contact URL, which a browser cannot send, so the
// lookup happens here. The response is the upstream JSON; the page reads the
// first photo, links it to its Planespotters page and credits the photographer.
// Query: /api/photo?reg=<registration> or /api/photo?hex=<6 hex digits>

const TIMEOUT_MS = 8000;
const CACHE_S = 24 * 60 * 60;
const USER_AGENT = 'Stratos/2 (+https://github.com/Nyclyy/stratos-tracker)';
const REG_ENDPOINT = 'https://api.planespotters.net/pub/photos/reg/';
const HEX_ENDPOINT = 'https://api.planespotters.net/pub/photos/hex/';

/** Only a plausible registration reaches the service. N-numbers are kept even
 *  when they look like a type code, because N123 and N1234 are real tails. */
function registration(value) {
  const reg = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,9}$/.test(reg)) return '';
  if (/^\d+$/.test(reg) || (/^[A-Z]{1,4}\d{1,4}$/.test(reg) && !/^N\d[0-9A-Z]{0,5}$/.test(reg))) return '';
  return reg;
}

/** A 24-bit Mode S address, or an empty string. */
function hexAddress(value) {
  const hex = String(value || '').trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : '';
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const reg = registration(req.query && req.query.reg);
  const hex = reg ? '' : hexAddress(req.query && req.query.hex);
  if (!reg && !hex) {
    res.status(400).json({ error: 'Unsupported registration or Mode S address' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch((reg ? REG_ENDPOINT + encodeURIComponent(reg) : HEX_ENDPOINT + hex), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      // An airframe the service does not know is a 404, not a broken proxy.
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
