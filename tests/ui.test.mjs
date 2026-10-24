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
  // Node 22+ exposes `localStorage` as a non-writable global, so a plain
  // assignment throws; define it the same way as navigator and location above.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      store: new Map(),
      getItem(key) { return this.store.get(key) ?? null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); },
    },
  });
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

const settingsHealth = () => ({
  version: '2.1.12', uptimeSeconds: 120, simulator: { connected: false, source: '' },
  xplane: { ready: true }, msfs: { available: false }, ports: { udp: 49003 },
  airports: 100, faaCharts: 10, logbook: { flights: 0, hours: 0 },
  dataDir: '/tmp', identity: { aircraft: '', registration: '', callsign: '' },
});

const mountSettings = async desktop => {
  installDom();
  // Always assign: linkedom windows share state, so a stub from an earlier test
  // would otherwise leak into this one.
  window.stratosDesktop = desktop || null;
  const { mount } = await import('../app/js/pilot/settings.js');
  const root = document.getElementById('view');
  await mount(root, { health: settingsHealth(), async reload() {} });
  return root;
};

// The update centre reads the manifest over the network; tests serve one from
// memory so no suite depends on GitHub being reachable.
const updateManifest = (version = '2.1.13') => ({
  schemaVersion: 1,
  source: 'https://example.test',
  latest: {
    version,
    releasedAt: '2026-10-19',
    severity: 'normal',
    summary: '1 fix.',
    changelog: { features: [], improvements: [], fixes: ['Keep landing rates signed.'], performance: [], ui: [], compatibility: [], other: [] },
  },
  releases: [{
    version,
    releasedAt: '2026-10-19',
    severity: 'normal',
    summary: '1 fix.',
    changelog: { features: [], improvements: [], fixes: ['Keep landing rates signed.'], performance: [], ui: [], compatibility: [], other: [] },
  }],
});

const stubUpdateFetch = (version = '2.1.13') => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => updateManifest(version) });
};

const settle = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

// These dispatch real bubbled clicks, so a listener that re-renders the page
// mid-dispatch would hang the runner; the timeout turns that into a clean fail.
test('a click on the settings page does not re-render it through the theme listener', { timeout: 10000 }, async () => {
  const root = await mountSettings(null);
  const card = root.querySelector('.card');
  assert.ok(card, 'the settings page rendered a card');
  card.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector('.card'), card, 'a click elsewhere is not treated as a theme change');
});

test('the theme buttons still switch the theme', { timeout: 10000 }, async () => {
  await mountSettings(null);
  const day = document.querySelector('button[data-theme="day"]');
  assert.ok(day, 'the day theme button exists');
  day.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(document.documentElement.dataset.theme, 'day', 'the theme button still applies its theme');
});

test('the Settings update centre reports the desktop updater and its real version', { timeout: 10000 }, async () => {
  stubUpdateFetch('2.1.13');
  const calls = [];
  await mountSettings({
    async getUpdateStatus() { calls.push('status'); return { supported: true, currentVersion: '2.1.12', downloaded: false, version: '2.1.12' }; },
    async checkForUpdates() { calls.push('check'); return { supported: true, currentVersion: '2.1.12', downloaded: false, available: true, version: '2.1.13' }; },
    async installUpdate() { calls.push('install'); return { ok: true }; },
    onUpdateProgress() { return () => {}; },
  });
  await settle();
  const slot = document.getElementById('updates-slot');
  assert.ok(slot, 'the update card exists');
  assert.match(slot.textContent, /v2\.1\.13/, 'the published version is shown');
  assert.match(slot.textContent, /Installed/, 'the installed build is named');
  assert.ok(slot.querySelector('[data-check]'), 'there is a check control');
  assert.ok(calls.includes('check'), 'the centre asks the desktop updater, not the service worker');
  assert.ok(!calls.includes('install'), 'nothing is installed before a build has downloaded');
});

test('a downloaded desktop update becomes a restart-to-install action', { timeout: 10000 }, async () => {
  stubUpdateFetch('2.1.13');
  const calls = [];
  await mountSettings({
    async getUpdateStatus() { calls.push('status'); return { supported: true, currentVersion: '2.1.12', downloaded: true, version: '2.1.13', verified: true }; },
    async checkForUpdates() { calls.push('check'); return { supported: true, downloaded: true, version: '2.1.13' }; },
    async installUpdate() { calls.push('install'); return { ok: true }; },
    onUpdateProgress() { return () => {}; },
  });
  await settle();
  const apply = document.querySelector('[data-apply]');
  assert.ok(apply, 'the ready update has its own action');
  assert.match(apply.textContent, /Restart to update/, 'the action names what it will do');
  apply.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(calls.includes('install'), 'the click installs the downloaded update');
});

test('the browser build checks the manifest and reports the version honestly', { timeout: 10000 }, async () => {
  stubUpdateFetch('2.1.13');
  await mountSettings(null);
  await settle();
  const slot = document.getElementById('updates-slot');
  assert.ok(slot, 'the update card exists without the desktop bridge');
  assert.match(slot.textContent, /Latest published/, 'the published version is read from the manifest');
  assert.doesNotMatch(slot.textContent, /2\.1\.0\b/, 'no invented version is shown');
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
  // The Flight Deck is a full-bleed map now: no stat strip is injected into it.
  assert.equal(document.querySelectorAll('.stat-card').length, 0, 'the map page has no stat band');
  offline.destroy();

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ version: '2.1.6', simulator: { connected: true, source: 'xplane' } }),
  });
  const live = mountShell({ page: 'home', stats: false });
  await new Promise(resolve => setTimeout(resolve, 40));
  const sim2 = document.querySelector('[data-status="sim"]');
  assert.match(sim2.textContent, /live from xplane/i, 'the chip names the simulator it is reading');
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
    assert.equal(items.length, 5, 'five top-level destinations, never more');
    const hrefs = [...rail.querySelectorAll('a.tab')].map(a => a.getAttribute('href'));
    assert.deepEqual(hrefs, ['logbook.html', 'discover.html', 'pilot.html#settings']);
    for (const id of ['bMap', 'bRoute']) {
      assert.ok(document.getElementById(id), `${id} is one of the five tabs`);
    }
    // Features that used to own a tab now live in the map's own tools menu, so
    // every one of them is still one interaction away.
    for (const id of ['bLive', 'bCh', 'bWx', 'bData']) {
      assert.ok(document.getElementById(id), `${id} still drives its map panel`);
      assert.ok(document.getElementById(id).closest('#lay'), `${id} lives in the map tools menu`);
    }
    assert.equal(document.getElementById('bPlan'), null, 'the pencil-circle control is gone');
    // The Flight Deck bar carries the page's own state line rather than two
    // duplicate pills: one honest sentence about the feed it is actually reading.
    assert.equal(document.querySelectorAll('[data-status]').length, 0, 'no duplicate status pills beside the state line');
    const state = document.querySelector('#appbar [data-shell-status]');
    assert.ok(state, 'the connection state moves into the bar');
    assert.ok(state.closest('.tb-brand'), 'the state line sits under the wordmark');
    assert.ok(document.querySelector('#appbar #sb'), 'the search field sits in the bar');
    const support = document.querySelector('[data-support]');
    assert.ok(support, 'Support Us / Go Premium is in the bar');
    assert.match(support.textContent, /support us/i);
    assert.match(support.textContent, /go premium/i);
    const clock = document.querySelector('[data-clock]');
    assert.ok(clock, 'the UTC clock is in the bar');
    assert.match(clock.querySelector('b').textContent, /^\d{4}Z$/, 'the clock reads HHMMZ');
    assert.ok(document.querySelector('#appbar').classList.contains('tb--rail'), 'the rail pages centre the search on the bar');

    const toggle = rail.querySelector('.rail-toggle');
    assert.equal(document.querySelector('.app-shell').dataset.collapsed, '1', 'the rail opens icon-only');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the toggle reports the rail is collapsed');
    toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(document.querySelector('.app-shell').dataset.collapsed, undefined, 'one click expands it');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'and reports the expanded rail');
    assert.equal(localStorage.getItem('stratos.rail'), 'open');
    toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(document.querySelector('.app-shell').dataset.collapsed, '1', 'the next click collapses it again');
    assert.equal(localStorage.getItem('stratos.rail'), 'collapsed');
  } finally {
    shell.destroy();
  }
});

