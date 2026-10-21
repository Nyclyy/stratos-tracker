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

test('minimap: a hidden track layer does not contribute to fit', () => {
  const map = new MiniMap(makeCanvas(), { padding: 22 });
  map.setTrack([{ lat: 37.6, lon: -122.3 }, { lat: 45.0, lon: -100.0 }]);
  map.setPosition({ lat: 37.6, lon: -122.3 });
  const withTrack = map.fit().zoom;
  map.setLayers({ track: false });
  assert.ok(map.fit().zoom > withTrack, 'fit falls back to the aircraft position alone');
});
