import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

function installDom() {
  const { window } = parseHTML('<!doctype html><html data-theme="night"><head></head><body><div id="view"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  for (const [key, value] of [
    ['navigator', window.navigator],
    ['location', { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/pilot.html', hash: '' }],
  ]) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) { return this.store.get(key) ?? null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
}

test('career dashboard renders and opens its widget customizer', async () => {
  installDom();
  const { computeCareer } = await import('../app/js/lib/stats.js');
  const { mount, WIDGET_KEYS } = await import('../app/js/pilot/career.js');
  const now = Date.now();
  const flights = Array.from({ length: 12 }, (_, index) => ({
    id: `f${index}`,
    complete: true,
    startTime: now - index * 86400000,
    takeoffTime: now - index * 86400000,
    landingTime: now - index * 86400000 + 3600000,
    depAirport: index % 2 ? 'KSFO' : 'KLAX',
    arrAirport: index % 2 ? 'KLAX' : 'KJFK',
    aircraft: index % 3 ? 'B738' : 'A320',
    distanceNm: 300 + index * 10,
    maxAlt: 35000,
    landing: { vsFpm: -120 - index, gsKt: 130, runway: { id: '28L' } },
    track: [],
  }));
  const root = document.getElementById('view');
  await mount(root, {
    career: computeCareer(flights),
    flights,
    toast() {},
    openFlight() {},
    async reload() {},
  });

  assert.equal(root.querySelectorAll('.dashboard-cards .stat').length, 4);
  const customize = root.querySelector('[data-customize]');
  assert.ok(customize, 'customize button exists');
  customize.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(document.querySelector('.dialog-backdrop'), 'dialog opens');
  // Every catalogued widget is offered, so the count follows the catalogue.
  assert.equal(document.querySelectorAll('.widget-row').length, WIDGET_KEYS.length);
  assert.ok(document.querySelector('.widget-row [data-drag]'), 'rows expose a drag handle');
});

test('settings page renders bridge and phone sections', async () => {
  installDom();
  const { mount } = await import('../app/js/pilot/settings.js');
  const root = document.getElementById('view');
  await mount(root, {
    health: {
      version: '2.1.0', uptimeSeconds: 120, simulator: { connected: false, source: '' },
      xplane: { ready: true }, msfs: { available: false }, ports: { udp: 49003 },
      airports: 100, faaCharts: 10, logbook: { flights: 0, hours: 0 },
      dataDir: '/tmp', identity: { aircraft: '', registration: '', callsign: '' },
    },
    async reload() {},
  });
  assert.match(root.textContent, /Simulator bridge/);
  assert.match(root.textContent, /Phone access/);
  assert.match(root.textContent, /Resource profile/);
});

test('dashboard layout helpers clamp moves and reject bad stored data', async () => {
  const { moveWidget, normalizeLayout, DEFAULT_CARDS, WIDGET_KEYS } = await import('../app/js/pilot/career.js');
  assert.deepEqual(moveWidget(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveWidget(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveWidget(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c'], 'no-op move keeps order');
  assert.deepEqual(moveWidget(['a', 'b', 'c'], 0, 9), ['a', 'b', 'c'], 'out of range is ignored');
  assert.deepEqual(moveWidget(['a', 'b', 'c'], -1, 0), ['a', 'b', 'c'], 'negative index is ignored');
  assert.deepEqual(moveWidget(null, 0, 1), []);

  assert.deepEqual(normalizeLayout(null).cards, DEFAULT_CARDS, 'missing layout falls back');
  assert.deepEqual(normalizeLayout({ cards: [] }).cards, DEFAULT_CARDS, 'empty layout falls back');
  assert.deepEqual(normalizeLayout({ cards: ['bogus'] }).cards, DEFAULT_CARDS, 'unknown keys fall back');
  assert.deepEqual(normalizeLayout({ cards: ['rank', 'rank', 'bogus', 'week'] }).cards, ['rank', 'week'], 'duplicates and unknown keys dropped');
  // What was saved must come back in the same order, dense flag included.
  const reloaded = normalizeLayout({ cards: ['week', 'landings', 'rank'], dense: true, version: 1 });
  assert.deepEqual(reloaded.cards, ['week', 'landings', 'rank'], 'saved order survives a reload');
  assert.equal(reloaded.dense, true, 'saved density survives a reload');
  assert.equal(normalizeLayout({ cards: ['week'], dense: 1 }).dense, true);
  assert.equal(normalizeLayout({ cards: ['week'] }).dense, false);
  for (const key of normalizeLayout({ cards: ['rank', 'week'] }).cards) {
    assert.ok(WIDGET_KEYS.includes(key), `${key} is a real widget`);
  }
});

test('customizer arrows reorder rows and renumber positions', async () => {
  installDom();
  const { computeCareer } = await import('../app/js/lib/stats.js');
  const { mount } = await import('../app/js/pilot/career.js');
  const now = Date.now();
  const flights = Array.from({ length: 3 }, (_, index) => ({
    id: `r${index}`, complete: true, startTime: now - index * 86400000,
    takeoffTime: now - index * 86400000, landingTime: now - index * 86400000 + 3600000,
    depAirport: 'EGLL', arrAirport: 'KJFK', aircraft: 'B738', distanceNm: 3000,
    maxAlt: 35000, landing: { vsFpm: -140, gsKt: 130, runway: { id: '27L' } }, track: [],
  }));
  const root = document.getElementById('view');
  await mount(root, { career: computeCareer(flights), flights, toast() {}, openFlight() {}, async reload() {} });
  root.querySelector('[data-customize]').dispatchEvent(new window.Event('click', { bubbles: true }));

  const rows = () => [...document.querySelectorAll('.widget-row')];
  const firstKey = rows()[0].dataset.key;
  assert.equal(rows()[0].querySelector('[data-pos]').textContent, '1');
  rows()[0].querySelector('[data-down]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(rows()[1].dataset.key, firstKey, 'row moved down one place');
  assert.equal(rows()[1].querySelector('[data-pos]').textContent, '2', 'positions renumber');

  // Moving the first row up is a no-op, not a crash.
  const topKey = rows()[0].dataset.key;
  rows()[0].querySelector('[data-up]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(rows()[0].dataset.key, topKey);
});

test('weather center boots and its watchlist adds, dedupes and removes stations', async () => {
  const { parseHTML } = await import('linkedom');
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../app/weather.html', import.meta.url), 'utf8');
  const { window } = parseHTML(html);
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true });
  define('window', window);
  define('document', window.document);
  define('navigator', window.navigator);
  define('location', { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/weather.html', search: '', hash: '' });
  define('localStorage', {
    store: new Map(),
    getItem(key) { return this.store.get(key) ?? null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  });
  // No network in tests: every station request fails cleanly.
  define('fetch', async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }));
  define('HTMLElement', window.HTMLElement);
  define('Event', window.Event);
  define('CustomEvent', window.CustomEvent);

  const inline = [...window.document.querySelectorAll('script:not([src])')].map(node => node.textContent).join('\n');
  assert.match(inline, /renderWatch/, 'watchlist code is present in the page');

  // Running the page script is itself the test: it wires every element by id,
  // so a renamed or missing id throws here instead of failing silently in a browser.
  new Function(inline)();

  const body = window.document.getElementById('watch-body');
  assert.match(body.textContent, /No airports yet/);

  const addButton = window.document.getElementById('watch-add-btn');
  const input = window.document.getElementById('watch-input');
  const click = element => element.dispatchEvent(new window.Event('click', { bubbles: true }));

  input.value = 'kden';
  click(addButton);
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('wx.watch')), ['KDEN'], 'lowercase input is stored as an ICAO');
  assert.match(body.textContent, /KDEN/);

  input.value = 'KDEN';
  click(addButton);
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('wx.watch')), ['KDEN'], 'a duplicate is not added twice');
  assert.equal(body.querySelectorAll('tr[data-watch]').length, 1);

  click(window.document.getElementById('watch-auto'));
  assert.equal(window.document.getElementById('watch-auto').getAttribute('aria-pressed'), 'true');
  assert.equal(globalThis.localStorage.getItem('wx.watchAuto'), '1', 'auto refresh choice persists');
  click(window.document.getElementById('watch-auto'));
  assert.equal(globalThis.localStorage.getItem('wx.watchAuto'), '0');

  click(body.querySelector('[data-remove="KDEN"]'));
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('wx.watch')), [], 'remove clears the stored station');
  assert.match(body.textContent, /No airports yet/);
});
