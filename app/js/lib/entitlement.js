/* Premium entitlement.
 *
 * A client-side flag is not a purchase. This module therefore has exactly two
 * trusted answers:
 *
 *   1. the desktop app's main process, which verifies a licence token against
 *      the configured licence endpoint (and reports a clearly-labelled
 *      development entitlement when the operator enables it), or
 *   2. an explicit "unavailable" state, which the UI shows honestly.
 *
 * Nothing is read from localStorage, and no code path invents a purchase.
 */

const CACHE_MS = 60 * 1000;
const FEATURES = {
  charts: {
    key: 'charts',
    label: 'Integrated charts',
    description: 'Open official terminal procedures inside Stratos with zoom, pan, pages and full screen.',
  },
  analytics: {
    key: 'analytics',
    label: 'Advanced analytics',
    description: 'Expanded reports, filters and exportable summaries.',
  },
};
let cached = null;

export function premiumFeatures() {
  return Object.values(FEATURES).map(feature => ({ ...feature }));
}

export function resetEntitlementCache() {
  cached = null;
}

/** True only when a trusted source says so. */
export function isPremium(entitlement) {
  return Boolean(entitlement && entitlement.premium === true && entitlement.verified !== false);
}

/**
 * Ask the trusted channel. The desktop renderer exposes `stratosDesktop.
 * getEntitlement()`; a hosted page has no trusted channel and is therefore
 * free until a licence service is configured for it.
 */
export async function getEntitlement(options = {}) {
  const now = Date.now();
  if (!options.force && cached && now - cached.checkedAt < CACHE_MS) return cached;
  const desktop = options.desktop || (typeof globalThis !== 'undefined' ? globalThis.stratosDesktop : null);
  let result;
  if (desktop && typeof desktop.getEntitlement === 'function') {
    try {
      const answer = await desktop.getEntitlement();
      result = {
        premium: answer && answer.premium === true && answer.verified !== false,
        verified: true,
        mode: (answer && answer.mode) || (answer && answer.premium ? 'licence' : 'none'),
        plan: (answer && answer.plan) || null,
        expiresAt: (answer && answer.expiresAt) || null,
        reason: (answer && answer.reason) || '',
        checkedAt: now,
      };
    } catch (error) {
      result = {
        premium: false, verified: false, mode: 'unavailable', plan: null, expiresAt: null,
        reason: `The licence check failed: ${error.message || error}`, checkedAt: now,
      };
    }
  } else {
    result = {
      premium: false,
      verified: false,
      mode: 'unavailable',
      plan: null,
      expiresAt: null,
      reason: 'Premium needs the installed Stratos app: this page has no trusted licence channel.',
      checkedAt: now,
    };
  }
  cached = result;
  return result;
}

/** Short status line used by the upgrade panel and Settings. */
export function describeEntitlement(entitlement) {
  if (!entitlement) return 'Checking your licence…';
  if (isPremium(entitlement)) {
    if (entitlement.mode === 'development') {
      return 'Development entitlement active — this build has no payment step, so this is not a purchase.';
    }
    const plan = entitlement.plan ? `${entitlement.plan} ` : 'Premium ';
    return `${plan}licence verified${entitlement.expiresAt ? ` · renews ${new Date(entitlement.expiresAt).toISOString().slice(0, 10)}` : ''}.`;
  }
  if (entitlement.mode === 'unavailable') return entitlement.reason || 'This build has no licence channel.';
  return entitlement.reason || 'No Premium licence is active on this device.';
}

/** What an operator still has to configure for real purchases to work. */
export function premiumSetupNotes() {
  return [
    'A licence service that issues a signed token per purchase, set as STRATOS_ENTITLEMENT_URL for the desktop app.',
    'A checkout provider wired to that service; Stratos does not implement payments itself.',
    'The token stored on the device as entitlement.json in the app data folder; it is verified by the main process, never by the page.',
  ];
}
