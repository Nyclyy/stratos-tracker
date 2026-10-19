// World basemap benchmark: how long one sheet rebuild costs in a real browser.
//
// The World style paints country outlines, names and water names into an
// offscreen sheet and blits that sheet while the view only pans, so the number
// that matters is a rebuild (snap, zoom or theme change), not a frame. This
// serves app/ from a throwaway static server, opens the tracker with the World
// style selected, and times buildWorld() and worldLayer() at three zooms.
//
// Playwright is deliberately not a project dependency: it would add a ~120 MB
// browser download to every install. Install it when you want this number:
//
//   npx playwright install chromium
//   node scripts/world-bench.mjs
//
// If Playwright lives somewhere node will not resolve, point at its entry file:
//
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs node scripts/world-bench.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'app');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, requested === '/' ? 'index.html' : requested);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const port = await new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

// The tracker keeps its state in top-level bindings, so the hooks are appended
// to the page rather than injected from the outside: a later classic script
// shares the same global lexical scope.
page.route('**/index.html', async route => {
  const response = await route.fetch();
  const body = (await response.text()).replace('</body>', `<script>
    window.__benchRebuild=(z,lon,lat,n)=>{V.z=z;V.lon=lon;V.lat=lat;
      const c=document.createElement('canvas');c.width=W+WM*2;c.height=H+WM*2;
      const g=c.getContext('2d');
      buildWorld(g);
      const t0=performance.now();
      for(let i=0;i<n;i++)buildWorld(g);
      return (performance.now()-t0)/n};
    window.__benchPan=(z,lon,lat,n)=>{V.z=z;V.lon=lon;V.lat=lat;wkey='';
      worldLayer();
      const t0=performance.now();
      for(let i=0;i<n;i++){V.lon+=0.02;worldLayer()}
      return (performance.now()-t0)/n};
    window.__benchLatency=(z,lon,lat,n)=>{V.z=z;V.lon=lon;V.lat=lat;
      const t0=performance.now();
      for(let i=0;i<n;i++){wkey='';worldLayer()}
      return (performance.now()-t0)/n};
  </script></body>`);
  await route.fulfill({ response, body });
});
await page.addInitScript(() => {
  localStorage.setItem('dl.style', 'world');
  localStorage.setItem('dl.theme', 'night');
});
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
await page.waitForTimeout(800);

const rows = await page.evaluate(() => [
  { view: 'world (z2.9)', z: 2.9, lon: -20, lat: 35, rebuild: 40, pan: 300, latency: 12 },
  { view: 'continent (z6)', z: 6, lon: -3, lat: 40, rebuild: 40, pan: 300, latency: 12 },
  { view: 'city (z9)', z: 9, lon: -122.4, lat: 37.8, rebuild: 40, pan: 300, latency: 12 },
].map(r => ({
  view: r.view,
  rebuild: window.__benchRebuild(r.z, r.lon, r.lat, r.rebuild),
  pan: window.__benchPan(r.z, r.lon, r.lat, r.pan),
  latency: window.__benchLatency(r.z, r.lon, r.lat, r.latency),
})));

const version = browser.version();
console.log(`viewport 1280x800, dpr 1, ${version}, software rasterisation`);
console.log('view                 rebuild sheet   pan frame (cached)   centre change -> painting');
for (const r of rows) {
  console.log(`${r.view.padEnd(20)} ${(r.rebuild.toFixed(2) + ' ms').padEnd(15)} ${(r.pan.toFixed(3) + ' ms').padEnd(20)} ${r.latency.toFixed(2)} ms`);
}

await browser.close();
server.close();
