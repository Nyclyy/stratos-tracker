/* Earth imagery and terrain elevation for the EFB globe.
 *
 * Two publishers, each doing the part it is actually good at. Nothing here is
 * invented: a pixel that has not been read is reported as missing, never painted
 * with a guess, and every number carries the source it came from.
 *
 *   imagery  NASA GIBS, "Blue Marble Next Generation" — a cloud-free global
 *            mosaic, public domain. NASA asks for this acknowledgement:
 *            "We acknowledge the use of imagery provided by services from
 *            NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth
 *            Science Data and Information System (ESDIS)." Blue Marble imagery
 *            should also be credited to NASA Earth Observatory. NASA content is
 *            generally not subject to copyright and NASA does not endorse this
 *            app; its identifiers and logos are not used here.
 *
 *   elevation  AWS Open Data "Terrain Tiles", a Mapzen (Linux Foundation
 *            project) dataset hosted by AWS, encoded as terrarium PNGs:
 *            height in metres = (R * 256 + G + B / 256) - 32768. It is a
 *            composite of 3DEP and GMTED2010 (USGS, public domain), SRTM
 *            (public domain, with a copyright assertion attached to some
 *            products distributed outside the United States), ETOPO1 (NOAA,
 *            public domain in the U.S.) and regional national datasets whose
 *            terms vary by source. ETOPO1 states that it is not suitable for
 *            navigation, and the assembled tiles are a display product: the
 *            elevations here are for situational awareness on a simulator map,
 *            never for terrain clearance or any navigational use.
 *
 * Both services send `Access-Control-Allow-Origin: *` (checked against the live
 * endpoints), so a tile can be decoded for pixel work — which shading and
 * elevation sampling both need — instead of only being blitted. Both are read
 * straight from the publisher: no key, no proxy, nothing redistributed, and the
 * publisher is always named on screen next to the data.
 *
 * Cost is deliberately small, because a globe is cheap to draw and easy to make
 * expensive:
 *   • the tile zoom is chosen from the size of the sphere on screen, so a globe
 *     a few hundred pixels across reads a handful of coarse tiles, not a
 *     worldwide pyramid;
 *   • tiles are decoded once and cached, shaded once per tile, and reused;
 *   • a pass fetches at most a few new tiles, nearest the camera first, and the
 *     sphere is sampled at a bounded resolution rather than per device pixel.
 */

import { DEG, validLatLon } from './geo.js';
import { globeRasterPlan, rasteriseGlobe } from './globeview.js';

/* ── NASA GIBS ──────────────────────────────────────────────────────────── */

export const GIBS = {
  id: 'gibs',
  service: "NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)",
  base: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best',
  /* GIBS serves this pyramid as 512-pixel tiles whose matrix is not a power of
     two — the widths below are the ones published in the service capabilities,
     in order, from the whole world down. Guessing them like a slippy map is
     what returns 400 from the service. */
  matrices: [[2, 1], [3, 2], [5, 3], [10, 5], [20, 10], [40, 20], [80, 40], [160, 80]],
  tilePixels: 512,
  layers: {
    imagery: 'BlueMarble_NextGeneration',
    relief: 'BlueMarble_ShadedRelief_Bathymetry',
  },
  attribution: 'Imagery: NASA Earth Observatory Blue Marble, served by NASA GIBS/ESDIS (public domain)',
  acknowledgement: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
  terms: 'NASA content is generally not subject to copyright and NASA does not endorse Stratos.',
};

/** Matrix width and height of a GIBS level: not 2^z, so it is looked up. */
export function gibsMatrix(zoom) {
  const z = Math.max(0, Math.min(GIBS.matrices.length - 1, Math.round(Number(zoom) || 0)));
  const [w, h] = GIBS.matrices[z];
  return { zoom: z, width: w, height: h };
}

/** The tile that the whole world is cut into at one GIBS level. */
export function gibsCoverage(zoom, x, y) {
  const { width, height } = gibsMatrix(zoom);
  return {
    west: -180 + (x / width) * 360,
    east: -180 + ((x + 1) / width) * 360,
    north: 90 - (y / height) * 180,
    south: 90 - ((y + 1) / height) * 180,
  };
}

/**
 * A real GIBS tile URL. `layer` is a key of GIBS.layers, never a free string:
 * an unknown layer is a bug in the caller, not a request to try.
 */
export function gibsTileUrl(zoom, x, y, { layer = 'imagery' } = {}) {
  const name = GIBS.layers[layer];
  if (!name) throw new Error(`Unknown imagery layer: ${layer}`);
  const { width, height } = gibsMatrix(zoom);
  if (!(x >= 0 && x < width && y >= 0 && y < height)) return null;
  return `${GIBS.base}/${name}/default/500m/${gibsMatrix(zoom).zoom}/${y}/${x}.jpeg`;
}

/**
 * How many tiles a pane of this angular radius takes out of a level this many
 * tiles wide. A globe shows a pane of itself, not a hemisphere, once it is
 * zoomed in: the closer the camera, the smaller the pane in degrees, and the
 * deeper the level that same count of tiles can pay for. That is what makes a
 * deep zoom affordable at all — level 7 over a hemisphere is twelve thousand
 * tiles, and level 7 over the few degrees a zoomed pane covers is a handful.
 */
function paneTiles(tilesWide, capDeg) {
  const across = (Math.max(0, Math.min(90, capDeg)) * tilesWide) / 180;
  return across * across;
}

/**
 * The GIBS level for a sphere drawn this many pixels in radius, over a pane the
 * camera can see `capDeg` degrees around its target.
 *
 * The level follows what is drawn, so a zoomed sphere reads finer imagery
 * rather than the same coarse mosaic enlarged: 512-pixel tiles at `tilesWide`
 * across the world are 512*tilesWide/360 pixels per degree, and a sphere of
 * radius R draws R/90 pixels per degree at the middle of its face. So the level
 * is the shallowest one whose source is at least as fine as the sphere is drawn,
 * which the pyramid's doubling of every step lands between one and two times
 * finer — 1.8 times, measured from zoom 1 to zoom 40. The shallower level of
 * each pair is the one that stays nearest the sphere, because a step that is not
 * needed is a step of tiles that never have to be fetched.
 *
 * It is bounded by cost rather than by a fixed number: a level deeper than the
 * visible pane can pay for is dropped, which keeps a zoomed-in sphere to about
 * a dozen tiles and a whole-hemisphere view to a couple of dozen.
 */
