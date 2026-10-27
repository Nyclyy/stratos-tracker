import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  cameraDirection,
  cameraFor,
  clipToHemisphere,
  globeProject,
  globeProjectClamped,
  globeProjectVector,
  globeRadiusFor,
  globeUnproject,
  nmPerPixelAtCentre,
  orbitBy,
  rasteriseGlobe,
  unitVector,
  vectorMeanCentre,
} from '../app/js/lib/globeview.js';

/* The globe's geometry, shared by the tracker's Flight Deck and the EFB's map.
   Every one of these mistakes is silent on screen: a projection that clamps the
   wrong way paints a symbol on a place the pilot cannot see, a clip that cuts a
   chord slices a bite out of a continent, an orbit that ignores the latitude
   makes a drag near the pole spin at a different speed than at the equator, and
   a raster pass that writes outside its own buffer corrupts whatever is next to
   it in memory. */

const RADIUS = 200;
const CAMERA = cameraFor({ lat: 0, lon: 0 }, RADIUS, 400, 300);

test('the camera target lands in the middle and the limb is 90 degrees away', () => {
  const centre = globeProject(0, 0, CAMERA);
  assert.deepEqual([Math.round(centre.x), Math.round(centre.y)], [400, 300]);
  // Exactly 90 degrees away is the horizon: the point is still drawn, on the rim.
  const east = globeProject(0, 90, CAMERA);
  assert.equal(Math.round(Math.hypot(east.x - 400, east.y - 300)), RADIUS);
  const north = globeProject(90, 0, CAMERA);
  assert.equal(Math.round(Math.hypot(north.x - 400, north.y - 300)), RADIUS);
  assert.equal(globeProject(0, 91, CAMERA), null, 'past the horizon nothing is drawn');
  assert.equal(globeProject(-10, 180, CAMERA), null);
  assert.equal(globeProject(NaN, 20, CAMERA), null, 'a broken coordinate is not a place');
});

test('an orthographic projection foreshortens by the cosine of the angle', () => {
  // 60 degrees from the camera => sin(60) = 0.866 of the radius, on the disc.
  const sixty = globeProject(0, 60, CAMERA);
  assert.ok(Math.abs(Math.hypot(sixty.x - 400, sixty.y - 300) - RADIUS * Math.sin(Math.PI / 3)) < 0.001);
  // And the polar axis tilts the way a sphere does: the north pole above centre.
  const tilted = cameraFor({ lat: 40, lon: 0 }, RADIUS, 400, 300);
  const pole = globeProject(90, 0, tilted);
  assert.ok(pole, 'the pole faces a camera at 40 N');
  assert.ok(pole.y < 300, 'and it sits above the middle of the disc');
});

test('a projected point unprojects back to itself', () => {
  const camera = cameraFor({ lat: 47.45, lon: -122.3 }, RADIUS, 400, 300);
  for (const [lat, lon] of [[47.45, -122.3], [40, -100], [30, -140], [70, -100], [10, -160], [-20, -80]]) {
    const point = globeProject(lat, lon, camera);
    assert.ok(point, `${lat},${lon} faces the camera`);
    const back = globeUnproject(point.x, point.y, camera);
    assert.ok(Math.abs(back.lat - lat) < 1e-9 && Math.abs(back.lon - lon) < 1e-9,
      `${lat},${lon} round-trips (${back.lat},${back.lon})`);
  }
  assert.equal(globeUnproject(400 - RADIUS * 2, 300, camera), null, 'outside the disc is not a place');
});

test('a point on the far side is folded onto the limb, in its own direction', () => {
  // The clamped projection is what a line through a sequence of coordinates
  // needs: it must answer with a position, and that position must be the rim.
  const hidden = globeProjectClamped(0, 120, CAMERA);
  const distance = Math.hypot(hidden.x - 400, hidden.y - 300);
  assert.ok(Math.abs(distance - RADIUS) < 1e-6, `the far side lands on the rim (${distance})`);
  assert.ok(hidden.x > 400, 'and on the side its own longitude points to');
  assert.ok(hidden.z < 0, 'and is marked as facing away');
  // A visible point is passed straight through.
  const visible = globeProjectClamped(0, 40, CAMERA);
  assert.equal(Math.round(visible.x - 400), Math.round(globeProject(0, 40, CAMERA).x - 400));
  // The exact antipode has no direction of its own; it must still be a stable
  // point on the rim rather than the middle of the sphere or a NaN.
  const antipode = globeProjectClamped(0, 180, CAMERA);
  assert.ok(Number.isFinite(antipode.x) && Number.isFinite(antipode.y));
  assert.ok(Math.abs(Math.hypot(antipode.x - 400, antipode.y - 300) - RADIUS) < 1e-6);
});

