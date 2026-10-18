/* Stratos service worker.
   The shell is available offline after the first visit. Live data, telemetry,
   logbook JSON, weather and map tiles are NEVER cached, so stale data can never
   be presented as live. A new build replaces the old cache on activation. */
const CACHE = 'stratos-shell-v3';
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
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
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
          return (await caches.match('index.html')) || (await caches.match('./')) || Response.error();
        }
        return Response.error();
      })
  );
});
