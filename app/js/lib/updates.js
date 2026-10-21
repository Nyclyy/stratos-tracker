/* Update checking for every Stratos surface.

   The rules live here once so the desktop app, the browser and the installed
   iPhone app agree on what "newer" means:

   - versions are compared as semantic versions, never as strings;
   - the published manifest (app/releases.json, also attached to the newest
     GitHub release) is the only source of a latest version and its notes;
   - the last good answer is cached so an offline launch still knows what it
     knew, and a check never invents a version when the network fails;
   - a dismissal is stored per release fingerprint, so nobody is asked twice
     about the same build, but a genuinely changed or more serious release can
     still be announced.

   Nothing here touches the DOM; app/js/update-ui.js draws the interface and
   tests/updates.test.mjs exercises these functions directly. */

export const MANIFEST_URLS = [
  'releases.json',
  'https://github.com/Nyclyy/stratos-tracker/releases/latest/download/releases.json',
];

export const CACHE_KEY = 'stratos.update.cache';
export const DISMISS_KEY = 'stratos.update.dismissed';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 9000;

export const SEVERITY_RANK = { normal: 0, important: 1, critical: 2 };

export const SEVERITY_LABEL = {
  normal: 'Optional update',
  important: 'Important update',
  critical: 'Critical update',
};

export const CATEGORY_ORDER = ['features', 'improvements', 'fixes', 'performance', 'ui', 'compatibility', 'other'];

export const CATEGORY_LABELS = {
  features: 'New features',
  improvements: 'Improvements',
  fixes: 'Bug fixes',
  performance: 'Performance',
  ui: 'Interface',
  compatibility: 'Compatibility and important notices',
  other: 'Other changes',
};

/* ── Versions ───────────────────────────────────────────────────────── */

