// Vercel Serverless Function – OurAirports data
// Returns a JSON array of airports filtered by query parameters.
// Query params: q (search term, matches ICAO, IATA, name, city, country)
// The function downloads the CSV from OurAirports (public domain) and caches it in memory.
// Cache expires after 24h.

let cache = null; // {timestamp: ms, data: []}

async function loadCsv() {
  const resp = await fetch('https://ourairports.com/data/airports.csv');
  if (!resp.ok) throw new Error('Failed to fetch OurAirports CSV');
  const text = await resp.text();
  const lines = text.split('\n');
  const header = lines[0].split(',');
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split(',');
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      let val = cols[j] ?? '';
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      obj[header[j]] = val;
    }
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
    const q = (req.query.q || '').toLowerCase();
    let result = cache.data;
    if (q) {
      result = result.filter(rec => {
        return (
          (rec.ident && rec.ident.toLowerCase().includes(q)) ||
          (rec.iata_code && rec.iata_code.toLowerCase().includes(q)) ||
          (rec.name && rec.name.toLowerCase().includes(q)) ||
          (rec.municipality && rec.municipality.toLowerCase().includes(q)) ||
          (rec.iso_country && rec.iso_country.toLowerCase().includes(q))
        );
      });
    }
    // Limit to 200 results to keep payload small
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
    res.json(result.slice(0, 200));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
