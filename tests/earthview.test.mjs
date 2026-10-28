import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EARTH_STYLES, GIBS, GlobeRaster, MAX_FACE_TILES, MAX_TERRAIN_FACE_TILES, POINT_ZOOM, TERRAIN,
  EarthView, decodeTerrarium, earthStyle, elevationColor, gibsCoverage, gibsMatrix, gibsTileUrl,
  gibsZoomForSphere, mercatorFraction, offsetNm, probeZoomForRadius, shadeTerrainTile,
  terrainMetresPerPixel, terrainTileAt, terrainTileUrl, terrainZoomForSphere,
} from '../app/js/lib/earthview.js';

/* The two publishers, checked against the way their services actually address
   tiles. Both mistakes these tests pin — a GIBS URL built by doubling, and a
   terrarium height decoded the wrong way round — are silent: the first returns
   an error document instead of a picture, the second paints plausible nonsense
   in which the ocean is 32 768 m high. */

test('a GIBS URL comes from the published matrix, not from a slippy assumption', () => {
  // Level 2 of the 4326 pyramid is five tiles across and three down. A slippy
  // map would ask for 2^2 = 4 and land outside the pyramid.
  assert.deepEqual([gibsMatrix(2).width, gibsMatrix(2).height], [5, 3]);
  assert.equal(gibsTileUrl(2, 2, 0), `${GIBS.base}/BlueMarble_NextGeneration/default/500m/2/0/2.jpeg`);
  assert.equal(gibsTileUrl(2, 5, 0), null, 'x outside that level is never requested');
  assert.equal(gibsTileUrl(2, 0, 3), null, 'nor is y');
  assert.equal(gibsTileUrl(0, 99, 0), null);
  assert.throws(() => gibsTileUrl(1, 0, 0, { layer: 'made-up' }), /Unknown imagery layer/);
});

test('a GIBS tile covers the ground its matrix says it does', () => {
  const tile = gibsCoverage(2, 2, 0);
  assert.deepEqual([tile.west, tile.east, tile.north, tile.south], [-36, 36, 90, 30]);
  const south = gibsCoverage(2, 2, 2);
  assert.deepEqual([south.north, south.south], [-30, -90], 'and the last row reaches the pole');
});

/* The radius and the angular radius of the pane the camera can see, for the
   sphere each zoom of a 1280x800 chart draws: the pane narrows as the sphere
   grows past the canvas, which is what makes a deep level affordable. */
const DRAWN = [[348, 90], [696, 90], [1392, 33], [2784, 16], [5568, 8], [13920, 3.1]];

/** How many tiles of one level a pane of that angular radius takes. */
const paneTilesOf = (level, capDeg, tilesWide = GIBS.matrices[level][0]) => ((capDeg * tilesWide) / 180) ** 2;

test('the imagery level follows what is drawn, and is bounded by the pane', () => {
  // One sphere per screen has always read the coarse level, and still does.
  assert.equal(gibsZoomForSphere(348), 2);
  assert.equal(gibsZoomForSphere(20), 0);

  // Zooming in reads deeper, because the camera is closer to the ground and the
  // pane it can see is narrower in degrees.
  const levels = DRAWN.map(([radius, capDeg]) => gibsZoomForSphere(radius, { capDeg }));
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'a closer camera reads a deeper level');
  assert.ok(levels[0] < levels[levels.length - 1], 'from the coarse level to the deepest the pyramid holds');
  assert.equal(levels[levels.length - 1], GIBS.matrices.length - 1, 'a zoomed globe is not capped short of the source');

  // The source is never coarser than the sphere is drawn. The pyramid doubles at
  // every step, so "at least as fine" lands between one and two times finer.
  for (const [radius, capDeg] of DRAWN) {
    const level = gibsZoomForSphere(radius, { capDeg });
    const source = (GIBS.tilePixels * GIBS.matrices[level][0]) / 360;   // pixels per degree
    const ratio = source / (radius / 90);
    assert.ok(ratio >= 1, `${radius} px sphere reads at least as fine as it is drawn (${ratio.toFixed(2)}x)`);
    assert.ok(ratio < 2.1, `and not a whole step finer (${ratio.toFixed(2)}x)`);
  }

  // Cost is bounded by the pane rather than by a fixed ceiling: eight degrees of
  // level 7 is a handful of tiles, while a hemisphere of level 7 is thousands.
  for (const [radius, capDeg] of DRAWN) {
    const tiles = paneTilesOf(gibsZoomForSphere(radius, { capDeg }), capDeg);
    assert.ok(tiles <= MAX_FACE_TILES, `a ${radius} px sphere asks for ${Math.round(tiles)} tiles`);
  }
  assert.equal(gibsZoomForSphere(13920, { capDeg: 90 }), 3, 'the same sphere over a whole hemisphere is held back');
});

