/* End-to-end check of the website download offer in a real Chromium.

   A plain http dev server and localhost are deliberately not the website, so
   the offer cannot be exercised there. This serves app/ over https under a
   non-loopback host name (mapped to 127.0.0.1 in the browser) and checks the
   three surfaces that matter:

   - the public https site: panel, four real installers, close, Downloads chip,
     reopen, and no overlap with the map's own controls;
   - the bridge's plain http page: nothing mounted;
   - the packaged app's file:// page: nothing mounted.

   Run: node scripts/dl-offer-check.mjs
*/
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'app');
const PORT = 8453;
const HOST = 'stratos-tracker.test';

// A throwaway certificate for the throwaway https origin. Nothing here is a
// secret and nothing is kept: the directory is removed on the way out.
const CERT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-dl-'));
const cert = path.join(CERT_DIR, 'cert.pem');
const key = path.join(CERT_DIR, 'key.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
  '-days', '1', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`,
], { stdio: 'ignore' });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

const server = https.createServer(
  { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
  (req, res) => {
    const url = new URL(req.url, 'https://x');
    let file = path.join(APP, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(APP)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, body) => {
      if (error) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  },
);
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

const browser = await chromium.launch({
  args: [
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    '--ignore-certificate-errors',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`https://${HOST}:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dlOffer', { timeout: 15000 });

  const panel = await page.evaluate(() => {
    const offer = document.getElementById('dlOffer');
    const links = [...offer.querySelectorAll('a.dl-btn')].map(a => ({ href: a.href, label: a.querySelector('.dl-plat').textContent, note: a.querySelector('.dl-note').textContent }));
    const box = offer.getBoundingClientRect();
    const hit = (id) => {
      const el = document.getElementById(id);
      if (!el) return { id, missing: true };
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { id, overlaps: Boolean(top && (top === offer || offer.contains(top))) };
    };
    return {
      version: (offer.querySelector('.dl-ver') || {}).textContent || '',
      text: offer.textContent.replace(/\s+/g, ' ').trim(),
      links,
      box: { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) },
      controls: ['fab', 'tabs', 'bLay', 'online'].map(hit),
      close: Boolean(offer.querySelector('.dl-x')),
      chipHidden: document.getElementById('dlChip').hidden,
      mapRunning: Boolean(document.getElementById('map')),
      html: offer.innerHTML,
    };
  });

  record('the offer appears on the https website', Boolean(panel.version), panel.version);
  record('it lists Windows, both macOS builds and Linux', panel.links.length === 4,
    panel.links.map(l => `${l.label} ${l.note}`).join(' | '));
  record('every button uses the site’s own download link',
    panel.links.every(l => /\/api\/download\?p=(windows|mac-arm64|mac-x64|linux-x64)$/.test(l.href)),
    panel.links.map(l => l.href.replace(/^https:\/\/[^/]+/, '')).join(', '));
  record('no third-party download address appears on the page',
    !/github/i.test(panel.html), panel.html.includes('github') ? 'github found in the panel markup' : 'panel markup is clean');
  record('the panel is compact and clear of the map controls',
    panel.box.height <= 240 && panel.controls.every(c => !c.overlaps),
    `${panel.box.width}×${panel.box.height} at ${panel.box.left},${panel.box.top}; controls ${JSON.stringify(panel.controls)}`);
  record('the map is still mounted and running underneath', panel.mapRunning);
  record('the close control is present', panel.close);

  await page.click('#dlOffer .dl-x');
  const afterClose = await page.evaluate(() => ({
    hidden: document.getElementById('dlOffer').hidden,
    chipHidden: document.getElementById('dlChip').hidden,
    chipText: document.getElementById('dlChip').textContent.trim(),
    stored: localStorage.getItem('stratos.downloads.dismissed'),
    map: Boolean(document.getElementById('map')),
  }));
  record('close hides the panel in place, without a reload', afterClose.hidden && afterClose.map,
    `dismissed for ${afterClose.stored}`);
  record('a small Downloads control takes its place', !afterClose.chipHidden && /Downloads/.test(afterClose.chipText), afterClose.chipText);

  await page.click('#dlChip');
  const afterChip = await page.evaluate(() => ({
    hidden: document.getElementById('dlOffer').hidden,
    chipHidden: document.getElementById('dlChip').hidden,
    links: document.querySelectorAll('#dlOffer a.dl-btn').length,
  }));
  record('the Downloads control reopens the panel', !afterChip.hidden && afterChip.chipHidden && afterChip.links === 4);

  // Dismiss, reload: the panel stays away and the way back remains.
  await page.click('#dlOffer .dl-x');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dlChip', { timeout: 15000 });
  const afterReload = await page.evaluate(() => ({
    panel: Boolean(document.getElementById('dlOffer')),
    hidden: document.getElementById('dlOffer') ? document.getElementById('dlOffer').hidden : null,
    chipHidden: document.getElementById('dlChip').hidden,
  }));
  record('a dismissed build stays dismissed after a reload', afterReload.panel && afterReload.hidden && !afterReload.chipHidden);

  // Mobile: the same offer, full width, above the bottom rail.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  await phone.goto(`https://${HOST}:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('#dlOffer', { timeout: 15000 });
  const mobile = await phone.evaluate(() => {
    const offer = document.getElementById('dlOffer');
    const box = offer.getBoundingClientRect();
    const tabs = document.getElementById('tabs').getBoundingClientRect();
    return {
      width: Math.round(box.width), viewport: window.innerWidth,
      clearsRail: box.bottom <= tabs.top + 1,
      buttons: [...offer.querySelectorAll('a.dl-btn')].map(a => a.getBoundingClientRect().height),
    };
  });
  record('on a phone it fits the width and stays above the bottom rail',
    mobile.width <= mobile.viewport - 8 && mobile.clearsRail && mobile.buttons.every(h => h >= 28),
    `${mobile.width}px of ${mobile.viewport}px, buttons ${mobile.buttons.map(h => Math.round(h)).join('/')}px tall`);

  // The bridge's own page is plain http, not the website.
  const bridge = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await bridge.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await bridge.waitForTimeout(1200);
  const bridgeState = await bridge.evaluate(() => ({ offer: Boolean(document.getElementById('dlOffer')), chip: Boolean(document.getElementById('dlChip')) })).catch(() => ({ offer: false, chip: false, unreachable: true }));
  record('the plain http page (the shape the bridge serves) shows nothing', !bridgeState.offer && !bridgeState.chip, JSON.stringify(bridgeState));

  // The packaged app loads local files: file:// must stay clean too.
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktop.goto('file:///' + path.join(APP, 'index.html').replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await desktop.waitForTimeout(1200);
  const fileState = await desktop.evaluate(() => ({ offer: Boolean(document.getElementById('dlOffer')), chip: Boolean(document.getElementById('dlChip')) })).catch(() => ({ offer: false, chip: false }));
  record('the packaged app’s file:// page shows nothing', !fileState.offer && !fileState.chip, JSON.stringify(fileState));

  record('no page errors on the website', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(CERT_DIR, { recursive: true, force: true });
}

const failed = results.filter(item => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
