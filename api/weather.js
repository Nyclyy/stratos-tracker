// Vercel Serverless Function – NOAA Aviation Weather (METAR/TAF)
// Expects query param: icao (ICAO code)
// Returns JSON with metar and taf if available.

export default async function handler(req, res) {
  const icao = (req.query.icao || '').toUpperCase();
  if (!icao) {
    res.status(400).json({ error: 'Missing icao parameter' });
    return;
  }
  try {
    const metarUrl = `https://aviationweather.gov/adds/dataserver_current/httpparam?dataSource=metars&requestType=retrieve&format=xml&hoursBeforeNow=2&mostRecent=true&stationString=${icao}`;
    const tafUrl = `https://aviationweather.gov/adds/dataserver_current/httpparam?dataSource=tafs&requestType=retrieve&format=xml&hoursBeforeNow=6&mostRecent=true&stationString=${icao}`;
    const [metarResp, tafResp] = await Promise.all([fetch(metarUrl), fetch(tafUrl)]);
    const metarText = await metarResp.text();
    const tafText = await tafResp.text();
    const extractRaw = xml => {
      const m = xml.match(/<raw_text>([^<]*)<\/raw_text>/);
      return m ? m[1] : null;
    };
    const metar = extractRaw(metarText);
    const taf = extractRaw(tafText);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.json({ icao, metar, taf });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