test('the drawn level stays cheap and the probe level stays honest', () => {
  const drawn = terrainZoomForSphere(160, { capDeg: 90 });
  assert.equal(drawn, 3);
  assert.ok(2 ** drawn <= 16, 'so the visible face is a handful of tiles, not a pyramid');
  assert.equal(terrainZoomForSphere(160, { capDeg: 90 }), terrainZoomForSphere(84, { capDeg: 90 }) + 1, 'and it follows the sphere');

  // Terrain is decoded and hillshaded rather than merely sampled, so its pane is
  // held to fewer tiles than the imagery's — which is what bounds the work now
  // that the level follows the zoom instead of a fixed ceiling.
  for (const [radius, capDeg] of DRAWN) {
    const level = terrainZoomForSphere(radius, { capDeg });
    const tiles = ((capDeg * 2 ** level) / 180) ** 2;
    assert.ok(tiles <= MAX_TERRAIN_FACE_TILES, `a ${radius} px sphere asks for ${Math.round(tiles)} terrain tiles`);
    assert.ok(level >= 1 && level <= TERRAIN.maxZoom, 'at a level the publisher actually serves');
  }

  // A radius scan reads a level whose tiles are near its own sample spacing,
  // which keeps a 20 NM scan and a 320 NM scan to about the same number of
  // tiles — fourteen each — instead of one of them asking for hundreds.
  assert.ok(POINT_ZOOM >= 8, 'a point reading is worth a deep tile');
  const widths = [20, 40, 80, 160, 320].map(nm => probeZoomForRadius(nm));
  assert.deepEqual(widths, [...widths].sort((a, b) => b - a), 'a wider scan reads a coarser level');
  for (const nm of [20, 40, 80, 160, 320]) {
    const zoom = probeZoomForRadius(nm);
    const tilesAcross = (nm * 2) / ((360 / 2 ** zoom) * 60);
    assert.ok(tilesAcross ** 2 <= 30, `a ${nm} NM scan touches ${Math.round(tilesAcross ** 2)} tiles`);
  }
  assert.equal(probeZoomForRadius(10000), 4, 'a scan of a hemisphere does not go below the drawing level');
});

test('terrain tiles are slippy, and their level follows the sphere', () => {
  const seattle = terrainTileAt(47.449, -122.309, 7);
  assert.deepEqual([seattle.z, seattle.x, seattle.y], [7, 20, 44]);
  assert.equal(terrainTileUrl(7, 20, 44), `${TERRAIN.base}/7/20/44.png`);
  assert.equal(terrainTileUrl(16, 0, 0), null, "past the publisher's ceiling");
  assert.equal(terrainTileUrl(1, 2, 1), null, 'x beyond the width of that level');
  const zoom = terrainZoomForSphere(150);
  assert.ok(zoom >= 1 && zoom <= 6, 'a globe reads a coarse level, not a pyramid');
  assert.ok(terrainMetresPerPixel(6, 60) < terrainMetresPerPixel(6, 0), 'narrower as the meridians converge');
});

test('a terrarium pixel decodes to the height it encodes', () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(162, 144, 0), 8848, 'the encoding of Everest');
  assert.equal(Math.round(decodeTerrarium(0, 0, 0)), -32768, 'the floor of the encoding');
  assert.equal(decodeTerrarium(128, 51, 51), 51 + 51 / 256, 'and the sub-metre channel counts');
});