test('the icon rail names itself on hover and keyboard focus', async () => {
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
    const toggle = rail.querySelector('.rail-toggle');
    const item = rail.querySelector('.tab[data-label="Logbook"]');
    const tip = document.body.querySelector('.rail-tip');
    assert.ok(tip, 'one tooltip serves the icon rail');
    assert.equal(item.getAttribute('aria-label'), 'Logbook', 'the hidden label stays in the accessible name');
    assert.equal(item.hasAttribute('title'), false, 'no native title competes with the focus tooltip while collapsed');

    // The tooltip follows keyboard focus, not just the mouse.
    item.dispatchEvent(new window.Event('focusin', { bubbles: true }));
    assert.equal(tip.hidden, false, 'focus shows the tooltip');
    assert.equal(tip.textContent, 'Logbook', 'the tooltip carries the destination name');
    item.dispatchEvent(new window.Event('focusout', { bubbles: true }));
    assert.equal(tip.hidden, true, 'leaving hides it again');

    // A pointer crossing the rail waits before it names an icon, so a sweep
    // does not flash every label on the way past.
    item.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    assert.equal(tip.hidden, true, 'a passing pointer does not flash the name');
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(tip.hidden, false, 'a resting pointer gets the name');
    rail.dispatchEvent(new window.Event('pointerleave'));
    assert.equal(tip.hidden, true, 'leaving the rail hides it at once');

    // Expanded rows print their labels, so the native title is enough there.
    toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(item.getAttribute('title'), 'Logbook', 'the expanded row keeps a native title');
    assert.equal(tip.hidden, true, 'the tooltip stays out of the labelled sidebar');
    item.dispatchEvent(new window.Event('focusin', { bubbles: true }));
    assert.equal(tip.hidden, true, 'focusing an expanded row never opens it');
  } finally {
    shell.destroy();
    assert.equal(document.body.querySelector('.rail-tip'), null, 'the tooltip is removed with the shell');
  }
});

test('the expanded rail is a labelled sidebar and the focus ring stays inside it', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../app/shell.css', import.meta.url), 'utf8');
  const desktop = css.match(/@media \(min-width: 768px\) \{([\s\S]*?)\n\}/);
  assert.ok(desktop, 'the rail has a desktop block');
  const rules = desktop[1];
  assert.match(rules, /--rail: 244px/, 'the expanded rail fits the longest destination');
  assert.match(rules, /#tabs \.tab \{[^}]*flex-direction: row/, 'expanded rows put the icon beside the label');
  assert.match(rules, /#tabs \.tab span \{[^}]*text-transform: none/, 'labels are sentence case, not stacked captions');
  assert.match(rules, /\.app-shell\[data-collapsed="1"\] #tabs \.tab span \{ display: none; \}/, 'the icon rail hides its labels');
  assert.match(rules, /#tabs \.tab\.on:not\(\.act\)[^{]*\{ background: none;/, 'a live feed hint is not a second current page');
  assert.match(css, /#tabs \.tab:focus-visible \{ outline-offset: -2px; \}/, 'the rail draws its ring inside the pill');
  assert.match(css, /#appbar #sb:has\(#q:focus-visible\) \{[^}]*box-shadow:/, 'the search field shows a keyboard-focus ring, not only a border');
  assert.match(css, /\.rail-tip \{[^}]*position: fixed;/, 'the icon tooltip escapes the rail clip');
});

test('the flight card states an arrival time and the corner badge stays short', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /function etaZ\(duration\)/, 'remaining time becomes a clock time in the card');
  assert.match(page, /eta <b>'\+etaZ\(g\('tEt'\)\)/, 'the card prints the arrival, not the countdown');
  assert.match(page, /'Simulator online'/, 'the corner badge names the simulator when it is live');
  assert.ok(!/aircraft online'\):wtTxt\(\)/.test(page), 'the badge no longer prints the long feed sentence');
});

test('the rebuilt bar centres its search and the phone row stays inside the viewport', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../app/shell.css', import.meta.url), 'utf8');
  assert.match(css, /\.tb--rail \.tb-search \{[^}]*position:\s*absolute;[^}]*left:\s*50%/, 'the rail pages centre the search on the bar');
  assert.match(css, /@media \(max-width: 767px\) \{[^}]*\.tb-support,[^{]*\.tb-clock,[^{]*\.tb-perf-wrap \{ display: none; \}/, 'the phone bar drops the wide controls');
  assert.match(css, /@media \(max-width: 1024px\) \{[^}]*\.tb-support,[^{]*\.tb-perf-wrap \{ display: none; \}/, 'a narrow desktop drops the invitation and the profile before the row widens the page');
  assert.match(css, /@media \(max-width: 800px\) \{[^}]*\.tb-clock \{ display: none; \}/, 'the clock goes once the nav needs the room');
  assert.match(css, /\.tb-btn \{[^}]*white-space: nowrap;/, 'a bar label never wraps into a clipped second line');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /grid-template-columns:minmax\(0,1fr\);grid-template-rows:auto minmax\(0,1fr\) auto/, 'the shell column cannot be widened by its content');
});

test('the shared stylesheet never imposes a page layout grid', async () => {
  // shell.css loads after the page's own <style>, so a grid template here would
  // silently win and collapse the sidebar/map columns. The page owns its grid.
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../app/shell.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/\.app-shell\s*\{([^}]*)\}/g)].map(match => match[1]).join('\n');
  assert.ok(!/grid-template|display:\s*grid/.test(rules), 'shell.css must stay out of the page grid');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /grid-template-columns:var\(--rail\) minmax\(0,1fr\)/, 'the page owns the two-column grid');
});

test('the discover page turns a mood into three cards and hands one to the planner', async () => {
  installDom();
  const fs = await import('node:fs');
  const { parseHTML } = await import('linkedom');
  const html = fs.readFileSync(new URL('../app/discover.html', import.meta.url), 'utf8');
  const { window } = parseHTML(html);
  class FakeResizeObserver { observe() {} disconnect() {} }
  for (const [key, value] of [
    ['window', window], ['document', window.document], ['navigator', window.navigator],
    ['HTMLElement', window.HTMLElement], ['Event', window.Event], ['CustomEvent', window.CustomEvent],
    ['location', { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/discover.html', search: '', hash: '' }],
    ['ResizeObserver', FakeResizeObserver],
  ]) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  globalThis.fetch = async () => { throw new Error('no bridge in this test'); };

  await import('../app/js/discover.js');
  await new Promise(resolve => setTimeout(resolve, 80));

  const click = el => el.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(document.querySelectorAll('[data-category]').length, 10, 'ten moods are offered');
  assert.ok(document.getElementById('db-note').textContent.includes('airport'), 'the data source is stated');

  click(document.querySelector('[data-category="mountain"]'));
  assert.equal(document.querySelector('[data-category="mountain"]').getAttribute('aria-pressed'), 'true');
  click(document.getElementById('find'));

  const cards = document.querySelectorAll('.route-card');
  assert.equal(cards.length, 3, 'three recommendations');
  assert.ok(document.querySelector('.map-panel'), 'a map preview is present');
  assert.ok(cards[0].textContent.includes('estimated'));

  const second = cards[1];
  click(second);
  assert.equal(second.getAttribute('aria-selected'), 'true', 'selecting a card updates the preview');
  assert.equal(cards[0].getAttribute('aria-selected'), 'false');

  click(second.querySelector('[data-act="fly"]'));
  const active = JSON.parse(localStorage.getItem('stratos.activeRoute'));
  assert.ok(active && Array.isArray(active.points) && active.points.length >= 2, 'the route is handed to the planner');
  assert.equal(active.points[0].kind, 'apt');
  assert.ok(localStorage.getItem('dl.route'), 'the map route payload is written too');

  assert.equal(document.querySelectorAll('[data-act="save"]').length, 3, 'each card offers Save Route');

  click(document.getElementById('again'));
  assert.equal(document.querySelectorAll('.route-card').length, 3, 'alternatives still return three cards');
  window.StratosShell?.destroy();
});

test('the existing route planner opens a Discover route without a rebuild', async () => {
  installDom();
  const points = [
    { id: 'LSZH', name: 'Zurich', lat: 47.458, lon: 8.548, elev: 1416, kind: 'apt' },
    { id: 'LOWI', name: 'Innsbruck', lat: 47.26, lon: 11.344, elev: 1906, kind: 'apt' },
  ];
  localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: null, name: 'Alpine Escape', points }));

  const { mount } = await import('../app/js/pilot/routes.js');
  const root = document.getElementById('view');
  await mount(root, { directory: [], toast() {}, async reload() {} });

  const text = root.textContent;
  assert.match(text, /Alpine Escape/, 'the planner shows the handoff name');
  assert.match(text, /LSZH/);
  assert.match(text, /LOWI/);
  assert.match(text, /Route weather/, 'the planner carries the along-route weather card');
  assert.match(text, /Weather is not reachable/, 'without a bridge the card says so instead of inventing weather');
  const stored = JSON.parse(localStorage.getItem('stratos.activeRoute'));
  assert.deepEqual(stored.points.map(p => p.id), ['LSZH', 'LOWI'], 'the planner keeps the handed-over waypoints');
});

