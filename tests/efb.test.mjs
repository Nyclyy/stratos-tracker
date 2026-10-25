import test from 'node:test';
import assert from 'node:assert/strict';

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

test('EFB live map keeps the flight it drew when the rollout opens a new record', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/js/efb/live.js', import.meta.url), 'utf8');
  assert.match(page, /trailContinues\(drawnTrack\[drawnTrack\.length - 1\], track\[0\]\)/,
    'a record that starts where the drawn path stopped continues it');
  assert.match(page, /drawnTrack = track\.slice\(\);/, 'a flight from somewhere else replaces the path');
  assert.match(page, /if \(drawnTrack\.length > 6000\) drawnTrack\.splice/, 'the joined path stays bounded');
});
