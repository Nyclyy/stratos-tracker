// Vercel Serverless Function – NOAA Aviation Weather (METAR/TAF)
// Uses the current aviationweather.gov REST API (replaces deprecated ADDS endpoint).
// Expects query param: icao (ICAO code, e.g. KJFK)

export default async function handler(req, res) {
  const icao = (req.query.icao || '').toUpperCase().trim();
  if (!icao) {
    res.status(400).json({ error: 'Missing icao parameter' });
    return;
  }
  try {
    // New NOAA Aviation Weather Center API (v1, released 2023)
    const metarUrl = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=2`;
    const tafUrl   = `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json&time=valid`;

    const [metarResp, tafResp] = await Promise.all([
      fetch(metarUrl, { headers: { 'Accept': 'application/json' } }),
      fetch(tafUrl,   { headers: { 'Accept': 'application/json' } }),
    ]);

    const metarData = metarResp.ok ? await metarResp.json() : [];
    const tafData   = tafResp.ok  ? await tafResp.json()   : [];

    // API returns arrays; grab most recent entry
    const metarEntry = Array.isArray(metarData) ? metarData[0] : null;
    const tafEntry   = Array.isArray(tafData)   ? tafData[0]   : null;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.json({
      icao,
      metar: metarEntry?.rawOb   ?? null,
      taf:   tafEntry?.rawTAF    ?? null,
      // Decoded fields from METAR
      decoded: metarEntry ? {
        temp_c:       metarEntry.temp       ?? null,
        dewpoint_c:   metarEntry.dewp       ?? null,
        wind_dir:     metarEntry.wdir       ?? null,
        wind_speed_kt: metarEntry.wspd      ?? null,
        wind_gust_kt: metarEntry.wgst       ?? null,
        visibility_sm: metarEntry.visib     ?? null,
        altimeter:    metarEntry.altim      ?? null,
        flight_category: metarEntry.fltcat  ?? null,
        sky_conditions: metarEntry.clouds   ?? null,
        obs_time:     metarEntry.obsTime    ?? null,
      } : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
