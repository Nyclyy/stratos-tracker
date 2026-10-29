/* Aircraft photos by registration or Mode S address, from the Planespotters.net
 * public API.
 *
 * The API refuses a request whose User-Agent is a browser's or a library's:
 * it wants an application name with a contact URL, so the page asks its own
 * /api/photo endpoint (or the local dev server, which mounts the same handler).
 * Only the desktop build, where the main process supplies that header, falls
 * back to calling the service directly.
 *
 * The service indexes a photo by registration or by ICAO 24-bit address. A
 * registration is preferred because that is the airframe the feed reports; the
 * address is the fallback the service supports, not a guessed type match.
 *
 * All of this is pure so the page and the tests read the payload the same way.
 * A missing photo is reported as missing: no placeholder is presented as the
 * aircraft, and the returned photo page is the one the API supplied.
 */

import { normalizeHex } from './aircraftreg.js';

const REG = /^[A-Z0-9][A-Z0-9-]{1,9}$/;
// A callsign or an ICAO type designator takes this shape. N-numbers can too
// (N123, N1234), and those are real registrations, so they are kept.
const TYPE_LIKE = /^[A-Z]{1,4}\d{1,4}$/;
const N_NUMBER = /^N\d[0-9A-Z]{0,5}$/;

/** A registration the service could know, or an empty string. */
export function normalizeRegistration(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
  if (!REG.test(raw)) return '';
  // A callsign or a type code is not a registration.
  if (/^\d+$/.test(raw)) return '';
  if (TYPE_LIKE.test(raw) && !N_NUMBER.test(raw)) return '';
  return raw;
}

/** Ask for this registration through the app's own endpoint. */
export function photoRequest(registration) {
  const reg = normalizeRegistration(registration);
  return reg ? '/api/photo?reg=' + encodeURIComponent(reg) : '';
}

/** Ask for the airframe by Mode S address when no registration is reported. */
export function photoHexRequest(hex) {
  const address = normalizeHex(hex);
  return address ? '/api/photo?hex=' + address : '';
}

/** The URL the service itself answers, for the desktop build's direct call. */
export function photoUpstreamUrl({ registration = '', hex = '' } = {}) {
  const reg = normalizeRegistration(registration);
  if (reg) return 'https://api.planespotters.net/pub/photos/reg/' + encodeURIComponent(reg);
  const address = normalizeHex(hex);
  return address ? 'https://api.planespotters.net/pub/photos/hex/' + address : '';
}

// Marketing names and simulator titles that name a type but not its ICAO code.
// Only used to look up a representative photo; the aircraft itself is still
// identified from the ICAO code the source reports.
// The end of a variant is not a word boundary when it is followed by a suffix
// such as the ER in "777-300ER", so each pattern ends at a non-alphanumeric.
const END = '(?![A-Z0-9])';
const TYPE_NAMES = [
  [/\bA350[ -]?900/, 'A359'], [/\bA350[ -]?1000/, 'A35K'],
  [/\bA330[ -]?900/, 'A339'], [/\bA330[ -]?300/, 'A333'], [/\bA330[ -]?200/, 'A332'],
  [/\bA340[ -]?600/, 'A346'], [/\bA380(?:[ -]?800)?/, 'A388'],
  [/\bA321 ?NEO/, 'A21N'], [/\bA320 ?NEO/, 'A20N'],
  [/\bA321/, 'A321'], [/\bA320/, 'A320'], [/\bA319/, 'A319'], [/\bA318/, 'A318'],
  [/\bB?737 ?MAX ?8/, 'B38M'], [/\bB?737 ?MAX ?9/, 'B39M'],
  [/\bB?737[ -]?800/, 'B738'], [/\bB?737[ -]?700/, 'B737'], [/\bB?737[ -]?900/, 'B739'],
  [/\bB?747[ -]?8/, 'B748'], [/\bB?747[ -]?400/, 'B744'],
  [/\bB?757[ -]?200/, 'B752'], [/\bB?757[ -]?300/, 'B753'], [/\bB?767[ -]?300/, 'B763'],
  [/\bB?777[ -]?300(?:ER|LR)?/, 'B77W'], [/\bB?777[ -]?200(?:ER|LR)?/, 'B772'],
  [/\bB?787[ -]?10/, 'B78X'], [/\bB?787[ -]?9/, 'B789'], [/\bB?787[ -]?8/, 'B788'],
  [/\bE ?195/, 'E195'], [/\bE ?190/, 'E190'], [/\bATR ?72/, 'AT72'],
  [/\b(?:DASH ?8 ?)?Q400/, 'DH8D'],
].map(([pattern, code]) => [new RegExp(pattern.source + END), code]);

