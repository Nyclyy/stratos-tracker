/* Aircraft checklist engine.

   Pure functions only: no DOM, no storage, no simulator access. The UI and the
   bridge both use this module so the desktop and the paired phone agree on
   which profile is active, which section is next and how far through it is.

   Auto-completion is deliberately absent. The available telemetry (position,
   altitude, groundspeed, vertical speed, on-ground) cannot prove that a
   checklist item was performed, so nothing here marks an item complete on its
   own. Phase inference is a suggestion the pilot can override. */

import { CHECKLIST_PROFILES, CHECKLIST_PHASES, GENERIC_PROFILE } from '../data/checklists.js';

export { CHECKLIST_PROFILES, CHECKLIST_PHASES, GENERIC_PROFILE };

const PHASE_LABEL = new Map(CHECKLIST_PHASES.map(phase => [phase.key, phase.label]));

export function phaseLabel(key) {
  return PHASE_LABEL.get(key) || 'Unknown phase';
}

/** The profile for a key, falling back to the generic checklist. */
export function profileByKey(key) {
  if (!key) return null;
  if (key === GENERIC_PROFILE.key) return GENERIC_PROFILE;
  return CHECKLIST_PROFILES.find(profile => profile.key === key) || null;
}

/**
 * Match a reported aircraft name against the bundled profiles.
 * Returns { profileKey, label, confidence, reason }. `confidence` is 'none'
 * when nothing matched, so the UI asks the pilot to choose instead of guessing.
 */
export function detectAircraft({ aircraft = '', src = '' } = {}, profiles = CHECKLIST_PROFILES) {
  const label = String(aircraft || '').trim();
  const simulator = /x-?plane/i.test(String(src)) ? 'X-Plane' : /msfs|simconnect|microsoft/i.test(String(src)) ? 'MSFS' : (src || '');
  if (!label) {
    return {
      profileKey: null,
      label: 'Aircraft not reported',
      simulator,
      confidence: 'none',
      reason: 'The simulator did not report an aircraft name. Choose the aircraft manually.',
    };
  }
  for (const profile of profiles) {
    for (const pattern of profile.detect || []) {
      if (pattern.test(label)) {
        return {
          profileKey: profile.key,
          label: profile.label,
          reported: label,
          simulator: simulator || profile.simulator,
          confidence: 'high',
          reason: `Matched "${label}" to ${profile.label}.`,
        };
      }
    }
  }
  return {
    profileKey: null,
    label,
    reported: label,
    simulator,
    confidence: 'none',
    reason: `"${label}" did not match a bundled profile. Choose an aircraft or use the generic checklist.`,
  };
}

/** Sections of one kind, in flight order. */
export function sectionsOf(profile, kind = 'normal') {
  if (!profile) return [];
  return (profile.sections || []).filter(section => section.kind === kind);
}

/** Stable item keys: section key plus position. */
export function itemKey(sectionKey, index) {
  return `${sectionKey}.${index}`;
}

export function allItems(profile, kind = 'normal') {
  const rows = [];
  for (const section of sectionsOf(profile, kind)) {
    section.items.forEach((item, index) => {
      rows.push({ sectionKey: section.key, sectionTitle: section.title, index, key: itemKey(section.key, index), ...item });
    });
  }
  return rows;
}

function checked(checks, key) {
  return Boolean(checks && checks[key]);
}

/** Per-section and overall progress. Emergency items are reported separately. */
export function progressOf(profile, checks = {}) {
  const normal = sectionsOf(profile, 'normal');
  const bySection = normal.map(section => {
    const done = section.items.filter((_, index) => checked(checks, itemKey(section.key, index))).length;
    return {
      key: section.key,
      title: section.title,
      phase: section.phase,
      total: section.items.length,
      done,
      complete: section.items.length > 0 && done === section.items.length,
    };
  });
  const total = bySection.reduce((sum, row) => sum + row.total, 0);
  const done = bySection.reduce((sum, row) => sum + row.done, 0);
  const collect = kind => sectionsOf(profile, kind).map(section => ({
    key: section.key,
    title: section.title,
    total: section.items.length,
    done: section.items.filter((_, index) => checked(checks, itemKey(section.key, index))).length,
  }));
  return {
    total,
    done,
    remaining: total - done,
    percent: total ? Math.round((done / total) * 100) : 0,
    bySection,
    supplementary: collect('supplementary'),
    emergency: collect('emergency'),
    complete: total > 0 && done === total,
  };
}

/** The next normal section with an unchecked item, from the current one on. */
export function nextIncompleteSection(profile, checks = {}, fromKey = null) {
  const sections = sectionsOf(profile, 'normal');
  const start = fromKey ? Math.max(0, sections.findIndex(section => section.key === fromKey)) : 0;
  const ordered = [...sections.slice(start), ...sections.slice(0, start)];
  for (const section of ordered) {
    const incomplete = section.items.findIndex((_, index) => !checked(checks, itemKey(section.key, index)));
    if (incomplete !== -1) return { section, itemIndex: incomplete };
  }
  return null;
}

/**
 * Infer a flight phase from telemetry the bridge actually provides. The result
 * is a suggestion: engine, gear and parking-brake state are not in the stream,
 * so the confidence is 'inferred', never 'certain'.
 */
