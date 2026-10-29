import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const raw = JSON.parse(fs.readFileSync(new URL('app/js/data/performance-profiles.json', root), 'utf8'));
const {
  loadDatabase, parseDatabase, profileById, profileByIcao,
} = await import('../app/js/lib/performance-db.js');
const { matchAircraft } = await import('../app/js/lib/aircraft-match.js');
const {
  analyseConditions, convertDistance, convertWeight, evaluatePhase, interpolateTable,
  pressureAltitudeFt, windComponents,
} = await import('../app/js/lib/aircraftperformance.js');

const database = parseDatabase(raw);
const a321 = profileById(database, 'a321-200');
const a346 = profileById(database, 'a340-600');
const b77w = profileById(database, 'b777-300er');

const conditions = {
  weight: 70000,
  elevationFt: 392,
  qnhHpa: 1013,
  oatC: 8,
  windFromDeg: 260,
  windKt: 10,
  gustKt: '',
  runwayHeadingDeg: 270,
  runwayLengthFt: 11000,
  units: { weight: 'kg', distance: 'ft' },
};

function byId(evaluation, id) {
  return evaluation.results.find(item => item.id === id);
}

test('the bundled database is versioned, sourced and valid', () => {
  const loaded = loadDatabase();
  assert.equal(loadDatabase(), loaded, 'the JSON module is validated once and reused');
  assert.equal(loaded.version, database.version);
  assert.deepEqual(loaded.profiles.map(profile => profile.id), database.profiles.map(profile => profile.id));
  assert.equal(database.schema, 'stratos.performance-db/1');
  assert.match(database.version, /2026/);
  assert.match(database.released, /^2026-/);
  assert.match(database.source.name, /FAA Aircraft Characteristics Database/);
  assert.match(database.source.license, /public domain/i);
  assert.deepEqual(database.units, {
    weight: 'kg', distance: 'ft', speed: 'kt', altitude: 'ft', temperature: 'C', pressure: 'hPa',
  });

  assert.ok(database.profiles.length >= 6, 'the ToLiss and FlightFactor families are covered');
  for (const profile of database.profiles) {
    assert.ok(profile.source.record, `${profile.id} names the ACD record`);
    assert.ok(profile.source.retrieved, `${profile.id} names when it was read`);
    assert.equal(profile.verification, 'verified');
    assert.equal(profile.units.weight, 'kg');
    assert.ok(profile.operatingRange.weightKg[1] >= profile.limits.mtowKg);
    assert.ok(profile.limits.mtowKg >= profile.limits.mlwKg);
    assert.equal(profile.takeoff.status, 'unsupported', 'no field-length table is invented');
    assert.equal(profile.landing.status, 'unsupported');
    assert.equal(profile.corrections.status, 'unsupported');
    assert.deepEqual(profile.corrections.axes, ['wind', 'slope', 'surface', 'flaps', 'thrust', 'antiIce', 'braking', 'autobrake']);
    assert.match(profile.corrections.reason, /contains no takeoff or landing corrections/);
    assert.ok(profile.takeoff.reason.length > 20);
    assert.ok(profile.landing.vrefKt > 80);
  }

  assert.equal(a321.limits.mtowKg, 91000);
  assert.equal(a321.limits.mlwKg, 77800);
  assert.equal(a321.landing.vrefKt, 142);
  assert.equal(a346.limits.mtowKg, 380000);
  assert.equal(b77w.limits.mtowKg, 351534);
});