test('the elevation ramp reads like a chart and the shading follows the light', () => {
  const deep = elevationColor(-4000);
  const lowland = elevationColor(0);
  const snow = elevationColor(6000);
  assert.ok(deep[2] > deep[0], 'deep water reads blue');
  assert.ok(lowland[1] > lowland[2], 'lowland reads green');
  assert.ok(snow[0] > 200 && snow[1] > 200 && snow[2] > 200, 'high ground reads white');

  // Level ground under a 45-degree sun is one flat tone, nowhere painted twice.
  const level = shadeTerrainTile({ width: 8, height: 4, metresPerPixel: 100, style: 'relief', elevation: () => 1000 });
  const first = [level[0], level[1], level[2]];
  for (let i = 1; i < 32; i += 1) {
    assert.deepEqual([level[i * 4], level[i * 4 + 1], level[i * 4 + 2]], first, 'no slope, no variation');
  }
  assert.ok(first[0] > 140 && first[0] < 180, 'and it is neither black nor white');

  // The sun is in the north-west, so a west-facing slope is the lit one. Getting
  // this backwards is invisible on a flat test tile and obvious on the Alps.
  const westFacing = shadeTerrainTile({ width: 4, height: 4, metresPerPixel: 50, style: 'relief', elevation: x => 1000 - x * 10 });
  const eastFacing = shadeTerrainTile({ width: 4, height: 4, metresPerPixel: 50, style: 'relief', elevation: x => 1000 + x * 10 });
  assert.ok(westFacing[0] > eastFacing[0], 'the lit slope is the brighter one');

  const water = shadeTerrainTile({ width: 1, height: 1, metresPerPixel: 100, style: 'relief', elevation: () => -1500 });
  assert.ok(water[2] > water[0], 'below sea level reads as water, not as shaded ground');

  const shaded = shadeTerrainTile({ width: 2, height: 2, metresPerPixel: 100, style: 'elevation', elevation: () => 2500 });
  assert.ok(shaded[0] > shaded[2], 'and the elevation look keeps its hypsometric colour');
});

test('an EarthView names its sources and never turns an unread tile into a number', () => {
  const view = new EarthView({ style: 'relief' });
  assert.equal(view.style.id, 'relief');
  assert.equal(view.elevationAt(47.45, -122.31), null, 'nothing read is not an elevation');
  assert.equal(view.highestNear(47.45, -122.31, 40), null, 'and it is not a terrain profile either');
  assert.equal(view.sample(47.45, -122.31), null, 'nor is it a colour');
  assert.equal(view.readyCount(), 0);

  assert.match(view.notes().join(' '), /Mapzen/, 'the elevation source is named');
  assert.match(view.notes().join(' '), /display product/, 'along with what it may not be used for');
  assert.match(view.notes().join(' '), /not suitable for navigation/, 'and which source says so');

  view.setStyle('imagery');
  const imagery = view.notes().join(' ');
  assert.match(imagery, /NASA/);
  assert.match(imagery, /public domain/);

  view.setStyle('vector');
  assert.match(view.notes().join(' '), /Natural Earth/, 'outlines say they are outlines');

  // Reading terrain is asked for, and doing it without a browser must not throw.
  assert.doesNotThrow(() => view.readTerrain(47, -122, { radiusNm: 40, rasterPx: 200 }));
  assert.ok(view.stats().failedReasons.length === 0 || view.stats().failedReasons.some(reason => typeof reason === 'string'));
  view.destroy();
  assert.equal(view.tiles.size, 0);
  assert.equal(view.readyCount(), 0);
});