// ── Tracker: the learned descent rate drives top-of-descent placement ──
import { readFile as readTrackerFile } from 'node:fs/promises';

const trackerSource = await readTrackerFile(new URL('../app/index.html', import.meta.url), 'utf8');

function trackerPiece(startText, endText) {
  const start = trackerSource.indexOf(startText);
  const end = trackerSource.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, 'tracker source contains: ' + startText);
  return trackerSource.slice(start, end);
}

// The page's own distance helper, copied so the real placement code runs on real numbers.
function trackerDist(a, b) {
  const R = Math.PI / 180;
  const dl = (b.lat - a.lat) * R, dn = (b.lon - a.lon) * R;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dn / 2) ** 2;
  return 6880.13 * Math.asin(Math.sqrt(h));
}

// The MMMX arrival as the app draws it: NOSIT, SLM, then the descent through TOD
// to UKTEN and MMMX. Distances from MMMX follow the plan (SLM 29 nm, NOSIT 43.4 nm).
const MMMX_ARRIVAL = [
  { id: 'NOSIT', name: 'NOSIT', lat: 20.143496, lon: -99.232869, elev: 18000 },
  { id: 'SLM', name: 'SANTA LUCIA', lat: 19.890154, lon: -99.248691, elev: 18000 },
  { id: 'TOD', name: 'TOP OF DESCENT', lat: 19.688, lon: -99.330, elev: 18000 },
  { id: 'UKTEN', name: 'UKTEN', lat: 19.565, lon: -99.167, elev: 11000 },
  { id: 'MMMX', name: 'BENITO JUAREZ INTL', lat: 19.435969, lon: -99.073392, elev: 9800 },
];

function placeTodWith(rate) {
  const route = MMMX_ARRIVAL.map(p => ({ ...p }));
  const desc = trackerPiece('const DESC_DEFAULT', 'function descActive()').replace('=DESC_DEFAULT', '=descRate');
  return new Function('route', 'dist', 'descRate',
    desc + trackerPiece('function placeTod()', 'async function importSB') + '; placeTod(); return route;'
  )(route, trackerDist, rate);
}

async function loadRateFrom(payload, stored) {
  const storedMap = new Map(Object.entries(stored || {}));
  const storage = {
    getItem: key => storedMap.get(key) ?? null,
    setItem: (key, value) => storedMap.set(key, String(value)),
  };
  const calls = [];
  const fetchStub = async url => {
    calls.push(url);
    if (payload instanceof Error) throw payload;
    if (payload === null) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => payload };
  };
  const placed = [];
  const run = new Function('localStorage', 'fetch', 'location', 'panel', 'route', 'placeTod', 'save', 'render',
    trackerPiece('const DESC_DEFAULT', 'function loadDescentRate()') +
    trackerPiece('function loadDescentRate()', '\nloadDescentRate();') +
    'loadDescentRate();' +
    'return { get rate(){ return DESC_FT_PER_NM }, get source(){ return DESC_SRC } };'
  );
  const result = run(
    storage, fetchStub, { origin: 'http://127.0.0.1:8765', protocol: 'http:' }, 'route',
    [{ id: 'TOD', lat: 19.6, lon: -99.1, elev: 18000 }, { id: 'MMMX', lat: 19.4, lon: -99.0, elev: 9800 }],
    () => placed.push(1), () => {}, () => {}
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  return { result, calls, placed, storedMap };
}

test('tracker: a descent measured by the bridge replaces the default rate', async () => {
  const { result, calls, placed, storedMap } = await loadRateFrom({ available: true, ftPerNm: 205.5, flights: 3 });
  assert.deepEqual(calls, ['http://127.0.0.1:8765/descent.json']);
  assert.equal(result.rate, 205.5);
  assert.equal(result.source, 'sim');
  assert.equal(placed.length, 1, 'an imported plan is re-placed when the measurement arrives');
  assert.equal(JSON.parse(storedMap.get('dl.desc')).v, 205.5);
});

test('tracker: without a bridge the default rate stays in use', async () => {
  const { result, placed } = await loadRateFrom(new Error('offline'));
  assert.equal(result.rate, 200);
  assert.equal(result.source, 'default');
  assert.equal(placed.length, 0);
});

test('tracker: an implausible measured rate is refused', async () => {
  const { result } = await loadRateFrom({ available: true, ftPerNm: 9000 });
  assert.equal(result.rate, 200);
  assert.equal(result.source, 'default');
});

test('tracker: a cached measurement is used before the bridge answers', async () => {
  const { result } = await loadRateFrom(null, { 'dl.desc': JSON.stringify({ v: 231, src: 'sim' }) });
  assert.equal(result.rate, 231);
});

test('tracker: TOD is placed just past NOSIT at the measured 200 ft/nm', () => {
  const placed = placeTodWith(200);
  assert.deepEqual(placed.map(p => p.id), ['NOSIT', 'TOD', 'SLM', 'UKTEN', 'MMMX']);
  const tod = placed.find(p => p.id === 'TOD');
  const mmmx = placed[placed.length - 1];
  const along = trackerDist(tod, mmmx);
  assert.ok(along > 35 && along < 45, 'TOD is ' + along.toFixed(1) + ' nm from MMMX');
  assert.ok(along < trackerDist(placed[0], mmmx), 'TOD is short of NOSIT');
});

test('tracker: the old 3 degree rate would have put TOD past SLM', () => {
  const placed = placeTodWith(318);
  const tod = placed.find(p => p.id === 'TOD');
  const along = trackerDist(tod, placed[placed.length - 1]);
  assert.ok(along < 30, 'the 3 degree rate gives ' + along.toFixed(1) + ' nm, which is the reported bug');
});