test('the database validator refuses a broken profile instead of repairing it', () => {
  assert.throws(() => parseDatabase({ ...raw, schema: 'wrong' }), /schema must be/);

  const duplicate = structuredClone(raw);
  duplicate.profiles[1].id = duplicate.profiles[0].id;
  assert.throws(() => parseDatabase(duplicate), /Duplicate profile id/);

  const badLimits = structuredClone(raw);
  badLimits.profiles[0].limits.mlwKg = badLimits.profiles[0].limits.mtowKg + 1;
  assert.throws(() => parseDatabase(badLimits), /mlwKg cannot exceed mtowKg/);

  const noReason = structuredClone(raw);
  noReason.profiles[0].takeoff.reason = '';
  assert.throws(() => parseDatabase(noReason), /unsupported but gives no reason/);

  const noTable = structuredClone(raw);
  noTable.profiles[0].takeoff.status = 'supported';
  assert.throws(() => parseDatabase(noTable), /supported but has no table/);

  const noReasonForCorrections = structuredClone(raw);
  noReasonForCorrections.profiles[0].corrections.reason = '';
  assert.throws(() => parseDatabase(noReasonForCorrections), /corrections must give a reason/);

  const claimedCorrections = structuredClone(raw);
  claimedCorrections.profiles[0].corrections.status = 'supported';
  assert.throws(() => parseDatabase(claimedCorrections), /no correction model is bundled/);
});

test('the matcher resolves the airframe X-Plane reports, not a neighbouring type', () => {
  const toLiss = matchAircraft(database, { icaoType: 'A321', description: 'ToLiss A321' });
  assert.equal(toLiss.profile.id, 'a321-200');
  assert.equal(toLiss.confidence, 'exact');

  const neo = matchAircraft(database, { icaoType: 'A21N', description: 'ToLiss A321neo' });
  assert.equal(neo.profile.id, 'a321neo');

  const airbus340 = matchAircraft(database, { icaoType: 'A346', description: 'Airbus A340-600' });
  assert.equal(airbus340.profile.id, 'a340-600');

  const ff777 = matchAircraft(database, { icaoType: 'B77W', description: 'FlightFactor 777-300ER' });
  assert.equal(ff777.profile.id, 'b777-300er');

  const fromText = matchAircraft(database, { icaoType: '', description: 'ToLiss A321' });
  assert.equal(fromText.profile.id, 'a321-200');
  assert.equal(fromText.confidence, 'text');

  const fromNeoText = matchAircraft(database, { icaoType: '', description: 'ToLiss A321neo' });
  assert.equal(fromNeoText.profile.id, 'a321neo', 'the longer, more specific token wins');

  const fromFile = matchAircraft(database, { filename: 'FlightFactor_777-200LR.acf' });
  assert.equal(fromFile.profile.id, 'b777-200lr');

  const manual = matchAircraft(database, { profileId: 'a340-600' });
  assert.equal(manual.profile.id, 'a340-600');
  assert.equal(manual.confidence, 'manual');

  const unknown = matchAircraft(database, { icaoType: 'A20N', description: 'Airbus A320neo' });
  assert.equal(unknown.profile, null);
  assert.match(unknown.reason, /No bundled performance profile matches type A20N/);
});

test('units convert at the boundary and never pass a blank through as zero', () => {
  assert.ok(Math.abs(convertWeight(1000, 'kg', 'lb') - 2204.6226) < 0.001);
  assert.ok(Math.abs(convertWeight(2204.6226, 'lb', 'kg') - 1000) < 0.001);
  assert.ok(Math.abs(convertDistance(1000, 'ft', 'm') - 304.8) < 0.001);
  assert.ok(Math.abs(convertDistance(304.8, 'm', 'ft') - 1000) < 0.001);
  assert.equal(convertWeight('', 'kg', 'kg'), null);
  assert.equal(convertDistance(' ', 'm', 'ft'), null);
  assert.equal(convertWeight(100, 'stone', 'kg'), null);

  const blank = analyseConditions({ elevationFt: 0, qnhHpa: 1013.25, oatC: '' });
  assert.equal(blank.pressureAltitudeFt, 0);
  assert.equal(blank.densityAltitudeFt, null, 'a blank OAT is not 0 °C');
  assert.equal(blank.isaDeviationC, null);
  assert.equal(pressureAltitudeFt('', 1013), null);
});

