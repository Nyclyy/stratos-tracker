#!/usr/bin/env node
/* Reproducible in-process benchmark for Stratos's data path.
   It measures the pure functions that run on every live frame or logbook
   refresh. It does not measure simulator FPS or Electron rendering; see
   PERFORMANCE.md for those instructions. */

import { performance } from 'node:perf_hooks';
import { prepareReplay, sampleAt, simplifyTrack } from '../app/js/lib/replay.js';
import { summarizeLandings } from '../app/js/lib/landing.js';
import { computeCareer } from '../app/js/lib/stats.js';
import { routeTotals } from '../app/js/lib/planner.js';

function track(points) {
  const rows = [];
  let lat = 37.6;
  let lon = -122.3;
  const start = Date.now() - points * 4000;
  for (let i = 0; i < points; i++) {
    rows.push({
      t: start + i * 4000,
      lat,
      lon,
      alt: 3000 + Math.sin(i / 80) * 2500,
      gs: 240 + Math.sin(i / 60) * 30,
      hdg: 90 + Math.sin(i / 90) * 20,
      vs: Math.cos(i / 80) * 900,
    });
    lat += 0.0008 + Math.sin(i / 120) * 0.00045;
    lon += 0.0011 + Math.cos(i / 95) * 0.00035;
  }
  return rows;
}

function flights(count) {
  const output = [];
  for (let i = 0; i < count; i++) {
    const takeoff = Date.now() - i * 86400000;
    const landing = takeoff + 5400000;
    output.push({
      id: `bench-${i}`,
      complete: true,
      startTime: takeoff,
      takeoffTime: takeoff,
      landingTime: landing,
      depAirport: i % 3 === 0 ? 'KSFO' : 'KLAX',
      arrAirport: i % 3 === 0 ? 'KLAX' : 'KJFK',
      aircraft: i % 4 === 0 ? 'B738' : 'A320',
      distanceNm: 400 + (i % 120),
      maxAlt: 35000,
      track: track(60),
      landing: { vsFpm: -(80 + (i % 300)), gsKt: 132, runway: { id: '28L', distanceFromThresholdFt: 1200 } },
    });
  }
  return output;
}

function measure(label, iterations, fn) {
  for (let i = 0; i < Math.min(20, iterations); i++) fn(i);
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const elapsed = performance.now() - started;
  const per = elapsed / iterations;
  console.log(`${label.padEnd(38)} ${iterations.toString().padStart(7)} ops  ${elapsed.toFixed(1).padStart(9)} ms  ${per.toFixed(4).padStart(10)} ms/op  ${Math.round(1000 / per).toLocaleString().padStart(12)} ops/s`);
  return { label, iterations, elapsed, per };
}

console.log(`Stratos data-path benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log('');

const rows = track(12000);
const prepared = prepareReplay({ id: 'bench', track: rows });
const career = flights(2000);

const results = [
  measure('normalize + simplify 12k-point track', 20, () => prepareReplay({ id: 'bench', track: rows })),
  measure('sample prepared 12k track', 2000, i => sampleAt(prepared, prepared.start + ((i * 971) % prepared.durationMs))),
  measure('simplify 12k track only', 20, () => simplifyTrack(rows, 0.012)),
  measure('summarize landings (2,000 flights)', 20, () => summarizeLandings(career)),
  measure('career totals (2,000 flights)', 20, () => computeCareer(career)),
  measure('route totals (25 waypoints)', 20000, () => routeTotals([
    { id: 'KSFO', lat: 37.6188, lon: -122.3754 },
    { id: 'KLAX', lat: 33.9425, lon: -118.4081 },
    { id: 'KJFK', lat: 40.6398, lon: -73.7789 },
  ])),
];

console.log('');
console.log('Replay index:', `${prepared.simplifiedPoints} rendered points from ${rows.length} recorded samples`, `(${Math.round((1 - prepared.simplifiedPoints / rows.length) * 100)}% reduction)`);
console.log('Heap used:', `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MiB`);
console.log('');
console.log('These numbers exclude browser layout, canvas painting and the simulator bridge.');
console.log('Run the same file on the same machine before and after a change. Do not compare across machines.');
