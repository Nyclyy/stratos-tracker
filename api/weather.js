// Stratos API: METAR + TAF for one station from NOAA Aviation Weather Center.
// Public-domain data, no API key. Results are cached for 5 minutes at the edge.
// Query: /api/weather?icao=KJFK

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // icao -> { at, payload }

function station(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{3,5}$/.test(code) ? code : '';
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Stratos/2 (flight simulation companion)',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NOAA returned ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const icao = station(req.query && req.query.icao);
  if (!icao) {
    res.status(400).json({ error: 'Provide a 3–5 character station identifier, e.g. ?icao=KJFK' });
    return;
  }

  const hit = cache.get(icao);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=120');
    res.status(200).json(hit.payload);
    return;
  }

  const payload = {
    icao,
    metar: null,
    taf: null,
    decoded: null,
    tafIssueTime: null,
    fetchedAt: Date.now(),
    source: 'NOAA Aviation Weather Center',
    sourceUrl: 'https://aviationweather.gov/data/api/',
  };

  const [metarResult, tafResult] = await Promise.allSettled([
    getJson(`https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&hours=2`),
    getJson(`https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(icao)}&format=json&time=valid`),
  ]);

  const metar = metarResult.status === 'fulfilled' ? metarResult.value[0] : null;
  const taf = tafResult.status === 'fulfilled' ? tafResult.value[0] : null;

  if (metar) {
    payload.metar = metar.rawOb || null;
    payload.decoded = {
      temp_c: metar.temp ?? null,
      dewpoint_c: metar.dewp ?? null,
      wind_dir: metar.wdir ?? null,
      wind_speed_kt: metar.wspd ?? null,
      wind_gust_kt: metar.wgst ?? null,
      visibility_sm: metar.visib ?? null,
      altimeter: metar.altim ?? null,
      flight_category: metar.fltcat ?? null,
      sky_conditions: metar.clouds ?? null,
      obs_time: metar.obsTime ?? null,
    };
  }
  if (taf) {
    payload.taf = taf.rawTAF || null;
    payload.tafIssueTime = taf.issueTime ?? null;
  }

  if (metarResult.status === 'rejected' && tafResult.status === 'rejected') {
    payload.error = 'NOAA weather is temporarily unreachable. This is not a cached observation.';
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json(payload);
    return;
  }

  // Cache even an empty-but-successful answer briefly, to avoid hammering NOAA
  // for stations that do not report weather.
  cache.set(icao, { at: Date.now(), payload });
  if (cache.size > 300) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 60);
    for (const [key] of oldest) cache.delete(key);
  }

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=120');
  res.status(200).json(payload);
}
