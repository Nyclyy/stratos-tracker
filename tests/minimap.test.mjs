import test from 'node:test';
import assert from 'node:assert/strict';

// Browser stubs: MiniMap only needs a 2D context, sizing, a theme and an observer.
const noop = () => {};
const ctx = new Proxy({}, {
  get: (target, prop) => (prop in target ? target[prop]
    : prop === 'measureText' ? () => ({ width: 10 } ) : noop),
  set: (target, prop, value) => { target[prop] = value; return true; },
});
globalThis.document = { documentElement: { dataset: { theme: 'night' } } };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.window = { devicePixelRatio: 1 };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.Image = class { set src(value) { this.value = value; } };

const { MiniMap } = await import('../app/js/minimap.js');

function makeCanvas(width = 400, height = 300) {
  return {
    parentElement: null,
    width: 0,
    height: 0,
    getContext: () => ctx,
    addEventListener: noop,
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
  };
}

function makeHost() {
  return {
    child: null,
    replaceChildren(node) { this.child = node; node.parentElement = this; this.calls = (this.calls || 0) + 1; },
  };
}

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;

test('minimap: a planned route widens the auto-fit when its layer is on', () => {
  const track = [{ lat: 37.6, lon: -122.3 }, { lat: 37.62, lon: -122.28 }];
  const far = [{ lat: 37.6, lon: -122.3, id: 'KSFO' }, { lat: 40.6, lon: -73.8, id: 'KJFK' }];
  const withRoute = new MiniMap(makeCanvas(), { padding: 22 });
  withRoute.setTrack(track);
  withRoute.setRoute(far);
  const withoutRoute = new MiniMap(makeCanvas(), { padding: 22, layers: { route: false } });
  withoutRoute.setTrack(track);
  withoutRoute.setRoute(far);
  assert.ok(withRoute.fit().zoom < withoutRoute.fit().zoom,
    'a continental route must zoom out further than the track alone');
});

test('minimap: hiding the route layer restores the track-only view', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  map.setTrack([{ lat: 37.6, lon: -122.3 }, { lat: 37.62, lon: -122.28 }]);
  const before = map.fit().zoom;
  map.setRoute([{ lat: 37.6, lon: -122.3 }, { lat: 40.6, lon: -73.8 }]);
  assert.ok(map.fit().zoom < before);
  map.setLayers({ route: false });
  assert.equal(map.fit().zoom, before);
});

test('minimap: follow mode centres on the aircraft at a fixed zoom', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  map.setTrack([{ lat: 37.6, lon: -122.3 }, { lat: 37.9, lon: -121.9 }]);
  map.setPosition({ lat: 37.7, lon: -122.1 }, 90);
  map.setFollow(true);
  const view = map.fit();
  assert.equal(view.zoom, 9);
  assert.equal(view.centerX, lonToX(-122.1, 9));
});

test('minimap: zoom steps are whole levels and clamp to the supported range', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  map.setTrack([{ lat: 37.6, lon: -122.3 }, { lat: 37.62, lon: -122.28 }]);
  const start = map.fit().zoom;
  assert.equal(map.zoomBy(1), Math.min(13, start + 1));
  assert.equal(map.zoomBy(-100), 2);
  assert.equal(map.zoomBy(100), 13);
  map.resetZoom();
  assert.equal(map.fit().zoom, start);
});

test('minimap: attach moves the canvas once and keeps the same instance', () => {
  const canvas = makeCanvas();
  const map = new MiniMap(canvas, { padding: 22 });
  const host = makeHost();
  map.attach(host);
  assert.equal(host.child, canvas);
  map.attach(host);
  assert.equal(host.calls, 1, 'attaching to the same container must not re-insert the canvas');
  const next = makeHost();
  map.attach(next);
  assert.equal(next.child, canvas, 'a re-rendered container takes over the existing canvas');
});

test('minimap: route hit testing finds waypoints and legs in screen space', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  const route = [
    { id: 'KSFO', lat: 37.6188, lon: -122.3754 },
    { id: 'KLAX', lat: 33.9425, lon: -118.4081 },
  ];
  map.setRoute(route);
  const view = map.fit();
  const a = map.project(route[0].lat, route[0].lon, view);
  const b = map.project(route[1].lat, route[1].lon, view);

  assert.deepEqual(map.hitTest(a.x + 3, a.y + 2), { kind: 'waypoint', index: 0 });
  assert.deepEqual(map.hitTest(b.x - 2, b.y - 1), { kind: 'waypoint', index: 1 });
  const middle = map.hitTest((a.x + b.x) / 2, (a.y + b.y) / 2);
  assert.equal(middle.kind, 'segment');
  assert.equal(middle.index, 0);
  map.setSelection({ segments: [0, 1], waypointIndex: 1 });
  assert.deepEqual(map.selection.segments, [0, 1]);
  assert.equal(map.hitTest(a.x + 120, a.y + 120), null);
});