export function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Cannot compare "${a}" with "${b}"`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1;
    if (ln) return -1;
    if (rn) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function isNewer(latest, installed) {
  try { return compareVersions(latest, installed) > 0; } catch (_) { return false; }
}

/* ── Manifest ───────────────────────────────────────────────────────── */

function text(value, limit = 400) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function stringList(value) {
  return Array.isArray(value) ? value.map(item => text(item, 300)).filter(Boolean).slice(0, 60) : [];
}

export function normalizeChangelog(raw) {
  const changelog = {};
  for (const key of CATEGORY_ORDER) changelog[key] = stringList(raw && raw[key]);
  return changelog;
}

/** A release object with only the fields the interface understands. */
export function normalizeRelease(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const version = text(raw.version, 32).replace(/^v/i, '');
  if (!parseVersion(version)) return null;
  const severity = SEVERITY_RANK[raw.severity] == null ? 'normal' : raw.severity;
  const downloads = {};
  if (raw.downloads && typeof raw.downloads === 'object') {
    for (const [platform, entry] of Object.entries(raw.downloads)) {
      if (!entry || typeof entry !== 'object') continue;
      const url = text(entry.url, 500);
      // Update packages are only ever fetched over HTTPS.
      if (!/^https:\/\//i.test(url)) continue;
      downloads[platform] = {
        url,
        sha256: /^[a-f0-9]{64}$/i.test(String(entry.sha256 || '')) ? String(entry.sha256).toLowerCase() : '',
        size: Number(entry.size) > 0 ? Number(entry.size) : null,
      };
    }
  }
  return {
    version,
    releasedAt: text(raw.releasedAt, 40),
    severity,
    reason: text(raw.reason, 500),
    summary: text(raw.summary, 400),
    minimumSupported: parseVersion(raw.minimumSupported) ? text(raw.minimumSupported, 32) : '',
    changelog: normalizeChangelog(raw.changelog),
    downloads,
  };
}

/**
 * Validate a parsed manifest. Returns `{ ok, manifest, problems }`; a caller can
 * show `problems` as a readable error instead of pretending the check worked.
 */
export function validateManifest(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, manifest: null, problems: ['The release manifest is not an object.'] };
  }
  if (raw.schemaVersion !== 1) problems.push('Unsupported manifest schema.');
  if (!Array.isArray(raw.releases)) problems.push('The release list is missing.');
  const releases = (Array.isArray(raw.releases) ? raw.releases : [])
    .map(normalizeRelease)
    .filter(Boolean);
  if (!releases.length) problems.push('No readable releases are listed.');
  const latest = normalizeRelease(raw.latest) || releases[0] || null;
  if (!latest) problems.push('No latest version is published.');
  const versions = new Set();
  for (const release of releases) {
    if (versions.has(release.version)) problems.push(`Release ${release.version} is listed twice.`);
    versions.add(release.version);
  }
  // A manifest whose "latest" is older than a listed stable release is stale;
  // saying the installed app is current would be wrong, so it is rejected.
  // "latest" is the newest stable release; a prerelease may be listed without
  // ever being offered to users.
  const stable = releases.filter(release => !parseVersion(release.version).prerelease.length)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (latest && stable && compareVersions(latest.version, stable.version) < 0) {
    problems.push(`The manifest says ${latest.version} is latest but lists ${stable.version}.`);
  }
  return {
    ok: problems.length === 0,
    manifest: problems.length === 0 ? { schemaVersion: 1, source: text(raw.source, 300), latest, releases } : null,
    problems,
  };
}

export function findRelease(manifest, version) {
  return (manifest?.releases || []).find(release => release.version === version)
    || (manifest?.latest?.version === version ? manifest.latest : null);
}

/** "optional", "important" or "critical" — the prompt's tone, not a fake gate. */
export function updateKind(release, installedVersion) {
  if (!release) return 'optional';
  if (release.severity === 'critical') return 'critical';
  if (release.minimumSupported && isNewer(release.minimumSupported, installedVersion)) return 'critical';
  if (release.severity === 'important') return 'important';
  return 'optional';
}

/** True only when the install is genuinely too old for the published release. */
export function isRequired(release, installedVersion) {
  if (!release) return false;
  if (release.severity === 'critical' && release.reason) return true;
  return Boolean(release.minimumSupported) && isNewer(release.minimumSupported, installedVersion);
}

export function releaseFingerprint(release) {
  if (!release) return '';
  const counts = CATEGORY_ORDER.map(key => (release.changelog?.[key] || []).length).join('.');
  return [release.version, release.releasedAt, release.severity, counts].join('|');
}

/* ── Dismissal and cache ────────────────────────────────────────────── */

function storageOf(storage) {
  if (storage) return storage;
  try { return window.localStorage; } catch (_) { return null; }
}

function readJson(storage, key) {
  const store = storageOf(storage);
  if (!store) return null;
  try {
    const value = store.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch (_) { return null; }
}

function writeJson(storage, key, value) {
  const store = storageOf(storage);
  if (!store) return;
  try { store.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode or quota */ }
}

export function readDismissed(storage) {
  const saved = readJson(storage, DISMISS_KEY);
  if (!saved || typeof saved !== 'object') return null;
  return {
    version: text(saved.version, 32),
    severity: SEVERITY_RANK[saved.severity] == null ? 'normal' : saved.severity,
    fingerprint: text(saved.fingerprint, 200),
    at: text(saved.at, 40),
  };
}

export function writeDismissed(storage, release, now = new Date()) {
  if (!release) return;
  writeJson(storage, DISMISS_KEY, {
    version: release.version,
    severity: release.severity,
    fingerprint: releaseFingerprint(release),
    at: now.toISOString(),
  });
}

export function clearDismissed(storage) {
  const store = storageOf(storage);
  try { store?.removeItem(DISMISS_KEY); } catch (_) { /* nothing to clear */ }
}

/**
 * Ask once per release. A dismissed version is announced again only when the
 * published release itself changed (its fingerprint) or became more serious.
 */
export function shouldPrompt(release, { installedVersion, dismissed = null } = {}) {
  if (!release || !isNewer(release.version, installedVersion)) return false;
  if (!dismissed || dismissed.version !== release.version) return true;
  if (SEVERITY_RANK[release.severity] > SEVERITY_RANK[dismissed.severity]) return true;
  if (dismissed.fingerprint && dismissed.fingerprint !== releaseFingerprint(release)) return true;
  return false;
}

export function readCache(storage) {
  const saved = readJson(storage, CACHE_KEY);
  if (!saved || typeof saved !== 'object') return null;
  const checked = validateManifest(saved.manifest);
  if (!checked.ok) return null;
  return { checkedAt: text(saved.checkedAt, 40), manifest: checked.manifest };
}

export function writeCache(storage, manifest, checkedAt = new Date().toISOString()) {
  if (!manifest) return;
  writeJson(storage, CACHE_KEY, { checkedAt, manifest });
}

/* ── Network ────────────────────────────────────────────────────────── */

async function requestManifest(url, { fetchImpl, timeoutMs }) {
  const fetcher = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetcher) throw new Error('This browser cannot fetch the release manifest.');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetcher(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const checked = validateManifest(payload);
    if (!checked.ok) throw new Error(checked.problems[0] || 'The release manifest is malformed.');
    return { manifest: checked.manifest, url };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Try each manifest location in order. Returns `{ manifest, url }` or throws with
 * the first useful reason; callers decide whether that is an error or a cache hit.
 */
export async function fetchManifest({ urls = MANIFEST_URLS, fetchImpl, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const failures = [];
  for (const url of urls) {
    try {
      return await requestManifest(url, { fetchImpl, timeoutMs });
    } catch (error) {
      failures.push(`${url}: ${error && error.message ? error.message : String(error)}`);
    }
  }
  throw new Error(failures[0] || 'No release manifest could be read.');
}

/**
 * Check once. Never throws: a failed network or malformed manifest is reported
 * as a state with `error`, and the last good cache is still returned beside it.
 */
export async function checkForUpdate({
  installedVersion,
  fetchImpl,
  storage,
  now = () => new Date(),
  urls = MANIFEST_URLS,
  timeoutMs = CHECK_TIMEOUT_MS,
} = {}) {
  const checkedAt = now().toISOString();
  const cached = readCache(storage);
  try {
    const { manifest, url } = await fetchManifest({ urls, fetchImpl, timeoutMs });
    writeCache(storage, manifest, checkedAt);
    const release = manifest.latest;
    const available = isNewer(release.version, installedVersion);
    return {
      state: available ? 'available' : 'current',
      installedVersion,
      latestVersion: release.version,
      release: available ? release : null,
      releases: manifest.releases,
      checkedAt,
      source: url,
      cached: false,
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (cached) {
      const release = cached.manifest.latest;
      const available = isNewer(release.version, installedVersion);
      return {
        state: available ? 'available' : 'current',
        installedVersion,
        latestVersion: release.version,
        release: available ? release : null,
        releases: cached.manifest.releases,
        checkedAt: cached.checkedAt,
        source: 'cache',
        cached: true,
        offline: typeof navigator !== 'undefined' && navigator.onLine === false,
        error: message,
      };
    }
    return {
      state: 'error',
      installedVersion,
      latestVersion: null,
      release: null,
      releases: [],
      checkedAt,
      source: 'none',
      cached: false,
      error: message,
    };
  }
}

/* ── Service worker (website and installed PWA) ─────────────────────── */

/**
 * Report a build that is downloaded but waiting. The page decides how to offer
 * it; nothing activates behind the user's back, because that would reload a map
 * mid-flight and discard the panel the pilot is reading.
 */
export function watchServiceWorker(registration, onWaiting) {
  if (!registration || typeof onWaiting !== 'function') return () => {};
  let disposed = false;
  const report = worker => {
    if (disposed || !worker) return;
    if (worker.state === 'installed' && navigator.serviceWorker?.controller) onWaiting(worker);
  };
  const watch = worker => {
    if (!worker) return;
    report(worker);
    worker.addEventListener('statechange', () => report(worker));
  };
  registration.addEventListener('updatefound', () => watch(registration.installing));
  watch(registration.waiting);
  return () => { disposed = true; };
}

/**
 * Activate the waiting worker. The service worker answers by claiming clients,
 * which fires `controllerchange`; the caller reloads exactly once on that event.
 */
export async function activateServiceWorker(registration) {
  const worker = registration?.waiting || registration?.installing;
  if (!worker) return false;
  await new Promise(resolve => {
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    worker.addEventListener('statechange', () => { if (worker.state === 'activated') done(); });
    // A worker that never reports activation must not leave the promise (or a
    // browser timer) hanging. The reload that follows still picks up the new
    // build on the next navigation.
    timer = setTimeout(done, 4000);
    worker.postMessage({ type: 'STRATOS_SKIP_WAITING' });
  });
  return true;
}

/** Refresh the registration without blocking the page. */
export async function refreshServiceWorker(registration) {
  if (!registration || typeof registration.update !== 'function') return false;
  try { await registration.update(); return true; } catch (_) { return false; }
}

/* ── Presentation helpers ───────────────────────────────────────────── */

export function changelogGroups(release) {
  if (!release) return [];
  return CATEGORY_ORDER
    .map(key => ({ key, label: CATEGORY_LABELS[key], items: release.changelog?.[key] || [] }))
    .filter(group => group.items.length);
}

export function totalChanges(release) {
  return CATEGORY_ORDER.reduce((total, key) => total + (release?.changelog?.[key]?.length || 0), 0);
}

export function formatChecked(iso, now = new Date()) {
  const date = new Date(iso || '');
  if (Number.isNaN(date.getTime())) return 'never';
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDate(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(0)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
}