export function gibsZoomForSphere(radiusPx, { capDeg = 90, maxTiles = MAX_FACE_TILES } = {}) {
  const px = Math.max(8, Number(radiusPx) || 0);
  const wanted = px / 90;
  let level = 0;
  while (level < GIBS.matrices.length - 1 && GIBS.matrices[level][0] < wanted) level += 1;
  const cap = Number(capDeg);
  const room = Math.max(1, Number(maxTiles) || MAX_FACE_TILES);
  while (level > 0 && paneTiles(GIBS.matrices[level][0], Number.isFinite(cap) ? cap : 90) > room) level -= 1;
  return level;
}

/* ── AWS / Mapzen terrain tiles ─────────────────────────────────────────── */

export const TERRAIN = {
  id: 'terrain',
  service: 'AWS Open Data Terrain Tiles, a Mapzen (Linux Foundation project) dataset',
  base: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',
  maxZoom: 15,
  tilePixels: 256,
  /* Each level's ground resolution at the equator, from the publisher's own
     table; the globe reports the level it actually read. */
  metresPerPixel: { 0: 156543, 1: 78272, 2: 39136, 3: 19568, 4: 9784, 5: 4892, 6: 2446, 7: 1223, 8: 612, 9: 306, 10: 153, 11: 76, 12: 38 },
  attribution: 'Terrain elevation: AWS Open Data Terrain Tiles (Mapzen), from USGS 3DEP and GMTED2010, NASA SRTM and NOAA ETOPO1',
  terms: 'Source terms vary by region and by data source. ETOPO1 states it is not suitable for navigation. SRTM is public domain, with a copyright assertion attached to some products distributed outside the United States.',
  displayOnly: 'Terrain shading and elevations here are a display product for simulator situational awareness, not for terrain clearance or navigation.',
};

/** Terrarium height in metres from one pixel's three channels. */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/* The Mercator row of a latitude, from a table built once. The globe asks this
   per pixel while it is being drawn, and a logarithm there is the difference
   between a sphere that follows a drag and one that stutters. Interpolation
   between 4096 rows is exact to well inside a pixel of the tile grid. */
const MERCATOR_LIMIT = 85.05112878;
const MERCATOR_STEPS = 4096;
let mercatorRows = null;

export function mercatorFraction(lat) {
  const clamped = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, Number(lat) || 0));
  if (!mercatorRows) {
    mercatorRows = new Float64Array(MERCATOR_STEPS + 1);
    const span = MERCATOR_LIMIT * 2;
    for (let i = 0; i <= MERCATOR_STEPS; i += 1) {
      const phi = (-MERCATOR_LIMIT + (i / MERCATOR_STEPS) * span) * DEG;
      mercatorRows[i] = 0.5 - Math.log((1 + Math.sin(phi)) / (1 - Math.sin(phi))) / (4 * Math.PI);
    }
  }
  const position = ((clamped + MERCATOR_LIMIT) / (MERCATOR_LIMIT * 2)) * MERCATOR_STEPS;
  const low = Math.floor(position);
  if (low <= 0) return mercatorRows[0];
  if (low >= MERCATOR_STEPS) return mercatorRows[MERCATOR_STEPS];
  const t = position - low;
  return mercatorRows[low] + (mercatorRows[low + 1] - mercatorRows[low]) * t;
}

