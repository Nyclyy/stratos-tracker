import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  activateServiceWorker,
  compareVersions,
  parseVersion,
  validateManifest,
  normalizeRelease,
  updateKind,
  isRequired,
  shouldPrompt,
  writeDismissed,
  readDismissed,
  writeCache,
  readCache,
  checkForUpdate,
  changelogGroups,
  formatChecked,
  CATEGORY_ORDER,
} from '../app/js/lib/updates.js';

import { checkSmokeReceipt } from '../scripts/check-update-smoke.mjs';

import {
  classifyCommit,
  humanize,
  buildChangelog,
  summarize,
  mergeRelease,
  emptyManifest,
  validateManifest as validateReleaseManifest,
  renderMarkdown,
  validateCurated,
  validateCuratedFile,
  curatedRelease,
  loadCurated,
} from '../scripts/release-notes.mjs';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const release = (version, extra = {}) => ({
  version,
  releasedAt: '2026-10-20',
  severity: 'normal',
  summary: 'Notes.',
  changelog: { features: ['Something new.'], improvements: [], fixes: [], performance: [], ui: [], compatibility: [], other: [] },
  ...extra,
});

const manifestFor = (releases) => {
  const sorted = releases.slice().sort((a, b) => compareVersions(b.version, a.version));
  return { schemaVersion: 1, source: 'https://example.test', latest: sorted[0], releases: sorted };
};

const fakeFetch = payloadByUrl => async url => ({
  ok: true,
  status: 200,
  json: async () => payloadByUrl[url],
});

/* ── Versions ───────────────────────────────────────────────────────── */

test('semantic versions compare numerically, not as strings', () => {
  assert.equal(compareVersions('2.1.10', '2.1.9'), 1, '2.1.10 is newer than 2.1.9');
  assert.equal(compareVersions('2.1.9', '2.1.10'), -1);
  assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  assert.equal(compareVersions('v2.2.0', '2.1.99'), 1);
  assert.equal(compareVersions('3.0.0', '2.99.99'), 1);
  assert.equal(compareVersions('2.1.0-beta.2', '2.1.0-beta.10'), -1, 'numeric prerelease identifiers compare as numbers');
  assert.equal(compareVersions('2.1.0-beta', '2.1.0'), -1, 'a prerelease is older than the release');
  assert.equal(compareVersions('2.1.0+build.5', '2.1.0'), 0, 'build metadata does not affect precedence');
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(parseVersion('2.1'), null);
});

/* ── Manifest validation ────────────────────────────────────────────── */

test('a well-formed manifest is accepted and normalised', () => {
  const result = validateManifest(manifestFor([release('2.1.14')]));
  assert.equal(result.ok, true);
  assert.equal(result.manifest.latest.version, '2.1.14');
  assert.deepEqual(result.manifest.latest.changelog.features, ['Something new.']);
});

test('malformed manifests are rejected with a readable reason', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
  assert.equal(validateManifest({ schemaVersion: 2, releases: [] }).ok, false);

  const missing = validateManifest({ schemaVersion: 1, latest: null, releases: [] });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.length > 0);

  const duplicate = validateManifest({ schemaVersion: 1, latest: release('2.0.0'), releases: [release('2.0.0'), release('2.0.0')] });
  assert.equal(duplicate.ok, false, 'duplicate versions are ambiguous');
  assert.match(duplicate.problems.join(' '), /twice/);

  const stale = validateManifest({ schemaVersion: 1, latest: release('2.0.0'), releases: [release('2.0.0'), release('2.1.0')] });
  assert.equal(stale.ok, false, 'a stale latest must not be shown as the newest release');
  assert.match(stale.problems.join(' '), /2\.1\.0/);
});

test('downloads are only accepted over HTTPS, and a bad checksum is dropped', () => {
  const insecure = normalizeRelease(release('2.1.14', {
    downloads: { windows: { url: 'http://example.test/Stratos-Setup.exe', sha256: 'a'.repeat(64) } },
  }));
  assert.deepEqual(insecure.downloads, {});

  const secure = normalizeRelease(release('2.1.14', {
    downloads: { windows: { url: 'https://github.com/x/y/releases/download/v2.1.14/Stratos-Setup.exe', sha256: 'B'.repeat(64), size: 42000000 } },
  }));
  assert.equal(secure.downloads.windows.sha256, 'b'.repeat(64));
  assert.equal(secure.downloads.windows.size, 42000000);

  const badHash = normalizeRelease(release('2.1.14', {
    downloads: { windows: { url: 'https://github.com/x/y/releases/download/v2.1.14/a.exe', sha256: 'nope' } },
  }));
  assert.equal(badHash.downloads.windows.sha256, '', 'an unreadable hash is not treated as verification');
});

