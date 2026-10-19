// Browser check for the native Charts workspace.
// Requires: the bridge on 127.0.0.1:8765 (it serves the app too) and a
// Premium-capable stub injected before the page loads.
// Usage: node scripts/chart-check.mjs

import { chromium } from 'playwright';

// Served by the bridge itself, so the page and its data share an origin.
const URL_BASE = 'http://127.0.0.1:8765/pilot.html';
const PREMIUM = { premium: true, verified: true, mode: 'licence', plan: 'Premium licence' };
const FREE = { premium: false, verified: true, mode: 'none', reason: 'No licence service is configured.' };

const browser = await chromium.launch({ headless: true });
const problems = [];

async function open(entitlement) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(value => {
    window.stratosDesktop = { getEntitlement: async () => value };
  }, entitlement);
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  await page.goto(`${URL_BASE}#charts?icao=KJFK`, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

// ── Premium view ────────────────────────────────────────────────────────
const premium = await open(PREMIUM);
const page = premium.page;
await page.waitForSelector('.chart-row', { timeout: 30000 }).catch(error => {
  console.log('problems so far:', problems);
  throw error;
});
const header = await page.locator('#charts-head').innerText();
const groups = await page.locator('.chart-group-head h3').allInnerTexts();
const rows = await page.locator('.chart-row').count();
const meta = await page.locator('.chart-meta').innerText();
console.log('groups:', groups.join(' | '));
console.log('rows:', rows);
console.log('meta:', meta.replace(/\s+/g, ' '));

// Open the airport diagram (single page, dense vector content).
const diagram = page.locator('.chart-row', { hasText: 'AIRPORT DIAGRAM' }).first();
await diagram.click();
await page.waitForSelector('.chart-stage canvas', { timeout: 30000 });
// The canvas element exists before pdf.js has painted it: wait for the real
// render, which replaces the 300 px default backing store and sets a zoom.
await page.waitForFunction(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  const zoom = document.getElementById('chart-zoom');
  return canvas && canvas.width > 400 && zoom && /%$/.test(zoom.textContent);
}, null, { timeout: 30000 });
await page.waitForTimeout(200);
const before = await page.evaluate(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  return { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width, zoom: document.getElementById('chart-zoom')?.textContent, pages: document.getElementById('chart-pages')?.textContent };
});
await page.screenshot({ path: 'artifacts/charts-diagram.png' });

await page.click('[data-zoom="in"]');
await page.click('[data-zoom="in"]');
await page.waitForTimeout(700);
const zoomed = await page.evaluate(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  return { width: canvas.width, zoom: document.getElementById('chart-zoom')?.textContent, transform: canvas.style.transform };
});

// Drag to pan: the transform must move the page.
const box = await page.locator('.chart-stage').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 - 140, box.y + box.height / 2 - 90, { steps: 8 });
await page.mouse.up();
const panned = await page.evaluate(() => document.querySelector('.chart-stage canvas').style.transform);

// Fit width returns to the stage width.
await page.click('[data-fit="width"]');
await page.waitForTimeout(400);
const fitted = await page.evaluate(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  const stage = document.querySelector('.chart-stage');
  return { cssWidth: parseFloat(canvas.style.width), stageWidth: stage.clientWidth, zoom: document.getElementById('chart-zoom')?.textContent };
});

// Switch charts: an approach procedure with a different document.
const approach = page.locator('.chart-row', { hasText: /ILS|RNAV/ }).first();
const approachTitle = await approach.locator('b').innerText();
await approach.click();
await page.waitForTimeout(1200);
await page.waitForSelector('.chart-stage canvas', { timeout: 30000 });
const switched = await page.evaluate(() => ({
  title: document.querySelector('.chart-footer-main b')?.textContent,
  validity: document.getElementById('chart-viewer-status')?.textContent,
  source: document.querySelector('.chart-footer-main span')?.textContent,
}));

// Search by ICAO for another airport.
await page.fill('#chart-airport', 'KDEN');
await page.press('#chart-airport', 'Enter');
await page.waitForTimeout(2500);
await page.waitForSelector('.chart-row', { timeout: 30000 });
const denver = await page.locator('.chart-row').count();
const denverHeader = await page.locator('.chart-meta').innerText();

// A filter narrows the visible list without a new network request.
await page.fill('#chart-filter', 'ILS');
await page.waitForTimeout(250);
const filtered = await page.locator('.chart-row').count();

await page.screenshot({ path: 'artifacts/charts-filter.png' });

// ── Free view ──────────────────────────────────────────────────────────
const free = await open(FREE);
const freePage = free.page;
await freePage.waitForSelector('.chart-row', { timeout: 30000 });
const freeRows = await freePage.locator('.chart-row').count();
const freeLocks = await freePage.locator('.chart-row-lock').count();
const freePanel = await freePage.locator('.premium-panel').innerText();
await freePage.locator('.chart-row').first().click();
await freePage.waitForTimeout(300);
const gated = await freePage.evaluate(() => ({
  canvas: Boolean(document.querySelector('.chart-stage canvas')),
  panel: Boolean(document.querySelector('.premium-panel')),
  text: document.querySelector('.premium-status')?.innerText,
}));
await freePage.screenshot({ path: 'artifacts/charts-premium-gate.png' });

console.log('premium header:', header.replace(/\s+/g, ' ').slice(0, 160));
console.log('diagram before:', before);
console.log('after zoom:', zoomed);
console.log('transform after pan:', panned);
console.log('fit width:', fitted);
console.log('switched to:', approachTitle, switched);
console.log('denver rows:', denver, 'cycle:', denverHeader.replace(/\s+/g, ' ').slice(0, 120));
console.log('filtered rows:', filtered);
console.log('free rows/locks:', freeRows, freeLocks, 'panel:', freePanel.split('\n')[0]);
console.log('free gate:', gated);
console.log('problems:', problems.length ? problems : 'none');

await browser.close();

const ok = rows > 20 && before.width > 200 && zoomed.width > before.width && panned !== 'translate3d(0px, 0px, 0px)'
  && Math.abs(fitted.cssWidth - fitted.stageWidth) < 200 && denver > 10 && filtered > 0
  && freeRows === rows && freeLocks === rows && !gated.canvas && gated.panel && problems.length === 0;
console.log(ok ? 'CHART CHECK PASSED' : 'CHART CHECK FAILED');
process.exit(ok ? 0 : 1);
