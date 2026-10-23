/* Aircraft photos by registration, from the Planespotters.net public API.
 *
 * The API refuses a request whose User-Agent is a browser's or a library's:
 * it wants an application name with a contact URL, so the page asks its own
 * /api/photo endpoint (or the local dev server, which mounts the same handler).
 * Only the desktop build, where the main process supplies that header, falls
 * back to calling the service directly.
 *
 * All of this is pure so the page and the tests read the payload the same way.
 * A missing photo is reported as missing: no placeholder is presented as the
 * aircraft.
 */

const REG = /^[A-Z0-9][A-Z0-9-]{1,9}$/;

/** A registration the service could know, or an empty string. */
export function normalizeRegistration(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
  if (!REG.test(raw)) return '';
  // A callsign or a type code is not a registration.
  if (/^\d+$/.test(raw)) return '';
  if (/^[A-Z]{1,4}\d{1,4}$/.test(raw)) return '';
  return raw;
}

/** Ask for this registration through the app's own endpoint. */
export function photoRequest(registration) {
  const reg = normalizeRegistration(registration);
  return reg ? '/api/photo?reg=' + encodeURIComponent(reg) : '';
}

/** The first spotter photo in the payload, or null when none is published. */
export function photoFromPayload(payload) {
  const photo = payload && Array.isArray(payload.photos) ? payload.photos[0] : null;
  if (!photo || typeof photo !== 'object') return null;
  const large = photo.thumbnail_large && photo.thumbnail_large.src;
  const thumb = photo.thumbnail && photo.thumbnail.src;
  const src = large || thumb;
  if (!src || !/^https:\/\//.test(src)) return null;
  const size = (photo.thumbnail_large && photo.thumbnail_large.size) || null;
  return {
    src,
    thumb: thumb && /^https:\/\//.test(thumb) ? thumb : src,
    width: size && Number(size.width) ? Number(size.width) : null,
    height: size && Number(size.height) ? Number(size.height) : null,
    link: typeof photo.link === 'string' ? photo.link : '',
    photographer: typeof photo.photographer === 'string' ? photo.photographer.trim() : '',
  };
}

/** The credit the photographer is owed, or the site that supplied the photo. */
export function photoCredit(photo) {
  if (!photo) return '';
  return photo.photographer ? `Planespotters © ${photo.photographer}` : 'Planespotters.net';
}