/* ── Severity and required updates ──────────────────────────────────── */

test('update severity is reported honestly and never fabricates a gate', () => {
  assert.equal(updateKind(release('2.1.14'), '2.1.13'), 'optional');
  assert.equal(updateKind(release('2.1.14', { severity: 'important' }), '2.1.13'), 'important');
  assert.equal(updateKind(release('2.1.14', { severity: 'critical', reason: 'Security fix.' }), '2.1.13'), 'critical');
  assert.equal(isRequired(release('2.1.14', { severity: 'critical', reason: 'Security fix.' }), '2.1.13'), true);
  // A critical label without a reason is not enough to call an update required.
  assert.equal(isRequired(release('2.1.14', { severity: 'critical' }), '2.1.13'), false);
  const minimum = release('2.1.14', { minimumSupported: '2.1.10' });
  assert.equal(updateKind(minimum, '2.1.8'), 'critical', 'a build below the supported minimum is a real compatibility case');
  assert.equal(isRequired(minimum, '2.1.8'), true);
  assert.equal(isRequired(minimum, '2.1.12'), false);
});

/* ── Prompting and dismissal ────────────────────────────────────────── */

test('a dismissed release is not asked about twice, unless it changes or gets more serious', () => {
  const storage = new MemoryStorage();
  const published = release('2.1.14');
  assert.equal(shouldPrompt(published, { installedVersion: '2.1.13' }), true);
  writeDismissed(storage, published, new Date('2026-10-20T10:00:00Z'));
  const dismissed = readDismissed(storage);
  assert.equal(dismissed.version, '2.1.14');
  assert.equal(shouldPrompt(published, { installedVersion: '2.1.13', dismissed }), false);

  const serious = release('2.1.14', { severity: 'important' });
  assert.equal(shouldPrompt(serious, { installedVersion: '2.1.13', dismissed }), true, 'a severity increase is a new reason to ask');

  const changed = release('2.1.14', { changelog: { ...published.changelog, fixes: ['A late fix.'] } });
  assert.equal(shouldPrompt(changed, { installedVersion: '2.1.13', dismissed }), true, 'republished notes are a changed release');

  assert.equal(shouldPrompt(published, { installedVersion: '2.1.14', dismissed: null }), false, 'the installed version is never announced');
});

/* ── Network, cache and offline behaviour ───────────────────────────── */

test('a newer release is reported as available without touching the installed version', async () => {
  const storage = new MemoryStorage();
  const manifest = manifestFor([release('2.1.14'), release('2.1.13')]);
  const result = await checkForUpdate({
    installedVersion: '2.1.13',
    storage,
    urls: ['https://example.test/releases.json'],
    fetchImpl: fakeFetch({ 'https://example.test/releases.json': manifest }),
  });
  assert.equal(result.state, 'available');
  assert.equal(result.latestVersion, '2.1.14');
  assert.equal(result.installedVersion, '2.1.13');
  assert.equal(result.release.version, '2.1.14');
  assert.equal(readCache(storage).manifest.latest.version, '2.1.14', 'the answer is cached for offline launches');
});

test('the installed version equals the latest version: no prompt, no fake update', async () => {
  const manifest = manifestFor([release('2.1.14')]);
  const result = await checkForUpdate({
    installedVersion: '2.1.14',
    storage: new MemoryStorage(),
    urls: ['https://example.test/releases.json'],
    fetchImpl: fakeFetch({ 'https://example.test/releases.json': manifest }),
  });
  assert.equal(result.state, 'current');
  assert.equal(result.release, null);
});

