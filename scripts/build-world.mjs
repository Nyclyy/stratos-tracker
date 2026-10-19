#!/usr/bin/env node
/* Build the bundled world layer: country outlines, country label points,
   continent labels and ocean labels.

   Data: Natural Earth 1:110m cultural and physical vectors, which are in the
   public domain (see SOURCES_AND_LICENSING.md). Nothing here is hand-drawn.

   Usage:
     node scripts/build-world.mjs                 # reads ./tmp-natural-earth
     node scripts/build-world.mjs --download      # fetches the three GeoJSON files first
     node scripts/build-world.mjs --in DIR

   Output: app/js/data/world.js — a plain script that assigns window.STRATOS_WORLD.
   It is a script rather than a module because the tracker is a classic inline
   script and must also work when the app is opened from file://, where module
   loading and fetch of sibling files are blocked by the browser.

   The output is deliberately small: coordinates are flattened, rounded to two
   decimals (about 1 km, far below what a screen pixel resolves at these zooms)
   and reduced with Douglas–Peucker. Total payload is reported at the end. */

import fs from 'node:fs';
import path from 'node:path';

const SOURCES = {
  countries: 'ne_110m_admin_0_countries.geojson',
  regions: 'ne_110m_geography_regions_polys.geojson',
  oceans: 'ne_110m_geography_marine_polys.geojson',
};
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
// The continent polygons carry the continent name in NAME; REGION holds the
// continent for every region (Sahara, the Alps, ...), so it cannot be used as
// the filter.
const CONTINENT_NAMES = new Set(['AFRICA', 'ANTARCTICA', 'ASIA', 'EUROPE', 'NORTH AMERICA', 'SOUTH AMERICA', 'AUSTRALIA']);
const titleCase = value => value === value.toUpperCase()
  ? value.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
  : value;

const args = process.argv.slice(2);
const wantDownload = args.includes('--download');
const inDir = (() => {
  const index = args.indexOf('--in');
  return index >= 0 && args[index + 1] ? args[index + 1] : path.join(process.cwd(), 'tmp-natural-earth');
})();
const outFile = path.join(process.cwd(), 'app/js/data/world.js');

async function ensureInputs() {
  fs.mkdirSync(inDir, { recursive: true });
  for (const file of Object.values(SOURCES)) {
    const target = path.join(inDir, file);
    if (fs.existsSync(target)) continue;
    if (!wantDownload) {
      throw new Error(`Missing ${target}. Re-run with --download, or place the Natural Earth GeoJSON there.`);
    }
    process.stdout.write(`downloading ${file} ... `);
    const response = await fetch(`${BASE}/${file}`);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    console.log('ok');
  }
}

const read = name => JSON.parse(fs.readFileSync(path.join(inDir, SOURCES[name]), 'utf8'));

/** Squared distance from a point to a segment, in degrees. */
function segDist2(px, py, ax, ay, bx, by) {
  let x = ax, y = ay, dx = bx - ax, dy = by - ay;
  if (dx || dy) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  return (px - x) ** 2 + (py - y) ** 2;
}

