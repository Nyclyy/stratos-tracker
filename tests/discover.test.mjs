import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_AIRPORTS } from '../app/js/data/airports.js';
import { CATEGORIES, DURATIONS } from '../app/js/discover/catalog.js';
import { discoverRoutes, estimateHours, toWaypoints, ISLAND_AIRPORTS } from '../app/js/discover/engine.js';
import { regionsAlongPath } from '../app/js/discover/regions.js';
import { distanceNm } from '../app/js/lib/geo.js';

const band = id => DURATIONS.find(entry => entry.id === id);

test('every category returns three distinct, plausible recommendations', () => {
  for (const category of CATEGORIES) {
    const result = discoverRoutes(BUNDLED_AIRPORTS, {
      category: category.id, duration: 'medium', aircraft: 'turboprop', seed: 42,
    });
    assert.equal(result.recommendations.length, 3, `${category.id} returns three routes`);
    assert.equal(new Set(result.recommendations.map(r => r.id)).size, 3, `${category.id} recommendations are distinct`);

    const seen = new Set();
    for (const reco of result.recommendations) {
      assert.ok(reco.stops.length >= 2, `${category.id} has at least two airports`);
      for (const stop of reco.stops) {
        assert.ok(!seen.has(stop.id + reco.id), 'an airport is not repeated inside one route');
        assert.ok(Number.isFinite(stop.lat) && Number.isFinite(stop.lon), `${stop.id} has real coordinates`);
        const known = BUNDLED_AIRPORTS.find(a => a.id === stop.id);
        assert.ok(known, `${stop.id} exists in the airport database`);
        assert.equal(stop.lat, known.lat, `${stop.id} uses the database latitude`);
      }
      // Distance is the sum of real great-circle legs.
      const sum = reco.legs.reduce((total, leg) => total + distanceNm(leg.from, leg.to), 0);
      assert.ok(Math.abs(sum - reco.nm) < 1e-6, 'distance is computed from real coordinates');
      assert.ok(reco.nm > 0);
      assert.ok(reco.name.length > 0 && reco.explanation.length > 40, 'a card has a name and an explanation');
      assert.deepEqual(toWaypoints(reco).map(p => p.kind), reco.stops.map(() => 'apt'));
      // Never claim live weather.
      assert.ok(reco.weather === null || reco.weather === 'simulated');
    }
    // No airport is shared between the three cards.
    const ids = result.recommendations.flatMap(r => r.stops.map(s => s.id));
    assert.equal(new Set(ids).size, ids.length, `${category.id} cards do not repeat airports`);
  }
});

test('every category and duration produces three cards with honest windows', () => {
  for (const category of CATEGORIES) {
    for (const duration of DURATIONS) {
      const result = discoverRoutes(BUNDLED_AIRPORTS, { category: category.id, duration: duration.id, aircraft: 'any', seed: 7 });
      assert.equal(result.recommendations.length, 3, `${category.id}/${duration.id} returns three cards`);
      const bandEntry = band(duration.id);
      for (const reco of result.recommendations) {
        const inside = reco.hours >= bandEntry.min && reco.hours <= bandEntry.max;
        assert.equal(reco.withinWindow, inside, `${category.id}/${duration.id} describes its own duration honestly`);
        if (!inside) assert.match(result.limitations.join(' '), /outside/i, 'stretched cards are declared');
      }
      if (category.id === 'islands') {
        for (const reco of result.recommendations) {
          for (const stop of reco.stops) assert.ok(ISLAND_AIRPORTS.has(stop.id), `${stop.id} is a known island field`);
          for (const leg of reco.legs) assert.ok(leg.nm <= 520, 'island legs stay short');
        }
      }
      if (category.id === 'longhaul') {
        for (const reco of result.recommendations) assert.ok(reco.nm >= 500, `${reco.nm} nm is a long sector`);
      }
    }
  }
});