test('an outline is cut at the horizon, not sliced across it', () => {
  // A square of four points 120 degrees apart: only one corner faces the camera.
  const ring = [unitVector(0, -120), unitVector(0, -60), unitVector(0, 60), unitVector(0, 30)];
  const clipped = clipToHemisphere(ring, cameraDirection({ lat: 0, lon: 0 }));
  assert.ok(clipped.length >= 3, 'the visible part survives');
  const camera = CAMERA;
  for (const vertex of clipped) {
    const projected = globeProjectVector(vertex, camera);
    const distance = Math.hypot(projected.x - 400, projected.y - 300);
    assert.ok(distance <= RADIUS + 1e-6, 'every kept vertex is on the visible face');
    // A vertex the cut created lies exactly on the limb.
    if (vertex.limb) assert.ok(Math.abs(distance - RADIUS) < 1e-6, 'the cut runs along the limb');
  }
  // A ring entirely on the visible face comes back intact, point for point.
  const facing = [unitVector(10, -10), unitVector(10, 10), unitVector(-10, 10), unitVector(-10, -10)];
  assert.equal(clipToHemisphere(facing, cameraDirection({ lat: 0, lon: 0 })).length, 4);
  // A ring entirely behind the camera is not a shape at all.
  const behind = [unitVector(0, 170), unitVector(10, 175), unitVector(-10, 178)];
  assert.ok(clipToHemisphere(behind, cameraDirection({ lat: 0, lon: 0 })).length < 3);
  assert.ok(clipToHemisphere([], cameraDirection({ lat: 0, lon: 0 })).length < 3, 'an empty ring has no shape');
});

test('the middle of a set of points is the same calculation at the date line', () => {
  const across = vectorMeanCentre([{ lat: 10, lon: 179 }, { lat: 10, lon: -179 }]);
  assert.equal(Math.abs(across.lon), 180, `the middle is at the date line, not at zero (${across.lon})`);
  // A mean on a sphere is not an arithmetic mean: the two points are 222 NM
  // apart along a parallel, and their vector mean sits very slightly poleward of
  // both, which is the correct answer rather than an error to be hidden.
  assert.ok(across.lat >= 10 && across.lat < 10.01, `the middle stays between them (${across.lat})`);
  const normal = vectorMeanCentre([{ lat: 40, lon: -100 }, { lat: 44, lon: -104 }]);
  assert.ok(Math.abs(normal.lon + 102) < 0.5 && Math.abs(normal.lat - 42) < 0.5);
  assert.equal(vectorMeanCentre([]), null);
  assert.equal(vectorMeanCentre([{ lat: NaN, lon: 4 }]), null, 'a broken point cannot be averaged in');
});

test('a drag turns the globe at the same speed at every latitude', () => {
  // Sideways is a spin, divided by the cosine of the latitude, so one pixel of
  // drag moves the same distance of ground near the pole as at the equator.
  const equator = orbitBy({ lat: 0, lon: 0 }, 20, 0, RADIUS);
  assert.ok(equator.lon < 0, 'dragging right spins the globe west');
  // Away from the polar cap the same drag covers the same ground: the turn of
  // longitude grows as the cosine shrinks, exactly as far as it needs to.
  const groundNm = c => Math.abs(c.lon) * 60 * Math.cos((c.lat * Math.PI) / 180);
  const mid = orbitBy({ lat: 60, lon: 0 }, 20, 0, RADIUS);
  assert.ok(Math.abs(mid.lon) > Math.abs(equator.lon), 'sixty degrees north turns further in longitude');
  assert.ok(Math.abs(groundNm(mid) - groundNm(equator)) < 5,
    `and covers the same ground, ${groundNm(equator).toFixed(1)} NM against ${groundNm(mid).toFixed(1)} NM`);
  // Inside the polar cap the division is floored, so a small drag does not spin
  // the sphere away: the turn stops growing and the drag covers less ground.
  const polar = orbitBy({ lat: 87, lon: 0 }, 20, 0, RADIUS);
  assert.ok(Math.abs(polar.lon) > Math.abs(equator.lon) * 2, 'and near the pole it still turns further in longitude than at the equator');
  assert.ok(groundNm(polar) < groundNm(equator),
    `but covers less ground (${groundNm(polar).toFixed(1)} NM against ${groundNm(equator).toFixed(1)} NM), because the division is floored so a short drag cannot fling the sphere around`);
  const pulled = orbitBy({ lat: 0, lon: 0 }, 0, 20, RADIUS);
  assert.ok(pulled.lat > 0, 'pulling the globe down rolls the camera north, so the surface follows the pointer');
  const over = orbitBy({ lat: 89, lon: 0 }, 0, 400, RADIUS);
  assert.equal(over.lat, 89.5, 'the roll stops short of the pole rather than flipping over it');
  const wrapped = orbitBy({ lat: 0, lon: 179 }, -400, 0, RADIUS);
  assert.ok(wrapped.lon >= -180 && wrapped.lon < 180, 'and the longitude wraps instead of running away');
});