test('an elevation reading comes from the tile and the row the point is in', () => {
  const view = new EarthView({ style: 'relief' });
  const lat = 47.6062;
  const lon = -122.3321;
  const size = TERRAIN.tilePixels;
  const tile = terrainTileAt(lat, lon, POINT_ZOOM);
  // A tile whose height rises with the row, so a reading taken from the wrong
  // row cannot pass and neither can one taken from the wrong tile.
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const encoded = Math.round(y * 10 + 32768);
      const index = (y * size + x) * 4;
      data[index] = Math.floor(encoded / 256);
      data[index + 1] = encoded % 256;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }
  view.tiles.set(view.key('terrain', POINT_ZOOM, tile.x, tile.y), {
    key: 'probe', kind: 'terrain', z: POINT_ZOOM, x: tile.x, y: tile.y,
    ready: true, requested: true, data, width: size, height: size,
  });

  const row = mercatorFraction(lat) * 2 ** POINT_ZOOM * size - tile.y * size;
  const metres = view.elevationAt(lat, lon);
  assert.ok(metres !== null, 'the reading is found in the tile that holds the point');
  assert.ok(metres >= Math.floor(row) * 10 && metres <= (Math.floor(row) + 1) * 10,
    `expected a reading from row ${Math.floor(row)}, got ${metres}`);

  // A little further south is a different row of the same tile, and its own
  // height: a reading that ignored the row would return the same number twice.
  const southRow = mercatorFraction(lat - 0.02) * 2 ** POINT_ZOOM * size - tile.y * size;
  assert.notEqual(Math.floor(southRow), Math.floor(row), 'the two points are in different rows');
  const south = view.elevationAt(lat - 0.02, lon);
  assert.ok(south !== null && south >= Math.floor(southRow) * 10 && south <= (Math.floor(southRow) + 1) * 10,
    `expected a reading from row ${Math.floor(southRow)}, got ${south}`);
  // And a place whose tile is not read says so instead of borrowing a neighbour's.
  assert.equal(view.elevationAt(-33.87, 151.21), null, 'another continent is not this continent');
});

test('relief and elevation are two different pictures of the same ground', () => {
  const view = new EarthView({ style: 'relief' });
  const size = TERRAIN.tilePixels;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const encoded = Math.round(200 + (x / size) * 1800 + 32768);   // climbing east
      const index = (y * size + x) * 4;
      data[index] = Math.floor(encoded / 256);
      data[index + 1] = encoded % 256;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }
  const entry = { key: 'shade', kind: 'terrain', z: 8, x: 100, y: 100, ready: true, requested: true, data, width: size, height: size };
  view.tiles.set(view.key('terrain', 8, 100, 100), entry);

  const grey = view.shadedTerrain(entry);
  assert.equal(grey.style, 'relief');
  const east = (128 * size + 240) * 4;
  const greySpread = Math.abs(grey.data[east] - grey.data[east + 2]);
  assert.ok(greySpread < 25, 'relief is a grey picture of the ground');

  view.setStyle('elevation');
  const colour = view.shadedTerrain(entry);
  assert.equal(colour.style, 'elevation');
  const colourSpread = Math.abs(colour.data[east] - colour.data[east + 2]);
  assert.ok(colourSpread > greySpread + 20,
    `the elevation look carries the hypsometric colour (${colourSpread} against ${greySpread})`);
  assert.ok(colour.data[east + 3] === 255, 'and it is opaque');
  view.destroy();
});

/* The painter, which is what decides whether a zoomed globe is sharp and what it
   costs a frame to get there. A canvas is stubbed because none of this needs a
   real one: what matters is which buffer is painted, how much of it per frame,
   and which picture is handed back. */