test('duration bands drive the estimate for the chosen aircraft', () => {
  for (const duration of DURATIONS) {
    const result = discoverRoutes(BUNDLED_AIRPORTS, { category: 'scenic', duration: duration.id, aircraft: 'narrowbody', seed: 7 });
    assert.ok(result.recommendations.length >= 1, `${duration.id} has routes`);
    for (const reco of result.recommendations) {
      const expected = estimateHours(reco.nm, 450, Math.max(0, reco.stops.length - 2));
      assert.ok(Math.abs(expected - reco.hours) < 1e-6);
      const slack = 0.35; // estimation, not a promise
      assert.ok(reco.hours >= duration.min - slack && reco.hours <= duration.max + slack,
        `${duration.id} keeps ${reco.hours.toFixed(2)} h near the band`);
    }
  }
});

test('aircraft selection changes the reachable distance', () => {
  const slow = discoverRoutes(BUNDLED_AIRPORTS, { category: 'short', duration: 'medium', aircraft: 'ga', seed: 5 });
  const fast = discoverRoutes(BUNDLED_AIRPORTS, { category: 'short', duration: 'medium', aircraft: 'widebody', seed: 5 });
  const avg = list => list.reduce((sum, r) => sum + r.nm, 0) / Math.max(1, list.length);
  assert.ok(avg(fast.recommendations) > avg(slow.recommendations), 'faster aircraft fly further in the same window');
});

test('a new seed produces different alternatives but a fixed seed is repeatable', () => {
  const a = discoverRoutes(BUNDLED_AIRPORTS, { category: 'scenic', duration: 'medium', aircraft: 'any', seed: 11 });
  const b = discoverRoutes(BUNDLED_AIRPORTS, { category: 'scenic', duration: 'medium', aircraft: 'any', seed: 11 });
  const c = discoverRoutes(BUNDLED_AIRPORTS, { category: 'scenic', duration: 'medium', aircraft: 'any', seed: 99 });
  assert.deepEqual(a.recommendations.map(r => r.id), b.recommendations.map(r => r.id), 'same seed, same answer');
  assert.notDeepEqual(a.recommendations.map(r => r.id), c.recommendations.map(r => r.id), 'another seed, another answer');
});

test('random adventure resolves to a real category and varies', () => {
  const ids = new Set();
  for (let seed = 1; seed <= 6; seed++) {
    const result = discoverRoutes(BUNDLED_AIRPORTS, { category: 'random', duration: 'long', aircraft: 'any', seed });
    assert.ok(result.resolvedCategory !== 'random');
    assert.ok(CATEGORIES.some(c => c.id === result.resolvedCategory));
    assert.equal(result.recommendations.length, 3);
    result.recommendations.forEach(r => ids.add(r.id));
  }
  assert.ok(ids.size >= 9, 'repeated random adventures are not identical');
});

test('a requested departure airport is honoured when the data allows it', () => {
  const result = discoverRoutes(BUNDLED_AIRPORTS, {
    category: 'scenic', duration: 'medium', aircraft: 'turboprop', departure: 'EGLL', seed: 3,
  });
  assert.ok(result.recommendations.length >= 1);
  for (const reco of result.recommendations) assert.equal(reco.stops[0].id, 'EGLL');
});

