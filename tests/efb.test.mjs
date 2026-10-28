import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('EFB conditions: pressure altitude, ISA and density altitude', async () => {
  const {
    pressureAltitudeFt, isaTemperatureC, isaDeviationC, densityAltitudeFt, analyseConditions,
  } = await import('../app/js/lib/aircraftperformance.js');

  assert.equal(pressureAltitudeFt(0, 1013.25), 0, 'sea level on a standard day is zero');
  assert.ok(pressureAltitudeFt(1000, 1013.25) > 995 && pressureAltitudeFt(1000, 1013.25) < 1005,
    'elevation is carried through the standard atmosphere');
  assert.ok(pressureAltitudeFt(0, 1000) > 100, 'a low QNH raises the pressure altitude');
  assert.ok(pressureAltitudeFt(0, 1030) < 0, 'a high QNH lowers it');
  assert.equal(pressureAltitudeFt(0, 500), null, 'an impossible QNH is refused');
  assert.equal(pressureAltitudeFt('x', 1013), null);

  assert.equal(isaTemperatureC(0), 15);
  assert.ok(Math.abs(isaTemperatureC(10000) - 15 + 19.8) < 0.01, 'ISA loses 1.98 °C per 1000 ft');
  assert.equal(isaDeviationC(30, 0), 15, 'ISA+15 at sea level');
  assert.ok(densityAltitudeFt(0, 15) === 0, 'a standard day has no density-altitude correction');
  assert.ok(densityAltitudeFt(0, 35) > 2000, 'a hot day raises the density altitude');

  const wet = analyseConditions({
    elevationFt: 0, qnhHpa: 1000, oatC: 30,
    runwayHeadingDeg: 90, windFromDeg: 120, windKt: 20, gustKt: 30,
  });
  assert.ok(wet.pressureAltitudeFt > 300, 'QNH is applied');
  assert.ok(wet.densityAltitudeFt > wet.pressureAltitudeFt, 'heat is applied');
  assert.equal(wet.wind.headwindKt, 17.3, 'a 30° offset leaves 17.3 kt of headwind');
  assert.equal(wet.wind.crosswindSide, 'right');
  assert.equal(wet.wind.crosswindKt, 10, 'and 10 kt across the runway');
  assert.equal(wet.wind.gustCrosswindKt, 15);
});

test('EFB conditions: wind components keep their sign and side', async () => {
  const { windComponents } = await import('../app/js/lib/aircraftperformance.js');
  const direct = windComponents(270, 270, 20);
  assert.equal(direct.headwindKt, 20);
  assert.equal(direct.crosswindKt, 0);
  assert.equal(direct.crosswindSide, 'none');

  const tail = windComponents(90, 270, 12);
  assert.equal(tail.headwindKt, -12);
  assert.equal(tail.tailwindKt, 12);

  const left = windComponents(0, 345, 20);
  assert.equal(left.crosswindSide, 'left');
  assert.ok(left.crosswindKt > 4 && left.crosswindKt < 6);

  assert.equal(windComponents(null, 270, 10), null);
  assert.equal(windComponents(270, 270, -3), null);
  assert.equal(windComponents(270, 270, ''), null);
});

function demoDataset() {
  return {
    schema: 'stratos.performance/1',
    aircraft: { icao: 'A321', variant: 'A321-200 test' },
    source: 'Unit-test AFM extract',
    revision: 'test-1',
    approved: false,
    mode: 'simulation',
    axes: {
      weight: [60000, 80000],
      pressureAltitudeFt: [0, 8000],
      oatC: [0, 20],
    },
    takeoff: {
      // Values are deliberate lattice points so the interpolation can be checked.
      distanceFt: [
        [[1800, 2200], [2600, 3200]],
        [[2600, 3100], [3800, 4500]],
      ],
      v1Kt: [
        [[130, 132], [140, 143]],
        [[144, 147], [156, 160]],
      ],
    },
    landing: {
      distanceFt: [
        [[1300, 1500], [1800, 2100]],
        [[1500, 1750], [2100, 2450]],
      ],
    },
  };
}

test('EFB performance dataset: validation refuses anything it cannot trust', async () => {
  const { validateDataset, SCHEMA } = await import('../app/js/lib/aircraftperformance.js');
  assert.equal(validateDataset(demoDataset()).ok, true);

  const noSource = { ...demoDataset(), source: '' };
  assert.equal(validateDataset(noSource).ok, false);
  const badAxis = demoDataset();
  badAxis.axes.weight = [80000, 60000];
  assert.match(validateDataset(badAxis).problems.join(' '), /strictly ascending/);
  const shortRow = demoDataset();
  shortRow.takeoff.distanceFt[0].pop();
  assert.equal(validateDataset(shortRow).ok, false);
  const wrongSchema = { ...demoDataset(), schema: 'something-else' };
  assert.equal(validateDataset(wrongSchema).ok, false);
  assert.match(validateDataset(wrongSchema).problems.join(' '), new RegExp(SCHEMA.replace('/', '\\/')));
  assert.equal(validateDataset(null).ok, false);
});