test('the painter fills a pane in bands and keeps a coarse one for a turn', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {
    documentElement: { dataset: { theme: 'night' } },
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: image => { canvas.painted = image.width * image.height; },
        }),
      };
      return canvas;
    },
  };
  try {
    const band = 2000;
    let ticks = 0;
    let sampled = 0;
    const painter = new GlobeRaster({ band, onProgress: () => { ticks += 1; } });
    const surface = {
      key: 'imagery|night',
      tiles: 3,
      base: [10, 22, 34],
      sample: (lat, lon, out) => { sampled += 1; out[0] = 90; out[1] = 120; out[2] = 60; out[3] = 255; return out; },
    };
    const camera = { lat: 47.4, lon: -122.3 };
    const geometry = { width: 640, height: 400, radius: 1800, cx: 320, cy: 200, dpr: 1 };
    const pane = painter.geometry(geometry);

    // The coarse pane is the same piece of canvas at a coarser scale, so a turn
    // can be drawn from it straight away without moving the sphere.
    assert.ok(pane.coarse.columns < pane.columns, 'the coarse pane is coarser');
    assert.deepEqual(
      [pane.coarse.x0, pane.coarse.y0, pane.coarse.width, pane.coarse.height],
      [pane.x0, pane.y0, pane.width, pane.height],
      'and sits in the same place',
    );
    assert.ok(pane.coarse.columns * pane.coarse.rows < 30000, 'small enough for a frame of a drag');

    // A frame of a turn: the coarse pane, and nothing kept for later.
    const turning = painter.frame({ pane, camera, surface, still: false });
    assert.ok(turning && turning.canvas, 'a turning frame is drawn from the coarse pane');
    assert.equal(turning.canvas.width, pane.coarse.columns, 'at the coarse pane\'s own size');
    assert.equal(painter.picture, null, 'and no sharp pane has been finished yet');
    assert.equal(painter.frame({ pane, camera, surface, still: false }), turning,
      'the same camera does not repaint the pane it already has');

    // The camera still: the pane is filled in a band at a time, and no frame is
    // asked for more than its band.
    let previousRow = 0;
    let widestFrame = 0;
    let frames = 0;
    while (!painter.picture && frames < 400) {
      const before = sampled;
      painter.frame({ pane, camera, surface, still: true });
      widestFrame = Math.max(widestFrame, sampled - before);
      if (painter.build) {
        assert.ok(painter.build.row >= previousRow, 'the pane fills in from the top, never backwards');
        previousRow = painter.build.row;
      }
      frames += 1;
    }
    assert.ok(painter.picture, 'a pane converges once the camera stops');
    assert.ok(frames > 1, `and takes more than one frame to do it (${frames})`);
    assert.ok(widestFrame <= band + pane.columns, `and no frame asks for more than a band (${widestFrame} samples)`);
    assert.equal(ticks, frames - 1, 'each unfinished band asks for the next frame');

    // The finished pane is what is handed back, at its own size.
    const sharp = painter.frame({ pane, camera, surface, still: true });
    assert.equal(sharp, painter.picture.view, 'the sharp pane is what a still camera is drawn from');
    assert.equal(sharp.canvas.width, pane.columns);
    assert.equal(sharp.width, pane.width, 'and it covers the same rectangle of the canvas');
    assert.equal(sharp.share, 1, 'a sampler that answers everything paints everything');

    // Tiles landing while a pane is filling in are absorbed, not restarted: a
    // face filling in would otherwise begin again on every arrival.
    painter.clear();
    painter.frame({ pane, camera, surface, still: false });
    const rows = [];
    for (let i = 0; i < 8; i += 1) {
      surface.tiles = 3 + i;
      painter.frame({ pane, camera, surface, still: true });
      rows.push(painter.build ? painter.build.row : -1);
    }
    assert.ok(rows.every((row, i) => i === 0 || row >= rows[i - 1]), `a pane keeps filling through arrivals (${rows.join(',')})`);

    // Moving the camera drops the half-painted pane rather than blitting it in
    // the wrong place, and draws the coarse one instead.
    const moved = painter.frame({ pane, camera: { lat: 48.2, lon: -122.3 }, surface, still: false });
    assert.equal(painter.build, null, 'a pane of another frame\'s geometry is dropped');
    assert.equal(moved.canvas.width, pane.coarse.columns, 'and the coarse pane is drawn in its place');

    // Changing the surface is a different picture even at the same place.
    painter.frame({ pane, camera, surface, still: true });
    surface.key = 'relief|night';
    assert.equal(painter.picture, null, 'a new surface has no pane yet');
    painter.clear();
    assert.equal(painter.coarse, null);
    assert.equal(painter.frame({ pane, camera, surface: { ...surface, sample: null } }), null, 'a surface with no sampler paints nothing');
  } finally {
    if (had) Object.defineProperty(globalThis, 'document', had);
    else delete globalThis.document;
  }
});