// ── Dashboard: the flight overview band reports only what exists ─────
function flightFixture(now) {
  return [{
    id: 'f1', complete: true, startTime: now - 86400000,
    takeoffTime: now - 86400000, landingTime: now - 86400000 + 5400000,
    depAirport: 'MMPB', arrAirport: 'MMMX', aircraft: 'B738', registration: 'XA-ABC',
    distanceNm: 118, maxAlt: 18000,
    landing: { vsFpm: -140, gsKt: 130, runway: { id: '05R' } }, track: [],
  }];
}

function planDistanceNm(points) {
  const R = Math.PI / 180;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dl = (b.lat - a.lat) * R, dn = (b.lon - a.lon) * R;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dn / 2) ** 2;
    total += 6880.13 * Math.asin(Math.sqrt(h));
  }
  return total;
}

function dashboardCtx(flights, extra = {}) {
  return {
    flights,
    career: null,
    health: null, live: null, thresholds: {}, directory: [], mode: 'normal',
    params: new URLSearchParams(),
    toast() {}, openFlight() {}, async reload() {}, async refresh() {},
    async setThresholds() {}, go() {},
    ...extra,
  };
}

test('dashboard: the flight overview band shows the saved route and stays honest', async () => {
  installDom();
  const { computeCareer } = await import('../app/js/lib/stats.js');
  const { mount } = await import('../app/js/pilot/career.js');
  const points = [
    { id: 'MMPB', lat: 19.15, lon: -98.37 },
    { id: 'NOSIT', lat: 19.69, lon: -98.75 },
    { id: 'MMMX', lat: 19.43, lon: -99.07 },
  ];
  localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: null, name: 'MMPB to MMMX', points }));
  const flights = flightFixture(Date.now());
  const ctx = dashboardCtx(flights);
  ctx.career = computeCareer(flights);

  const root = document.getElementById('view');
  await mount(root, ctx);
  await new Promise(resolve => setTimeout(resolve, 20));

  const ops = root.querySelector('.ops');
  assert.ok(ops, 'the flight overview band renders');
  assert.equal(root.querySelectorAll('.ops-cell').length, 7);
  assert.equal(root.querySelectorAll('.dashboard-cards .stat').length, 4, 'the coordinated stats stay at four tiles');
  assert.match(ops.textContent, /Bridge offline/, 'no bridge is reported as no bridge');
  assert.match(ops.textContent, /MMPB → MMMX/, 'the pair comes from the saved route');
  assert.match(ops.textContent, /planned track/, 'distance is labelled as planned, not flown');
  assert.match(ops.textContent, /set it in Briefing/, 'an unknown cruise level is admitted, not invented');
  assert.equal(root.querySelector('.ops-track'), null, 'no progress bar until something is airborne');
});

test('dashboard: an airborne flight drives real progress against the planned route', async () => {
  installDom();
  const { computeCareer } = await import('../app/js/lib/stats.js');
  const { mount } = await import('../app/js/pilot/career.js');
  const points = [
    { id: 'MMPB', lat: 19.15, lon: -98.37 },
    { id: 'NOSIT', lat: 19.69, lon: -98.75 },
    { id: 'MMMX', lat: 19.43, lon: -99.07 },
  ];
  localStorage.setItem('stratos.activeRoute', JSON.stringify({ id: null, name: 'MMPB to MMMX', points }));
  const flownNm = 30;
  const expected = Math.round(Math.min(1, flownNm / planDistanceNm(points)) * 100);

  const flights = flightFixture(Date.now());
  const ctx = dashboardCtx(flights);
  ctx.career = computeCareer(flights);
  const root = document.getElementById('view');
  await mount(root, ctx);

  window.dispatchEvent(new window.CustomEvent('stratos:telemetry', { detail: {
    phase: 'AIRBORNE',
    currentFlight: { phase: 'AIRBORNE', aircraft: 'B738', registration: 'XA-ABC', depAirport: 'MMPB', arrAirport: 'MMMX', distanceNm: flownNm },
    health: { version: '2.1.6', simulator: { connected: true, source: 'xplane' } },
  } }));
  await new Promise(resolve => setTimeout(resolve, 20));

  const ops = root.querySelector('.ops');
  assert.match(ops.textContent, /Simulator live/, 'a live bridge is reported as live');
  assert.match(ops.textContent, /60|30 nm/, 'the flown distance is shown');
  const bar = root.querySelector('.ops-track');
  assert.ok(bar, 'progress appears once airborne');
  assert.equal(bar.getAttribute('aria-valuenow'), String(expected), 'progress is flown over planned');
});

test('dashboard: an empty logbook and no route produce a designed empty state', async () => {
  installDom();
  const { computeCareer } = await import('../app/js/lib/stats.js');
  const { mount } = await import('../app/js/pilot/career.js');
  const ctx = dashboardCtx([]);
  ctx.career = computeCareer([]);
  const root = document.getElementById('view');
  await mount(root, ctx);
  await new Promise(resolve => setTimeout(resolve, 20));
  const empty = root.querySelector('.ops-empty');
  assert.ok(empty, 'the empty state renders');
  assert.match(empty.textContent, /nothing is flying and no route is saved/i);
  assert.equal(root.querySelectorAll('.dashboard-cards .stat').length, 4, 'honest zeros still fill the tiles');
});

