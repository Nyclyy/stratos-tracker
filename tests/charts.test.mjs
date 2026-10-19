import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const META = `<?xml version="1.0" encoding="utf-8"?>
<digital_tpp cycle="2610" from_edate="0901Z  10/01/26" to_edate="0901Z  10/29/26">
  <state_code ID="CA" state_fullname="CALIFORNIA">
    <city_name ID="SAN FRANCISCO" volume="SW-1">
      <airport_name ID="SAN FRANCISCO INTL" military="N" apt_ident="SFO" icao_ident="KSFO" alnum="1234">
        <record>
          <chart_code>APD</chart_code>
          <chart_name>AIRPORT DIAGRAM</chart_name>
          <pdf_name>00375AD.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>IAP</chart_code>
          <chart_name>ILS OR LOC RWY 28L</chart_name>
          <pdf_name>00375IL28L.PDF</pdf_name>
          <amdtdate>12/05/2019</amdtdate>
        </record>
        <record>
          <chart_code>IAP</chart_code>
          <chart_name>RNAV (GPS) Y RWY 19R</chart_name>
          <pdf_name>00375R19R.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>DP</chart_code>
          <chart_name>SFO SIX</chart_name>
          <pdf_name>00375SFO6.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>STR</chart_code>
          <chart_name>BIG SUR FIVE</chart_name>
          <pdf_name>00375BIG5.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>MIN</chart_code>
          <chart_name>TAKEOFF MINIMUMS</chart_name>
          <pdf_name>00375MIN.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>HOT</chart_code>
          <chart_name>HOT SPOT 1</chart_name>
          <pdf_name>00375HOT.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
      </airport_name>
    </city_name>
  </state_code>
</digital_tpp>`;

test('the FAA cycle code follows the 28-day publication calendar', async () => {
  const { CYCLE_EPOCH, faaCycle, cycleStart, cycleEnd, CYCLE_DAYS } = await import('../app/js/lib/charts.js');
  assert.equal(faaCycle(Date.UTC(2026, 0, 22, 9, 1)), '2601');
  // 2025's cycles start on 23 January; thirteen 28-day cycles reach 25 December.
  assert.equal(faaCycle(Date.UTC(2026, 0, 21, 23, 0)), '2513');
  const second = CYCLE_DAYS * 86400000;
  assert.equal(faaCycle(CYCLE_EPOCH + second), '2602');
  const start = cycleStart('2602');
  assert.equal(faaCycle(start), '2602');
  assert.equal(cycleEnd('2602') - start, second);
  // A code that does not exist in the surrounding year still resolves sanely.
  assert.equal(cycleStart('not-a-cycle'), null);
});

test('the metafile becomes a catalogue with real categories and dates', async () => {
  const {
    normaliseCatalogue, parseFaaAirport, parseMetafileHeader, groupCharts, searchCharts,
    validityState, approachType, runwaysInTitle,
  } = await import('../app/js/lib/charts.js');

  const header = parseMetafileHeader(META);
  assert.equal(header.cycle, '2610');
  assert.equal(new Date(header.from).toISOString(), '2026-10-01T09:01:00.000Z');
  assert.equal(new Date(header.to).toISOString(), '2026-10-29T09:01:00.000Z');

  const airport = parseFaaAirport(META, 'KSFO');
  assert.equal(airport.icao, 'KSFO');
  assert.equal(airport.records.length, 7);

  const charts = normaliseCatalogue({
    source: 'faa-dtpp', sourceName: 'FAA Digital Terminal Procedures',
    cycle: header.cycle, effective: header.from, expires: header.to, checkedAt: Date.UTC(2026, 9, 19),
    charts: airport.records,
  }, 'KSFO');

  assert.equal(charts.length, 7);
  assert.deepEqual(groupCharts(charts).map(group => group.key), ['diagram', 'sid', 'star', 'approach', 'minimums', 'hotspot']);

  const ils = charts.find(chart => chart.pdf === '00375IL28L.PDF');
  assert.equal(ils.category, 'approach');
  assert.equal(ils.approach, 'ILS/LOC');
  assert.deepEqual(ils.runways, ['28L']);
  assert.equal(ils.cycle, '2610');
  assert.equal(ils.url, 'https://aeronav.faa.gov/d-tpp/2610/00375IL28L.PDF');
  assert.equal(new Date(ils.amended).toISOString().slice(0, 10), '2019-12-05');
  assert.equal(validityState(ils, Date.UTC(2026, 9, 19)), 'current');
  assert.equal(validityState(ils, Date.UTC(2026, 10, 2)), 'expired');
  assert.equal(validityState({ expires: null }), 'unverified');

  assert.equal(approachType('RNAV (GPS) Y RWY 19R'), 'RNAV');
  assert.deepEqual(runwaysInTitle('ILS OR LOC RWY 28L'), ['28L']);
  assert.deepEqual(searchCharts(charts, '19R').map(chart => chart.pdf), ['00375R19R.PDF']);
  assert.equal(searchCharts(charts, 'SID').length, 1);
  assert.equal(searchCharts(charts, '').length, 7);
  assert.equal(searchCharts(charts, 'EGLL').length, 0);
});