test('a finished pane is left alone until the camera, the surface or a tile changes', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {
    documentElement: { dataset: { theme: 'night' } },
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      }),
    }),
  };
  try {
    let sampled = 0;
    const painter = new GlobeRaster({ band: 4000 });
    const surface = {
      key: 'imagery|night',
      tiles: 2,
      base: [10, 22, 34],
      sample: (lat, lon, out) => { sampled += 1; out[0] = 90; out[1] = 120; out[2] = 60; out[3] = 255; return out; },
    };
    const camera = { lat: 46.9, lon: 7.4 };
    const pane = painter.geometry({ width: 320, height: 240, radius: 120, cx: 160, cy: 120, dpr: 1 });
    const still = { pane, camera, surface, still: true };

    let frames = 0;
    while (!painter.picture && frames < 400) { painter.frame(still); frames += 1; }
    assert.ok(painter.picture, 'the pane converges');
    assert.equal(painter.picture.tiles, 2, 'and records the tiles it was painted from');
    assert.ok(painter.picture.settled, 'nothing was on its way, so it is finished');

    // A tracker map draws every frame for as long as the page is open. A pane
    // that repainted itself on every one of those would burn a frame's worth of
    // samples forever for a picture that cannot change.
    const painted = sampled;
    for (let i = 0; i < 30; i += 1) painter.frame(still);
    assert.equal(sampled, painted, 'a finished pane is not painted again by a map that keeps drawing');
    assert.equal(painter.frame(still), painter.picture.view, 'the same picture is handed back');

    // A tile landing is the one thing besides the camera that changes the
    // picture, so it is painted in — once, and then the pane is quiet again.
    // The pane already on screen stays until the new one is finished, because a
    // sharp picture of the same place is better than a coarse one of it.
    surface.tiles = 3;
    const previous = painter.picture;
    painter.frame(still);
    assert.ok(sampled > painted, 'a tile arriving is painted into the pane');
    assert.equal(painter.picture, previous, 'and does not take the finished pane away while it is painted');
    frames = 0;
    while (painter.picture === previous && frames < 400) { painter.frame(still); frames += 1; }
    assert.notEqual(painter.picture, previous, 'the pane is painted again');
    assert.equal(painter.picture.tiles, 3);
    assert.ok(painter.picture.settled, 'started with nothing on its way, so this pass is the finished one');
    const repainted = sampled;
    for (let i = 0; i < 30; i += 1) painter.frame(still);
    assert.equal(sampled, repainted, 'and then it is left alone again');

    // A pane painted while its tiles were still arriving is not finished: the
    // pass paints from the top down, so a tile that arrived after its own rows
    // were painted would leave a permanent hole. It runs once more instead — and
    // that second pass, with nothing on its way, settles.
    painter.clear();
    surface.tiles = 7;
    painter.frame(still);                                  // a pass starts here
    surface.tiles = 8;                                     // and a tile lands mid-pass
    frames = 0;
    while (!painter.picture && frames < 400) { painter.frame(still); frames += 1; }
    assert.equal(painter.picture.settled, false, 'a pane painted through an arrival is not finished');
    frames = 0;
    while (!(painter.picture && painter.picture.settled) && frames < 400) { painter.frame(still); frames += 1; }
    assert.ok(painter.picture.settled, 'so it is painted once more');
    assert.equal(painter.picture.tiles, 8, 'from the tiles that were there when it ended');
    const settled = sampled;
    for (let i = 0; i < 30; i += 1) painter.frame(still);
    assert.equal(sampled, settled, 'and that pass is the last one until something else changes');

    // Moving the camera is the other thing that changes it.
    painter.frame({ pane, camera: { lat: 45.6, lon: 9.1 }, surface, still: true });
    assert.ok(sampled > settled, 'a camera move paints the pane it is now looking at');
  } finally {
    if (had) Object.defineProperty(globalThis, 'document', had);
    else delete globalThis.document;
  }
});

