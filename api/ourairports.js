// Stratos API: airport search from OurAirports (public domain).
// Query: /api/ourairports?q=heathrow&limit=25&country=GB
// The CSV is parsed once per warm function instance and cached for 24 hours.

const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CSV_BYTES = 40 * 1024 * 1024;
const SOURCES = [
  'https://davidmegginson.github.io/ourairports-data/airports.csv',
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv',
];
const FIELDS = [
  'ident', 'type', 'name', 'iata_code', 'iso_country', 'iso_region', 'municipality',
  'latitude_deg', 'longitude_deg', 'elevation_ft', 'scheduled_service', 'home_link',
  'wikipedia_link', 'keywords',
];

let cache = null; // { at, rows, source }

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function downloadCsv() {
  let lastError = null;
  for (const url of SOURCES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Stratos/2 (flight simulation companion)' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_CSV_BYTES) throw new Error('Airport data is unexpectedly large');
      const text = await response.text();
      if (text.length > MAX_CSV_BYTES) throw new Error('Airport data is unexpectedly large');
      return { text: text.replace(/^\uFEFF/, ''), source: url };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('No airport data source was reachable');
}

function buildRows(text, source) {
  const table = parseCsv(text);
  if (!table.length) throw new Error('Airport data was empty');
  const header = table[0].map(value => value.trim());
  const index = Object.fromEntries(FIELDS.map(field => [field, header.indexOf(field)]));
  if (index.ident < 0 || index.name < 0 || index.latitude_deg < 0 || index.longitude_deg < 0) {
    throw new Error('Airport data did not have the expected columns');
  }
  const rows = [];
  for (let i = 1; i < table.length; i++) {
    const line = table[i];
    if (!line || line.length < header.length / 2) continue;
    const ident = String(line[index.ident] || '').trim().toUpperCase();
    if (!ident) continue;
    const lat = Number(line[index.latitude_deg]);
    const lon = Number(line[index.longitude_deg]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const row = {
      ident,
      type: String(line[index.type] || '').trim(),
      name: String(line[index.name] || '').trim(),
      iata: index.iata_code >= 0 ? String(line[index.iata_code] || '').trim().toUpperCase() : '',
      country: index.iso_country >= 0 ? String(line[index.iso_country] || '').trim().toUpperCase() : '',
      region: index.iso_region >= 0 ? String(line[index.iso_region] || '').trim() : '',
      city: index.municipality >= 0 ? String(line[index.municipality] || '').trim() : '',
      lat,
      lon,
      elev: index.elevation_ft >= 0 && line[index.elevation_ft] !== '' ? Number(line[index.elevation_ft]) : null,
      scheduled: index.scheduled_service >= 0 && line[index.scheduled_service] === 'yes',
      home: index.home_link >= 0 ? String(line[index.home_link] || '').trim() : '',
      wiki: index.wikipedia_link >= 0 ? String(line[index.wikipedia_link] || '').trim() : '',
      keywords: index.keywords >= 0 ? String(line[index.keywords] || '').trim() : '',
    };
    rows.push(row);
  }
  if (!rows.length) throw new Error('Airport data had no usable rows');
  return { at: Date.now(), rows, source };
}

async function getData() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const { text, source } = await downloadCsv();
    cache = buildRows(text, source);
    return cache;
  } catch (error) {
    // A stale copy is better than no airport data, but it is explicitly marked.
    if (cache) return { ...cache, stale: true, warning: error.message };
    throw error;
  }
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const q = normalize(Array.isArray(req.query.q) ? req.query.q[0] : req.query.q).slice(0, 60);
  if (q.length < 2) {
    res.status(400).json({ error: 'Provide at least two characters in ?q=' });
    return;
  }
  const country = normalize(req.query.country).slice(0, 2).toUpperCase();
  const limitRaw = Number(req.query.limit);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 25));

  let data;
  try {
    data = await getData();
  } catch (error) {
    res.status(503).json({ error: `Airport data is unavailable: ${error.message}` });
    return;
  }

  const matches = [];
  for (const row of data.rows) {
    if (country && row.country !== country) continue;
    const ident = row.ident.toLowerCase();
    const iata = row.iata.toLowerCase();
    const name = row.name.toLowerCase();
    const city = row.city.toLowerCase();
    if (!(ident.includes(q) || iata === q || name.includes(q) || city.includes(q) || row.keywords.toLowerCase().includes(q))) continue;
    let score = 0;
    if (ident === q) score += 100;
    else if (ident.startsWith(q)) score += 70;
    if (iata === q) score += 90;
    if (iata) score += 10;
    if (name === q) score += 25;
    else if (name.startsWith(q)) score += 18;
    else if (name.includes(q)) score += 8;
    if (city.startsWith(q)) score += 8;
    if (row.type === 'large_airport') score += 30;
    else if (row.type === 'medium_airport') score += 12;
    if (row.scheduled) score += 12;
    matches.push({ score, row });
  }

  matches.sort((a, b) => b.score - a.score || a.row.ident.localeCompare(b.row.ident));
  const result = matches.slice(0, limit).map(({ row }) => row);

  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
  res.setHeader('X-Data-Source', 'OurAirports (public domain)');
  res.setHeader('X-Data-Age', String(Math.round((Date.now() - data.at) / 1000)));
  if (data.stale) res.setHeader('Warning', '110 - "Response is stale"');
  res.status(200).json({
    query: q,
    count: result.length,
    totalMatches: matches.length,
    source: 'OurAirports',
    sourceUrl: 'https://ourairports.com/data/',
    fetchedAt: data.at,
    stale: Boolean(data.stale),
    results: result,
  });
}