test('a Premium entitlement is only trusted when a trusted channel verifies it', async () => {
  const { describeEntitlement, getEntitlement, isPremium, premiumSetupNotes, resetEntitlementCache } =
    await import('../app/js/lib/entitlement.js');

  const previous = globalThis.stratosDesktop;
  try {
    resetEntitlementCache();
    globalThis.stratosDesktop = { getEntitlement: async () => ({ premium: true, verified: true, mode: 'development' }) };
    const dev = await getEntitlement({ force: true });
    assert.equal(isPremium(dev), true);
    assert.match(describeEntitlement(dev), /not a purchase/i);

    resetEntitlementCache();
    globalThis.stratosDesktop = { getEntitlement: async () => ({ premium: true, verified: false }) };
    assert.equal(isPremium(await getEntitlement({ force: true })), false);

    resetEntitlementCache();
    delete globalThis.stratosDesktop;
    const browser = await getEntitlement({ force: true });
    assert.equal(isPremium(browser), false);
    assert.equal(browser.mode, 'unavailable');

    // A value in browser storage is never consulted; only the desktop channel is.
    globalThis.localStorage = { getItem: () => 'true', setItem() {}, removeItem() {} };
    resetEntitlementCache();
    assert.equal(isPremium(await getEntitlement({ force: true })), false);
    assert.ok(premiumSetupNotes().length >= 2);
  } finally {
    resetEntitlementCache();
    if (previous) globalThis.stratosDesktop = previous;
    else delete globalThis.stratosDesktop;
  }
});

function installDom() {
  const { window } = parseHTML('<!doctype html><html data-theme="night"><head></head><body><main id="view"></main></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/pilot.html', hash: '' },
    configurable: true,
  });
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) { return this.store.get(key) ?? null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.fetch = async () => { throw new Error('the charts page must not fetch without an airport'); };
  return window;
}

test('a free pilot sees the catalogue and a Premium panel instead of a chart', async () => {
  installDom();
  const { resetEntitlementCache } = await import('../app/js/lib/entitlement.js');
  resetEntitlementCache();
  globalThis.stratosDesktop = {
    getEntitlement: async () => ({ premium: false, verified: true, mode: 'none', reason: 'No licence service is configured.' }),
  };
  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const instance = await mount(root, { params: new URLSearchParams(''), directory: [], bridgeBase: '', health: null });
  assert.match(root.textContent, /Charts/);
  assert.match(root.textContent, /Integrated charts/);
  assert.match(root.textContent, /No licence service is configured/);
  assert.match(root.textContent, /Not for navigation/);
  assert.equal(root.querySelector('.chart-page'), null, 'no document is rendered for a free pilot');
  instance.destroy();
  assert.equal(root.innerHTML, '');
});

test('a verified Premium pilot gets the empty viewer ready to open a chart', async () => {
  installDom();
  const { resetEntitlementCache } = await import('../app/js/lib/entitlement.js');
  resetEntitlementCache();
  globalThis.stratosDesktop = { getEntitlement: async () => ({ premium: true, verified: true, mode: 'licence', plan: 'Premium' }) };
  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const instance = await mount(root, { params: new URLSearchParams(''), directory: [], bridgeBase: '', health: null });
  assert.match(root.textContent, /Select a chart/);
  assert.doesNotMatch(root.textContent, /Stratos Premium/);
  instance.destroy();
});

