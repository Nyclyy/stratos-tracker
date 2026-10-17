// Vercel Serverless Function – OurAirports data
// Uses the GitHub Pages mirror which is more reliable from serverless environments.

let cache = null; // {timestamp: ms, data: []}

async function loadCsv() {
  // GitHub Pages mirror is more reliable than ourairports.com directly
  const urls = [
    'https://davidmegginson.github.io/ourairports-data/airports.csv',
    'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv',
  ];
  let text = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Stratos/1.0 (aviation tracker; https://stratos-tracker.vercel.app)' }
      });
      if (resp.ok) { text = await resp.text(); break; }
    } catch (_) { /* try next */ }
  }
  if (!text) throw new Error('Failed to fetch OurAirports CSV from all mirrors');

  const lines = text.split('\n');
  const header = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV parse handling quoted fields
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    const obj = {};
    header.forEach((h, j) => { obj[h] = cols[j] ?? ''; });
    records.push(obj);
  }
  return records;
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (!cache || now - cache.timestamp > 24 * 60 * 60 * 1000) {
      const data = await loadCsv();
      cache = { timestamp: now, data };
    }
    const q = (req.query.q || '').toLowerCase().trim();
    let result = cache.data;
    if (q) {
      result = result.filter(rec =>
        (rec.ident && rec.ident.toLowerCase().includes(q)) ||
        (rec.iata_code && rec.iata_code.toLowerCase().includes(q)) ||
        (rec.name && rec.name.toLowerCase().includes(q)) ||
        (rec.municipality && rec.municipality.toLowerCase().includes(q)) ||
        (rec.iso_country && rec.iso_country.toLowerCase().includes(q))
      );
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
    res.json(result.slice(0, 200));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