test('a malformed manifest is an error, not a silent "up to date"', async () => {
  const storage = new MemoryStorage();
  const result = await checkForUpdate({
    installedVersion: '2.1.13',
    storage,
    urls: ['https://example.test/releases.json'],
    fetchImpl: fakeFetch({ 'https://example.test/releases.json': { latest: { version: 'newest!' } } }),
  });
  assert.equal(result.state, 'error');
  assert.match(result.error, /manifest/i);
  assert.equal(readCache(storage), null, 'nothing invalid is cached');

  const broken = await checkForUpdate({
    installedVersion: '2.1.13',
    storage,
    urls: ['https://example.test/releases.json'],
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(broken.state, 'error');
  assert.match(broken.error, /ENOTFOUND/);
});

test('offline with a cached answer reports the cached release instead of inventing one', async () => {
  const storage = new MemoryStorage();
  const manifest = manifestFor([release('2.1.14')]);
  writeCache(storage, manifest, '2026-10-19T08:00:00.000Z');

  const result = await checkForUpdate({
    installedVersion: '2.1.13',
    storage,
    urls: ['https://example.test/releases.json'],
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.state, 'available');
  assert.equal(result.cached, true);
  assert.equal(result.latestVersion, '2.1.14');
  assert.match(result.error, /offline/);
  assert.equal(result.checkedAt, '2026-10-19T08:00:00.000Z');

  // A corrupt cache is ignored, not trusted.
  const corrupt = new MemoryStorage();
  corrupt.setItem('stratos.update.cache', '{"checkedAt":"x","manifest":{"schemaVersion":1}}');
  assert.equal(readCache(corrupt), null);
});

test('the second manifest location is used when the first fails', async () => {
  const manifest = manifestFor([release('2.1.14')]);
  const asked = [];
  const result = await checkForUpdate({
    installedVersion: '2.1.13',
    storage: new MemoryStorage(),
    urls: ['https://app.test/releases.json', 'https://github.test/releases.json'],
    fetchImpl: async url => {
      asked.push(url);
      if (url.includes('app.test')) throw new Error('blocked');
      return { ok: true, status: 200, json: async () => manifest };
    },
  });
  assert.equal(result.state, 'available');
  assert.deepEqual(asked, ['https://app.test/releases.json', 'https://github.test/releases.json']);
  assert.equal(result.source, 'https://github.test/releases.json');
});

test('accepting a web update asks the waiting worker to take over', async () => {
  let message = null;
  const listeners = [];
  const worker = {
    state: 'installed',
    addEventListener(type, handler) { if (type === 'statechange') listeners.push(handler); },
    postMessage(payload) {
      message = payload;
      worker.state = 'activated';
      listeners.forEach(handler => handler());
    },
  };
  const registration = { waiting: worker };
  assert.equal(await activateServiceWorker(registration), true);
  assert.deepEqual(message, { type: 'STRATOS_SKIP_WAITING' });
  assert.equal(await activateServiceWorker({ waiting: null, installing: null }), false, 'nothing waiting means nothing to activate');
});

test('the Windows update smoke receipt must show a verified, newer download', () => {
  const good = {
    currentVersion: '2.1.13',
    downloadedVersion: '2.1.14',
    verified: true,
    platform: 'win32',
  };
  assert.deepEqual(checkSmokeReceipt(good, { from: '2.1.13', to: '2.1.14' }), []);

  assert.match(checkSmokeReceipt({ ...good, verified: false }, { from: '2.1.13', to: '2.1.14' }).join(' '), /not reported as verified/);
  assert.match(checkSmokeReceipt({ ...good, error: 'net::ERR_FAILED' }, {}).join(' '), /net::ERR_FAILED/);
  assert.match(checkSmokeReceipt({ ...good, currentVersion: '2.1.12' }, { from: '2.1.13' }).join(' '), /running build/);
  assert.match(checkSmokeReceipt({ ...good, downloadedVersion: '2.1.13' }, { from: '2.1.13', to: '2.1.14' }).join(' '), /downloaded build/);
  assert.match(checkSmokeReceipt(good, { from: '2.1.14', to: '2.1.13' }).join(' '), /not newer/);
  assert.match(checkSmokeReceipt({ ...good, platform: 'linux' }, {}).join(' '), /not Windows/);
});

/* ── Presentation helpers ───────────────────────────────────────────── */

test('the changelog viewer keeps the published category order and hides empty groups', () => {
  const groups = changelogGroups(release('2.1.14', {
    changelog: {
      features: ['A feature.'],
      improvements: [],
      fixes: ['A fix.'],
      performance: [],
      ui: ['A control.'],
      compatibility: [],
      other: [],
    },
  }));
  assert.deepEqual(groups.map(group => group.key), ['features', 'fixes', 'ui']);
  assert.equal(formatChecked('not a date'), 'never');
  assert.equal(formatChecked(new Date(Date.now() - 90_000).toISOString()).includes('min'), true);
});

/* ── Changelog generation ───────────────────────────────────────────── */

test('commits are classified from their type and never moved into an unrelated category', () => {
  assert.deepEqual(classifyCommit('feat(charts): add PDF export'), { category: 'features', text: 'Add PDF export.' });
  assert.deepEqual(classifyCommit('fix(bridge): stop dropping the last track sample'), { category: 'fixes', text: 'Stop dropping the last track sample.' });
  assert.deepEqual(classifyCommit('perf: cache airport lookups'), { category: 'performance', text: 'Cache airport lookups.' });
  assert.equal(classifyCommit('style(sidebar): align rail icons').category, 'ui');
  assert.equal(classifyCommit('docs: explain the relay').category, 'other');
  assert.equal(classifyCommit('Merge pull request #42 from x/y'), null);
  assert.equal(classifyCommit('Release 2.1.14'), null, 'version bumps are the release itself');
  assert.equal(classifyCommit('feat(api)!: require the new token').category, 'compatibility');

  // Unprefixed history still classifies on words, and anything doubtful is Other.
  assert.equal(classifyCommit('Fix the collapsed grid').category, 'fixes');
  assert.equal(classifyCommit('Improve map tile caching').category, 'performance');
  assert.equal(classifyCommit('Unrelated maintenance work').category, 'other');
});

test('humanized commit text is readable and stable', () => {
  assert.equal(humanize('feat(x): add a thing'), 'Add a thing.');
  assert.equal(humanize('Add a thing'), 'Add a thing.');
  assert.equal(humanize('feat: add a thing (#15)'), 'Add a thing.');
  assert.equal(humanize('  spaces   collapse  '), 'Spaces collapse.');
});

test('a changelog is categorised, deduplicated and summarised', () => {
  const changelog = buildChangelog([
    { subject: 'feat: add replay' },
    { subject: 'feat: add replay' },
    { subject: 'fix: keep landing rates signed' },
    { subject: 'perf: stop repainting tiles' },
    { subject: 'chore: tidy scripts' },
  ]);
  assert.deepEqual(Object.keys(changelog), CATEGORY_ORDER);
  assert.deepEqual(changelog.features, ['Add replay.']);
  assert.deepEqual(changelog.other, ['Tidy scripts.']);
  assert.equal(summarize(changelog), '1 new feature, 1 fix and 1 performance change.');
  assert.equal(summarize(buildChangelog([])), 'Maintenance release with no user-facing changes.');
});

test('merging a release keeps history sorted and latest pointing at the newest stable version', () => {
  let manifest = emptyManifest();
  manifest = mergeRelease(manifest, release('2.1.9'));
  manifest = mergeRelease(manifest, release('2.1.14'));
  manifest = mergeRelease(manifest, release('2.2.0-beta.1'));
  assert.deepEqual(manifest.releases.map(item => item.version), ['2.2.0-beta.1', '2.1.14', '2.1.9']);
  assert.equal(manifest.latest.version, '2.1.14', 'a prerelease is never announced as the latest stable version');

  manifest = mergeRelease(manifest, release('2.1.14', { severity: 'important' }));
  assert.equal(manifest.releases.length, 3, 're-releasing the same version updates it instead of duplicating');
  assert.equal(manifest.latest.severity, 'important');
  assert.deepEqual(validateReleaseManifest(manifest), []);

  const markdown = renderMarkdown(manifest.latest);
  assert.match(markdown, /## Stratos 2\.1\.14/);
  assert.match(markdown, /### New features/);
});

function curatedFile(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-curated-'));
  const file = path.join(dir, 'curated.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  return file;
}

test('curated notes replace generated ones and keep the manifest shape', () => {
  const file = curatedFile({
    '2.1.14': {
      summary: 'A written summary.',
      changelog: { features: ['A real feature.'], fixes: ['A real fix.'], other: 'not an array' },
    },
  });
  // The malformed category is reported instead of being dropped silently.
  const problems = validateCurated(loadCurated(file)['2.1.14'], '2.1.14');
  assert.ok(problems.some(problem => problem.includes('other must be an array')), problems.join('; '));
  assert.throws(() => curatedRelease('2.1.14', file), /other must be an array/);

  const good = curatedFile({
    '2.1.14': { summary: 'A written summary.', changelog: { features: ['A real feature.'], fixes: ['A real fix.'] } },
  });
  const release = curatedRelease('2.1.14', good);
  assert.equal(release.summary, 'A written summary.');
  assert.deepEqual(release.changelog.features, ['A real feature.']);
  assert.deepEqual(release.changelog.ui, [], 'every category exists so the interface never reads undefined');
  assert.equal(curatedRelease('2.1.13', good), null, 'a version with no written notes falls back to the commits');
});

test('a curated entry with no summary still gets one, and an empty entry is refused', () => {
  const file = curatedFile({ '2.2.0': { changelog: { features: ['Two new pages.'] } } });
  const release = curatedRelease('v2.2.0', file);
  assert.equal(release.summary, '1 new feature.', 'the generated summary is used when none was written');

  const empty = curatedFile({ '2.2.1': { changelog: { features: [] } } });
  assert.throws(() => curatedRelease('2.2.1', empty), /changelog is empty/);
});

test('a mistyped category or version is a build failure, not a silently dropped line', () => {
  const file = curatedFile({
    'not-a-version': { changelog: { features: ['Something.'] } },
    '2.1.14': { changelog: { feature: ['Wrong key.'] } },
  });
  const problems = validateCuratedFile(file);
  assert.ok(problems.some(problem => problem.includes('is not a version')), problems.join('; '));
  assert.ok(problems.some(problem => problem.includes('"feature" is not a category')), problems.join('; '));
});

test('the checked-in curated notes are valid and cover the release they describe', () => {
  const file = fileURLToPath(new URL('../release-notes/curated.json', import.meta.url));
  assert.deepEqual(validateCuratedFile(file), []);
  const all = loadCurated(file);
  const manifest = JSON.parse(fs.readFileSync(new URL('../app/releases.json', import.meta.url), 'utf8'));
  for (const [version, entry] of Object.entries(all)) {
    const known = manifest.releases.find(item => item.version === version);
    assert.ok(known, `curated notes for ${version} have no release in the manifest yet`);
    assert.ok(entry.changelog && Object.values(entry.changelog).some(list => list.length), `${version} lists no changes`);
  }
});

test('generating a release with curated notes writes them and refuses a broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-generate-'));
  const curated = path.join(dir, 'curated.json');
  const manifest = path.join(dir, 'releases.json');
  fs.writeFileSync(manifest, JSON.stringify(emptyManifest()));
  fs.writeFileSync(curated, JSON.stringify({
    '2.3.0': { summary: 'Hand written.', changelog: { features: ['Only real work.'], other: [] } },
  }));
  const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script, '--version', '2.3.0', '--curated', curated, '--manifest', manifest, '--date', '2026-01-02'], { encoding: 'utf8' });
  assert.match(output, /using curated notes for 2\.3\.0/);
  const written = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(written.latest.summary, 'Hand written.');
  assert.deepEqual(written.latest.changelog.features, ['Only real work.']);

  fs.writeFileSync(curated, JSON.stringify({ '2.3.1': { changelog: { features: 'not-an-array' } } }));
  assert.throws(() => execFileSync(process.execPath, [script, '--version', '2.3.1', '--curated', curated, '--manifest', manifest], { encoding: 'utf8', stdio: 'pipe' }), /Command failed|invalid curated/);
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).latest.version, '2.3.0', 'a broken file changes nothing');
});

test('the checked-in release manifest is valid and its latest entry matches the app version', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../app/releases.json', import.meta.url), 'utf8'));
  const checked = validateManifest(raw);
  assert.equal(checked.ok, true, checked.problems.join('; '));
  const versionSource = fs.readFileSync(new URL('../app/js/lib/version.js', import.meta.url), 'utf8');
  const appVersion = versionSource.match(/APP_VERSION = '([^']+)'/)[1];
  assert.equal(checked.manifest.latest.version, appVersion, 'the manifest and the app report the same version');
  assert.deepEqual(validateReleaseManifest(raw), []);
  assert.ok(raw.releases.length >= 2, 'previous release notes are retained');
});