test('categories only make claims the data supports', () => {
  const mountains = discoverRoutes(BUNDLED_AIRPORTS, { category: 'mountain', duration: 'medium', aircraft: 'turboprop', seed: 8 });
  for (const reco of mountains.recommendations) {
    const elevated = reco.stops.some(stop => Number(stop.elev) >= 1500);
    const crossesMountains = reco.regions.some(region => ['alps', 'rockies', 'andes', 'himalaya', 'scandinavia', 'newzealand', 'patagonia', 'iceland'].includes(region.id));
    assert.ok(elevated || crossesMountains, 'mountain routes are actually mountainous');
  }

  const storm = discoverRoutes(BUNDLED_AIRPORTS, { category: 'storm', duration: 'medium', aircraft: 'turboprop', seed: 8 });
  for (const reco of storm.recommendations) {
    assert.equal(reco.weather, 'simulated', 'storm chasing never claims live weather');
    assert.match(reco.explanation, /simulated/i);
  }

  // The bundled snapshot has no field shorter than 5,000 ft, so Bush Flying
  // cannot be served honestly from it. Cards must carry runway data when the
  // category is honoured; otherwise the result has to say so and stop calling
  // ordinary airliners bush strips.
  const bush = discoverRoutes(BUNDLED_AIRPORTS, { category: 'bush', duration: 'short', aircraft: 'ga', seed: 4 });
  for (const reco of bush.recommendations) {
    if (reco.flavourCategory === 'bush') {
      const dest = reco.stops[reco.stops.length - 1];
      assert.ok(Array.isArray(dest.len) && dest.len.length && Math.min(...dest.len) <= 5000,
        'bush destinations carry real short-runway data');
    } else {
      assert.match(bush.limitations.join(' '), /bush/i, 'an unservable bush request explains itself');
    }
  }
});

test('region claims follow the great circle, including across the antimeridian', () => {
  const auckland = { lat: -37.008, lon: 174.792 };
  const oakland = { lat: 37.721, lon: -122.221 };
  const ids = regionsAlongPath(auckland, oakland).map(region => region.id);
  assert.ok(!ids.includes('australia'), 'a Pacific crossing is not claimed as an Australian crossing');
  assert.ok(!ids.includes('newzealand'), 'the route leaves New Zealand behind instead of flying back over it');

  const zurich = { lat: 47.458, lon: 8.548 };
  const milan = { lat: 45.63, lon: 8.723 };
  assert.ok(regionsAlongPath(zurich, milan).some(region => region.id === 'alps'), 'a real Alpine crossing is still claimed');
});

test('an unusable database explains itself instead of inventing routes', () => {
  const result = discoverRoutes([], { category: 'scenic', duration: 'medium', aircraft: 'any', seed: 1 });
  assert.equal(result.recommendations.length, 0);
  assert.match(result.limitations[0], /bridge/i);
});

test('easier and harder refinements actually change the difficulty offered', () => {
  const easier = discoverRoutes(BUNDLED_AIRPORTS, { category: 'challenging', duration: 'long', aircraft: 'turboprop', difficulty: 'easier', seed: 21 });
  const harder = discoverRoutes(BUNDLED_AIRPORTS, { category: 'challenging', duration: 'long', aircraft: 'turboprop', difficulty: 'harder', seed: 21 });
  const score = list => list.reduce((sum, r) => sum + ({ easy: 0, moderate: 1, demanding: 2 }[r.difficulty] ?? 0), 0);
  assert.ok(score(harder.recommendations) >= score(easier.recommendations), 'harder asks for harder routes');
});

test('a region constraint keeps routes in that region', () => {
  const result = discoverRoutes(BUNDLED_AIRPORTS, { category: 'scenic', duration: 'medium', aircraft: 'turboprop', regionId: 'alps', seed: 12 });
  assert.ok(result.recommendations.length >= 1);
  for (const reco of result.recommendations) {
    const inside = reco.stops.some(stop => stop.lat >= 44 && stop.lat <= 48 && stop.lon >= 5 && stop.lon <= 17);
    assert.ok(inside, 'every card touches the requested region');
  }
});

test('a recommendation becomes a valid saved route for the existing planner', async () => {
  const { createSavedRoute } = await import('../app/js/lib/planner.js');
  const result = discoverRoutes(BUNDLED_AIRPORTS, { category: 'scenic', duration: 'medium', aircraft: 'turboprop', seed: 17 });
  const reco = result.recommendations[0];
  const route = createSavedRoute(reco.name, toWaypoints(reco));
  assert.equal(route.points.length, reco.stops.length);
  assert.ok(route.points.every(point => point.kind === 'apt' && point.id && Number.isFinite(point.lat)));
  assert.equal(route.points[0].id, reco.stops[0].id);
  assert.equal(route.name, reco.name);
});