// ── World layer: bundled country outlines, names and water names ─────
// The release workflow runs these tests on a Windows checkout, which writes
// CRLF. The wrapper is split on a line break, so read the payload line-ending
// agnostic instead of failing the build on the runner's Git settings.
const worldData = (await readTrackerFile(new URL('../app/js/data/world.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const TRACKER_HTML = trackerSource;

test('world layer: the bundled data is complete and its labels sit on land', () => {
  const marker = 'root.STRATOS_WORLD = ';
  const from = worldData.indexOf(marker) + marker.length;
  const to = worldData.indexOf(';\n})(', from);
  assert.ok(from > marker.length && to > from, 'the payload is delimited by the wrapper');
  const world = JSON.parse(worldData.slice(from, to));

  assert.ok(world.countries.length >= 170, `country count is ${world.countries.length}`);
  assert.ok(world.continents.length === 7, 'seven continent labels');
  assert.ok(world.oceans.length >= 20, 'oceans and seas are included');

  const names = world.countries.map(c => c.n);
  for (const expected of ['Mexico', 'France', 'Japan', 'Brazil', 'Australia']) {
    assert.ok(names.includes(expected), `${expected} is in the layer`);
  }
  assert.ok(world.continents.some(c => c.n === 'Europe'), 'Europe is labelled');

  let points = 0;
  for (const country of world.countries) {
    assert.ok(typeof country.n === 'string' && country.n.length, 'every entry has a name');
    assert.ok(Array.isArray(country.p) && country.p.length, `${country.n} has at least one ring`);
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const ring of country.p) {
      assert.equal(ring.length % 2, 0, `${country.n} ring is a flat coordinate list`);
      assert.ok(ring.length >= 8, `${country.n} ring has at least four points`);
      for (let i = 0; i < ring.length; i += 2) {
        points++;
        minx = Math.min(minx, ring[i]); maxx = Math.max(maxx, ring[i]);
        miny = Math.min(miny, ring[i + 1]); maxy = Math.max(maxy, ring[i + 1]);
        assert.ok(ring[i] >= -180 && ring[i] <= 180, `${country.n} longitude in range`);
        assert.ok(ring[i + 1] >= -90 && ring[i + 1] <= 90, `${country.n} latitude in range`);
      }
      assert.ok(ring.every(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9), `${country.n} coordinates are rounded`);
    }
    // A label outside its own outline would print the country name in the sea.
    assert.ok(country.x >= minx - 1 && country.x <= maxx + 1, `${country.n} label longitude on land`);
    assert.ok(country.y >= miny - 1 && country.y <= maxy + 1, `${country.n} label latitude on land`);
  }
  assert.ok(points > 5000 && points < 20000, `payload is simplified: ${points} points`);
});

test('world layer: the tracker offers the style, ships the data and draws names', () => {
  assert.match(TRACKER_HTML, /<script src="js\/data\/world\.js"><\/script>/, 'the data is loaded as a plain script');
  assert.ok(TRACKER_HTML.indexOf('js/data/world.js') < TRACKER_HTML.indexOf('const A='), 'the data loads before the map script');
  assert.match(TRACKER_HTML, /world:\{n:'World'/, 'a World style is offered');
  assert.match(TRACKER_HTML, /L\.style!='world'/, 'World is drawn, not tiled');
  assert.match(TRACKER_HTML, /world:\{n:'World',m:18,a:'Natural Earth \(public domain\)'\}/, 'the source is credited in the style');

  const projection = trackerPiece('const wpx=', 'const dist=');
  const layer = trackerPiece('var WD=null', 'function drawTiles()');
  const counts = { labels: [], ink: {}, fonts: [], fills: [], rebuilds: 0, blits: 0, offsets: [] };
  const stub = kind => ({
    fillStyle: '', strokeStyle: '', lineWidth: 0, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    setTransform() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, translate() {},
    fillRect() {}, clearRect() { if (kind === 'off') counts.rebuilds++; },
    fill() { if (kind === 'off') counts.fills.push(this.fillStyle); }, stroke() {},
    measureText(t) { return { width: String(t).length * 6 }; },
    fillText(t) { counts.labels.push(String(t)); counts.ink[String(t)] = this.fillStyle; counts.fonts.push(this.font); },
    strokeText() {},
    drawImage(_c, dx, dy) { counts.blits++; counts.offsets.push(dx); },
  });
  const mount = (z, lat, lon, theme = 'night') => new Function('__cx', '__off', `
    const cx=__cx, SZ=256, R=Math.PI/180, W=1280, H=800, dpr=1;
    const V={lon:${lon},lat:${lat},z:${z}};
    const L={style:'world'};
    const C={bg:'#0a1421',land:'#101d2b',coast:'#2c3f55',txt:'#e4ecf5',mut:'#8b9db3',ui:'#0d1927'};
    const document={createElement:()=>({width:0,height:0,getContext:()=>__off}),documentElement:{dataset:{theme:'${theme}'}}};
    ${projection}
    ${worldData}
    ${layer}
    return { worldLayer, buildWorld, V, M:WM };
  `)(stub('main'), stub('off'));

  const world = mount(2.5, 30, -10);
  world.buildWorld(stub('off'));
  const seen = counts.labels.slice();
  for (const continent of ['EUROPE', 'ASIA', 'AFRICA', 'NORTH AMERICA']) {
    assert.ok(seen.includes(continent), `${continent} is named at world zoom`);
  }
  assert.ok(seen.some(l => /Atlantic Ocean/.test(l)), 'the Atlantic is named at world zoom');
  assert.ok(seen.includes('France'), 'countries are named at world zoom');
  // A whole-world view stays quiet: the great oceans are named in italic serif,
  // seas wait for a closer look, and countries are muted rather than shouting.
  assert.ok(!seen.includes('Mediterranean Sea'), 'seas wait until the view is closer than the whole world');
  assert.ok(counts.fonts.some(f => /italic .*Georgia/.test(f)), 'water names are set in an italic serif');
  assert.equal(counts.ink['France'], '#8b9db3', 'country names use the muted ink at world zoom');
  assert.ok(seen.includes('United States') && !seen.includes('United States of America'), 'long official names are shortened on the map');
  assert.ok(counts.fills.includes('#16212c'), 'land is painted with the world basemap tone');

  // A saved World style must not kill the frame loop: the loop starts after the
  // script is evaluated, and the layer resolves its data without a dead zone.
  assert.match(TRACKER_HTML, /requestAnimationFrame\(function loop\(/, 'the render loop survives the first frame');
  assert.match(TRACKER_HTML, /var WD=null;try\{WD=globalThis\.STRATOS_WORLD/, 'the world data has no temporal dead zone');

  counts.labels = []; counts.fonts = []; counts.ink = {};
  mount(4.6, 40, 15).buildWorld(stub('off'));
  assert.ok(counts.labels.includes('Mediterranean Sea'), 'the sea is named once the view is close');

  counts.labels = []; counts.fills = [];
  mount(2.5, 30, -10, 'day').buildWorld(stub('off'));
  assert.ok(!counts.fills.includes('#16212c'), 'the night land tone stays out of the day theme');
  assert.ok(counts.fills.includes('#101d2b'), 'the day theme keeps the page land colour');

  counts.labels = [];
  mount(6.5, 48, 8).buildWorld(stub('off'));
  assert.ok(counts.labels.includes('Germany'), 'closer in, the local country is named');

  // Panning must reuse the sheet: a rebuild per frame would stutter.
  const panned = mount(6, 40, -3);
  counts.rebuilds = 0; counts.blits = 0; counts.offsets = [];
  for (let i = 0; i < 60; i++) { panned.V.lon += 0.004; panned.worldLayer(); }
  assert.equal(counts.blits, 60, 'every frame blits the cached sheet');
  assert.ok(counts.rebuilds <= 10, `panning rebuilt only ${counts.rebuilds} times in 60 frames`);
  // The sheet is drawn 24 px larger than the viewport on every side, so the
  // viewport stays covered for any offset the clamp allows.
  for (const dx of counts.offsets) {
    assert.ok(dx <= 0 && dx >= -2 * panned.M, `blit offset ${dx} keeps the viewport covered`);
  }
});

test('map tiles need no API key and credit the provider that serves them', async () => {
  const fs = await import('node:fs');
  const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const page = read('../app/index.html');
  const minimap = read('../app/js/minimap.js');
  const discover = read('../app/js/discover.js');
  // CARTO's public raster endpoints answer 200 with an "API KEY REQUIRED"
  // placeholder tile, which painted a watermark across the Light, Dark,
  // replay and preview maps. Nothing may send tiles there again.
  for (const [name, text] of [['the tracker', page], ['the minimap', minimap], ['discover', discover]]) {
    assert.doesNotMatch(text, /basemaps\.cartocdn\.com/, `${name} must not use a key-requiring tile host`);
    assert.doesNotMatch(text, /OpenStreetMap contributors, CARTO|© OpenStreetMap contributors · © CARTO/, `${name} must credit the provider it actually uses`);
  }
  assert.match(page, /Canvas\/World_Light_Gray_Base\/MapServer\/tile/, 'the Light style uses the key-free Esri gray canvas');
  assert.match(page, /Canvas\/World_Dark_Gray_Base\/MapServer\/tile/, 'the Dark style uses the key-free Esri gray canvas');
  assert.match(minimap, /Canvas\/\$\{service\}\/MapServer\/tile/, 'the replay and preview maps use the same key-free tiles');
  assert.match(minimap, /© Esri, HERE, Garmin · © OpenStreetMap contributors/, 'the minimap credits Esri');
});

test('the aircraft card works out a registration its feed did not report', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /import \* as REG from '\.\/js\/lib\/aircraftreg\.js';/, 'the card loads the registration module');
  assert.match(page, /window\.REG = REG;/, 'and the page script can reach it');
  // The simulator's own airframe carries no tail number in every livery; the
  // title is what Volanta-style apps read instead.
  assert.match(page, /registrationFromTitle\(\(live\.d&&live\.d\.aircraft\)\|\|''\)/, 'your aircraft is identified from its title');
  assert.match(page, /lookupPlan\(\{hex:o\.hx,callsign:o\.id\}\)/, 'live traffic is resolved from its Mode S address or callsign');
  assert.match(page, /fcDetect\(sel\);/, 'the card detects before it draws');
  assert.match(page, /\(detected\?' \(detected\)':''\)/, 'a worked-out registration is labelled as detected, not as feed data');
  assert.match(page, /if\(!reg\)return fcNoRegHtml\(o\);/, 'a missing registration has its own card states');
  assert.match(page, /Detecting the registration…/, 'the card says it is detecting instead of claiming there is none');
});

test('the map draws waypoint symbols over a route line it never rewrites', async () => {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

  // The route line is locked: the statement that paints it is byte-identical to
  // the one in the previous release, and it is painted before any marker.
  const line = 'if(route.length&&!CH.on&&L.rte){cx.save();cx.globalAlpha=.35;cx.strokeStyle=C.route;cx.lineWidth=12;cx.lineCap=\'round\';cx.lineJoin=\'round\';cx.beginPath();route.forEach((p,i)=>{const[x,y]=sc(p.lon,p.lat);i?cx.lineTo(x,y):cx.moveTo(x,y)});cx.stroke();if(liveOk()&&route.length>1){const pr=routeProg(),pts=[route[0]];let acc=0;for(let i=0;i<route.length-1;i++){acc+=dist(route[i],route[i+1]);if(acc<pr)pts.push(route[i+1])}pts.push(pos(pr));cx.globalAlpha=.6;cx.beginPath();pts.forEach((p,i)=>{const[x,y]=sc(p.lon,p.lat);i?cx.lineTo(x,y):cx.moveTo(x,y)});cx.stroke()}cx.restore()';
  assert.ok(page.includes(line), 'the route line statement is unchanged');
  assert.ok(page.indexOf(line) < page.indexOf('drawRouteMarkers();}'), 'markers are painted after the line');

  // The marker layer is a separate visual pass: no symbol code may touch the
  // route array, its order or its coordinates.
  const start = page.indexOf('/* ── Waypoint markers');
  const stop = page.indexOf("window.addEventListener('aircraft-atlas-ready'");
  const markerLayer = page.slice(start, stop);
  assert.ok(start > 0 && stop > start, 'the marker layer exists as its own pass');
  assert.doesNotMatch(markerLayer, /route\s*=|route\.push|route\.splice|route\.sort|route\[[^\]]+\]\s*=/, 'marker code never edits the route');
  assert.match(markerLayer, /function routeKind\(p\)/, 'symbols come from the point type, not from its position');

  // One shape per aeronautical meaning, in the reference palette.
  for (const [shape, colour] of [['mkCross', '#3b82f6'], ['mkTri', '#d946ef'], ['mkDiamond', '#a855f7'], ['mkStar4', '#2dd4bf'], ['mkRing', '#'], ['mkSquare', '#fb7185'], ['mkHex', '#94a3b8']]) {
    assert.ok(page.includes(`function ${shape}(`), `${shape} exists`);
    assert.ok(page.includes(colour), `${colour} is in the palette`);
  }
  assert.match(page, /function mkR\(\)\{return V\.z>=12\?16/, 'markers are larger than the old four-pixel squares and sit a step above the 12 px route band');
  // Long legs carry their own heading and distance; short ones stay bare so
  // the idents at each end are not crowded.
  assert.match(markerLayer, /const LEG_MIN_NM=50,LEG_MIN_PX=92/, 'only legs of 50 nm or more get a tag, and only when they are long on screen');
  assert.match(markerLayer, /function mkLegTag\(ax,ay,bx,by,nm,hdg\)/, 'the leg tag is drawn by its own helper');
  assert.match(markerLayer, /Math\.round\(nm\)\+' NM'/, 'the tag carries the leg distance');
  assert.match(markerLayer, /Math\.round\(hdg\)/, 'the tag carries the initial heading');
  // Map labels use the shell's condensed technical face, not a default UI sans.
  assert.match(markerLayer, /const MKF='"Bahnschrift SemiCondensed"/, 'labels are set in the condensed chart face');
  assert.match(markerLayer, /\+'px '\+MKF/, 'every map label measures and draws in that face');
  assert.match(page, /registrationFromTitle|mkPlanLabel/, 'the drawing layer is wired up');
  // TOC/TOD are read from the plan: a procedure tag and an airway are only used
  // when the imported plan states them, and TOC/TOD never become route points.
  assert.match(page, /is_sid_star/, 'a SID/STAR tag is taken from the plan');
  assert.match(page, /via_airway/, 'an airway fix is taken from the plan');
  assert.match(page, /function planTocTod\(\)/, 'TOC/TOD are derived for drawing');
  assert.doesNotMatch(markerLayer, /route\.(push|unshift)\(/, 'TOC/TOD are not inserted into the route');

  // cross-check the locked line against the committed file, so an edit in the
  // working tree cannot quietly disagree with what the test above compares to.
  const head = execFileSync('git', ['show', 'HEAD:app/index.html'], { encoding: 'utf8' });
  assert.ok(head.includes(line), 'the committed build paints the same line');
});

test('a selected waypoint turns purple without touching the route line', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /const MKSELN='#a78bfa',MKSELD='#7c3aed'/, 'the selection palette is the board violet');
  assert.match(page, /function mkSelHalo\(x,y,r\)/, 'the selection indicator is its own pass');
  assert.match(page, /function mkDraw\(kind,x,y,r,override\)/, 'a glyph can be redrawn in the selection colour');
  assert.match(page, /chosen=wpIdx===i,col=chosen\?mkSelColor\(\):null/, 'only the selected marker changes colour');
  assert.match(page, /if\(chosen\)mkSelHalo\(/, 'the selected marker gets the halo');
  assert.match(page, /if\(wpIdx!=null&&!route\[wpIdx\]\)wpIdx=null/, 'a stale index is dropped, never drawn on another point');
  // Selection lives on the map layer; closing the card or pressing Escape clears it.
  assert.match(page, /if\(act=='close'\)\{wpIdx=null;/, 'closing the card clears the selection');
  assert.match(page, /if\(e\.key=='Escape'\)\{if\(wpCard\)closeRouteCard\(\);wpIdx=null\}/, 'Escape clears it too');
  // The same statement that paints the line must still be there.
  assert.match(page, /cx\.globalAlpha=\.35;cx\.strokeStyle=C\.route;cx\.lineWidth=12/, 'the route line is unchanged');
});

test('the tracking card minimizes to a SID and STAR summary', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /function fcProcHtml\(o\)/, 'procedures are their own block');
  assert.match(page, /block\('SID',p\.sid/, 'the SID label sits above its runway');
  assert.match(page, /block\('STAR',p\.star/, 'the STAR label sits above its runway');
  assert.match(page, /'RWY '\+esc\(rwy\)/, 'the planned runway is written under the procedure');
  assert.match(page, /runway not in plan/, 'an unplanned runway is named as missing, not invented');
  assert.match(page, /if\(!fExp\)\{\s*return header\+compact\+fcProcHtml\(o\)\+actions/, 'a minimized card keeps the live strip, the procedures and the actions');
  assert.match(page, /s=\(fExp\?fcPhotoHtml\(sel\):''\)\+fcAircraftHtml\(sel\)/, 'the photograph is hidden when minimized');
  assert.match(page, /data-fc-act="expand">Show details/, 'the minimized card says how to reopen it');
  assert.match(page, /localStorage\.getItem\('stratos\.cardExpanded'\)/, 'the state is remembered');
  assert.match(page, /from the SimBrief plan/, 'the card says where the procedures came from');
  // Data the plan does not hold is never displayed as if it did.
  assert.match(page, /runway not in plan/, 'a missing runway is honest');
  assert.match(page, /Not in the plan/, 'a missing field says so');
});

test('the flight trail starts from the track the bridge recorded', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  const live = fs.readFileSync(new URL('../app/js/live.js', import.meta.url), 'utf8');
  assert.match(page, /function seedTrail\(flight\)/, 'the map seeds the trail from the recorded flight');
  assert.match(page, /seedTrail\(live\.d\.currentFlight\)/, 'each snapshot offers the recorded track');
  assert.match(page, /if\(id!==trailFlightId\)\{trailFlightId=id;trailSeeded='';TRL\.delete\('own'\)\}/, 'a new flight never joins the previous trail');
  assert.match(page, /TRL\.set\('own',seeded\.slice\(-cap\)\)/, 'the recorded points replace an empty trail');
  assert.match(page, /const stamp=id\+':'\+flight\.track\.length/, 'the seed is refreshed when the recording grows');
  assert.match(page, /if\(trailSeeded===stamp\)return/, 'an unchanged recording is not re-read every frame');
  assert.match(page, /trailSeeded=stamp/, 'the refreshed recording is the trail, so its departure end cannot erode');
  assert.match(live, /mapTrack = Array\.isArray\(flight\?\.track\)/, 'the phone seeds its map from the same track');
  assert.match(live, /if \(moved\) mapTrack\.push/, 'the live point continues the trail instead of duplicating it');
});

test('a clicked aircraft shows its own recorded trail, from every traffic source', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  // The selected target's trail is drawn whether or not the all-trails layer is on.
  assert.match(page, /if\(sel&&sel\.k=='trf'\)\{const a=TRL\.get\(sel\.hx\|\|sel\.id\);if\(a\)drawTrail\(a,sel,false\)\}/, 'a selected aircraft is drawn with its own path');
  // ADS-B traffic is recorded as it polls.
  assert.match(page, /trlAdd\(o\.hx\|\|o\.id,o\.lat,o\.lon,o\.alt,400\)/, 'every polled aircraft appends a position');
  // VATSIM used to replace its objects on each refresh and record nothing.
  const vatsim = page.slice(page.indexOf('function vatsimTraffic()'), page.indexOf('function vatsimHtml('));
  assert.match(vatsim, /trlAdd\(p\.id,p\.lat,p\.lon,p\.alt,400\)/, 'every VATSIM pilot appends a position');
  assert.match(vatsim, /known\.get\(id\)/, 'the existing object is reused, so an open card and its trail survive a refresh');
  assert.match(vatsim, /sel\.source=='vatsim'&&!out\.includes\(sel\)/, 'a selected pilot stays selectable when it leaves the view');
  assert.match(vatsim, /trlGC\(\)/, 'expired trails are cleared on the same cycle');
});

test('observed traffic positions go to the bridge, so a trail outlives the page', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /fetch\('\/traffic\/track',\{method:'POST'/, 'the page reports what it has seen');
  assert.match(page, /if\(now-trfPostAt<15000\)return/, 'batched: at most one post every fifteen seconds');
  assert.match(page, /fetch\('\/traffic\/trail\?hex='\+encodeURIComponent\(key\)/, 'a clicked aircraft asks the bridge for its path');
  assert.match(page, /TRL\.set\(key,\[...older,\.\.\.have\]\)/, 'the history is prepended, never drawn out of order');
  assert.match(page, /if\(best\.k=='trf'\)\{tk=true;setFol\(false\);trafficBackfill\(best\)\}/, 'a tap on an aircraft backfills its trail');
  assert.match(page, /trafficPost\(\)\}$/m, 'the VATSIM refresh posts the positions it just saw');
});

test('the flown trail is a continuous line coloured by height above the ground', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /import \* as TRAILC from '\.\/js\/lib\/trailcolor\.js'/, 'the map shares one ramp with the phone');
  assert.match(page, /window\.TRAILC = TRAILC/, 'the classic script can reach it');
  assert.match(page, /function trailInk\(h\)\{return window\.TRAILC\?window\.TRAILC\.trailInk\(h\)/, 'a height becomes a colour');
  assert.match(page, /const agl=Number\(p&&p\[4\]\)/, 'height above ground is used when the recording has it');
  assert.match(page, /own\?floor:0/, 'a recording without it falls back to height above the lowest point');
  assert.match(page, /for\(let i=1;i<m;i\+\+\)\{if\(inks\[i\]!==ink\)\{run\(start,i\)/, 'a run of one colour is stroked once, not per segment');
  // The trail is one solid line: no fading contrail, no gradient tail.
  const draw = page.slice(page.indexOf('function drawTrail(a,cur,own)'), page.indexOf('function trails()'));
  assert.doesNotMatch(draw, /globalAlpha=\.[0-9]/, 'the drawn path is opaque');
  assert.doesNotMatch(draw, /f\*f|wmax/, 'there is no tapering width');
  assert.match(draw, /cx\.lineWidth=7;cx\.stroke\(\)[\s\S]*cx\.lineWidth=4/, 'a dark casing under a 4 px line');
});

test('TOC and TOD are computed on the route legs by the profile module', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /import \* as PROFILE from '\.\/js\/lib\/profile\.js'/, 'the page loads the profile module');
  assert.match(page, /window\.PROFILE = PROFILE/, 'the classic script can reach it');
  assert.match(page, /PROFILE\.computeVerticalProfile\(\{/, 'the markers come from the profile');
  assert.match(page, /descentFtPerNm:DESC_FT_PER_NM/, 'the measured descent rate is used');
  assert.match(page, /out\.toc=\{lat:profile\.toc\.lat,lon:profile\.toc\.lon/, 'the marker is the interpolated position');
  assert.match(page, /altitudeLabel\(alt,source\)/, 'an estimate is marked as one');
  assert.match(page, /key\+='\|'\+Math\.round\(DESC_FT_PER_NM\)/, 'a changed descent rate recomputes the profile');
  // The profile module loads after the first paint. A cached empty result would
  // otherwise survive every later frame and the markers would never appear.
  assert.ok(page.includes("+Math.round(DESC_FT_PER_NM)+'|'+(window.PROFILE?1:0)"), 'the cache knows when the profile module has loaded');
});

test('a plan keeps its procedures and markers when it moves between pages', async () => {
  const fs = await import('node:fs');
  const routes = fs.readFileSync(new URL('../app/js/pilot/routes.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  // The planner used to drop is_sid_star and the airway, so a plan imported
  // there reached the map with every fix drawn as an ordinary waypoint.
  assert.match(routes, /ss: fix\.is_sid_star == '1'/, 'the SID/STAR tag survives the import');
  assert.match(routes, /aw: fix\.via_airway/, 'the airway survives the import');
  assert.match(routes, /saveOfp\(localStorage, ofp, entered\)/, 'the plan is stored where the tracking card reads it');
  assert.match(routes, /p\.kind === 'airport' \? 'apt'/, 'an airport keeps its airport symbol on the map');
  assert.match(routes, /p\.kind === 'navaid' \? 'nav'/, 'a navaid keeps its navaid symbol');
  assert.match(page, /function routeKindName\(kind\)/, 'the map accepts the planner names too');
  assert.match(page, /k:routeKindName\(p\.kind\|\|p\.k\)/, 'a stored route is normalised on load');
});

test('SID and STAR runway paths come from the simulator data, under the route line', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /import \* as PROC from '\.\/js\/lib\/procedures\.js'/, 'the page loads the procedure helpers');
  assert.match(page, /window\.PROC = PROC/, 'the classic script can reach them');
  assert.match(page, /function procTick\(\)/, 'the plan is checked once per key, not per frame');
  assert.match(page, /PROC\.procedureEndpoint\(airport,kind,ident\)/, 'one request per airport, kind and procedure');
  assert.match(page, /PROC\.procedurePath\(payload,\{kind,ident,runway:rwy,routeIds\}\)/, 'the plan runway picks the transition and the plan its en-route branch');
  assert.match(page, /PROC\.connectorFor\(kind,path\.points,routeIds\)/, 'only the part the plan does not draw is painted');
  assert.match(page, /function drawProcedurePaths\(\)/, 'the geometry has its own drawing pass');
  assert.match(page, /cx\.lineWidth=9/, 'it is a step thinner than the 12 px waypoint line');
  // It is painted before the route line, so the waypoints still read on top and
  // the line between them is never redrawn or repainted by this layer.
  assert.ok(page.indexOf('drawProcedurePaths();') < page.indexOf('cx.globalAlpha=.35;cx.strokeStyle=C.route;cx.lineWidth=12'), 'procedure paths sit under the route line');
  const start = page.indexOf('/* ── Published procedure geometry');
  const stop = page.indexOf('function mkPlanLabel(');
  const block = page.slice(start, stop);
  assert.ok(start > 0 && stop > start, 'the procedure layer exists as its own block');
  assert.doesNotMatch(block, /route\s*=|route\.(push|splice|sort|unshift)\(/, 'it never edits the route');
  assert.match(page, /fcProcHtml\(o\)/, 'the card reports the procedure source');
  assert.match(page, /PROCG\.notes\.join\(' · '\)/, 'and any limitation the source reported');
});

test('a dead telemetry socket is noticed and reopened', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  // A restarted bridge, or a Wi-Fi change, can leave an EventSource that never
  // fires onerror. The bridge writes a heartbeat every five seconds, so silence
  // is the only reliable signal.
  assert.match(page, /function openStream\(base\)/, 'the stream is opened by its own function');
  assert.match(page, /es\.onerror=\(\)=>\{if\(live\.es===es\)live\.at=0\}/, 'an errored stream stops counting as live');
  assert.match(page, /performance\.now\(\)-live\.at>12000/, 'twelve seconds of silence is treated as a dead socket');
  assert.match(page, /openStream\(live\.base\)/, 'the watchdog reopens it without a reload');
  assert.match(page, /addEventListener\('online',\(\)=>\{if\(live\.on&&live\.base\)openStream\(live\.base\)\}\)/, 'a returning network reopens at once');
  assert.match(page, /function disc\(\)\{if\(live\.es\)live\.es\.close\(\);live\.on=false;live\.base=''/, 'a deliberate disconnect stops the watchdog');
});

test('the phone page reconnects on its own and retries when the network returns', async () => {
  const fs = await import('node:fs');
  const live = fs.readFileSync(new URL('../app/js/live.js', import.meta.url), 'utf8');
  assert.match(live, /async function servedByBridge\(\)/, 'a bridge on another port is still recognised');
  assert.match(live, /await startBridge\(location\.origin\)/, 'and its own origin is used');
  assert.match(live, /addEventListener\('online'/, 'a network that returns triggers an immediate retry');
  assert.match(live, /telemetryClient\.open\(\)/, 'the stream is reopened, not left to the backoff');
  assert.match(live, /setStatus\('connecting', 'Looking for your PC…'\)/, 'searching is its own state');
  assert.match(live, /function connectLocal\(\)/, 'one button drives the connection');
  assert.match(live, /blocksLocalBridge\(location\)/, 'an HTTPS page navigates instead of failing a mixed-content fetch');
  assert.match(live, /location\.href = phoneConnectUrl\(\)/, 'the bridge page is opened, with nothing to type');
});

test('the flight-plan card replaces the pencil and never invents a value', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /<div id="fp" class="box" aria-live="polite"><\/div>/, 'the map owns a flight-plan card');
  assert.equal(page.includes('id="bPlan"'), false, 'the pencil-in-a-circle control is gone');
  assert.match(page, /Import a flight plan to view your route, departure, arrival, weather and flight details\./, 'the empty state explains the card');
  assert.match(page, /class="primary" data-fp-act="import">Import Flight Plan</, 'the import action is the primary button');
  // The SID/STAR runway sits under its own procedure, and an absent one says so.
  assert.match(page, /const block=\(label,row,rwyRow,ofpOn\)/, 'the procedure block takes its own runway row');
  assert.match(page, /rwyRow&&rwyRow\.rwy\?'RWY '\+esc\(rwyRow\.rwy\)/, 'the planned runway is printed when the plan states one');
  assert.match(page, /runway not in plan/, 'a plan without a runway says so');
  assert.match(page, /no procedure claimed/, 'no plan means no procedure is claimed');
  // Weather is fetched for the two airports and reuses the page cache.
  assert.match(page, /function fpWxFetch\(\)/, 'the card refreshes the departure and arrival weather itself');
  assert.match(page, /if\(now-fpWxAt<240000\)return/, 'the refresh is rate limited');
  assert.match(page, /getMetar\(a\)/, 'it reuses the existing METAR pipeline');
  assert.match(page, /This SimBrief plan carries no weight or fuel figures/, 'an OFP without weights is described, not filled in');
  assert.match(page, /fpstale/, 'stale data is marked');
});

test('the colour board documents the palette the interface really uses', async () => {
  const fs = await import('node:fs');
  const settings = fs.readFileSync(new URL('../app/js/pilot/settings.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  const shell = fs.readFileSync(new URL('../app/shell.css', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../app/stratos-ui.css', import.meta.url), 'utf8');
  assert.match(settings, /Aviation colour board/, 'the board lives in Settings');
  for (const hex of ['#38bdf8', '#a78bfa', '#f59e0b', '#ffffff', '#0a1421', '#8b9db3', '#df827a', '#5ec99a']) {
    assert.ok(settings.toLowerCase().includes(hex), `${hex} is shown with its job`);
  }
  assert.match(settings, /class="board-demo"/, 'the board shows real controls, markers and a TOD');
  // The documented values are the live tokens, not a second palette.
  assert.match(page, /--acc:#38bdf8/);
  assert.match(page, /const MKSELN='#a78bfa'/);
  assert.match(shell, /--shell-accent: #38bdf8/);
  assert.match(ui, /--acc:#38bdf8/);
});

test('every page offers the same five destinations', async () => {
  const fs = await import('node:fs');
  const read = name => fs.readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');
  const index = read('index.html');
  const rail = index.match(/<nav id="tabs"[\s\S]*?<\/nav>/)[0];
  assert.equal((rail.match(/class="tab/g) || []).length, 6, 'five destinations and the collapse control');
  const shell = read('js/shell.js');
  const nav = shell.match(/const NAV = \[([\s\S]*?)\];/)[1];
  assert.equal((nav.match(/href:/g) || []).length, 5, 'the bar and the rail share one five-item list');
  for (const href of ['index.html', 'index.html#plan', 'logbook.html', 'discover.html', 'pilot.html#settings']) {
    assert.ok(nav.includes(`'${href}'`), `${href} is one of the five`);
  }
  // The pages without a rail carry the same five in their own bottom bar.
  for (const name of ['logbook.html', 'weather.html', 'live.html']) {
    const page = read(name);
    assert.equal((page.match(/class="bnav-item|bottom-live[\s\S]*?<\/nav>/g) || []).length >= 1, true, `${name} has a bottom bar`);
    assert.ok(!/href="weather.html"[^>]*>\s*<span[^>]*>⛅/.test(page), `${name} no longer gives Weather its own tab`);
  }
  // Features that lost a tab are one step inside Explore.
  const discover = read('discover.html');
  for (const href of ['weather.html', 'pilot.html#airports', 'pilot.html#charts', 'pilot.html#career', 'live.html']) {
    assert.ok(discover.includes(`href="${href}"`), `${href} is reachable from Explore`);
  }
});