test('takeoff returns verified limits and plainly unavailable field data for a supported profile', () => {
  const evaluation = evaluatePhase(a321, 'takeoff', conditions);
  const mtow = byId(evaluation, 'mtow');
  assert.equal(mtow.value, 91000);
  assert.equal(mtow.status, 'verified');
  assert.match(mtow.source, /FAA Aircraft Characteristics Database/);
  assert.equal(byId(evaluation, 'margin').value, 21000);
  assert.equal(byId(evaluation, 'margin').status, 'verified');

  for (const id of ['groundRollFt', 'distanceFt', 'requiredRunwayFt', 'v1Kt', 'vrKt', 'v2Kt']) {
    const item = byId(evaluation, id);
    assert.equal(item.value, null, `${id} is never invented`);
    assert.equal(item.status, 'unavailable');
    assert.ok(item.note.length > 20, `${id} explains why`);
  }
  assert.equal(evaluation.supported, false);
  assert.equal(evaluation.conditions.pressureAltitudeFt, 399);
  assert.equal(evaluation.conditions.densityAltitudeFt, -339);
  assert.equal(evaluation.conditions.wind.headwindKt, 9.8);
  assert.equal(evaluation.conditions.wind.crosswindKt, 1.7);
});

test('landing returns MLW and VREF but never the departure values or a guessed distance', () => {
  const evaluation = evaluatePhase(a321, 'landing', { ...conditions, weight: 62000 });
  assert.equal(byId(evaluation, 'mlw').value, 77800);
  assert.equal(byId(evaluation, 'mlw').status, 'verified');
  assert.equal(byId(evaluation, 'vref').value, 142);
  assert.equal(byId(evaluation, 'vref').status, 'verified');
  assert.equal(byId(evaluation, 'margin').value, 15800);
  for (const id of ['distanceFt', 'requiredRunwayFt']) {
    assert.equal(byId(evaluation, id).value, null);
    assert.equal(byId(evaluation, id).status, 'unavailable');
  }
});

test('an overweight input warns and a missing weight never becomes zero', () => {
  const heavy = evaluatePhase(a321, 'takeoff', { ...conditions, weight: 95000 });
  assert.ok(heavy.warnings.some(warning => /above the published MTOW/.test(warning)));
  assert.equal(byId(heavy, 'margin').value, -4000);

  const missing = evaluatePhase(a321, 'takeoff', { ...conditions, weight: '' });
  assert.equal(byId(missing, 'margin').value, null);
  assert.equal(byId(missing, 'margin').status, 'unavailable');
  assert.equal(missing.inputs.weightKg, null);

  const pounds = evaluatePhase(a321, 'takeoff', {
    ...conditions, weight: 209439, units: { weight: 'lb', distance: 'ft' },
  });
  assert.ok(pounds.warnings.some(warning => /lb above the published MTOW/.test(warning)), 'the warning follows the unit the pilot entered');
});

test('a licensed table is interpolated inside its axes and refused outside them', () => {
  const table = {
    axes: {
      weightKg: [60000, 80000],
      pressureAltitudeFt: [0, 8000],
      oatC: [0, 20],
    },
    distanceFt: [
      [[1800, 2200], [2600, 3200]],
      [[2600, 3100], [3800, 4500]],
    ],
    requiredRunwayFt: [
      [[2100, 2500], [2900, 3500]],
      [[2900, 3400], [4100, 4800]],
    ],
    v1Kt: [
      [[130, 132], [140, 143]],
      [[144, 147], [156, 160]],
    ],
  };
  const licensed = {
    ...structuredClone(a321),
    takeoff: { status: 'supported', table },
    source: { ...a321.source, record: 'test record' },
  };

  assert.equal(interpolateTable(table.distanceFt, table.axes, { weightKg: 70000, pressureAltitudeFt: 0, oatC: 10 }), 2425);
  const evaluation = evaluatePhase(licensed, 'takeoff', { ...conditions, elevationFt: 0, qnhHpa: 1013.25, oatC: 10 });
  assert.equal(byId(evaluation, 'distanceFt').value, 2425);
  assert.equal(byId(evaluation, 'distanceFt').status, 'interpolated');
  assert.equal(byId(evaluation, 'v1Kt').value, 138);
  assert.equal(byId(evaluation, 'requiredRunwayFt').value, 2725);
  assert.equal(byId(evaluation, 'runwayMargin').value, 8275);
  assert.equal(evaluation.supported, true);

  const outside = evaluatePhase(licensed, 'takeoff', { ...conditions, elevationFt: 0, qnhHpa: 1013, oatC: 35 });
  assert.equal(byId(outside, 'distanceFt').value, null);
  assert.match(byId(outside, 'distanceFt').note, /outside the published table/);

  const missingCorner = {
    ...table,
    distanceFt: [[[1800, null], [2600, 3200]], [[2600, 3100], [3800, 4500]]],
  };
  assert.equal(interpolateTable(missingCorner.distanceFt, missingCorner.axes, { weightKg: 60000, pressureAltitudeFt: 0, oatC: 10 }), null);
});

