/* Stratos service worker.
   The shell is available offline after the first visit. Live data, telemetry,
   logbook JSON, weather and map tiles are NEVER cached, so stale data can never
   be presented as live. A new build replaces the old cache on activation. */
const CACHE = 'stratos-shell-2.1.28';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'stratos-ui.css',
  'pilot.css',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'vendor/qrcode.js',
  // The bag has its own entry point and manifest, so an installed EFB opens
  // offline on itself rather than on the tracker.
  'efb.html',
  'efb.css',
  'efb-flightplan.css',
  'manifest-efb.webmanifest',
  'js/efb.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      // A first install takes over at once. An update waits: swapping the shell
      // under a live map would discard the panel the pilot is reading, so the
      // page asks for STRATOS_SKIP_WAITING when the user accepts the update.
      .then(() => caches.keys())
      .then(keys => { if (keys.length <= 1) return self.skipWaiting(); return undefined; })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'STRATOS_SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isLiveRequest(url) {
  return (
    url.pathname.includes('/api/') ||
    url.pathname.endsWith('/logbook.json') ||
    // The release manifest is checked fresh; a cached copy would keep offering
    // an old "latest" version after a new release is published.
    url.pathname.endsWith('/releases.json') ||
    url.pathname.endsWith('/health') ||
    url.pathname.endsWith('/stream') ||
    url.pathname.endsWith('/metar') ||
    url.pathname.endsWith('/weather') ||
    url.pathname.endsWith('/airports.json') ||
    url.pathname.endsWith('/navaids.json') ||
    url.pathname.startsWith('/tile/') ||
    url.pathname.startsWith('/relay/')
  );
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isLiveRequest(url)) return;
  // Never cache range requests (chart PDFs) or authenticated responses.
  if (request.headers.has('range') || request.headers.has('authorization')) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          /* An installed bag must open the bag, not the Flight Deck. */
          const wantsEfb = /\/efb\.html$/.test(new URL(request.url).pathname);
          if (wantsEfb) return (await caches.match('efb.html')) || Response.error();
          return (await caches.match('index.html')) || (await caches.match('./')) || Response.error();
        }
        return Response.error();
      })
  );
});