/** An ICAO aircraft type designator from a code or a common type name. */
export function typeCode(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  if (!text) return '';
  for (const [pattern, code] of TYPE_NAMES) if (pattern.test(text)) return code;
  const code = text.replace(/[^A-Z0-9]/g, '');
  return /^[A-Z][A-Z0-9]{2,3}$/.test(code) ? code : '';
}

/** A callsign airline code and ICAO type that can stand in for an unregistered
 *  airframe. This is a query for a representative aircraft, not a claim that it
 *  is the one being tracked. */
export function representativeQuery({ callsign = '', type = '' } = {}) {
  const match = String(callsign == null ? '' : callsign).trim().toUpperCase().replace(/\s+/g, '')
    .match(/^([A-Z]{3})(\d{1,4})([A-Z]?)$/);
  const code = typeCode(type);
  if (!match || !code) return null;
  return {
    designator: match[1],
    type: code,
    key: `${match[1]}|${code}`,
    url: `https://api.adsb.lol/v2/type/${encodeURIComponent(code)}`,
  };
}

/** Every live aircraft of the same operator and type that reports a
 *  registration, deduplicated by registration. `id`/`flight` and `reg`/`r`
 *  cover the map's traffic shape and the ADS-B feed's shape; a record from
 *  another operator or type is skipped. The caller chooses one, so a backup
 *  can be any real aircraft of that operator and type. */
export function representativeCandidates(records, query) {
  if (!Array.isArray(records) || !query) return [];
  const callsignShape = new RegExp(`^${query.designator}\\d{1,4}[A-Z]?$`);
  const found = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const callsign = String(record.id || record.flight || '').trim().toUpperCase();
    if (!callsignShape.test(callsign)) continue;
    // ADS-B calls the aircraft type `t` and uses `type` for the message kind
    // (`adsb_icao`); the map's traffic objects use `type` for the airframe. Only
    // a record that states the same type is the same aircraft type.
    if (typeCode(record.t || record.type) !== query.type) continue;
    const registration = normalizeRegistration(record.reg || record.r);
    if (!registration || found.has(registration)) continue;
    found.set(registration, {
      registration, callsign, type: query.type, designator: query.designator, key: query.key,
    });
  }
  return [...found.values()];
}

/** Only an HTTPS page on Planespotters is offered as the photo's link. */
function photoPage(value) {
  const raw = String(value == null ? '' : value).trim();
  return /^https:\/\/(?:www\.)?planespotters\.net\/photo\//i.test(raw) ? raw : '';
}

/** The first spotter photo in the payload, or null when none is published. */
export function photoFromPayload(payload) {
  const photo = payload && Array.isArray(payload.photos) ? payload.photos[0] : null;
  if (!photo || typeof photo !== 'object') return null;
  const large = photo.thumbnail_large && photo.thumbnail_large.src;
  const thumb = photo.thumbnail && photo.thumbnail.src;
  const src = large || thumb;
  if (!src || !/^https:\/\//.test(src)) return null;
  // A photo is only shown with the page link the terms require beside it; a
  // payload without one is not a usable photo, not an image to display bare.
  const link = photoPage(photo.link);
  if (!link) return null;
  const size = (photo.thumbnail_large && photo.thumbnail_large.size) || null;
  return {
    src,
    thumb: thumb && /^https:\/\//.test(thumb) ? thumb : src,
    width: size && Number(size.width) ? Number(size.width) : null,
    height: size && Number(size.height) ? Number(size.height) : null,
    link,
    photographer: typeof photo.photographer === 'string' ? photo.photographer.trim() : '',
  };
}

/** What a photo request told us, in the three states the card can show.
 *  A 404 means the app has no photo route at all (a static deployment), which is
 *  not the same answer as "this registration has no photo". */
export function photoOutcome(status, payload) {
  if (status === 404) return { state: 'unavailable' };
  if (!Number.isFinite(Number(status)) || status < 200 || status >= 300) return { state: 'unavailable' };
  const photo = photoFromPayload(payload);
  return photo ? { state: 'ok', photo } : { state: 'none' };
}

/** The credit the photographer is owed, or the site that supplied the photo. */
export function photoCredit(photo) {
  if (!photo) return '';
  return photo.photographer ? `Planespotters © ${photo.photographer}` : 'Planespotters.net';
}
