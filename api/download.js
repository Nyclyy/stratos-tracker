// Stratos API: the site's own download link for a desktop installer.
// Query: /api/download?p=windows | mac-arm64 | mac-x64 | linux-x64
//
// The website's buttons point here, not at a third-party file host, so the page
// carries no external download URL and a link written once keeps working: this
// resolves the platform against the published manifest the site already serves
// (app/releases.json) and hands the browser to that exact file. When a release
// is newer than the manifest's own download table, the release's attached
// assets are used instead, so a just-shipped build is never a dead button.
//
// Nothing is proxied or republished: the installer is served by whoever
// published it, with its own digest and size in the manifest.

const PLATFORMS = {
  windows: /^Stratos-Setup\.exe$/i,
  'mac-arm64': /-mac-arm64\.dmg$/i,
  'mac-x64': /-mac-x64\.dmg$/i,
  'linux-x64': /-linux-x64\.AppImage$/i,
};

const REPO = 'Nyclyy/stratos-tracker';
const CACHE_S = 300;

function isWebUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

/** The manifest's own table for one platform, or null. */
export function resolveDownload(manifest, platform) {
  const downloads = manifest && manifest.latest && manifest.latest.downloads;
  const entry = downloads && downloads[platform];
  if (!entry || !isWebUrl(entry.url)) return null;
  return String(entry.url);
}

/** A platform's file among a release's attached assets, or null. */
export function resolveAsset(release, platform) {
  const pattern = PLATFORMS[platform];
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const asset = assets.find(item => item && pattern.test(String(item.name || '')) && isWebUrl(item.browser_download_url));
  return asset ? String(asset.browser_download_url) : null;
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json', 'User-Agent': 'Stratos site download link' },
  });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return response.json();
}

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const platform = String((req.query && req.query.p) || '').trim().toLowerCase();

  if (!PLATFORMS[platform]) {
    sendJson(res, 400, { error: 'Unknown platform.', platforms: Object.keys(PLATFORMS) });
    return;
  }

  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'www.stratos-tracker.com');
  const origin = `${/^localhost|^127\./.test(host) ? 'http' : 'https'}://${host}`;

  let target = null;
  let source = '';
  try {
    target = resolveDownload(await fetchJson(`${origin}/app/releases.json`), platform);
    if (target) source = 'manifest';
  } catch (_) { /* the release itself is the fallback below */ }
  if (!target) {
    try {
      target = resolveAsset(await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`), platform);
      if (target) source = 'release';
    } catch (_) { /* reported below */ }
  }

  if (!target) {
    sendJson(res, 404, { error: 'No installer is published for that platform yet.', platform });
    return;
  }

  // A short edge cache keeps repeat clicks cheap while still following a new
  // release within minutes; the file itself is not cached here.
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${CACHE_S}`);
  res.setHeader('X-Stratos-Download', source);
  res.statusCode = 302;
  res.setHeader('Location', target);
  res.end();
}
