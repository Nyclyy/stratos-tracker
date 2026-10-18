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

test('weather center names the airport when the lookup answers and falls back to the code', async () => {
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
  const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const calls = [];
  define('fetch', async url => {
    const target = String(url);
    calls.push(target);
    if (target.includes('ourairports')) {
      // Only MMMX resolves; anything else returns an empty result set.
      return json(target.includes('MMMX')
        ? { results: [{ ident: 'MMMX', name: 'Mexico City Benito Juárez International Airport', city: 'Mexico City', country: 'MX', elev: 7316 }] }
        : { results: [] });
    }
    if (target.includes('weather')) {
      return json({
        icao: 'MMMX',
        metar: 'METAR MMMX 181855Z 32004KT 10SM FEW020 SCT080 BKN220 22/09 A3035 NOSIG',
        taf: 'TAF MMMX 181700Z 1818/1918 32004KT P6SM SKC',
      });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  });
  define('HTMLElement', window.HTMLElement);
  define('Event', window.Event);
  define('CustomEvent', window.CustomEvent);

  const inline = [...window.document.querySelectorAll('script:not([src])')].map(node => node.textContent).join('\n');
  new Function(inline)();
  // The button's handler is an inline onclick attribute, which linkedom does not
  // execute, so drive the search the way a keyboard user does.
  const search = id => {
    const input = window.document.getElementById('icao-input');
    input.value = id;
    const event = new window.Event('keydown', { bubbles: true });
    event.key = 'Enter';
    input.dispatchEvent(event);
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));

  search('MMMX');
  await settle();
  const name = window.document.getElementById('apt-name');
  assert.equal(name.textContent, 'Mexico City Benito Juárez International Airport', 'the real name replaces the bare code');
  assert.match(window.document.getElementById('apt-extra').textContent, /Mexico City · MX · elev 7,316 ft/);

  // METAR and TAF must share one station request rather than sending two.
  assert.equal(calls.filter(url => url.includes('/api/weather')).length, 1, 'one station request per search');

  // A station with no lookup available keeps the ICAO rather than showing nothing.
  search('KJFK');
  await settle();
  assert.equal(window.document.getElementById('apt-name').textContent, 'KJFK', 'the code is the fallback');
  assert.equal(window.document.getElementById('apt-extra').textContent, '', 'no stray location line');
});

test('weather center drops its own chrome only when embedded', async () => {
  const { parseHTML } = await import('linkedom');
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../app/weather.html', import.meta.url), 'utf8');
  const boot = search => {
    const { window } = parseHTML(html);
    const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true });
    define('window', window);
    define('document', window.document);
    define('navigator', window.navigator);
    define('location', { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/weather.html' + search, search, hash: '' });
    define('localStorage', { store: new Map(), getItem(k) { return this.store.get(k) ?? null; }, setItem(k, v) { this.store.set(k, String(v)); }, removeItem(k) { this.store.delete(k); } });
    define('fetch', async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }));
    define('HTMLElement', window.HTMLElement);
    define('Event', window.Event);
    define('CustomEvent', window.CustomEvent);
    const inline = [...window.document.querySelectorAll('script:not([src])')].map(node => node.textContent).join('\n');
    new Function(inline)();
    return window;
  };

  const embedded = boot('?embed=1');
  assert.equal(embedded.document.documentElement.getAttribute('data-embed'), '1', 'the map panel gets a chrome-free page');
  assert.ok(embedded.document.getElementById('bottom-nav'), 'the nav still exists in the markup, only hidden by CSS');

  const standalone = boot('');
  assert.equal(standalone.document.documentElement.getAttribute('data-embed'), null, 'the standalone page keeps its chrome');
});