test('ChartFox redirects and hard-coded chart URLs are gone', () => {
  const deck = read('app/index.html');
  assert.doesNotMatch(deck, /chartfox/i);
  assert.doesNotMatch(deck, /FAA_APD/);
  assert.doesNotMatch(deck, /aeronav\.faa\.gov\/d-tpp\/'\+/);
  assert.match(deck, /function openChartsPage\(icao\)\{location\.href='pilot\.html#charts'/);
  assert.match(deck, /chartLauncherHtml/);

  assert.doesNotMatch(read('app/js/pilot/airports.js'), /chartfox/i);
  assert.doesNotMatch(read('app/js/pilot/briefing.js'), /chartfox/i);
  assert.match(read('app/js/pilot/briefing.js'), /pilot\.html#charts/);
  assert.match(read('app/pilot.html'), /data-section="charts"/);
  assert.match(read('app/js/pilot.js'), /charts: \{ label: 'Charts'/);
  assert.match(read('app/js/pilot/charts.js'), /pilot\.html#charts|loadPdfjs/);
});

test('the chart endpoints are narrow and the entitlement check is in the main process', () => {
  const api = read('api/chart.js');
  assert.match(api, /ALLOWED_FILE = \/\^\[A-Z0-9\]\{1,12\}/);
  assert.ok(api.includes('.PDF$'), 'only .PDF documents are accepted');
  assert.match(api, /aeronav\.faa\.gov\/d-tpp\/\$\{cycle\}\/\$\{file\}/);
  assert.match(api, /Buffer\.from/);
  assert.match(read('api/charts.js'), /parseFaaAirport/);
  assert.match(read('api/charts.js'), /faaCycle/);

  const bridge = read('stratos_bridge.py');
  assert.match(bridge, /if path == "\/charts":/);
  assert.match(bridge, /if path == "\/chart":/);
  assert.match(bridge, /CHART_FILE_RE/);

  const main = read('electron-main.cjs');
  assert.match(main, /ipcMain\.handle\('premium:status'/);
  assert.match(main, /STRATOS_ENTITLEMENT_URL/);
  assert.match(read('electron-preload.cjs'), /getEntitlement: \(\) => ipcRenderer\.invoke\('premium:status'\)/);
});

test('the vertical profile reuses the route estimate and keeps imported altitudes', async () => {
  const { routeProfile, routeTotals, importPln, exportPln } = await import('../app/js/lib/planner.js');
  const route = [
    { id: 'KSFO', lat: 37.6188, lon: -122.375, elev: 13, kind: 'apt' },
    { id: 'DCT', lat: 39.5, lon: -110, elev: 0, kind: 'fix' },
    { id: 'KJFK', lat: 40.6413, lon: -73.7781, elev: 13, kind: 'apt' },
  ];
  const options = { cruiseKts: 450, cruiseAlt: 35000 };
  const totals = routeTotals(route, options);
  const profile = routeProfile(route, options);

  assert.equal(profile.toc.nm, totals.tocNm);
  assert.equal(profile.tod.nm, totals.todNm);
  assert.ok(profile.tocNm > 0 && profile.tocNm < profile.todNm);
  assert.ok(profile.todNm <= profile.distanceNm);
  assert.equal(profile.points[0].plannedAlt, 13);
  assert.equal(profile.points[2].plannedAlt, 13);
  assert.equal(profile.points[1].plannedAlt, 35000);
  assert.equal(profile.cruiseAlt, 35000);
  assert.equal(profile.estimated, true);
  assert.equal(routeProfile([route[0]]), null);

  const plan = `<?xml version="1.0"?><SimBase.Document><FlightPlan.FlightPlan>
    <ATCWaypoint id="KSFO"><ATCWaypointType>Airport</ATCWaypointType>
      <WorldPosition>N37 37.13,W122 22.50,+000000013.00</WorldPosition></ATCWaypoint>
    <ATCWaypoint id="COAST"><ATCWaypointType>User</ATCWaypointType>
      <Altitude>12000.00</Altitude>
      <WorldPosition>N39 30.00,W110 00.00,+000012000.00</WorldPosition></ATCWaypoint>
    <ATCWaypoint id="KJFK"><ATCWaypointType>Airport</ATCWaypointType>
      <WorldPosition>N40 38.48,W073 46.69,+000000013.00</WorldPosition></ATCWaypoint>
  </FlightPlan.FlightPlan></SimBase.Document>`;
  const imported = importPln(plan);
  assert.equal(imported[1].constraintAlt, 12000);
  assert.equal(imported[0].constraintAlt, null);
  assert.match(exportPln(imported), /<Altitude>12000\.00<\/Altitude>/);

  const constrained = routeProfile(imported, options);
  assert.equal(constrained.points[1].constraintAlt, 12000);
  assert.equal(constrained.points[1].plannedAlt, 35000, 'the estimate is not overwritten by the imported altitude');
});
