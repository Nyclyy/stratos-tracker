/* Registration resolution for aircraft whose feed does not carry one.
 *
 * ADS-B feeds usually report a registration; when they do not, the aircraft's
 * hex is resolved through hexdb.io. VATSIM publishes a callsign and nothing
 * else, so the callsign is resolved through a live ADS-B search, which is what
 * flight-tracking apps do to show an airframe's photo.
 *
 * Both answers are reported as looked up, never as feed data: the airframe
 * flying a callsign in the simulator need not be the one flying it today.
 * Pure, so the card and the tests read the payloads the same way.
 */

const HEX = /^[0-9A-F]{6}$/;
const CALLSIGN = /^[A-Z0-9]{2,8}$/;

// Registration shapes a livery name can carry: N8312C, G-TAWI, 9V-SKA, B-1234,
// JA801A, HL8008. Type codes never take one of these shapes once the type
// families below are excluded.
const TITLE_REGISTRATIONS = [
  /^N\d[0-9A-Z]{0,4}$/,
  /^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/,
  /^JA\d{3}[0-9A-Z]$/,
  /^HL\d{4}$/,
];
// Two-character prefixes that begin a type code rather than a country mark:
// MD-82, CRJ-900, PA-28, B7-200 and so on.
const TYPE_PREFIX = /^(MD|CRJ|ERJ|AT|DH|PA|C[0-9]|B[0-9]|A[0-9]|E[0-9]|F[0-9]|U[0-9])$/;
const TYPE_CODE = /^[A-Z][A-Z0-9]?\d[A-Z0-9]{1,2}$/;

/** A 24-bit Mode S address, or an empty string. */
export function normalizeHex(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase();
  return HEX.test(raw) ? raw : '';
}

/** A callsign an ADS-B search could answer, or an empty string. */
export function normalizeCallsign(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
  if (!CALLSIGN.test(raw)) return '';
  // A registration is not a callsign; it is resolved from the hex instead.
  if (/^[A-Z]{1,2}\d{1,5}[A-Z]?$/.test(raw) && raw.length <= 6) return '';
  return raw;
}

export function hexLookupUrl(hex) {
  const value = normalizeHex(hex);
  return value ? `https://hexdb.io/api/v1/aircraft/${value}` : '';
}

export function callsignLookupUrl(callsign) {
  const value = normalizeCallsign(callsign);
  return value ? `https://api.adsb.lol/v2/callsign/${encodeURIComponent(value)}` : '';
}

/** A registration named in a simulator title or livery, or an empty string.
 *
 * Most sims ship no tail number with a livery but name the airframe in the
 * title, e.g. "Boeing 737-800 Southwest N8312C". Reading it back is how Volanta
 * and similar apps identify the aircraft you are flying. */
export function registrationFromTitle(title) {
  const text = String(title == null ? '' : title).toUpperCase();
  if (!text) return '';
  for (const token of text.split(/[^A-Z0-9-]+/)) {
    if (!token || !TITLE_REGISTRATIONS.some(shape => shape.test(token))) continue;
    if (token.includes('-')) {
      if (/^\d+-\d+$/.test(token)) continue;          // 737-800 is a type
      if (TYPE_CODE.test(token)) continue;             // B737-800, A320-232
      const prefix = token.split('-')[0];
      if (TYPE_PREFIX.test(prefix)) continue;          // MD-82, PA-28, CRJ-900
    }
    return token;
  }
  return '';
}

/** What to look up for an aircraft whose feed carried no registration, or null.
 *  A Mode S address is answered by the aircraft database; a callsign, which is
 *  all VATSIM publishes, by a live search for that callsign. */
export function lookupPlan({ hex = '', callsign = '' } = {}) {
  const address = normalizeHex(hex);
  if (address) return { kind: 'hex', value: address, url: hexLookupUrl(address) };
  const call = normalizeCallsign(callsign);
  if (call) return { kind: 'callsign', value: call, url: callsignLookupUrl(call) };
  return null;
}

/** What a lookup request told the card: a registration, nothing known, or no
 *  answer at all. An unknown hex is a 404 from the database, not a failure. */
export function registrationOutcome(plan, status, payload) {
  const code = Number(status);
  if (!plan || !Number.isFinite(code) || code <= 0) return { state: 'unavailable' };
  if (code === 404) return { state: 'none' };
  if (code < 200 || code >= 300) return { state: 'unavailable' };
  const found = plan.kind === 'hex' ? registrationFromHexdb(payload) : registrationFromLive(payload);
  return found ? { state: 'ok', ...found } : { state: 'none' };
}

/** hexdb.io aircraft record: registration, type and owner when it knows them. */
export function registrationFromHexdb(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const registration = String(payload.Registration || '').trim().toUpperCase();
  if (!registration) return null;
  return {
    registration,
    type: String(payload.ICAOTypeCode || '').trim().toUpperCase(),
    owner: String(payload.RegisteredOwners || '').trim(),
    via: 'hex',
  };
}

/** adsb.lol live search: the first aircraft that reports a registration. */
export function registrationFromLive(payload) {
  const list = payload && Array.isArray(payload.ac) ? payload.ac : null;
  if (!list) return null;
  for (const aircraft of list) {
    const registration = String(aircraft && aircraft.r || '').trim().toUpperCase();
    if (!registration) continue;
    return {
      registration,
      type: String(aircraft.t || '').trim().toUpperCase(),
      owner: '',
      hex: normalizeHex(aircraft.hex),
      via: 'callsign',
    };
  }
  return null;
}