test('minimap: selection is kept without rebuilding the route', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  const route = [
    { id: 'KSFO', lat: 37.6188, lon: -122.3754 },
    { id: 'KLAX', lat: 33.9425, lon: -118.4081 },
  ];
  map.setRoute(route);
  const sameRoute = map.route;
  map.setSelection({ segmentIndex: 0, waypointIndex: 1 });
  assert.equal(map.route, sameRoute);
  assert.deepEqual(map.selection, { segments: [0], segmentIndex: 0, waypointIndex: 1 });
  map.setSelection({ segments: [0, 1], waypointIndex: 1 });
  assert.deepEqual(map.selection.segments, [0, 1]);
  map.setSelection({});
  assert.deepEqual(map.selection, { segments: [], segmentIndex: null, waypointIndex: null });
});

test('minimap: a recorded flight is coloured by height above the ground', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  // The first sample is on the taxiway at an airport 5,500 ft above sea level;
  // the last is at cruise. AGL is what makes the ground read as the ground.
  map.setTrack([
    { lat: 37.0, lon: -122.0, alt: 5500, agl: 0 },
    { lat: 37.5, lon: -122.0, alt: 17500, agl: 12000 },
    { lat: 38.0, lon: -122.0, alt: 41500, agl: 36000 },
  ]);
  assert.deepEqual(map.trackHeights(), [0, 12000, 36000]);
});

test('minimap: heights fall back to the lowest recorded altitude, and a preview has none', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  map.setTrack([
    { lat: 37.0, lon: -122.0, alt: 5500 },
    { lat: 37.5, lon: -122.0, alt: 12000 },
    { lat: 38.0, lon: -122.0, alt: 36000 },
  ]);
  assert.deepEqual(map.trackHeights(), [0, 6500, 30500], 'height above the departure elevation');
  map.setTrack([{ lat: 37.0, lon: -122.0 }, { lat: 38.0, lon: -122.0 }]);
  assert.equal(map.trackHeights(), null, 'a planned preview has no altitude, so it keeps the accent line');
});

test('minimap: traffic is filtered, selectable and keeps its own trail', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  map.setTrack([{ lat: 37.6, lon: -122.3 }, { lat: 37.9, lon: -121.9 }]);
  map.setTraffic([
    { key: 'SWR219', lat: 37.7, lon: -122.1, hdg: 90, alt: 12000 },
    { key: 'BAD', lat: 999, lon: 0 },
    null,
  ]);
  assert.equal(map.traffic.length, 1, 'a target without a valid position is never drawn');

  const view = map.fit();
  const p = map.project(37.7, -122.1, view);
  assert.deepEqual(map.hitTest(p.x + 2, p.y + 2), { kind: 'traffic', index: 0 });

  map.selectTraffic('SWR219');
  assert.equal(map.trafficSelected, 'SWR219');
  map.setTrafficTrail([
    { lat: 37.6, lon: -122.2, alt: 0 },
    { lat: 37.65, lon: -122.15, alt: 8000 },
    { lat: 37.7, lon: Number.NaN, alt: 12000 },
  ]);
  assert.equal(map.trafficTrail.length, 2, 'a trail keeps only usable positions');

  // A refresh that no longer sees the aircraft clears the stale selection
  // instead of leaving a trail with no target.
  map.setTraffic([{ key: 'DLH400', lat: 37.8, lon: -122.0 }]);
  assert.equal(map.trafficSelected, '');
  assert.equal(map.trafficTrail.length, 0);
});

test('minimap: an aircraft is picked before the route under it', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  const route = [{ id: 'KSFO', lat: 37.6188, lon: -122.3754 }, { id: 'KLAX', lat: 33.9425, lon: -118.4081 }];
  map.setRoute(route);
  map.setTraffic([{ key: 'N123AB', lat: route[0].lat, lon: route[0].lon, hdg: 0 }]);
  const view = map.fit();
  const p = map.project(route[0].lat, route[0].lon, view);
  assert.deepEqual(map.hitTest(p.x, p.y), { kind: 'traffic', index: 0 });
  map.setLayers({ traffic: false });
  assert.equal(map.hitTest(p.x, p.y).kind, 'waypoint', 'a hidden traffic layer is not clickable');
});

test('minimap: a hidden track layer does not contribute to fit', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  map.setTrack([{ lat: 37.6, lon: -122.3 }, { lat: 45.0, lon: -100.0 }]);
  map.setPosition({ lat: 37.6, lon: -122.3 });
  const withTrack = map.fit().zoom;
  map.setLayers({ track: false });
  assert.ok(map.fit().zoom > withTrack, 'fit falls back to the aircraft position alone');
});
