/* The bundled aircraft performance database.
 *
 * One versioned JSON file ships with Stratos. It is loaded from the app, never
 * from a user file, and every profile names the record it came from. The
 * database is deliberately small: the FAA Aircraft Characteristics Database
 * publishes weight limits and an airport-planning approach speed, but no
 * takeoff or landing distance. Those axes are marked unsupported in the data,
 * not filled with an estimate.
 *
 * A profile may carry a licensed table later. That table is validated here and
 * interpolated by the engine; no table is shipped today.
 */

import rawDatabase from '../data/performance-profiles.json' with { type: 'json' };

export const DB_SCHEMA = 'stratos.performance-db/1';

const VERIFICATIONS = new Set(['verified', 'unverified']);
const STATUSES = new Set(['supported', 'unsupported']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function ascending(values) {
  if (!Array.isArray(values) || values.length < 2) return false;
  let previous = -Infinity;
  for (const value of values) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= previous) return false;
    previous = number;
  }
  return true;
}

function range(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const low = Number(value[0]);
  const high = Number(value[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
  return [low, high];
}

/** Validate one licensed field-length table, shape and values. */
function checkTable(problems, name, table, profileId) {
  if (!isObject(table)) {
    problems.push(`${profileId}: ${name}.table must be an object.`);
    return;
  }
  const axes = table.axes || {};
  for (const axis of ['weightKg', 'pressureAltitudeFt', 'oatC']) {
    if (!ascending(axes[axis])) problems.push(`${profileId}: ${name}.table.axes.${axis} must be two or more ascending numbers.`);
  }
  for (const key of ['distanceFt', 'groundRollFt', 'requiredRunwayFt', 'v1Kt', 'vrKt', 'v2Kt']) {
    if (table[key] === undefined) continue;
    if (!Array.isArray(table[key])) {
      problems.push(`${profileId}: ${name}.table.${key} must be a 3-D array.`);
    }
  }
}

function checkPhase(problems, profile, phase) {
  const part = profile[phase];
  if (!isObject(part)) {
    problems.push(`${profile.id}: ${phase} is required.`);
    return;
  }
  if (!STATUSES.has(part.status)) {
    problems.push(`${profile.id}: ${phase}.status must be supported or unsupported.`);
    return;
  }
  if (part.status === 'unsupported' && !String(part.reason || '').trim()) {
    problems.push(`${profile.id}: ${phase} is unsupported but gives no reason.`);
  }
  if (part.table) checkTable(problems, phase, part.table, profile.id);
  if (part.status === 'supported' && !part.table) {
    problems.push(`${profile.id}: ${phase} is supported but has no table.`);
  }
  if (part.vrefKt !== undefined && !positive(part.vrefKt)) {
    problems.push(`${profile.id}: ${phase}.vrefKt must be positive.`);
  }
}

/** Parse and validate the database. Nothing is repaired or defaulted. */
export function parseDatabase(raw) {
  const problems = [];
  if (!isObject(raw)) throw new Error('The bundled performance database is not a JSON object.');
  if (raw.schema !== DB_SCHEMA) problems.push(`schema must be "${DB_SCHEMA}".`);
  if (!String(raw.version || '').trim()) problems.push('version is required.');
  if (!String(raw.released || '').trim()) problems.push('released is required.');
  if (!isObject(raw.source) || !String(raw.source.name || '').trim()) problems.push('source.name is required.');
  if (!isObject(raw.units)) problems.push('units is required.');
  if (!Array.isArray(raw.profiles) || !raw.profiles.length) problems.push('profiles must be a non-empty array.');

  const ids = new Set();
  const icaos = new Set();
  for (const profile of Array.isArray(raw.profiles) ? raw.profiles : []) {
    if (!isObject(profile)) {
      problems.push('Every profile must be an object.');
      continue;
    }
    const id = String(profile.id || '').trim();
    if (!id) problems.push('A profile has no id.');
    else if (ids.has(id)) problems.push(`Duplicate profile id ${id}.`);
    else ids.add(id);

    for (const key of ['manufacturer', 'name', 'icao']) {
      if (!String(profile[key] || '').trim()) problems.push(`${id || 'profile'}: ${key} is required.`);
    }
    const icao = String(profile.icao || '').trim().toUpperCase();
    if (icao && !/^[A-Z0-9]{3,4}$/.test(icao)) problems.push(`${id}: icao must be a 3–4 character designator.`);
    if (icao && icaos.has(icao)) problems.push(`Duplicate ICAO type ${icao}.`);
    if (icao) icaos.add(icao);

    if (!VERIFICATIONS.has(profile.verification)) problems.push(`${id}: verification must be verified or unverified.`);
    if (!isObject(profile.source) || !String(profile.source.name || '').trim() || !String(profile.source.record || '').trim()) {
      problems.push(`${id}: source.name and source.record are required.`);
    }
    if (!isObject(profile.units) || !profile.units.weight || !profile.units.distance || !profile.units.speed) {
      problems.push(`${id}: units.weight, distance and speed are required.`);
    }
    if (!isObject(profile.match) || !Array.isArray(profile.match.text)) {
      problems.push(`${id}: match.text must be an array.`);
    }
    const mtow = positive(profile.limits && profile.limits.mtowKg);
    const mlw = positive(profile.limits && profile.limits.mlwKg);
    if (!mtow || !mlw) problems.push(`${id}: limits.mtowKg and limits.mlwKg are required.`);
    else if (mlw > mtow) problems.push(`${id}: limits.mlwKg cannot exceed mtowKg.`);
    const operating = profile.operatingRange || {};
    if (!range(operating.weightKg) || !range(operating.pressureAltitudeFt) || !range(operating.oatC)) {
      problems.push(`${id}: operatingRange needs weightKg, pressureAltitudeFt and oatC [min, max].`);
    }
    const corrections = profile.corrections || {};
    if (corrections.status !== 'unsupported') {
      problems.push(`${id}: corrections.status must be unsupported; no correction model is bundled.`);
    }
    if (!Array.isArray(corrections.axes) || !corrections.axes.length) {
      problems.push(`${id}: corrections.axes must be a non-empty array.`);
    }
    if (!String(corrections.reason || '').trim()) {
      problems.push(`${id}: corrections must give a reason.`);
    }
    checkPhase(problems, profile, 'takeoff');
    checkPhase(problems, profile, 'landing');
  }

  if (problems.length) {
    const error = new Error(`The bundled performance database is invalid: ${problems.slice(0, 3).join(' ')}`);
    error.problems = problems;
    throw error;
  }
  return raw;
}

let database = null;

/** Validate and load the bundled database once. */
export function loadDatabase() {
  if (!database) database = parseDatabase(rawDatabase);
  return database;
}

export function profileById(database, id) {
  return (database && database.profiles || []).find(profile => profile.id === id) || null;
}

export function profileByIcao(database, icao) {
  const wanted = String(icao || '').trim().toUpperCase();
  if (!wanted) return null;
  return (database && database.profiles || []).find(profile => profile.icao === wanted) || null;
}

export function profileLabel(profile) {
  return profile ? `${profile.manufacturer} ${profile.name}` : '';
}
