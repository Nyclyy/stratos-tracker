/* Match the airframe X-Plane reports to a bundled performance profile.
 *
 * X-Plane exposes an author-entered ICAO type and a free-text description
 * through the bridge. Add-on developers are not consistent about either, so the
 * matcher tries the type designator first, then specific text such as
 * "ToLiss A321" or "FlightFactor 777-300ER". A filename is accepted when the
 * caller has one. It never guesses a nearby type: no match means the page asks
 * the pilot to choose a profile or says the type is unsupported.
 */

import { profileById, profileByIcao } from './performance-db.js';

function normalizeType(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(text) ? text : '';
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * @param {object} database parsed performance database
 * @param {{profileId?: string, icaoType?: string, description?: string, filename?: string}} identity
 * @returns {{profile: object|null, confidence: 'manual'|'exact'|'text'|'none', source: string, reason: string}}
 */
export function matchAircraft(database, identity = {}) {
  const manualId = String(identity.profileId || '').trim();
  if (manualId) {
    const profile = profileById(database, manualId);
    return profile
      ? { profile, confidence: 'manual', source: 'manual', reason: `Selected manually as ${profile.manufacturer} ${profile.name}.` }
      : { profile: null, confidence: 'none', source: 'manual', reason: `No bundled profile has the id ${manualId}.` };
  }

  const type = normalizeType(identity.icaoType || identity.icao);
  if (type) {
    const profile = profileByIcao(database, type);
    if (profile) {
      return { profile, confidence: 'exact', source: 'icao', reason: `The simulator reports ICAO type ${type}.` };
    }
  }

  const description = String(identity.description || identity.aircraft || '').trim();
  const filename = String(identity.filename || '').trim();
  const haystack = `${description} ${filename}`.trim().toLowerCase();
  if (haystack) {
    let best = null;
    for (const profile of database.profiles || []) {
      const match = profile.match || {};
      const excluded = (match.exclude || []).some(token => haystack.includes(normalizeText(token)));
      if (excluded) continue;
      for (const token of match.text || []) {
        const needle = normalizeText(token);
        if (!needle || !haystack.includes(needle)) continue;
        if (!best || needle.length > best.needle.length) best = { profile, needle };
      }
    }
    if (best) {
      const field = description && normalizeText(description).includes(best.needle) ? 'description' : 'filename';
      return {
        profile: best.profile,
        confidence: 'text',
        source: field,
        reason: `Matched "${best.needle}" in the aircraft ${field}.`,
      };
    }
  }

  return {
    profile: null,
    confidence: 'none',
    source: '',
    reason: type
      ? `No bundled performance profile matches type ${type}${description ? ` (${description})` : ''}.`
      : 'The simulator has not reported an airframe, and the stored plan names none.',
  };
}
