import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EARTH_STYLES, GIBS, POINT_ZOOM, TERRAIN, EarthView, decodeTerrarium, earthStyle, elevationColor,
  gibsCoverage, gibsMatrix, gibsTileUrl, gibsZoomForRaster, mercatorFraction, offsetNm,
  probeZoomForRadius, shadeTerrainTile, terrainMetresPerPixel, terrainTileAt, terrainTileUrl,
  terrainZoomForRaster,
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

test('the imagery level follows the sphere and stays bounded', () => {
  assert.equal(gibsZoomForRaster(20), 0);
  assert.equal(gibsZoomForRaster(300), 2);
  assert.equal(gibsZoomForRaster(4000), 4, 'never deeper than a globe can show');
  assert.ok(gibsZoomForRaster(600) > gibsZoomForRaster(200), 'a bigger sphere gets more detail');
});

test('the drawn level stays cheap and the probe level stays honest', () => {
  const drawn = terrainZoomForRaster(320);
  assert.equal(drawn, 3);
  assert.ok(2 ** drawn <= 16, 'so the visible face is a handful of tiles, not a pyramid');
  assert.equal(terrainZoomForRaster(320), terrainZoomForRaster(168) + 1, 'and it follows the sphere');

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
  const zoom = terrainZoomForRaster(300);
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