test('the shell reports simulator state honestly and never invents a connection', async () => {
  installDom();
  document.body.innerHTML = '<div class="app-shell"><header id="appbar"></header><section id="homestats"></section></div>';
  const { mountShell } = await import('../app/js/shell.js');

  globalThis.fetch = async () => { throw new Error('no bridge here'); };
  const offline = mountShell({ page: 'home', stats: true });
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(document.querySelectorAll('[data-status]').length, 2, 'simulator and live status are separate');
  const sim = document.querySelector('[data-status="sim"]');
  assert.match(sim.textContent, /offline/i);
  assert.ok(!sim.className.includes('is-live'), 'an unreachable bridge is never shown as connected');
  assert.match(document.querySelector('[data-status="live"]').textContent, /no live data/i);
  assert.ok(document.querySelector('.tb-perf').options.length >= 3, 'the resource profile selector keeps every mode');
  assert.equal(document.querySelectorAll('.stat-card').length, 4, 'four home totals');
  assert.match(document.querySelector('#homestats').textContent, /0\.0 h/, 'no logbook means honest zeros');
  offline.destroy();

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ version: '2.1.6', simulator: { connected: true, source: 'xplane' } }),
  });
  const live = mountShell({ page: 'home', stats: false });
  await new Promise(resolve => setTimeout(resolve, 40));
  const sim2 = document.querySelector('[data-status="sim"]');
  assert.match(sim2.textContent, /simulator live/i);
  assert.ok(sim2.className.includes('is-live'));
  assert.match(document.querySelector('[data-status="live"]').textContent, /live tracking/i);
  live.destroy();
});


test('the home sidebar is a real rail that collapses and remembers the choice', async () => {
  installDom();
  const fs = await import('node:fs');
  const { parseHTML } = await import('linkedom');
  const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  const { window } = parseHTML(html);
  for (const [key, value] of [
    ['window', window],
    ['document', window.document],
    ['navigator', window.navigator],
    ['HTMLElement', window.HTMLElement],
    ['Event', window.Event],
    ['location', { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/index.html', hash: '' }],
  ]) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  globalThis.fetch = async () => { throw new Error('no bridge'); };

  const { mountShell } = await import('../app/js/shell.js');
  const shell = mountShell({ page: 'home', stats: false });
  try {
    const rail = document.querySelector('#tabs');
    assert.ok(rail.closest('.app-shell'), 'the rail lives in the shell, not inside the map');
    assert.equal(document.querySelector('#app #tabs'), null, 'the map no longer owns the navigation');
    const items = [...rail.querySelectorAll('.tab')].filter(item => !item.classList.contains('rail-toggle'));
    assert.equal(items.length, 10, 'ten destinations in the sidebar');
    const hrefs = [...rail.querySelectorAll('a.tab')].map(a => a.getAttribute('href'));
    assert.deepEqual(hrefs, ['logbook.html', 'pilot.html#airports', 'pilot.html#career', 'pilot.html#settings']);
    for (const id of ['bMap', 'bLive', 'bCh', 'bRoute', 'bWx', 'bData']) {
      assert.ok(document.getElementById(id), `${id} still drives its map panel`);
    }
    assert.equal(document.querySelectorAll('[data-status]').length, 2, 'the bar still reports status');

    const toggle = rail.querySelector('.rail-toggle');
    toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(document.querySelector('.app-shell').dataset.collapsed, '1');
    assert.equal(localStorage.getItem('stratos.rail'), 'collapsed');
    toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(document.querySelector('.app-shell').dataset.collapsed, undefined);
    assert.equal(localStorage.getItem('stratos.rail'), 'open');
  } finally {
    shell.destroy();
  }
});

test('the shared stylesheet never imposes a page layout grid', async () => {
  // shell.css loads after the page's own <style>, so a grid template here would
  // silently win and collapse the sidebar/map columns. The page owns its grid.
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../app/shell.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/\.app-shell\s*\{([^}]*)\}/g)].map(match => match[1]).join('\n');
  assert.ok(!/grid-template|display:\s*grid/.test(rules), 'shell.css must stay out of the page grid');
  assert.match(css, /--shell-rail:\s*\d+px/, 'the rail keeps a concrete width token');
});