test('the sphere fills the canvas box, scaled by the pilot zoom', () => {
  assert.ok(globeRadiusFor(800, 600, 20, 1) < 300, 'the sphere fits inside the box');
  assert.ok(globeRadiusFor(800, 600, 20, 2) > globeRadiusFor(800, 600, 20, 1), 'zoom makes it bigger');
  assert.ok(globeRadiusFor(200, 900, 0, 1) <= 100, 'a tall box fits by its narrow side');
  assert.equal(globeRadiusFor(10, 10, 40, 1), 40, 'and there is a floor, so a tiny map is still a sphere');
});

test('a pixel at the middle of the sphere is a real ground distance', () => {
  assert.ok(Math.abs(nmPerPixelAtCentre(3437.7468) - 1) < 1e-9);
  assert.equal(nmPerPixelAtCentre(0), 3437.7468, 'a degenerate radius cannot divide by zero');
  assert.ok(nmPerPixelAtCentre(600) < nmPerPixelAtCentre(200), 'zooming in shrinks the ground per pixel');
});

test('the raster pass paints the disc and only the disc, into the buffer it was given', () => {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  const base = [10, 20, 30];
  let asked = 0;
  const stats = rasteriseGlobe({
    size,
    center: { lat: 0, lon: 0 },
    base,
    data,
    sample: (lat, lon, out) => {
      asked += 1;
      // A sampler that answers only for the northern half, so a missing answer
      // and a painted pixel can be told apart.
      if (lat < 0) return null;
      out[0] = 200;
      out[1] = 100;
      out[2] = 50;
      out[3] = 255;
      return out;
    },
  });
  assert.equal(stats.asked, asked, 'every pixel inside the disc asked once');
  assert.ok(stats.painted > 0 && stats.painted < stats.asked, 'part of the face was painted');
  assert.ok(Math.abs(stats.share - stats.painted / stats.asked) < 1e-9, 'and the share is reported');
  const at = (x, y) => [data[(y * size + x) * 4], data[(y * size + x) * 4 + 1], data[(y * size + x) * 4 + 2], data[(y * size + x) * 4 + 3]];
  // A pixel is sampled at its centre, so with an even-sized raster the middle
  // falls between two rows: the pixel above it is north of the camera's
  // latitude and the one below is south. Both facts matter — that is what makes
  // the raster line up with the sphere drawn over it.
  assert.deepEqual(at(size / 2 - 1, size / 2 - 1), [200, 100, 50, 255], 'just north of the centre, the sampler answered');
  assert.deepEqual(at(size / 2, size / 2), [10, 20, 30, 255], 'just south of it, the sphere\'s own base colour stands in');
  assert.deepEqual(at(size / 2, size - 2), [10, 20, 30, 255], 'and the far south falls back too');
  // The corners are outside the disc and are never touched: still zero.
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(size - 1, 0), [0, 0, 0, 0]);
  // Every pixel inside the disc is opaque, so the sphere is never see-through.
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0 && data[i] !== 255) transparent += 1;
  assert.equal(transparent, 0);
});

test('the geometry is pure, so a classic script and a module can both use it', () => {
  const source = fs.readFileSync(new URL('../app/js/lib/globeview.js', import.meta.url), 'utf8');
  // The tracker's engine is a classic script and the EFB's map is a module; the
  // shared arithmetic must not reach for a document or a window of its own.
  assert.doesNotMatch(source, /\bdocument\b/, 'no DOM');
  assert.doesNotMatch(source, /\bwindow\b/, 'no global');
  assert.match(source, /import \{ DEG, validLatLon \} from '\.\/geo\.js';/, 'it reuses the shared degrees and coordinate check');
});