/** Douglas–Peucker on a flat [x,y,x,y,...] ring. */
function simplifyFlat(flat, tolerance) {
  const count = flat.length / 2;
  if (count < 4) return flat;
  const keep = new Uint8Array(count);
  keep[0] = keep[count - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack = [[0, count - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = -1, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(flat[i * 2], flat[i * 2 + 1], flat[first * 2], flat[first * 2 + 1], flat[last * 2], flat[last * 2 + 1]);
      if (d > worst) { worst = d; index = i; }
    }
    if (worst > tol2 && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < count; i++) if (keep[i]) out.push(flat[i * 2], flat[i * 2 + 1]);
  return out;
}

/** Ring area in square degrees, used to rank rings and to drop slivers. */
function ringArea(flat) {
  let sum = 0;
  const count = flat.length / 2;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    sum += (flat[j * 2] * flat[i * 2 + 1]) - (flat[i * 2] * flat[j * 2 + 1]);
  }
  return Math.abs(sum) / 2;
}

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function prepareRings(geometry, tolerance, minArea) {
  const prepared = [];
  for (const ring of ringsOf(geometry)) {
    // Round first so duplicates collapse, then simplify what is left.
    const rounded = [];
    for (const [lon, lat] of ring) {
      const x = Math.round(lon * 100) / 100, y = Math.round(lat * 100) / 100;
      if (rounded.length && rounded[rounded.length - 2] === x && rounded[rounded.length - 1] === y) continue;
      rounded.push(x, y);
    }
    const simplified = simplifyFlat(rounded, tolerance);
    if (simplified.length < 8) continue;
    prepared.push({ flat: simplified, area: ringArea(simplified) });
  }
  if (!prepared.length) return [];
  prepared.sort((a, b) => b.area - a.area);
  // Keep the largest ring whatever its size; drop only true slivers after it.
  return prepared.filter((ring, index) => index === 0 || ring.area >= minArea).map(ring => ring.flat);
}

/** A label point that sits inside a ring: the "pole of inaccessibility" is
    overkill here, so use the centroid of the largest ring and accept it. */
function labelPoint(rings) {
  const flat = rings[0];
  let sx = 0, sy = 0;
  const count = flat.length / 2;
  for (let i = 0; i < count; i++) { sx += flat[i * 2]; sy += flat[i * 2 + 1]; }
  return [Math.round((sx / count) * 100) / 100, Math.round((sy / count) * 100) / 100];
}

const round2 = value => Math.round(value * 100) / 100;

async function main() {
  await ensureInputs();

  // ── Countries ──────────────────────────────────────────────────────
  const countrySource = read('countries');
  const countries = [];
  for (const feature of countrySource.features) {
    const props = feature.properties || {};
    const name = props.NAME_EN || props.NAME;
    if (!name) continue;
    const rings = prepareRings(feature.geometry, 0.06, 0.02);
    if (!rings.length) continue;
    const label = Number.isFinite(props.LABEL_X) && Number.isFinite(props.LABEL_Y)
      ? [round2(props.LABEL_X), round2(props.LABEL_Y)]
      : labelPoint(rings);
    countries.push({
      n: name,
      c: props.CONTINENT || '',
      k: Number(props.LABELRANK) || 8,
      x: label[0],
      y: label[1],
      p: rings,
    });
  }

  // ── Continents ─────────────────────────────────────────────────────
  const regionSource = read('regions');
  const continents = [];
  for (const feature of regionSource.features) {
    const props = feature.properties || {};
    const name = String(props.NAME || '').toUpperCase();
    if (!CONTINENT_NAMES.has(name)) continue;
    const rings = prepareRings(feature.geometry, 0.2, 2);
    if (!rings.length) continue;
    const [x, y] = labelPoint(rings);
    continents.push({ n: titleCase(name), x, y });
  }

  // ── Oceans and seas ────────────────────────────────────────────────
  const oceanSource = read('oceans');
  const oceans = [];
  for (const feature of oceanSource.features) {
    const props = feature.properties || {};
    // props.name keeps the precise wording ("North Atlantic Ocean"); name_en
    // flattens it to "Atlantic Ocean". Only the casing needs normalising.
    const name = titleCase(String(props.name || props.name_en || ''));
    if (!name) continue;
    const rings = prepareRings(feature.geometry, 0.25, 1.5);
    if (!rings.length) continue;
    const [x, y] = labelPoint(rings);
    oceans.push({ n: name, r: Number(props.scalerank) || 0, x, y });
  }

  const payload = { countries, continents, oceans };
  const body = JSON.stringify(payload);
  const output = `/* Stratos world layer. Generated by scripts/build-world.mjs - do not edit by hand.
   Source: Natural Earth 1:110m (public domain, naturalearthdata.com).
   Country outlines and label points, continent labels and ocean labels, flattened
   and rounded to two decimals. Loaded as a plain script so the tracker works
   from file:// as well as from the bridge. */
(function (root) {
  root.STRATOS_WORLD = ${body};
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
  fs.writeFileSync(outFile, output);

  const kb = (value) => `${(value / 1024).toFixed(0)} KB`;
  console.log(`countries ${countries.length} (${countries.reduce((n, c) => n + c.p.reduce((m, r) => m + r.length / 2, 0), 0)} points)`);
  console.log(`continents ${continents.length}: ${continents.map(c => c.n).join(', ')}`);
  console.log(`oceans ${oceans.length}`);
  console.log(`wrote ${outFile} (${kb(Buffer.byteLength(output))})`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
