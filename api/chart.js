// Stratos API: one official FAA d-TPP document.
// Query: /api/chart?cycle=2610&file=00375AD.PDF
//
// A deliberately narrow pass-through: the only host, path shape and document
// name that can be requested are the FAA's own published PDFs (U.S. Government
// works, public domain). No other URL, header or credential is forwarded.

const ALLOWED_FILE = /^[A-Z0-9]{1,12}\.PDF$/;
const ALLOWED_CYCLE = /^\d{4}$/;
const MAX_BYTES = 24 * 1024 * 1024;

export default async function handler(req, res) {
  const cycle = String((req.query && req.query.cycle) || '').trim();
  const file = String((req.query && req.query.file) || '').trim().toUpperCase();
  if (!ALLOWED_CYCLE.test(cycle) || !ALLOWED_FILE.test(file)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: 'Invalid chart request.' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://aeronav.faa.gov/d-tpp/${cycle}/${file}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Stratos/2 (flight simulation companion; public-domain FAA documents)' },
    });
    if (!response.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: 'upstream', message: `The FAA document answered ${response.status}.` });
      return;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: 'too-large', message: 'The document is larger than Stratos will serve.' });
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES || buffer.subarray(0, 4).toString() !== '%PDF') {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: 'not-a-pdf', message: 'The source did not return a PDF document.' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The cycle is part of the URL, so a document never changes in place.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(buffer);
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({
      error: 'upstream',
      message: error && error.name === 'AbortError' ? 'The FAA document timed out.' : (error.message || String(error)),
    });
  } finally {
    clearTimeout(timer);
  }
}