test('runway choices keep parallel strips distinct and never guess a suffix', async () => {
  const { runwayEnds, matchRunwayEnd } = await import('../app/js/efb/performance.js');

  const named = runwayEnds([{ id: '16L/34R', heading: 160, lengthFt: 11901 }]);
  assert.deepEqual(named.map(row => row.id), ['16L', '34R'], 'both ends are offered');
  assert.equal(named[0].heading, 160);
  assert.equal(named[1].heading, 340);
  assert.equal(matchRunwayEnd(named, '16L').row.id, '16L', 'a published suffix is matched exactly');

  const numeric = runwayEnds([
    { id: '16/34', heading: 160, lengthFt: 11901 },
    { id: '16/34', heading: 160, lengthFt: 9426 },
  ]);
  assert.equal(numeric.filter(row => row.id === '16').length, 2, 'two physical runways stay two choices');
  assert.equal(matchRunwayEnd(numeric, '16L').row, null, 'a suffix is never assigned to one of them');
  assert.match(matchRunwayEnd(numeric, '16L').message, /parallel runways numbered 16/);
  assert.equal(matchRunwayEnd(numeric, '16').row, null, 'the bare number is ambiguous too');

  const single = runwayEnds([{ id: '10/28', heading: 100, lengthFt: 6000 }]);
  assert.equal(matchRunwayEnd(single, '10').row.id, '10');
  assert.equal(matchRunwayEnd(single, '10L').row, null, 'a suffix the source does not publish is not invented');
  assert.match(matchRunwayEnd(single, '10L').message, /without a parallel suffix/);
  assert.match(matchRunwayEnd(single, '09').message, /not in the airport record/);
});

test('the page has no import path and always binds landing to the destination', () => {
  const page = fs.readFileSync(new URL('app/js/efb/performance.js', root), 'utf8');
  const css = fs.readFileSync(new URL('app/efb.css', root), 'utf8');

  assert.doesNotMatch(page, /perf-file|data-import|templateDataset|performanceDataset|localStorage/);
  assert.match(page, /data-calculate/);
  assert.match(page, /function phaseLeg\(\)/);
  assert.match(page, /state\.phase === 'landing' \? ofp\.destination : ofp\.origin/);
  assert.match(page, /state\.phase === 'landing' \? ofp\.weights\.lw : ofp\.weights\.tow/);
  assert.match(page, /matchAircraft\(state\.database/);
  assert.match(page, /evaluatePhase\(current, state\.phase/);
  // A route built in the Flight Planner supplies the airports and runways when
  // no SimBrief plan is stored, with the arrival's runway for landing.
  assert.match(page, /const builtPlan = loadRouteMeta\(\)\.plan/);
  assert.match(page, /builtPlan\.arrivalRwy : builtPlan\.departureRwy/);
  assert.match(page, /state\.airport === phaseAirport\(\) \? phaseRunway\(\)/, 'a changed airport drops the old runway');
  // Controls that do not change a result are not offered, and the axes the
  // mission names are declared unsupported rather than silently ignored.
  assert.doesNotMatch(page, /perf-surface|perf-slopePct|perf-flap|perf-thrust/);
  assert.match(page, /function correctionNotice\(\)/);
  assert.match(page, /No performance correction is applied for/);
  assert.match(page, /The Stratos bridge is offline, so no airframe can be detected/);
  assert.match(page, /STATUS_TEXT = \{ verified: 'Verified', interpolated: 'Interpolated', estimated: 'Estimated', unavailable: 'Unavailable' \}/);
  assert.match(css, /\.perf-layout \{/);
  assert.match(css, /@media \(max-width: 1180px\) \{\s*\.perf-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});