test('a pane that fits one frame is painted whole, so a shallow view never settles', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {
    documentElement: { dataset: { theme: 'night' } },
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      }),
    }),
  };
  try {
    const band = 40000;
    let ticks = 0;
    let sampled = 0;
    const painter = new GlobeRaster({ band, onProgress: () => { ticks += 1; } });
    const surface = {
      key: 'imagery|night',
      tiles: 2,
      base: [10, 22, 34],
      sample: (lat, lon, out) => { sampled += 1; out[0] = 90; out[1] = 120; out[2] = 60; out[3] = 255; return out; },
    };
    const camera = { lat: 47.4, lon: -122.3 };
    // A sphere drawn small: a phone, a toolbar inset, a globe zoomed out in a
    // narrow pane. Its own pane is cheaper than one frame's band.
    const pane = painter.geometry({ width: 320, height: 240, radius: 60, cx: 160, cy: 120, dpr: 1 });
    assert.ok(pane.columns * pane.rows <= band, `the pane fits a frame (${pane.columns}x${pane.rows})`);

    // Nothing is built ahead of the frame that needs it, and a turn over it is
    // still drawn from a coarse copy rather than from nothing.
    assert.equal(painter.coarse, null, 'no coarse copy is painted before it is needed');
    const turning = painter.frame({ pane, camera, surface, still: false });
    assert.ok(turning && turning.canvas, 'a turn is drawn from the coarse copy');
    assert.equal(turning.canvas.width, pane.coarse.columns, 'at the coarse size');
    assert.equal(painter.picture, null, 'and nothing sharp exists yet');

    // The camera still: the pane is finished by that one frame — no soft frame
    // first, no band left half-painted, and no extra frame asked for.
    const before = sampled;
    const sharp = painter.frame({ pane, camera, surface, still: true });
    assert.equal(painter.build, null, 'nothing is left half-painted');
    assert.ok(painter.picture, 'the pane is finished on the first still frame');
    assert.ok(painter.picture.settled, 'and it is finished, not a pass to be repeated');
    assert.equal(sharp, painter.picture.view, 'that pane is what is drawn');
    assert.equal(sharp.canvas.width, pane.columns, 'at the pane\'s own size');
    assert.equal(ticks, 0, 'and no further frame is asked for');
    const onePass = sampled - before;
    assert.ok(onePass > 0 && onePass <= pane.columns * pane.rows,
      `the whole pane was asked for once (${onePass} samples)`);

    // A map that keeps drawing keeps handing back the same picture.
    const after = sampled;
    for (let i = 0; i < 20; i += 1) painter.frame({ pane, camera, surface, still: true });
    assert.equal(sampled, after, 'a finished pane is not painted again');

    // The same rule survives a pane that is too big for one frame: that one
    // still fills in a band at a time, which is the only visible settle left.
    const big = painter.geometry({ width: 640, height: 400, radius: 1800, cx: 320, cy: 200, dpr: 1 });
    assert.ok(big.columns * big.rows > band, 'a deep pane is bigger than a frame');
    assert.ok(painter.frame({ pane: big, camera, surface, still: false }), 'and a turn still has something to draw');
    assert.equal(painter.picture, null, 'nothing sharp of the new pane yet');
    assert.ok(painter.frame({ pane: big, camera, surface, still: true }), 'the still frame draws the coarse copy');
    assert.ok(painter.build, 'and the sharp pass has begun');
    assert.ok(painter.build.row < big.rows, `a band, not the whole pane (${painter.build.row} of ${big.rows})`);
  } finally {
    if (had) Object.defineProperty(globalThis, 'document', had);
    else delete globalThis.document;
  }
});

test('a painter without a canvas paints nothing rather than throwing', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  delete globalThis.document;
  try {
    const painter = new GlobeRaster();
    const pane = painter.geometry({ width: 640, height: 400, radius: 300, cx: 320, cy: 200, dpr: 1 });
    assert.equal(painter.frame({
      pane,
      camera: { lat: 0, lon: 0 },
      surface: { key: 'imagery', tiles: 0, base: [0, 0, 0], sample: () => null },
      still: false,
    }), null);
  } finally {
    if (had) Object.defineProperty(globalThis, 'document', had);
    else delete globalThis.document;
  }
});

test('the sample grid walks north and east from the centre', () => {
  const north = offsetNm({ lat: 0, lon: 0 }, 60, 0);
  assert.ok(Math.abs(north.lat - 1) < 1e-9, 'a minute of latitude is a nautical mile');
  const east = offsetNm({ lat: 60, lon: 0 }, 0, 60);
  assert.ok(Math.abs(east.lon - 2) < 0.02, 'a degree of longitude is half as long at 60 N');
});

test('every surface the globe offers says what it is drawn from', () => {
  assert.deepEqual(EARTH_STYLES.map(style => style.id), ['vector', 'imagery', 'relief', 'elevation']);
  for (const style of EARTH_STYLES) {
    assert.ok(style.label, `${style.id} has a label`);
    assert.ok(style.hint.length > 20, `${style.id} explains itself`);
  }
  for (const style of EARTH_STYLES.filter(entry => entry.source)) {
    assert.ok(style.hint.length > 30, `${style.id} says where its tiles come from`);
  }
  assert.equal(earthStyle('nonsense').id, 'vector', 'an unknown surface falls back to the one that needs no network');
});