export function inferPhase(telemetry, previous = 'dispatch') {
  if (!telemetry) return { key: previous || 'dispatch', confidence: 'none', reason: 'No telemetry yet.' };
  const onGround = telemetry.onGround === true || (telemetry.agl != null && telemetry.agl < 30);
  const gs = Number(telemetry.gs) || 0;
  const vs = Number(telemetry.vs) || 0;
  const agl = Number(telemetry.agl);
  if (onGround) {
    // Coming back from an airborne phase is a landing, not a new taxi-out.
    if (/cruise|descent|climb/.test(String(previous)) && gs >= 3) {
      return { key: 'afterLanding', confidence: 'inferred', reason: 'On the ground after an airborne phase.' };
    }
    if (gs < 3) return { key: 'parked', confidence: 'inferred', reason: 'On the ground, stationary.' };
    if (gs >= 40) return { key: 'takeoff', confidence: 'inferred', reason: 'On the ground above 40 kt.' };
    return { key: 'taxi', confidence: 'inferred', reason: 'On the ground and moving.' };
  }
  if (vs > 400 || (Number.isFinite(agl) && agl < 2500 && vs > 150)) {
    return { key: 'climb', confidence: 'inferred', reason: 'Airborne and climbing.' };
  }
  if (vs < -400) return { key: 'descent', confidence: 'inferred', reason: 'Airborne and descending.' };
  return { key: 'cruise', confidence: 'inferred', reason: 'Airborne with little vertical speed.' };
}

/* The phase keys above are coarse; these are the checklist sections each one
   should surface. Manual selection always wins. */
const PHASE_TO_SECTION = {
  parked: ['beforeStart', 'engineStart', 'afterStart', 'shutdown'],
  taxi: ['taxi', 'beforeTakeoff'],
  takeoff: ['beforeTakeoff', 'takeoff', 'climb'],
  climb: ['takeoff', 'climb', 'cruise'],
  cruise: ['cruise', 'descentPrep'],
  descent: ['descentPrep', 'approachBrief', 'approach'],
  afterLanding: ['afterLanding', 'taxiIn', 'parking', 'shutdown'],
};

/**
 * Recommend a section for an inferred phase, skipping sections already done.
 * Returns { key, title, reason } or null when the profile has no match.
 */
export function recommendSection(profile, telemetry, checks = {}, phaseOverride = null, previousPhase = null) {
  if (!profile) return null;
  const phase = phaseOverride || inferPhase(telemetry, previousPhase).key;
  const candidates = PHASE_TO_SECTION[phase] || [];
  const sections = sectionsOf(profile, 'normal');
  for (const key of candidates) {
    const section = sections.find(entry => entry.phase === key);
    if (!section) continue;
    const incomplete = section.items.some((_, index) => !checked(checks, itemKey(section.key, index)));
    if (incomplete) return { key: section.key, title: section.title, reason: `Suggested for the ${phaseLabel(phase).toLowerCase()} phase.` };
  }
  const next = nextIncompleteSection(profile, checks, candidates[candidates.length - 1]);
  return next ? { key: next.section.key, title: next.section.title, reason: 'Next section with open items.' } : null;
}

/**
 * Progress belongs to a flight. When the bridge reports a flight id the key
 * changes with the flight, so completed items never roll into the next sector.
 * Without a flight id, the key is per aircraft and UTC day and the UI offers an
 * explicit reset.
 */
export function flightKeyFor({ flightId = null, profileKey = 'generic', now = Date.now() } = {}) {
  if (flightId) return `flight:${flightId}`;
  const day = new Date(now).toISOString().slice(0, 10);
  return `ground:${profileKey}:${day}`;
}

/** Keep only string keys with boolean true values; stored data is untrusted. */
export function sanitizeChecks(raw, limit = 4000) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= limit) break;
    if (typeof key !== 'string' || key.length > 80) continue;
    if (value === true) { out[key] = true; count++; }
  }
  return out;
}

/** A checklist state object safe to store or send to a paired phone. */
export function makeState({ profileKey, flightKey, checks, activeSection = null, revision = 0, updatedAt = Date.now() } = {}) {
  return {
    profileKey: profileKey || null,
    flightKey: flightKey || null,
    checks: sanitizeChecks(checks),
    activeSection: typeof activeSection === 'string' ? activeSection.slice(0, 60) : null,
    revision: Number.isFinite(Number(revision)) ? Number(revision) : 0,
    updatedAt: Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : Date.now(),
  };
}

/**
 * Two clients (PC and phone) exchange whole states. The higher revision wins;
 * a tie goes to the newer timestamp. Returns { state, source }.
 */
export function mergeChecklistStates(local, remote) {
  const a = makeState(local || {});
  const b = makeState(remote || {});
  if (!b.flightKey) return { state: a, source: 'local' };
  if (!a.flightKey) return { state: b, source: 'remote' };
  if (b.flightKey !== a.flightKey) {
    return b.updatedAt > a.updatedAt ? { state: b, source: 'remote' } : { state: a, source: 'local' };
  }
  if (b.revision > a.revision) return { state: b, source: 'remote' };
  if (b.revision < a.revision) return { state: a, source: 'local' };
  return b.updatedAt > a.updatedAt ? { state: b, source: 'remote' } : { state: a, source: 'local' };
}

/** Human label for a profile key (used by the phone, which knows no profiles). */
export function profileLabel(key) {
  if (key === GENERIC_PROFILE.key) return GENERIC_PROFILE.label;
  const profile = profileByKey(key);
  return profile ? profile.label : 'No checklist selected';
}