test('EFB performance: lookups interpolate inside the table and refuse outside it', async () => {
  const { validateDataset, lookupPerformance, datasetLabel } = await import('../app/js/lib/aircraftperformance.js');
  const { dataset } = validateDataset(demoDataset());

  const exact = lookupPerformance(dataset, 'takeoff', { weight: 60000, pressureAltitudeFt: 0, oatC: 0 });
  assert.equal(exact.distanceFt.value, 1800);
  assert.equal(exact.v1Kt.value, 130);

  const middle = lookupPerformance(dataset, 'takeoff', { weight: 70000, pressureAltitudeFt: 4000, oatC: 10 });
  assert.equal(middle.distanceFt.value, 2975, 'the centre of the table is the mean of its eight corners');
  assert.equal(middle.v1Kt.value, 144);
  const linear = lookupPerformance(dataset, 'takeoff', { weight: 70000, pressureAltitudeFt: 0, oatC: 0 });
  assert.equal(linear.distanceFt.value, 2200, 'halfway between two weight rows');

  const outside = lookupPerformance(dataset, 'takeoff', { weight: 95000, pressureAltitudeFt: 0, oatC: 0 });
  assert.match(outside.distanceFt.unavailable, /outside the dataset/);
  assert.equal(outside.distanceFt.value, undefined, 'an extrapolation is never returned as a value');

  const tooHot = lookupPerformance(dataset, 'landing', { weight: 70000, pressureAltitudeFt: 4000, oatC: 35 });
  assert.match(tooHot.distanceFt.unavailable, /outside the dataset/);

  const missing = lookupPerformance(null, 'takeoff', {});
  assert.deepEqual(missing, {});
  assert.match(datasetLabel(dataset), /A321 A321-200 test · Unit-test AFM extract · revision test-1 · simulation · unapproved/);
});

test('EFB weight and balance: sums, limits and the missing-CG truth', async () => {
  const { computeLoadSheet, limitsFromOfp, parseCg } = await import('../app/js/lib/weightbalance.js');
  const sheet = computeLoadSheet({
    oew: 48000,
    pax: 180,
    paxWeight: 84,
    crew: 400,
    cargo: 3000,
    fuel: 15000,
    taxiFuel: 200,
    tripFuel: 9000,
    limits: { unit: 'kg', mzfw: 75000, mtow: 93000, mlw: 77800 },
  });
  assert.equal(sheet.payload, 18520, 'passengers, crew and cargo');
  assert.equal(sheet.zfw, 66520);
  assert.equal(sheet.tow, 81520);
  assert.equal(sheet.lw, 72520);
  assert.equal(sheet.overLimit, false);
  assert.equal(sheet.checks.find(c => c.key === 'tow').margin, 11480);
  assert.equal(sheet.cg, null, 'no CG is invented');
  assert.match(sheet.notes.join(' '), /no centre of gravity/i);

  const heavy = computeLoadSheet({
    oew: 48000, pax: 230, paxWeight: 84, cargo: 8000, fuel: 20000,
    limits: { unit: 'kg', mzfw: 75000, mtow: 93000, mlw: 77800 },
  });
  assert.equal(heavy.overLimit, true, 'MTOW is checked');
  assert.equal(heavy.checks.find(c => c.key === 'zfw').over, true, 'MZFW is checked');

  const partial = computeLoadSheet({ oew: 48000, pax: 100, cargo: null, fuel: 5000 });
  assert.equal(partial.zfw, null, 'an incomplete payload does not become a number');
  assert.equal(partial.checks.find(c => c.key === 'zfw').checked, false);

  assert.equal(parseCg('25.4% MAC'), 25.4);
  assert.equal(parseCg('not stated'), null);
  assert.equal(parseCg('120'), null);
  const limits = limitsFromOfp({
    units: 'lb',
    weights: { oew: 100000, mzfw: 140000, mtow: 170000, mlw: 148000, cg: '31.2' },
  });
  assert.equal(limits.unit, 'lb');
  assert.equal(limits.cg, 31.2);
});

test('EFB fuel: components reconcile, nothing is double counted, units are explicit', async () => {
  const { fuelFromOfp, manualSheet, arrivalSummary } = await import('../app/js/lib/fuelfigures.js');
  const ofp = {
    units: 'kg',
    fuel: { block: 20000, taxi: 400, trip: 15000, contingency: 600, alternate: 1500, reserve: 2500, extra: 0, takeoff: 19600, landing: 4600 },
  };
  const plan = fuelFromOfp(ofp);
  assert.equal(plan.sum, 20000, 'the stated components add up to the stated block');
  assert.equal(plan.difference, 0);
  assert.equal(plan.balanced, true);
  assert.equal(plan.unit, 'kg');
  assert.equal(plan.rows.find(r => r.key === 'trip').value, 15000);
  assert.equal(plan.takeoff, 19600);
  assert.equal(plan.landing, 4600);

  const mismatch = fuelFromOfp({ units: 'kg', fuel: { block: 21000, taxi: 400, trip: 15000, reserve: 2500 } });
  assert.equal(mismatch.difference, 3100);
  assert.equal(mismatch.balanced, false, 'a plan that does not add up is reported, not repaired');

  const missing = fuelFromOfp({ units: 'kg', fuel: { block: null, taxi: 400 } });
  assert.equal(missing.block, null);
  assert.match(missing.notes.join(' '), /block fuel/i);
  assert.equal(fuelFromOfp(null), null);

  const manual = manualSheet({ unit: 'lb', taxi: 300, trip: 12000, reserve: 2000, alternate: 1000 });
  assert.equal(manual.block, 15300);
  assert.equal(manual.unit, 'lb');
  assert.equal(manual.balanced, true);
  assert.equal(manual.rows.find(r => r.key === 'extra').source, null, 'an unstated component is not given a source');

  const arrival = arrivalSummary(plan);
  assert.equal(arrival.landing, 4600);
  assert.equal(arrival.reservePlusAlternate, 4000);
});