/** Slippy tile holding a coordinate, clipped to the world. */
export function terrainTileAt(lat, lon, zoom) {
  const z = Math.max(0, Math.min(TERRAIN.maxZoom, Math.round(zoom)));
  const n = 2 ** z;
  const x = Math.floor((((Number(lon) + 180) % 360 + 360) % 360) / 360 * n);
  const y = Math.floor(mercatorFraction(lat) * n);
  return { z, x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

export function terrainTileUrl(z, x, y) {
  const zoom = Math.round(z);
  const n = 2 ** zoom;
  if (!(zoom >= 0 && zoom <= TERRAIN.maxZoom) || !(x >= 0 && x < n) || !(y >= 0 && y < n)) return null;
  return `${TERRAIN.base}/${zoom}/${x}/${y}.png`;
}

/**
 * The terrain level for a sphere of this drawn radius over a pane of this
 * angular radius. Same reasoning as the imagery level — the source is kept
 * about twice as fine as the sphere is drawn — but the ceiling is lower,
 * because every terrain tile is decoded and hillshaded rather than merely
 * sampled: a pane of sixteen of them is the most one surface can pay without a
 * visible stall, and that is what the deeper levels are checked against.
 */
export function terrainZoomForSphere(radiusPx, { capDeg = 90, maxTiles = MAX_TERRAIN_FACE_TILES } = {}) {
  const px = Math.max(8, Number(radiusPx) || 0);
  // A level's ground is 360/(256*2^level) degrees per pixel, and the sphere
  // draws 90/radius degrees per pixel at the middle of its face: this is the
  // level about four times finer than that, which is the oversampling relief was
  // tuned with — a hillshade read too coarsely looks like a flat wash.
  let level = Math.max(1, Math.min(TERRAIN.maxZoom, Math.round(Math.log2(px / 16))));
  const cap = Number(capDeg);
  const room = Math.max(1, Number(maxTiles) || MAX_TERRAIN_FACE_TILES);
  while (level > 1 && paneTiles(2 ** level, Number.isFinite(cap) ? cap : 90) > room) level -= 1;
  return level;
}

/* Reading a height is a different question from drawing terrain, and it wants a
   completely different level: a point reading is worth the deepest tile that
   covers it, and a scan out to a radius is worth a level whose tiles are about
   half the spacing of the sample grid — which keeps the scan near a dozen tiles
   whatever radius the pilot is working at. */
export const POINT_ZOOM = 9;

/* The tile ceilings the two surfaces are held to. Imagery is only sampled once
   it is decoded, so it can afford a pane of a few dozen tiles; terrain has to be
   hillshaded tile by tile, and one 256-pixel hillshade costs about as much as a
   hundred thousand imagery samples, so its pane stays smaller. Both are the
   count of tiles the *visible pane* needs, not the count a hemisphere would. */
export const MAX_FACE_TILES = 32;
export const MAX_TERRAIN_FACE_TILES = 16;

export function probeZoomForRadius(radiusNm) {
  const nm = Math.max(1, Number(radiusNm) || 0);
  return Math.max(4, Math.min(11, Math.round(Math.log2(43200 / nm))));
}

/** Ground resolution of a terrain level at a latitude, in metres per pixel. */
export function terrainMetresPerPixel(zoom, lat = 0) {
  const zoomed = TERRAIN.metresPerPixel[Math.max(0, Math.min(15, Math.round(zoom)))] ?? TERRAIN.metresPerPixel[12];
  return zoomed * Math.cos(Math.max(-85, Math.min(85, Number(lat) || 0)) * DEG);
}

/* ── Terrain colour ─────────────────────────────────────────────────────── */

/* A hypsometric ramp, the convention every paper chart uses: green lowland,
   khaki, brown highland, then rock and snow. Stops are metres. */
const ELEVATION_STOPS = [
  [-11000, [8, 22, 54]],
  [-4000, [16, 48, 96]],
  [-1000, [26, 78, 128]],
  [-200, [46, 110, 148]],
  [0, [196, 214, 170]],
  [200, [172, 200, 140]],
  [500, [226, 218, 160]],
  [1000, [216, 186, 122]],
  [2000, [198, 154, 99]],
  [3000, [176, 122, 82]],
  [4000, [156, 108, 90]],
  [5000, [232, 232, 238]],
  [7000, [250, 250, 252]],
];

/** Colour for an elevation in metres, interpolated between the stops. */
export function elevationColor(metres) {
  const m = Number.isFinite(metres) ? metres : 0;
  if (m <= ELEVATION_STOPS[0][0]) return ELEVATION_STOPS[0][1].slice();
  for (let i = 1; i < ELEVATION_STOPS.length; i += 1) {
    const [high, highColor] = ELEVATION_STOPS[i];
    if (m > high) continue;
    const [low, lowColor] = ELEVATION_STOPS[i - 1];
    const t = high === low ? 0 : (m - low) / (high - low);
    return [
      lowColor[0] + (highColor[0] - lowColor[0]) * t,
      lowColor[1] + (highColor[1] - lowColor[1]) * t,
      lowColor[2] + (highColor[2] - lowColor[2]) * t,
    ].map(value => Math.round(value));
  }
  return ELEVATION_STOPS[ELEVATION_STOPS.length - 1][1].slice();
}

/**
 * Shade one terrain tile. `elevation` is called with tile-local (x, y) that may
 * run one pixel outside the tile, so a slope is read across a tile boundary and
 * the shading has no seams; it returns null when that neighbour is not loaded,
 * in which case the edge pixel is clamped.
 *
 * The relief look is a real hillshade — the sun's azimuth and altitude resolved
 * against the ground gradient — and the elevation look is the same shading
 * modulated over the hypsometric ramp, so both read as terrain rather than as
 * decoration. Ocean (at or below sea level) is drawn flat, because shading a
 * bathymetry product would imply a precision the source does not claim.
 */
export function shadeTerrainTile({ width, height, metresPerPixel, style = 'relief', elevation, sun = { azimuth: 315, altitude: 45 } }) {
  const out = new Uint8ClampedArray(width * height * 4);
  const az = sun.azimuth * DEG;
  const alt = sun.altitude * DEG;
  const flat = style !== 'elevation';
  const at = (x, y) => {
    const value = elevation(x, y);
    return Number.isFinite(value) ? value : null;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const here = at(x, y);
      const index = (y * width + x) * 4;
      if (here === null) { out[index + 3] = 0; continue; }
      if (here <= 0 && flat) {
        const deep = Math.max(-6000, Math.min(0, here));
        const ocean = elevationColor(deep);
        out[index] = ocean[0];
        out[index + 1] = ocean[1];
        out[index + 2] = ocean[2];
        out[index + 3] = 255;
        continue;
      }
      const left = at(x - 1, y);
      const right = at(x + 1, y);
      const up = at(x, y - 1);
      const down = at(x, y + 1);
      const dx = ((right ?? here) - (left ?? here)) / (2 * metresPerPixel);
      const dy = ((down ?? here) - (up ?? here)) / (2 * metresPerPixel);
      // Surface normal of the slope, with the vertical exaggerated a little so
      // gentle terrain still reads as terrain on a small globe.
      const nx = -dx * 1.6;
      const ny = -dy * 1.6;
      const nz = 1;
      const norm = Math.hypot(nx, ny, nz) || 1;
      const shade = Math.max(0, (Math.cos(alt) * Math.cos(az) * (nx / norm)) +
        (Math.cos(alt) * Math.sin(az) * (ny / norm)) + Math.sin(alt) * (nz / norm));
      const lit = 0.35 + 0.65 * Math.min(1, shade);
      // Relief is neutral grey under the light; the elevation look keeps its
      // hypsometric colour and carries the shading on top of it.
      const base = flat ? [200, 208, 214] : elevationColor(here);
      out[index] = base[0] * lit;
      out[index + 1] = base[1] * lit;
      out[index + 2] = base[2] * lit;
      out[index + 3] = 255;
    }
  }
  return out;
}

/* ── Styles the globe offers ────────────────────────────────────────────── */

export const EARTH_STYLES = [
  {
    id: 'vector',
    label: 'Outlines',
    hint: 'Bundled Natural Earth 1:110m country outlines. No imagery, no network, no tiles.',
    source: '',
  },
  {
    id: 'imagery',
    label: 'Imagery',
    hint: 'NASA Blue Marble Next Generation satellite mosaic, served by NASA GIBS (public domain).',
    source: 'nasa',
  },
  {
    id: 'relief',
    label: 'Relief',
    hint: 'Shaded terrain computed from real elevations, not a picture of terrain.',
    source: 'terrain',
  },
  {
    id: 'elevation',
    label: 'Elevation',
    hint: 'Hypsometric colours from the same elevations, for reading height at a glance.',
    source: 'terrain',
  },
];

export function earthStyle(id) {
  return EARTH_STYLES.find(style => style.id === id) || EARTH_STYLES[0];
}

/* ── Painting the sphere ────────────────────────────────────────────────── */

/* What one frame of the sphere may spend, and how much of a sharp pane one frame
   may fill in. Measured with a sampler that does what `sample()` below does — a
   tile lookup and four writes per pixel — the raster runs at 2.9 million samples
   a second in Node and about a third of that in a browser, which is what these
   numbers are: the coarse pass is the same 22 000 samples the old fixed-size
   raster always cost a drag, and a band is half a frame, so filling the pane in
   does not hold a frame up. The sharp pane's own ceiling is where the memory and
   the time to converge stop being worth the last pixels of a zoomed view. */
export const COARSE_SAMPLES = 22000;
export const SHARP_SAMPLES = 1100000;
/* A band is one frame's worth of sampling, measured rather than guessed: with a
   real GIBS mosaic loaded the sampler here answers 3.4 million samples a second,
   so 48 000 samples is about fourteen milliseconds and filling the pane in does
   not hold a frame up. It is also the size at which a pane is worth painting in
   one go at all — a pane whose own sample count is no more than this is painted
   whole, sharp, on the first still frame, which is what keeps a shallow view
   (a small sphere, a phone, the chart inset) from ever showing a soft frame. */
export const BAND_SAMPLES = 48000;

/**
 * The picture on the sphere, painted a pane at a time.
 *
 * A globe zoomed in is drawn larger than the canvas, and a picture of what the
 * canvas can show has to be painted at the size it is drawn or it is soft
 * however fine the imagery underneath is. Painting that whole pane in one frame
 * costs hundreds of milliseconds at a real zoom — so the work is split:
 *
 *   • while the sphere is being turned, the pane is painted coarsely and at
 *     once. Every frame of a drag costs what the old fixed-size raster cost,
 *     and the pilot is watching geography move rather than reading pixels;
 *   • once the camera is still, the same pane is painted at the size it is
 *     drawn, a band of rows per frame, and the finished picture replaces the
 *     coarse one. No frame is ever blocked, and sharpness follows the zoom
 *     instead of being capped. That pass runs once per pane and per arrival,
 *     not once per frame: a finished pane is left alone until something about
 *     it actually changes;
 *   • a pane no larger than one frame's band is not banded at all. It is
 *     painted whole on the first still frame and needs no coarse copy, so a
 *     shallow view — a sphere drawn small, on a phone, in the chart inset — is
 *     sharp immediately instead of sharpening over a dozen frames. Only a pane
 *     whose own pixels exceed a frame's budget is filled in progressively, and
 *     that is what makes the deep zooms the only ones that visibly settle.
 *
 * Nothing here invents a pixel: what a frame cannot paint is the surface's own
 * base colour, and the share of the pane that asked for a colour and got one is
 * reported back so a caller can draw its own outlines instead of a half-empty
 * sphere.
 */
export class GlobeRaster {
  constructor({ onProgress = null, coarse = COARSE_SAMPLES, sharp = SHARP_SAMPLES, band = BAND_SAMPLES } = {}) {
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this.coarseSamples = Math.max(1, Number(coarse) || COARSE_SAMPLES);
    this.sharpSamples = Math.max(1, Number(sharp) || SHARP_SAMPLES);
    this.bandSamples = Math.max(1, Number(band) || BAND_SAMPLES);
    this.shape = null;     // the pane, camera and surface the pictures below belong to
    this.coarse = null;    // what a turn is drawn from, rebuilt whenever the pane moves
    this.picture = null;   // the sharp pane, once one has been finished
    this.build = null;     // the pane being filled in, a band at a time
  }

  /**
   * Where the sphere is this frame, and what its pane can see: the plan to paint
   * the pane at the size it is drawn, with the coarse plan for the same frame
   * kept alongside it.
   */
  geometry({ width, height, radius, cx, cy, dpr = 1 }) {
    const pane = globeRasterPlan({ width, height, radius, cx, cy, dpr, budget: this.sharpSamples });
    const coarse = globeRasterPlan({ width, height, radius, cx, cy, dpr: 1, budget: this.coarseSamples });
    return { ...pane, coarse };
  }

  /** Forget the picture: a surface change, a reset or a teardown. */
  clear() {
    this.shape = null;
    this.coarse = null;
    this.picture = null;
    this.build = null;
  }

  /**
   * One frame of the sphere, returning what to blit and where, or null when
   * there is nothing to blit at all.
   *
   * `pane` is from `geometry()`, `camera` is the place the sphere is centred on,
   * `surface` is `{ key, tiles, sample, base }` — the surface's own name, how
   * many tiles of it are read, and the sampler and base colour to paint with —
   * and `still` says the camera has stopped moving, which is what allows the
   * sharp pass to run at all.
   */
  frame({ pane, camera, surface, still = true }) {
    if (!pane || !pane.coarse || !camera || !surface || typeof surface.sample !== 'function') return null;
    const shape = [
      surface.key,
      camera.lat.toFixed(4),
      camera.lon.toFixed(4),
      `${pane.x0},${pane.y0}`,
      `${pane.columns}x${pane.rows}`,
      pane.radius.toFixed(2),
    ].join('|');
    /* A pane that fits one frame's sampling is painted whole, so it never needs
       the coarse copy a larger pane is turned from — see `advance()`, which
       paints it in a single band the moment the camera stops. */
    const whole = pane.columns * pane.rows <= this.bandSamples;
    if (this.shape !== shape) {
      // The camera or the pane moved: the coarse pass is what a turning frame is
      // drawn from, and a sharp pane of another frame's geometry is not this
      // frame's picture — an image in the wrong place is worse than a coarse one.
      this.shape = shape;
      this.coarse = whole ? null : this.paint(pane.coarse, camera, surface, shape);
      this.picture = this.picture && this.picture.shape === shape ? this.picture : null;
      this.build = null;
    }
    if (still) this.advance(pane, camera, surface, shape, Number(surface.tiles) || 0);
    // A whole pane has nothing to blit until it is painted, so a turn over one
    // falls back to its coarse copy rather than to nothing at all.
    else if (whole && !this.coarse) this.coarse = this.paint(pane.coarse, camera, surface, shape);
    const shown = this.picture && this.picture.shape === shape ? this.picture : this.coarse;
    return shown ? shown.view : null;
  }

  /** A whole pane in one pass, and the canvas it is blitted from. */
  paint(plan, camera, surface, shape) {
    const image = this.imageData(plan.columns, plan.rows);
    if (!image) return null;
    const stats = rasteriseGlobe({
      columns: plan.columns,
      rows: plan.rows,
      radius: plan.radius,
      cx: plan.cx,
      cy: plan.cy,
      center: camera,
      sample: surface.sample,
      base: surface.base,
      data: image.data,
    });
    return { shape, view: this.blit(image, plan, stats.share) };
  }

  /**
   * One band of the sharp pane, started here if there is none in flight. Filling
   * in a deep zoom takes tens of frames, so the bands are driven by the caller's
   * own redraws: each one asks for the next through `onProgress`, and the band
   * that finishes the pane becomes the picture. Tiles landing while the pane
   * fills in are absorbed rather than restarting it — the pass samples the store
   * itself, so a band painted after a tile arrived already has that tile in it,
   * and a pane filling in would otherwise begin again from the top on every
   * arrival and never finish.
   *
   * A pass is started only when there is something new to paint. A tracker map
   * draws every frame, so a pass that restarted itself would repaint a finished
   * pane for as long as the page is open, which is the one cost this whole design
   * exists to avoid — so a finished pane is left alone until the camera moves,
   * the surface changes, or a tile lands.
   *
   * A pane no larger than a frame's band is finished by its first band, which is
   * what makes a shallow view sharp on one frame with no soft one before it.
   *
   * A pane painted while tiles were still arriving is not finished: the pass
   * paints its rows from the top down, so a tile that arrived after its own rows
   * were painted would leave a permanent hole. Such a pass is therefore marked
   * unsettled and runs once more — and that pass, started from a store nothing
   * more is on its way to, settles.
   */
  advance(pane, camera, surface, shape, tiles = 0) {
    if (!this.build || this.build.shape !== shape) {
      if (this.picture && this.picture.settled && this.picture.shape === shape && this.picture.tiles === tiles) return;
      const image = this.imageData(pane.columns, pane.rows);
      if (!image) return;
      this.build = { shape, pane, image, row: 0, painted: 0, asked: 0, seen: tiles };
    }
    const build = this.build;
    const band = Math.max(1, Math.round(this.bandSamples / Math.max(1, pane.columns)));
    const rows = Math.max(0, Math.min(band, pane.rows - build.row));
    if (rows) {
      const stats = rasteriseGlobe({
        columns: pane.columns,
        rows,
        radius: pane.radius,
        cx: pane.cx,
        cy: pane.cy,
        rowOffset: build.row,
        center: camera,
        sample: surface.sample,
        base: surface.base,
        data: build.image.data,
      });
      build.painted += stats.painted;
      build.asked += stats.asked;
      build.row += rows;
    }
    if (build.row < pane.rows) {
      this.onProgress?.();
      return;
    }
    this.picture = { shape, tiles, settled: build.seen === tiles, view: this.blit(build.image, build.pane, build.asked ? build.painted / build.asked : 0) };
    this.build = null;
  }

  /** The pane as a canvas to blit from, and where on the map it goes. */
  blit(image, plan, share) {
    const canvas = imageCanvas(image.width, image.height);
    if (!canvas) return null;
    canvas.getContext('2d').putImageData(image, 0, 0);
    return { canvas, x: plan.x0, y: plan.y0, width: plan.width, height: plan.height, share };
  }

  /** A buffer to paint into, or null where there is no canvas to paint with. */
  imageData(columns, rows) {
    const canvas = imageCanvas(columns, rows);
    if (!canvas) return null;
    return canvas.getContext('2d').createImageData(columns, rows);
  }
}

/* ── The tile store and the sampler ─────────────────────────────────────── */

const MAX_TILES = 96;
const MAX_IN_FLIGHT = 6;
const MAX_REQUESTS_PER_PASS = 12;
/* A 5x5 scan plus the deep point tile: enough to cover a scan completely, and
   still a couple of dozen requests however wide the radius is. */
const MAX_PROBE_TILES = 26;

function canvasFor(width, height) {
  return imageCanvas(width, height);
}

/** An offscreen canvas of this size, or null where there is no DOM at all. */
function imageCanvas(width, height) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Imagery and terrain for one globe.
 *
 * The globe hands this the sphere's radius and centre and asks for colours by
 * coordinate; this class owns the tiles, the decode, the shading and the
 * book-keeping that lets the interface say exactly what is loaded and what is
 * missing.
 */
export class EarthView {
  constructor({ style = 'vector', onTiles = null, maxTiles = MAX_TILES } = {}) {
    this.styleId = earthStyle(style).id;
    this.onTiles = typeof onTiles === 'function' ? onTiles : null;
    this.maxTiles = maxTiles;
    this.tiles = new Map();       // "kind/z/x/y" -> tile record
    this.ready = 0;               // decoded tiles, the cheapest change counter
    this.failed = 0;
    this.failedReasons = new Set();
    this.rasterPx = 220;
    this.capDeg = 90;
    this.center = { lat: 0, lon: 0 };
    this.destroyed = false;
    this.setResolution(this.rasterPx);
  }

  get style() { return earthStyle(this.styleId); }

  /** Imagery, terrain, or neither. Turning tiles off releases nothing already read. */
  setStyle(id) {
    this.styleId = earthStyle(id).id;
    this.ensureAround(this.center.lat, this.center.lon, { capDeg: this.capDeg });
  }

  /**
   * The sphere changed size, or the camera moved closer to it: the levels it
   * draws from changed with it. The levels come from how many pixels across the
   * sphere actually is — not from how big it looks on a large screen, and not
   * from the resolution of the frame it is painted in — and they are worked out
   * once here rather than per pixel, because the globe reads these constants a
   * hundred thousand times per redraw.
   *
   * `drawnPx` is the sphere's size across on screen and `capDeg` is how far the
   * pane the camera can see reaches around its target: together they are what a
   * zoomed globe gets its detail from. A pane narrower than a hemisphere is what
   * lets the deeper levels stay affordable — a whole hemisphere at level 7 would
   * be twelve thousand tiles, and the few degrees a zoomed pane covers is ten.
   */
  setResolution(drawnPx, { capDeg = this.capDeg } = {}) {
    const px = Math.max(8, Number(drawnPx) || this.rasterPx);
    this.rasterPx = px;
    this.capDeg = Math.max(0, Math.min(90, Number.isFinite(Number(capDeg)) ? Number(capDeg) : 90));
    this.imageryZoom = gibsZoomForSphere(px / 2, { capDeg: this.capDeg });
    this.demZoom = terrainZoomForSphere(px / 2, { capDeg: this.capDeg });
    const matrix = gibsMatrix(this.imageryZoom);
    this.imageryGeometry = {
      zoom: this.imageryZoom,
      width: matrix.width,
      height: matrix.height,
      xScale: matrix.width / 360,
      yScale: matrix.height / 180,
    };
    this.terrainGeometry = {
      zoom: this.demZoom,
      n: 2 ** this.demZoom,
      size: TERRAIN.tilePixels,
      xScale: (2 ** this.demZoom) / 360,
    };
  }

  needsTiles() {
    return this.styleId === 'imagery' || this.styleId === 'relief' || this.styleId === 'elevation';
  }

  needsTerrain() {
    return this.styleId === 'relief' || this.styleId === 'elevation';
  }

  key(kind, z, x, y) { return `${kind}/${z}/${x}/${y}`; }

  /** How many tiles are decoded and ready to sample. */
  readyCount() { return this.ready; }

  /** A tile record, fetched at most once. */
  tile(kind, z, x, y, url) {
    const id = this.key(kind, z, x, y);
    let entry = this.tiles.get(id);
    if (entry) return entry;
    entry = { id, kind, z, x, y, url, image: null, data: null, width: 0, height: 0, error: '' };
    entry.ready = false;
    entry.requested = false;
    this.tiles.set(id, entry);
    this.trim();
    return entry;
  }

  trim() {
    while (this.tiles.size > this.maxTiles) {
      const oldest = this.tiles.keys().next().value;
      const entry = this.tiles.get(oldest);
      // A tile still in flight is left alone; dropping the reference would not
      // cancel the request, and the reply would be decoded into nothing.
      if (entry && !entry.ready && entry.requested) break;
      this.tiles.delete(oldest);
    }
  }

  /**
   * The angular radius to fetch around: what the pane can show, plus one tile, so
   * a tile the pane's own edge runs through is still fetched. A globe zoomed in
   * sees a narrow pane, and that is what keeps a deep level to a handful of
   * tiles instead of the hemisphere the old fixed reach would have walked.
   */
  fetchReach(capDeg, tilesWide) {
    const cap = Number.isFinite(Number(capDeg)) ? Number(capDeg) : 90;
    const tileDeg = tilesWide > 0 ? 360 / tilesWide : 0;
    return Math.max(0, Math.min(100, cap + tileDeg));
  }

  /**
   * Read one tile's pixels. `resolve(z, x, y)` returns the URL for a tile or
   * null when it is outside the world; every tile that arrives is decoded once,
   * because both the shading and a terrain elevation query need the pixels.
   */
  request(kind, z, x, y, resolve) {
    const url = resolve(z, x, y);
    if (!url) return null;
    const entry = this.tile(kind, z, x, y, url);
    if (entry.ready || entry.requested || this.destroyed) return entry;
    if (typeof Image !== 'function') { entry.error = 'no image support in this environment'; return entry; }
    entry.requested = true;
    const image = new Image();
    entry.image = image;
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (this.destroyed) return;
      try {
        const canvas = canvasFor(image.width, image.height);
        if (!canvas) throw new Error('no canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height);
        entry.data = pixels.data;
        entry.width = image.width;
        entry.height = image.height;
        entry.ready = true;
        this.ready += 1;
      } catch (error) {
        entry.error = `the tile could not be read pixel by pixel (${error.message})`;
        this.failed += 1;
        this.failedReasons.add(entry.error);
      }
      this.onTiles?.();
    };
    image.onerror = () => {
      entry.error = 'the tile did not load';
      this.failed += 1;
      this.failedReasons.add(entry.error);
      if (this.styleId === 'imagery' || this.needsTerrain()) this.onTiles?.();
    };
    image.src = url;
    return entry;
  }

  /**
   * Fetch what the visible face needs, nearest the camera first and only a few
   * at a time. Panning a globe gently must not fire off hundreds of requests,
   * and a globe that is not showing tiles must fire none.
   */
  ensureAround(lat, lon, options = {}) {
    const wantImagery = options.imagery ?? (this.styleId === 'imagery');
    const wantTerrain = options.terrain ?? this.needsTerrain();
    const capDeg = Number.isFinite(Number(options.capDeg)) ? Number(options.capDeg) : this.capDeg;
    this.center = { lat, lon };
    if (this.destroyed || (!wantImagery && !wantTerrain)) {
      this.settled = true;
      return;
    }
    const inFlight = [...this.tiles.values()].filter(entry => entry.requested && !entry.ready).length;
    let budget = Math.max(0, Math.min(MAX_REQUESTS_PER_PASS, MAX_IN_FLIGHT - inFlight));
    if (!budget) { this.settled = false; return; }

    /* The visible pane is everything within its own reach of the camera's
       centre. The bounding box of that cap is up to four times larger than the
       cap, so each candidate tile's own centre is measured against it. */
    const candidates = [];
    const consider = (kind, z, resolve, tileZ, tileX, tileY) => {
      const width = kind === 'imagery' ? gibsMatrix(z).width : 2 ** z;
      const height = kind === 'imagery' ? gibsMatrix(z).height : 2 ** z;
      const bounds = kind === 'imagery'
        ? gibsCoverage(z, tileX, tileY)
        : { west: (tileX / width) * 360 - 180, east: ((tileX + 1) / width) * 360 - 180, south: 90 - ((tileY + 1) / height) * 180, north: 90 - (tileY / height) * 180 };
      const tileLat = (bounds.north + bounds.south) / 2;
      const tileLon = (bounds.west + bounds.east) / 2;
      const entry = this.tiles.get(this.key(kind, tileZ, tileX, tileY));
      if (entry && (entry.ready || entry.requested)) return;
      if (sphericalDistanceDeg(lat, lon, tileLat, tileLon) > this.fetchReach(capDeg, width)) return;
      candidates.push({ kind, z: tileZ, x: tileX, y: tileY, resolve, distance: sphericalDistanceDeg(lat, lon, tileLat, tileLon) });
    };

    if (wantImagery) {
      const { zoom, width, height } = gibsMatrix(this.imageryZoom);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        consider('imagery', zoom, gibsTileUrl, zoom, x, y);
      }
    }
    if (wantTerrain) {
      const z = this.demZoom;
      const n = 2 ** z;
      for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) {
        consider('terrain', z, terrainTileUrl, z, x, y);
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    this.pending = candidates.length;
    for (const candidate of candidates) {
      if (!budget) break;
      budget -= 1;
      this.request(candidate.kind, candidate.z, candidate.x, candidate.y, candidate.resolve);
      this.pending -= 1;
    }
    this.settled = candidates.length === 0;
  }

  /**
   * Read terrain elevations around a place without changing what is drawn, so an
   * outlines globe can still answer how high the ground is. It is the pilot who
   * pays for these tiles, by asking, and the reading lands within about a dozen
   * of them however wide the radius is.
   */
  readTerrain(lat, lon, { radiusNm = 40, rasterPx = this.rasterPx } = {}) {
    this.setResolution(rasterPx);
    this.ensureAround(lat, lon, { imagery: false, terrain: true, capDeg: this.capDeg });
    this.ensureProbe(lat, lon, radiusNm);
  }

  /**
   * The tiles an elevation reading needs: the deep one under the point itself,
   * and the ring a radius scan samples, both nearest the centre first and both
   * capped. Fetching every tile a 320 NM scan touches at level 9 would be two
   * hundred requests for one number.
   */
  ensureProbe(lat, lon, radiusNm) {
    if (this.destroyed) return;
    const scanZoom = probeZoomForRadius(radiusNm);
    const wanted = [[POINT_ZOOM, lat, lon]];
    const samples = 5;
    for (let i = 0; i < samples; i += 1) {
      for (let j = 0; j < samples; j += 1) {
        const north = radiusNm - (i * (radiusNm * 2)) / (samples - 1);
        const east = -radiusNm + (j * (radiusNm * 2)) / (samples - 1);
        const point = offsetNm({ lat, lon }, north, east);
        wanted.push([scanZoom, point.lat, point.lon]);
      }
    }
    let budget = MAX_PROBE_TILES;
    const seen = new Set();
    for (const [zoom, pointLat, pointLon] of wanted) {
      if (!budget) break;
      const tile = terrainTileAt(pointLat, pointLon, zoom);
      const id = this.key('terrain', tile.z, tile.x, tile.y);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = this.tiles.get(id);
      if (entry && (entry.ready || entry.requested)) continue;
      budget -= 1;
      this.request('terrain', tile.z, tile.x, tile.y, terrainTileUrl);
    }
  }

  /**
   * One pixel from a decoded buffer, written into `out` and returned; null when
   * there is no buffer to read. Writing into the caller's array matters here:
   * a redraw reads a hundred thousand pixels, and one throwaway array each is
   * a hundred thousand allocations the collector then has to chase.
   */
  pixel(data, width, height, px, py, out = [0, 0, 0, 0]) {
    if (!data) return null;
    const x = Math.max(0, Math.min(width - 1, Math.round(px)));
    const y = Math.max(0, Math.min(height - 1, Math.round(py)));
    const index = (y * width + x) * 4;
    out[0] = data[index];
    out[1] = data[index + 1];
    out[2] = data[index + 2];
    out[3] = data[index + 3];
    return out;
  }

  /** The imagery colour at a coordinate, or null where the tile is not read. */
  imageryPixel(lat, lon, out = [0, 0, 0, 0]) {
    const geometry = this.imageryGeometry;
    const x = Math.floor((lon + 180) * geometry.xScale);
    const y = Math.floor((90 - lat) * geometry.yScale);
    if (!(x >= 0 && x < geometry.width && y >= 0 && y < geometry.height)) return null;
    const entry = this.tiles.get(this.key('imagery', geometry.zoom, x, y));
    if (!entry || !entry.ready) return null;
    const u = ((lon + 180) * geometry.xScale - x) * entry.width;
    const v = ((90 - lat) * geometry.yScale - y) * entry.height;
    return this.pixel(entry.data, entry.width, entry.height, u, v, out);
  }

  /**
   * The elevation at a coordinate in metres, from tiles already read. The point
   * is read at the deepest level that covers it, not at the coarser one the
   * globe draws with: the drawing level is chosen for a sphere a few hundred
   * pixels wide, and would turn a mountain into an average of the range.
   */
  elevationAt(lat, lon) {
    if (!validLatLon(lat, lon)) return null;
    const raw = this.rawAt(POINT_ZOOM, lat, lon);
    return raw === null ? null : raw;
  }

  /**
   * Bilinear elevation in metres from the terrain mosaic, or null when the tile
   * holding the point has not been read. Neighbours are resolved through the
   * tile grid, so a point near a tile edge still reads a real elevation.
   */
  rawAt(zoom, lat, lon) {
    const z = Math.max(0, Math.min(TERRAIN.maxZoom, Math.round(zoom)));
    const n = 2 ** z;
    const tile = terrainTileAt(lat, lon, z);
    const entry = this.tiles.get(this.key('terrain', z, tile.x, tile.y));
    if (!entry || !entry.ready) return null;
    const fx = ((lon + 180) / 360) * n * entry.width - tile.x * entry.width;
    // The row inside the tile is Mercator, like the tile grid itself: reading it
    // as an even division would sample a different latitude entirely — tens of
    // rows away by mid-latitude — and report that height as this one's.
    const fy = mercatorFraction(lat) * n * entry.height - tile.y * entry.height;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    // The neighbours are read by *global* pixel coordinate, so the tile's own
    // origin has to be added: without it every sample resolves against the
    // first tile of the world and a reading on the other side of the planet
    // comes back missing.
    const read = (gx, gy) => this.terrariumAt(z, tile.x * entry.width + gx, tile.y * entry.height + gy);
    const a = read(x0, y0);
    const b = read(x0 + 1, y0);
    const c = read(x0, y0 + 1);
    const d = read(x0 + 1, y0 + 1);
    if (a === null || b === null || c === null || d === null) return a ?? b ?? c ?? d;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /** One terrarium pixel by *global* pixel coordinate, across tile borders. */
  terrariumAt(zoom, gx, gy) {
    const size = TERRAIN.tilePixels;
    const z = Math.max(0, Math.min(TERRAIN.maxZoom, Math.round(zoom)));
    const n = 2 ** z;
    const max = n * size;
    let x = ((gx % max) + max) % max;
    let y = Math.max(0, Math.min(max - 1, gy));
    const tileX = Math.floor(x / size);
    const tileY = Math.floor(y / size);
    const entry = this.tiles.get(this.key('terrain', z, tileX, tileY));
    if (!entry || !entry.ready) return null;
    const index = ((y - tileY * size) * entry.width + (x - tileX * size)) * 4;
    if (index < 0 || index + 2 >= entry.data.length) return null;
    return decodeTerrarium(entry.data[index], entry.data[index + 1], entry.data[index + 2]);
  }

  /**
   * The shaded tile for a terrain tile, computed once per surface and kept.
   * Keyed by the surface as well as the tile: relief and elevation are two
   * different pictures of the same ground, and reusing one for the other is how
   * choosing Elevation ends up showing the grey relief it just replaced.
   */
  shadedTerrain(entry) {
    if (!entry || !entry.ready) return null;
    if (entry.shaded && entry.shaded.style === this.styleId) return entry.shaded;
    const zoom = entry.z;
    const size = entry.width;
    // The tile's own top edge in degrees, for the metres-per-pixel scale.
    const lat = 90 - (entry.y / (2 ** zoom)) * 180;
    const metresPerPixel = Math.max(1, terrainMetresPerPixel(zoom, lat));
    const elevation = (x, y) => this.terrariumAt(zoom, entry.x * size + x, entry.y * size + y);
    entry.shaded = {
      style: this.styleId,
      width: entry.width,
      height: entry.height,
      data: shadeTerrainTile({
        width: entry.width,
        height: entry.height,
        metresPerPixel,
        style: this.styleId === 'elevation' ? 'elevation' : 'relief',
        elevation,
      }),
    };
    return entry.shaded;
  }

  /** Terrain colour at a coordinate, from the shaded tile under it, or null. */
  terrainPixel(lat, lon, out = [0, 0, 0, 0]) {
    const geometry = this.terrainGeometry;
    const tile = terrainTileAt(lat, lon, geometry.zoom);
    const entry = this.tiles.get(this.key('terrain', geometry.zoom, tile.x, tile.y));
    const shaded = this.shadedTerrain(entry);
    if (!shaded) return null;
    const u = (lon + 180) * geometry.xScale * entry.width - tile.x * entry.width;
    const v = mercatorFraction(lat) * geometry.n * entry.height - tile.y * entry.height;
    return this.pixel(shaded.data, shaded.width, shaded.height, u, v, out);
  }

  /**
   * The colour the globe paints for a coordinate, written into `out`, or null
   * where nothing is read yet — the caller draws its own flat base colour
   * rather than a guess.
   */
  sample(lat, lon, out = [0, 0, 0, 0]) {
    if (this.styleId === 'imagery') return this.imageryPixel(lat, lon, out);
    if (this.needsTerrain()) return this.terrainPixel(lat, lon, out);
    return null;
  }

  /**
   * The highest terrain inside a great-circle radius, from tiles already read.
   * A grid of samples, not a claim about every square metre: the count of
   * samples that hit unloaded ground is reported alongside the answer so the
   * interface can say how complete it is.
   */
  highestNear(lat, lon, radiusNm, grid = 5) {
    if (!validLatLon(lat, lon) || !(radiusNm > 0)) return null;
    let max = null;
    let at = null;
    let min = null;
    let read = 0;
    let total = 0;
    // The scan reads the level its own sample spacing justifies, which is the
    // same level `ensureProbe` fetched tiles for — so a scan never fetches.
    const zoom = probeZoomForRadius(radiusNm);
    const stepNm = (radiusNm * 2) / (grid - 1);
    for (let i = 0; i < grid; i += 1) {
      for (let j = 0; j < grid; j += 1) {
        const north = radiusNm - i * stepNm;
        const east = -radiusNm + j * stepNm;
        const point = offsetNm({ lat, lon }, north, east);
        const metres = this.rawAt(zoom, point.lat, point.lon);
        total += 1;
        if (metres === null) continue;
        read += 1;
        if (min === null || metres < min) min = metres;
        if (max === null || metres > max) { max = metres; at = point; }
      }
    }
    if (!read) return null;
    return { maxMetres: max, minMetres: min, at, read, total, partial: read < total, zoom, grid };
  }

  /** What is actually loaded, in words the interface can print unedited. */
  stats() {
    const ready = [...this.tiles.values()].filter(entry => entry.ready);
    const imagery = ready.filter(entry => entry.kind === 'imagery');
    const terrain = ready.filter(entry => entry.kind === 'terrain');
    const waiting = [...this.tiles.values()].filter(entry => entry.requested && !entry.ready).length;
    return {
      style: this.styleId,
      imageryTiles: imagery.length,
      terrainTiles: terrain.length,
      waiting,
      failed: this.failed,
      failedReasons: [...this.failedReasons],
      imageryZoom: this.imageryZoom,
      demZoom: this.demZoom,
      pointZoom: POINT_ZOOM,
      rasterPx: this.rasterPx,
      imageryMetresPerPixel: (360 / (gibsMatrix(this.imageryZoom).width * GIBS.tilePixels)) * 111320,
      terrainMetresPerPixel: terrainMetresPerPixel(this.demZoom, this.center.lat),
      pointMetresPerPixel: terrainMetresPerPixel(POINT_ZOOM, this.center.lat),
      pending: this.pending || 0,
    };
  }

  /** The source lines for the chart readout, or an empty list for outlines. */
  notes() {
    const stats = this.stats();
    if (this.styleId === 'imagery') {
      return [
        `${GIBS.attribution}. ${GIBS.terms}`,
        `Level ${stats.imageryZoom} of the GIBS 4326 pyramid, about ${Math.round(stats.imageryMetresPerPixel)} m per pixel at the equator · ${stats.imageryTiles} tile${stats.imageryTiles === 1 ? '' : 's'} read${stats.waiting ? `, ${stats.waiting} on the way` : ''}${stats.failed ? `, ${stats.failed} failed` : ''}.`,
      ];
    }
    if (this.needsTerrain()) {
      return [
        `${TERRAIN.attribution}. ${TERRAIN.displayOnly}`,
        stats.terrainTiles
          ? `Terrain drawn at level ${stats.demZoom} (about ${Math.round(stats.terrainMetresPerPixel)} m per pixel here), elevations read at level ${stats.pointZoom} (about ${Math.round(stats.pointMetresPerPixel)} m per pixel) · ${stats.terrainTiles} tile${stats.terrainTiles === 1 ? '' : 's'} read${stats.waiting ? `, ${stats.waiting} on the way` : ''}${stats.failed ? `, ${stats.failed} failed` : ''}. ${TERRAIN.terms}`
          : `No terrain tile is read yet${stats.waiting ? `; ${stats.waiting} is on the way` : ''}. ${TERRAIN.terms}`,
      ];
    }
    return ['Outlines only: bundled Natural Earth 1:110m country outlines. No imagery or terrain is loaded.'];
  }

  destroy() {
    this.destroyed = true;
    for (const entry of this.tiles.values()) if (entry.image) entry.image.onload = entry.image.onerror = null;
    this.tiles.clear();
  }
}

/** Great-circle separation in degrees between two coordinates. */
function sphericalDistanceDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dLam = (lon2 - lon1) * DEG;
  const cos = Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
}

/** A point offset north and east in nautical miles, for the terrain grid. */
export function offsetNm({ lat, lon }, northNm, eastNm) {
  const lat2 = Math.max(-90, Math.min(90, lat + northNm / 60));
  const scale = Math.max(0.2, Math.cos(lat2 * DEG));
  const lon2 = ((lon + eastNm / (60 * scale) + 540) % 360) - 180;
  return { lat: lat2, lon: lon2 };
}
