// Stratos API: the FAA d-TPP catalogue for one airport.
// Query: /api/charts?icao=KJFK
//
// The FAA metafile is the authoritative index (it carries its own cycle and
// publication window). It is large (~16 MB) and changes every 28 days, so it is
// fetched once per warm instance and reused for six hours. Nothing is bundled:
// a stale copy on disk could mark an expired procedure as current.

import { FAA_BASE, faaCycle, parseFaaAirport, parseMetafileHeader } from '../app/js/lib/charts.js';

const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 25000;

let cache = null; // { text, header, at, cycle }
let pending = null;

async function download(cycle) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${FAA_BASE}/${cycle}/xml_data/d-TPP_Metafile.xml`, {
      signal: controller.signal,
      headers: {
        Accept: 'text/xml,application/xml',
        'User-Agent': 'Stratos/2 (flight simulation companion; charts are public-domain FAA data)',
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function catalogue() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (pending) return pending;
  pending = (async () => {
    // The 28-day guess can land in the gap around a cycle change, so try the
    // neighbouring cycles too and keep whichever publication the FAA serves.
    for (const step of [0, 1, -1, 2]) {
      const guess = faaCycle(Date.now() + step * 28 * 86400000);
      const text = await download(guess);
      if (!text || !text.includes('<digital_tpp')) continue;
      const header = parseMetafileHeader(text);
      cache = { text, header, at: Date.now(), cycle: header.cycle || guess };
      return cache;
    }
    throw new Error('The FAA d-TPP publication could not be reached.');
  })().finally(() => { pending = null; });
  return pending;
}

export default async function handler(req, res) {
  const icao = String((req.query && req.query.icao) || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,5}$/.test(icao)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: 'A 3-5 character airport identifier is required.' });
    return;
  }

  let data;
  try {
    data = await catalogue();
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({
      error: 'source-unavailable',
      message: error.message || String(error),
      retry: true,
    });
    return;
  }

  const base = {
    source: 'faa-dtpp',
    sourceName: 'FAA Digital Terminal Procedures',
    license: 'U.S. Government work - public domain',
    effective: data.header.from,
    expires: data.header.to,
    checkedAt: data.at,
    icao,
  };

  const block = parseFaaAirport(data.text, icao);
  if (!block || !block.records.length) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
    res.status(404).json({
      ...base,
      cycle: data.cycle,
      unsupported: true,
      charts: [],
      message: `No FAA d-TPP charts are published for ${icao}. Current coverage is the FAA publication `
        + '(United States and territories); other national authorities are not mirrored by Stratos.',
    });
    return;
  }

  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
  res.status(200).json({
    ...base,
    cycle: data.cycle,
    airport: block.name,
    charts: block.records.map(record => ({
      code: record.code,
      title: record.title,
      pdf: record.pdf,
      amended: record.amended,
    })),
  });
}