test('EFB TAF decoder reads validity, wind, visibility and change groups', async () => {
  const { decodeTaf } = await import('../app/js/lib/taf.js');
  const now = Date.UTC(2026, 0, 23, 18, 0, 0);
  const raw = 'TAF KJFK 231730Z 2318/2424 24012G20KT P6SM SCT040 BKN080 FM240000 25008KT 4SM -RA BKN025 TEMPO 2400/2404 2SM RA BR OVC008';
  const taf = decodeTaf(raw, now);
  assert.equal(taf.station, 'KJFK');
  assert.equal(taf.initial.wind.speedKt, 12);
  assert.equal(taf.initial.wind.gustKt, 20);
  assert.equal(taf.initial.visibility.sm, 6);
  assert.equal(taf.initial.clouds.length, 2);
  assert.equal(taf.initial.clouds[1].cover, 'broken');
  assert.equal(taf.initial.clouds[1].baseFt, 8000);
  assert.ok(taf.validFromMs < taf.validToMs, 'the validity window runs forwards');
  assert.equal(taf.changes.length, 2);
  assert.equal(taf.changes[0].type, 'FM');
  assert.equal(taf.changes[0].wind.direction, 250);
  assert.deepEqual(taf.changes[0].weather, ['light rain']);
  assert.equal(taf.changes[1].type, 'TEMPO');
  assert.equal(taf.changes[1].visibility.sm, 2);
  assert.equal(decodeTaf(''), null);
});

test('EFB TAF decoder handles metric visibility and CAVOK without inventing values', async () => {
  const { decodeTaf } = await import('../app/js/lib/taf.js');
  const taf = decodeTaf('TAF LFPG 231700Z 2318/2424 27010KT 9999 SCT035 BECMG 2320/2322 CAVOK');
  assert.equal(taf.station, 'LFPG');
  assert.ok(taf.initial.visibility.metres >= 9000);
  assert.equal(taf.initial.wind.direction, 270);
  assert.equal(taf.changes[0].type, 'BECMG');
  assert.equal(taf.changes[0].cavok, true);
  assert.equal(taf.changes[0].unknown.length, 0, 'a known group leaves nothing unexplained');
  const junk = decodeTaf('TAF XXXX 231700Z 2318/2424 27010KT QQQQ');
  assert.ok(junk.initial.unknown.includes('QQQQ'), 'unrecognised groups are kept, not guessed');
});

test('EFB charts: a real d-TPP payload becomes a catalogue the viewer can group', async () => {
  const { catalogueFromPayload } = await import('../app/js/efb/common.js');
  // The shape the FAA endpoint answers with: records under `charts`, cycle on top.
  const payload = {
    source: 'faa-dtpp', sourceName: 'FAA Digital Terminal Procedures',
    icao: 'KEWR', cycle: '2610', effective: 1790845260000, expires: 1793264460000,
    checkedAt: 1792945004297,
    charts: [
      { code: 'APD', title: 'AIRPORT DIAGRAM', pdf: '00285AD.PDF', amended: null },
      { code: 'IAP', title: 'ILS OR LOC RWY 04R', pdf: '00285I4R.PDF', amended: null },
      { code: 'XX', title: 'NO DOCUMENT', pdf: null, amended: null },
    ],
  };
  const catalogue = catalogueFromPayload(payload, 'KEWR');
  assert.ok(catalogue, 'a payload with documents is a catalogue');
  assert.equal(catalogue.icao, 'KEWR');
  assert.equal(catalogue.cycle, '2610');
  assert.equal(catalogue.source, 'faa-dtpp');
  assert.equal(catalogue.charts.length, 2, 'the record with no PDF is dropped, not shown as a chart');
  assert.equal(catalogue.charts[0].category, 'diagram', 'records are grouped in publication order');
  assert.match(catalogue.charts[1].url, /^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\//, 'the document URL stays on the publisher');
  // Anything empty or malformed is an honest "no catalogue", never an empty list drawn as charts.
  assert.equal(catalogueFromPayload({ charts: [] }, 'KEWR'), null);
  assert.equal(catalogueFromPayload(null, 'KEWR'), null);
  assert.equal(catalogueFromPayload({ charts: [{ code: 'APD', title: 'X', pdf: null }] }, 'KEWR'), null);
});

test('EFB Navigator keeps the flight it drew when the rollout opens a new record', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/js/efb/navigator.js', import.meta.url), 'utf8');
  assert.match(page, /trailContinues\(drawnTrack\[drawnTrack\.length - 1\], track\[0\]\)/,
    'a record that starts where the drawn path stopped continues it');
  assert.match(page, /drawnTrack = track\.slice\(\);/, 'a flight from somewhere else replaces the path');
  assert.match(page, /if \(drawnTrack\.length > 6000\) drawnTrack\.splice/, 'the joined path stays bounded');
});

