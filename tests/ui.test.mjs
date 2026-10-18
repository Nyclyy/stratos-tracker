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
  const { mount } = await import('../app/js/pilot/career.js');
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
  assert.equal(document.querySelectorAll('.widget-row').length, 9);
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