test('Navigator describes the route it drew, not a plan left over from another flight', async () => {
  const fs = await import('node:fs');
  // Matched line by line, so the file's line endings must not decide the result:
  // a checkout on Windows may hand us CRLF where the repository holds LF.
  const page = fs.readFileSync(new URL('../app/js/efb/navigator.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  // The route built in the Flight Plan app carries its own airports, procedures
  // and cruise in the shared record, so it is described from itself.
  assert.match(page, /const meta = loadRouteMeta\(\);/, 'the shared route record is read for the summary');
  assert.match(page, /const own = meta\.plan \|\| null;/, 'and its plan is what the summary prefers');
  assert.match(page, /const origin = \(own\.origin && own\.origin\.id\) \|\| '';/, 'the route names its own airports');
  assert.match(page, /sid: procedureLabel\(own\.sid\)/, 'and its own procedures');
  assert.match(page, /meta\.cruiseAlt \? fmtFl\(meta\.cruiseAlt\)/, 'and its own cruise level');

  // The callsign and the aircraft belong to a SimBrief plan, and it is only this
  // route's plan while both of its airports match.
  assert.match(page, /const sameFlight = Boolean\(ofp && origin && destination/, 'a match is required before any of it is shown');
  assert.match(page, /callsign: sameFlight \?[^:]*: '',/, 'a callsign from another flight is withheld');
  assert.match(page, /aircraft: sameFlight \?[^:]*: '',/, 'so is its aircraft');
  assert.match(page, /plannedNm: sameFlight &&[^,]*,/i, 'and its planned distance');

  // With no route record the SimBrief plan is the flight, which is the older path.
  assert.match(page, /if \(!own\) \{\n\s+if \(!ofp\) return null;/, 'a SimBrief-only flight still reads from the plan');
});

test('the EFB installs as its own app on a tablet or phone home screen', async () => {
  const fs = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const read = file => fs.readFileSync(new URL(file, root), 'utf8');
  const manifest = JSON.parse(read('app/manifest-efb.webmanifest'));
  assert.equal(manifest.name, 'Stratos EFB');
  assert.equal(manifest.start_url, './efb.html#/home', 'an installed bag starts on its own deck, never on the tracker');
  assert.equal(manifest.display, 'standalone', 'it launches without browser chrome');
  assert.notEqual(manifest.id, './', 'the bag is a separate install from the Flight Deck, which uses ./');
  const sizes = manifest.icons.map(icon => icon.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'the sizes an installable app needs');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'), 'a maskable icon for a shaped home screen');

  const page = read('app/efb.html');
  assert.match(page, /<link rel="manifest" href="manifest-efb\.webmanifest">/, 'the page names its own manifest');
  assert.match(page, /<meta name="apple-mobile-web-app-capable" content="yes">/, 'iOS launches it standalone');
  assert.match(page, /<meta name="apple-mobile-web-app-title" content="Stratos EFB">/, 'the home-screen label');
  assert.match(page, /navigator\.serviceWorker\.register\('sw\.js'\)/, 'the bag registers the same shell worker');
  assert.match(page, /display-mode: standalone/, 'it knows when it is running from a home screen');

  const sw = read('app/sw.js');
  for (const file of ['efb.html', 'efb.css', 'manifest-efb.webmanifest', 'js/efb.js']) {
    assert.ok(sw.includes(`'${file}'`), `${file} is part of the offline shell`);
  }
  assert.match(sw, /wantsEfb/, 'an offline launch of the bag returns the bag, not the Flight Deck');
  assert.match(read('vercel.json'), /manifest-efb\.webmanifest/, 'the deployment serves it as a manifest');

  // Same origin, so the tracker's manifest and the bag's must stay different apps.
  const tracker = JSON.parse(read('app/manifest.webmanifest'));
  assert.notEqual(tracker.start_url, manifest.start_url);
  assert.notEqual(tracker.id, manifest.id);
});

test('the EFB opens on a deck of apps, and Checklists is its own app', async () => {
  const fs = await import('node:fs');
  const root = new URL('../', import.meta.url);
  // Line endings normalised: a checkout on Windows may hand us CRLF where the
  // repository holds LF, and these tests match the source line by line.
  const shell = fs.readFileSync(new URL('app/js/efb.js', root), 'utf8').replace(/\r\n/g, '\n');
  const page = fs.readFileSync(new URL('app/efb.html', root), 'utf8');

  assert.match(shell, /const HOME_ROUTE = 'home'/, 'the deck is a route, not a splash screen');
  assert.match(shell, /const DEFAULT_ROUTE = HOME_ROUTE/, 'opening the bag lands on the deck');
  assert.match(shell, /id: 'checklists'/, 'Checklists is an app of its own');
  assert.match(shell, /module: '\.\/efb\/checklists\.js'/, 'and loads its own module');
  assert.doesNotMatch(shell, /efb\/documents\.js/, 'the document library is not shipped as an app');
  assert.ok(fs.existsSync(new URL('app/js/efb/checklists.js', root)), 'the checklists module exists where the shell loads it');

  assert.match(page, /id="efb-home"/, 'the deck is in the page');
  assert.match(page, /id="home-grid"/, 'with a grid of apps');
  assert.match(page, /id="home-dock"/, 'and a dock');
  assert.match(page, /href="#\/home"[^>]*aria-label="Home screen"/, 'every app view can come back to the deck');
});

test('the flight phase comes from the bridge, or from the position when there is no record', async () => {
  const { flightPhase, phaseLabel } = await import('../app/js/efb/common.js');
  const at = telemetry => ({ telemetry, currentFlight: null });

  assert.equal(flightPhase(null), null, 'no snapshot is no phase');
  assert.equal(flightPhase({ telemetry: null }), null);

  const parked = flightPhase(at({ gs: 0, alt: 495, agl: 0, vs: 0, onGround: true }));
  assert.equal(parked.code, 'PARKED');
  assert.equal(parked.derived, true, 'a phase read from the position says so');
  assert.equal(flightPhase(at({ gs: 14, agl: 0, onGround: true })).code, 'TAXI');
  assert.equal(flightPhase(at({ gs: 120, agl: 0, onGround: true })).code, 'TAKEOFF');
  assert.equal(flightPhase(at({ gs: 250, alt: 12000, agl: 11500, vs: 2200, onGround: false })).code, 'CLIMB');
  assert.equal(flightPhase(at({ gs: 472, alt: 35000, agl: 34500, vs: 0, onGround: false })).code, 'CRUISE');
  assert.equal(flightPhase(at({ gs: 300, alt: 20000, agl: 19500, vs: -1800, onGround: false })).code, 'DESCENT');
  assert.equal(flightPhase(at({ gs: 150, alt: 1800, agl: 1500, vs: -700, onGround: false })).code, 'APPROACH');
  assert.equal(flightPhase(at({ gs: 180, alt: 1200, agl: 900, vs: 0, onGround: false })).code, 'LEVEL',
    'level at low height is not called cruise');

  const recorded = flightPhase({ telemetry: { gs: 0, onGround: true }, currentFlight: { phase: 'LANDED' } });
  assert.equal(recorded.code, 'LANDED');
  assert.equal(recorded.derived, false, 'a recorded phase is not marked as derived');
  assert.equal(recorded.label, 'Landed');
  assert.equal(phaseLabel('TAXI'), 'Taxiing');
  assert.equal(phaseLabel(''), '');
  assert.equal(phaseLabel('SOMETHING'), 'SOMETHING', 'an unknown code is shown as it arrived');
});

test('Navigator replaced Live: one map app, planned route, chart conventions', async () => {
  const fs = await import('node:fs');
  const root = new URL('../', import.meta.url);
  // Line endings normalised: a checkout on Windows may hand us CRLF where the
  // repository holds LF, and these tests match the source line by line.
  const shell = fs.readFileSync(new URL('app/js/efb.js', root), 'utf8').replace(/\r\n/g, '\n');
  const page = fs.readFileSync(new URL('app/js/efb/navigator.js', root), 'utf8');
  const html = fs.readFileSync(new URL('app/efb.html', root), 'utf8');

  assert.match(shell, /id: 'navigator', group: 'Flight', name: 'Navigator'/, 'Navigator is the map app');
  assert.match(shell, /module: '\.\/efb\/navigator\.js'/, 'and loads its own module');
  assert.equal(fs.existsSync(new URL('app/js/efb/live.js', root)), false, 'the old Live module is gone');
  assert.doesNotMatch(shell, /name: 'Live'/, 'no app is still called Live');
  assert.match(shell, /const LEGACY_ROUTES = \{ live: 'navigator', map: 'navigator' \}/, 'old links land on Navigator');
  assert.match(shell, /const DOCK = \['navigator'/, 'the dock opens on it');
  assert.match(html, /href="#\/navigator"/, 'the deck widget opens Navigator');
  const manifest = JSON.parse(fs.readFileSync(new URL('app/manifest-efb.webmanifest', root), 'utf8'));
  assert.ok(manifest.shortcuts.some(shortcut => shortcut.url.endsWith('#/navigator')), 'the install shortcut too');

  // Route rendering: chart symbols, leg geometry and collision-thinned labels.
  assert.match(page, /new MiniMap\(el\.canvas, \{/, 'the page reuses the tracker\'s map engine');
  assert.match(page, /routeStyle: 'nav'/, 'and asks for the chart-style route');
  assert.match(page, /pannable: true/, 'the chart can be panned and wheel-zoomed');
  assert.match(page, /ownSymbol: 'aircraft'/, 'own aircraft is drawn as an aircraft');
  assert.match(page, /chartTheme/, 'the chart theme is chosen, not inherited from the tracker');
  assert.match(page, /attribution: false/, 'the credit lives in the footer instead of on the canvas');
  assert.match(page, /map-credit[^<]*© Esri/, 'and it is still shown');
  assert.match(page, /map\?\.setPosition\(null\)/, 'an offline feed clears the last position');
  assert.match(page, /The aircraft is still tracked on the map/, 'tracking needs no flight plan');
  assert.match(page, /flightPhase\(message\)/, 'the chip shows the current phase');
  assert.match(page, /setRouteState\(stateNow\)/, 'route progress is handed to the chart');
  assert.match(page, /data-wp="\$\{index\}"/, 'the panel lists waypoints');
  assert.match(page, /data-leg="\$\{index\}"/, 'and the legs between them');
  assert.match(page, /data-centre/, 'a selected point can be centred');
  assert.match(page, /distanceNm\(from, to\)/, 'a leg reports its real distance');
  assert.match(page, /bearingDeg\(from, to\)/, 'and its initial track');

  // The map is its own view: the content region is the chart, edge to edge.
  assert.match(html, /<body class="efb"/, 'the page is the bag shell');
  const css = fs.readFileSync(new URL('app/efb.css', root), 'utf8');
  assert.match(css, /body\.view-map \.efb-body \{ padding: 0/, 'the map view removes the page padding');
  assert.match(css, /^\.map-shell \{ flex: 1; display: flex; flex-direction: column/m, 'the chart and its bar stack');
  assert.match(css, /^\.map-foot\b/m, 'the progress bar has a bar of its own under the chart');
  assert.match(css, /^\.nav-panel \{/m, 'the route panel is styled');
});

test('the map engine draws route points as chart symbols without label pile-ups', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../app/js/minimap.js', import.meta.url), 'utf8');

  assert.match(source, /function drawNavPoint/, 'one symbol per point type');
  assert.match(source, /ctx\.arc\(0, 0, 5\.2/, 'an airport is a ringed dot');
  assert.match(source, /Math\.PI \/ 3/, 'a navaid is a hexagon');
  assert.match(source, /ctx\.moveTo\(0, -4\.8\)/, 'a fix is a triangle');
  assert.match(source, /const taken = \[\]/, 'labels share one occupancy list');
  assert.match(source, /if \(clash\)/, 'a label that would collide is dropped');
  assert.match(source, /important\.forEach\(labelFor\)/, 'endpoints and the next waypoint are placed first');
  assert.match(source, /legNm/, 'leg distances come from the plan');
  assert.match(source, /chartTheme === 'day'/, 'a page can choose a day chart');
  assert.match(source, /panBy\(dx, dy\)/, 'the chart pans');
  assert.match(source, /zoomAt\(x, y,/, 'wheel zoom keeps the point under the pointer');
});

test('airline callsigns are parsed strictly and only a known designator is applied', async () => {
  const {
    AIRLINES, airlineByIcao, airlineVars, detectAirline, parseCallsign, resolveAirline, searchAirlines,
  } = await import('../app/js/lib/airlines.js');

  assert.equal(parseCallsign('ACA123').designator, 'ACA');
  assert.equal(parseCallsign(' aca 123 ').designator, 'ACA');
  assert.equal(parseCallsign('UAL123').designator, 'UAL');
  assert.equal(parseCallsign('ACA123A').designator, 'ACA', 'a suffix letter is part of the flight number');
  assert.equal(parseCallsign('C-FACA'), null, 'a registration is not a callsign');
  assert.equal(parseCallsign('KJFK'), null, 'an airport is not a callsign');
  assert.equal(parseCallsign('1234'), null);
  assert.equal(parseCallsign(''), null);
  assert.equal(parseCallsign('AC1234KJFK'), null);

  // A designator the table does not know is not an airline, however plausible.
  assert.equal(detectAirline({ ofp: { flight: { callsign: 'ZZZ123', airline: 'ZZZ' } } }).airline, null);
  assert.equal(detectAirline({ ofp: { flight: { callsign: 'ACA123' } } }).airline.name, 'Air Canada');
  assert.equal(detectAirline({ ofp: { flight: { callsign: 'EZY456' } } }).airline.icao, 'EZY');
  assert.equal(detectAirline({ ofp: { flight: { callsign: 'AAL789' } } }).airline.icao, 'AAL');
  assert.equal(detectAirline({ ofp: { flight: { callsign: 'UAL123' } } }).airline.icao, 'UAL');
  assert.equal(detectAirline({ ofp: { flight: { airline: 'DLH', callsign: null } } }).source, 'plan',
    'the plan\'s airline field is authoritative');
  assert.equal(detectAirline({ ofp: { flight: { callsign: 'ACA123' } } }).source, 'callsign');
  assert.equal(detectAirline({ ofp: { flight: { callsign: 'C-FACA' } } }).airline, null,
    'a registration never picks an airline');
  assert.equal(detectAirline(null).airline, null);

  // Manual beats automatic; a manual code outside the table falls back to detection.
  const plan = { ofp: { flight: { callsign: 'ACA123' } } };
  assert.equal(resolveAirline({ airlineMode: 'manual', airline: 'UAL' }, plan).airline.icao, 'UAL');
  assert.equal(resolveAirline({ airlineMode: 'auto', airline: 'UAL' }, plan).airline.icao, 'ACA');
  assert.equal(resolveAirline({ airlineMode: 'manual', airline: 'ACA' }, null).airline.icao, 'ACA');
  assert.equal(resolveAirline({ airlineMode: 'auto' }, null).airline, null, 'nothing detected means house colours');
  assert.equal(resolveAirline({ airlineMode: 'manual', airline: 'ZZZ' }, null).airline, null);

  // Every profile is complete, and its tokens keep the interface readable.
  for (const airline of AIRLINES) {
    assert.match(airline.icao, /^[A-Z]{3}$/);
    assert.match(airline.accent, /^#[0-9a-f]{6}$/i);
    assert.match(airline.deep, /^#[0-9a-f]{6}$/i);
    assert.ok(airline.name.length > 2);
    const vars = airlineVars(airline);
    assert.equal(vars['--efb-accent'], airline.accent);
    assert.match(vars['--efb-accent-soft'], /^rgba\(/);
    assert.match(vars['--efb-accent-ink'], /^#[0-9a-f]{6}$/i);
  }
  // A pilot can pick from a real list: at least thirty operators, each one a
  // distinct designator with its own colours, and no duplicate keys to shadow
  // another in the lookup map.
  assert.ok(AIRLINES.length >= 30, `the table offers at least thirty airlines (${AIRLINES.length})`);
  const designators = new Set(AIRLINES.map(airline => airline.icao));
  assert.equal(designators.size, AIRLINES.length, 'every designator appears once');
  const iataCodes = AIRLINES.map(airline => airline.iata).filter(Boolean);
  assert.equal(new Set(iataCodes).size, iataCodes.length, 'every IATA code appears once');
  assert.equal(airlineByIcao('UAE').name, 'Emirates');
  assert.equal(airlineByIcao('SIA').name, 'Singapore Airlines');
  assert.equal(searchAirlines('singapore')[0].icao, 'SIA', 'the selector searches by name');
  assert.equal(airlineByIcao('aca').name, 'Air Canada', 'lookups are case-insensitive');
  assert.equal(airlineByIcao('ZZZ'), null);
  assert.equal(searchAirlines('easy').length, 1);
  assert.equal(searchAirlines('UAL')[0].name, 'United Airlines');
  assert.equal(searchAirlines('').length, AIRLINES.length);
  assert.equal(airlineVars(null)['--efb-accent'], '#22d3ee', 'the house default is the Stratos cyan');
});

test('the SimBrief plan carries the airline, the codesign and the point types', async () => {
  const { plannedRouteFromOfp, fixKind } = await import('../app/js/efb/common.js');
  const ofp = {
    origin: { icao: 'CYUL' },
    destination: { icao: 'LFPG' },
    flight: { callsign: 'ACA880', airline: 'ACA', flightNumber: '880' },
    fixes: [
      { ident: 'CYUL', lat: 45.47, lon: -73.74, altFt: 0, type: 'apt' },
      { ident: 'FAWNS', lat: 45.1, lon: -72.2, altFt: 24000, type: 'wpt' },
      { ident: 'YQB', lat: 46.79, lon: -71.4, altFt: 33000, type: 'vor' },
      { ident: 'LFPG', lat: 49.01, lon: 2.55, altFt: 0, type: 'apt' },
    ],
  };
  const route = plannedRouteFromOfp(ofp);
  assert.deepEqual(route.map(point => point.kind), ['apt', 'fix', 'nav', 'apt']);
  assert.equal(route[1].altFt, 24000, 'the planned level comes through');
  assert.equal(fixKind({ ident: 'CYUL', type: '' }, ofp), 'apt', 'an untagged endpoint is still the airport');
  assert.equal(fixKind({ ident: 'ABCD', type: '' }, ofp), 'fix', 'an untagged enroute point is not promoted');
});

test('the Notepad types and draws, and keeps neither secret nor synced', async () => {
  const fs = await import('node:fs');
  const root = new URL('../', import.meta.url);
  // Line endings normalised: a checkout on Windows may hand us CRLF where the
  // repository holds LF, and these tests match the source line by line.
  const shell = fs.readFileSync(new URL('app/js/efb.js', root), 'utf8').replace(/\r\n/g, '\n');
  const module = fs.readFileSync(new URL('app/js/efb/notepad.js', root), 'utf8');

  assert.match(shell, /id: 'notepad'/, 'the notepad is an app on the deck');
  assert.match(shell, /module: '\.\/efb\/notepad\.js'/, 'with its own module');
  const css = fs.readFileSync(new URL('app/efb.css', root), 'utf8');
  assert.doesNotMatch(shell, /TILE_TINT/, 'the deck has one tile tone, not a tint per app');
  assert.match(css, /\.hi-tile \{[^}]*background: #0e141c/, 'every tile is the same solid dark colour');
  assert.doesNotMatch(css, /var\(--tile-a/, 'and no per-app gradient survives');
  assert.match(shell, /notepad: '<path/, 'and its own icon');
  assert.ok(fs.existsSync(new URL('app/js/efb/notepad.js', root)));

  assert.match(module, /localStorage\.getItem\(key\)/, 'notes are read from this device');
  assert.match(module, /stratos\.efb\.notepad\.text/, 'the typed note has its own key');
  assert.match(module, /stratos\.efb\.notepad\.strokes/, 'and the drawing its own');
  assert.match(module, /addEventListener\('pointerdown'/, 'drawing starts with a pointer, pen or finger');
  assert.match(module, /canvas\.setPointerCapture\(event\.pointerId\)/, 'a stroke keeps tracking outside the canvas');
  assert.match(module, /point\[0\] \* w/, 'strokes are stored in normalised coordinates');
  assert.match(module, /destination-out/, 'the eraser rubs out rather than painting black');
  assert.match(module, /data-undo/, 'undo is offered');
  assert.match(module, /window\.confirm\(\'Clear the drawing on this device\?'\)/, 'clearing a drawing asks first');
  assert.match(module, /Nothing on this pad is uploaded, synced or shared/, 'the page says where the note lives');
  assert.doesNotMatch(module, /fetch\(|bridgeHealth|syncLogbook/, 'the pad never leaves the device');
});

test('the deck widget reports the real flight and only shows numbers it has', async () => {
  const fs = await import('node:fs');
  const root = new URL('../', import.meta.url);
  // Line endings normalised: a checkout on Windows may hand us CRLF where the
  // repository holds LF, and these tests match the source line by line.
  const shell = fs.readFileSync(new URL('app/js/efb.js', root), 'utf8').replace(/\r\n/g, '\n');
  const page = fs.readFileSync(new URL('app/efb.html', root), 'utf8');

  assert.match(page, /id="home-widget"/, 'the widget is on the deck');
  assert.match(page, /id="hw-route"/, 'with a route line');
  assert.match(page, /id="hw-tele"/, 'and a telemetry area');

  // Telemetry is read from the bridge snapshot, never from stored state.
  assert.match(shell, /status\.status === 'live' \? status\.snapshot : null/, 'numbers come from a live snapshot only');
  assert.match(shell, /fmtFl\(t\.alt\)/, 'altitude is the reported altitude');
  assert.match(shell, /fmtKt\(t\.gs\)/, 'ground speed is the reported ground speed');
  assert.match(shell, /The simulator is offline/, 'offline says so instead of leaving a position on screen');
});

test('the airline dresses the whole bag, with a preview and a manual override', async () => {
  const fs = await import('node:fs');
  const root = new URL('../', import.meta.url);
  // Line endings normalised: a checkout on Windows may hand us CRLF where the
  // repository holds LF, and these tests match the source line by line.
  const shell = fs.readFileSync(new URL('app/js/efb.js', root), 'utf8').replace(/\r\n/g, '\n');
  const settings = fs.readFileSync(new URL('app/js/efb/settings.js', root), 'utf8');
  const page = fs.readFileSync(new URL('app/efb.html', root), 'utf8');
  const css = fs.readFileSync(new URL('app/efb.css', root), 'utf8');

  // The shell resolves the airline once and writes the tokens every section reads.
  assert.match(shell, /function applyAirlineState\(\)/, 'one place resolves the airline');
  assert.match(shell, /resolveAirline\(state\.prefs, state\.plan, state\.liveCallsign\)/, 'from preference, plan and live callsign');
  assert.match(shell, /applyAirline\(resolved\.airline\)/, 'which writes the accent tokens');
  assert.match(shell, /applyAirlineState\(\);\n\}/, 'applying preferences reapplies the airline');
  assert.match(shell, /applyAirlineState\(\);\n  \}\);/, 'a new plan or callsign re-resolves it');
  assert.ok(/id="et-airline"/.test(page), 'the header carries the airline mark');
  assert.ok(/id="home-airline"/.test(page), 'and the deck carries the wordmark');
  assert.ok(/id="home-brand"/.test(page), 'with the operator mark laid under the deck');
  assert.match(shell, /function renderBrandMark\(air\)/, 'drawn from the resolved airline');
  assert.match(shell, /airlineText\(air\)/, 'and a typographic identifier where no mark is bundled');
  assert.match(css, /\.home-brand\.is-on \{ opacity: 1; \}/, 'only shown once an airline is resolved');
  assert.match(css, /\.hb-roundel \{[^}]*opacity: \.36/, 'the fallback roundel is faded behind the app labels');
  assert.match(css, /body\[data-airline\]:not\(\[data-airline=""\]\) \.home-wall::after/, 'the wallpaper picks up the airline glow');
  assert.match(css, /\.et-airline b \{[^}]*background: var\(--efb-accent\)/, 'the header pill is drawn in the accent');

  // The real operator mark: a bundled, licensed file rendered as a one-tone mask.
  assert.match(shell, /air\.logo\s*\?\s*`<span class="hb-mark hb-logo"/, 'a bundled mark is preferred over the roundel');
  assert.match(shell, /--brand-logo:url\('/, 'and is passed to the stylesheet as a mask');
  assert.match(css, /\.hb-logo \{[^}]*mask: var\(--brand-logo\) center \/ contain no-repeat/, 'so one tone runs across every airline');
  const { AIRLINES: profiles } = await import('../app/js/lib/airlines.js');
  for (const airline of profiles.filter(entry => entry.logo)) {
    assert.ok(fs.existsSync(new URL(`app/${airline.logo}`, root)), `${airline.icao} has the mark it names`);
    assert.ok(airline.logo.endsWith(`/${airline.icao}.svg`), `${airline.icao} names its own file`);
  }
  assert.ok(fs.existsSync(new URL('app/images/airlines/ATTRIBUTION.md', root)), 'every bundled mark has its source recorded');
  assert.equal(profiles.find(entry => entry.icao === 'UAL').logo, null, 'an unlicensed mark is not bundled or imitated');

  // Settings: search, preview before applying, automatic or manual, and a reset.
  assert.match(settings, /function airlineCard\(\)/, 'the airline card is part of the settings page');
  assert.match(settings, /searchAirlines\(airlineQuery\)/, 'the selector searches the table');
  assert.match(settings, /class="air-preview"/, 'a preview is shown before applying');
  assert.match(settings, /data-air-apply/, 'applying is an explicit action');
  assert.match(settings, /data-air-mode="auto"/, 'automatic detection is offered');
  assert.match(settings, /data-air-mode="manual"/, 'a manual override is offered');
  assert.match(settings, /data-air-reset/, 'and the house appearance can be restored');
  assert.match(settings, /ctx\.setPrefs\(\{ airlineMode: 'manual', airline: pick \}\)/, 'manual writes both mode and airline');
  assert.match(settings, /No SimBrief plan is stored/, 'a missing plan is explained, not guessed around');
});

test('EFB performance leads the pilot through what it needs, and never guesses the rest', () => {
  const src = fs.readFileSync(new URL('../app/js/efb/performance.js', import.meta.url), 'utf8');
  const lib = fs.readFileSync(new URL('../app/js/lib/aircraftperformance.js', import.meta.url), 'utf8');

  // One tap fills from the plan, the airport database and the observation.
  assert.match(src, /async function fillFromSources\(/);
  assert.match(src, /write\('airport', phaseAirportCode\(\), 'flight plan'\)/);
  assert.match(src, /write\('elevationFt', Number\(airport\.elev\), 'airport'\)/);
  assert.match(src, /write\('windKt', metar\.wind\.speedKt, 'METAR'\)/);
  // The takeoff analysis belongs to the departure, the landing one to the arrival.
  assert.match(src, /state\.phase === 'landing' \? ofp\.destination : ofp\.origin/);
  // Takeoff weight for takeoff, planned landing weight for landing.
  assert.match(src, /state\.phase === 'landing' \? weights\.lw : weights\.tow/);
  // A value the pilot typed is never overwritten; only a METAR value is refreshed.
  assert.match(src, /if \(!empty\(key\) && !replaceable\(key\)\) return false;/);
  // The list of what is missing is shown before the numbers, not after.
  assert.match(src, /function readinessRows\(\)/);
  assert.match(src, /Still needed: /);
  // A runway suggested from the wind is labelled a suggestion, never a report.
  assert.match(src, /Suggested from the wind — this is not a report of which runway is in use\./);
  assert.match(lib, /export function windComponents/);
  assert.match(lib, /export function lookupPerformance/);
  assert.match(src, /No validated performance dataset is loaded/);
});
