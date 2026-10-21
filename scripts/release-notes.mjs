#!/usr/bin/env node
/* Build the release manifest and the human-readable changelog for a release.

   The manifest (app/releases.json) is the single place the app reads a published
   version, its severity and its notes from. It is generated here from real git
   history, so a release can never describe a change that was not committed.

     node scripts/release-notes.mjs --version 2.1.14 --from v2.1.13
     node scripts/release-notes.mjs --version 2.1.14 --severity critical \
       --reason "Fixes a logbook migration that could drop records."

   Commit subjects are classified by their conventional-commit type when they
   have one and by conservative keywords when they do not. Anything the script
   cannot classify goes under "Other changes" instead of being guessed into a
   feature or a fix.
*/
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = ['features', 'improvements', 'fixes', 'performance', 'ui', 'compatibility', 'other'];

export const CATEGORY_LABELS = {
  features: 'New features',
  improvements: 'Improvements',
  fixes: 'Bug fixes',
  performance: 'Performance',
  ui: 'Interface',
  compatibility: 'Compatibility and important notices',
  other: 'Other changes',
};

export const SEVERITIES = ['normal', 'important', 'critical'];

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'app', 'releases.json');
const MAX_RELEASES = 30;

/* ── Version comparison ─────────────────────────────────────────────── */

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
  // A version with a prerelease tag sorts before the same version without one.
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

/* ── Commit classification ──────────────────────────────────────────── */

const TYPE_CATEGORY = {
  feat: 'features',
  feature: 'features',
  fix: 'fixes',
  bugfix: 'fixes',
  perf: 'performance',
  style: 'ui',
  ui: 'ui',
  refactor: 'improvements',
  docs: 'other',
  doc: 'other',
  test: 'other',
  tests: 'other',
  chore: 'other',
  build: 'other',
  ci: 'other',
  revert: 'other',
};

/** "feat(charts): add PDF export" -> { category, text } */
export function classifyCommit(subject, body = '') {
  const raw = String(subject || '').trim();
  if (!raw) return null;
  if (/^merge (pull request|branch|remote-tracking)/i.test(raw)) return null;
  // Version bumps are the release itself, not a change worth listing.
  if (/^release v?\d+\.\d+\.\d+/i.test(raw)) return null;

  const conventional = raw.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/);
  if (conventional) {
    const type = conventional[1].toLowerCase();
    const breaking = Boolean(conventional[3]) || /BREAKING[ -]CHANGE/i.test(String(body || ''));
    const text = humanize(conventional[4]);
    if (breaking) return { category: 'compatibility', text };
    return { category: TYPE_CATEGORY[type] || 'other', text };
  }

  const text = humanize(raw);
  if (/BREAKING[ -]CHANGE/i.test(String(body || ''))) return { category: 'compatibility', text };
  if (/\b(fix|fixes|fixed|corrects?|corrected|stops?|stopped|prevent|resolve|repair|guard)\b/i.test(raw)) {
    return { category: 'fixes', text };
  }
  if (/\b(perf|performance|faster|speed|optimi[sz]e|latency|memory|cache|caching)\b/i.test(raw)) {
    return { category: 'performance', text };
  }
  if (/\b(ui|ux|layout|design|theme|chrome|sidebar|rail|icon|polish|typography|responsive|style)\b/i.test(raw)) {
    return { category: 'ui', text };
  }
  if (/\b(add|adds|added|new|introduce|introduces|support|supports|ship|ships)\b/i.test(raw)) {
    return { category: 'features', text };
  }
  return { category: 'other', text };
}

/** Sentence-case a commit subject without changing its meaning. */
export function humanize(subject) {
  let text = String(subject || '').trim().replace(/\s+/g, ' ');
  text = text.replace(/^(feat|feature|fix|perf|style|ui|refactor|docs?|tests?|chore|build|ci|revert)(\([^)]*\))?!?:\s*/i, '');
  text = text.replace(/\s*\(#\d+\)\s*$/, '');
  if (!text) return '';
  text = text[0].toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) text += '.';
  return text;
}

/** Group classified commits into the manifest's changelog shape. */
export function buildChangelog(commits) {
  const changelog = Object.fromEntries(CATEGORIES.map(key => [key, []]));
  const seen = new Set();
  for (const commit of commits || []) {
    const entry = typeof commit === 'string' ? classifyCommit(commit) : classifyCommit(commit.subject, commit.body);
    if (!entry || !entry.text) continue;
    const fingerprint = entry.text.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    changelog[entry.category].push(entry.text);
  }
  return changelog;
}

export function summarize(changelog) {
  const parts = [];
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  if (changelog.features?.length) parts.push(plural(changelog.features.length, 'new feature', 'new features'));
  if (changelog.improvements?.length) parts.push(plural(changelog.improvements.length, 'improvement', 'improvements'));
  if (changelog.fixes?.length) parts.push(plural(changelog.fixes.length, 'fix', 'fixes'));
  if (changelog.performance?.length) parts.push(plural(changelog.performance.length, 'performance change', 'performance changes'));
  if (changelog.ui?.length) parts.push(plural(changelog.ui.length, 'interface change', 'interface changes'));
  if (!parts.length) {
    const total = countChanges(changelog);
    if (!total) return 'Maintenance release with no user-facing changes.';
    return `${plural(total, 'change', 'changes')} outside the main categories.`;
  }
  const last = parts.pop();
  return parts.length ? `${parts.join(', ')} and ${last}.` : `${last}.`;
}

function countChanges(changelog) {
  return CATEGORIES.reduce((total, key) => total + (changelog[key]?.length || 0), 0);
}

/* ── Manifest ───────────────────────────────────────────────────────── */

export function emptyManifest() {
  return {
    schemaVersion: 1,
    product: 'stratos',
    source: 'https://github.com/Nyclyy/stratos-tracker',
    latest: null,
    releases: [],
  };
}

/** Add a release, keeping history sorted and `latest` pointing at the newest stable one. */
export function mergeRelease(manifest, release) {
  const next = {
    ...emptyManifest(),
    ...(manifest || {}),
    releases: Array.isArray(manifest?.releases) ? manifest.releases.slice() : [],
  };
  const index = next.releases.findIndex(item => item.version === release.version);
  if (index >= 0) next.releases[index] = { ...next.releases[index], ...release };
  else next.releases.push(release);
  next.releases.sort((a, b) => compareVersions(b.version, a.version));
  next.releases = next.releases.slice(0, MAX_RELEASES);
  next.latest = next.releases.find(item => parseVersion(item.version)?.prerelease.length === 0) || next.releases[0] || null;
  return next;
}

export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['the manifest is not an object'];
  if (manifest.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (!Array.isArray(manifest.releases)) problems.push('releases must be an array');
  const versions = new Set();
  for (const release of manifest.releases || []) {
    if (!parseVersion(release?.version)) problems.push(`invalid version ${JSON.stringify(release?.version)}`);
    if (versions.has(release?.version)) problems.push(`duplicate release ${release.version}`);
    versions.add(release?.version);
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(release?.releasedAt || ''))) problems.push(`${release?.version}: releasedAt must be an ISO date`);
    if (!SEVERITIES.includes(release?.severity)) problems.push(`${release?.version}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (release?.severity === 'critical' && !String(release?.reason || '').trim()) {
      problems.push(`${release?.version}: a critical release needs a reason`);
    }
    if (release?.minimumSupported && !parseVersion(release.minimumSupported)) problems.push(`${release?.version}: invalid minimumSupported`);
    if (!release?.changelog || typeof release.changelog !== 'object') problems.push(`${release?.version}: changelog missing`);
  }
  const latest = manifest.latest;
  if (!latest || !parseVersion(latest.version)) problems.push('latest.version is not a valid version');
  if (latest) {
    const known = (manifest.releases || []).find(item => item.version === latest.version);
    if (!known) problems.push('latest does not appear in releases');
    // "latest" means the newest stable version; a prerelease may be newer in
    // the list without ever being announced to users.
    const stable = (manifest.releases || []).filter(item => !parseVersion(item.version)?.prerelease.length)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (stable && compareVersions(latest.version, stable.version) !== 0) problems.push(`latest is ${latest.version} but ${stable.version} is newer`);
  }
  return problems;
}

export function renderMarkdown(release) {
  const lines = [`## Stratos ${release.version}`, '', `Released ${release.releasedAt}. ${release.summary || ''}`.trim()];
  if (release.severity === 'critical') lines.push('', `> **Important:** ${release.reason}`);
  for (const key of CATEGORIES) {
    const items = release.changelog?.[key] || [];
    if (!items.length) continue;
    lines.push('', `### ${CATEGORY_LABELS[key]}`, '', ...items.map(item => `- ${item}`));
  }
  return `${lines.join('\n').trim()}\n`;
}

/* ── CLI ────────────────────────────────────────────────────────────── */

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function readManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return emptyManifest(); }
}

function commitsBetween(from, to) {
  const range = from ? `${from}..${to || 'HEAD'}` : (to || 'HEAD');
  const raw = git(['log', '--no-merges', '--pretty=format:%s%x1f%b%x1e', range]);
  return raw.split('\x1e').map(chunk => chunk.trim()).filter(Boolean).map(chunk => {
    const [subject, body] = chunk.split('\x1f');
    return { subject: subject.trim(), body: (body || '').trim() };
  });
}

function main() {
  if (has('check')) {
    const file = arg('manifest', MANIFEST);
    const problems = validateManifest(readManifest(file));
    if (problems.length) {
      console.error(`release manifest is invalid:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
      process.exit(1);
    }
    console.log(`release manifest is valid (${readManifest(file).releases.length} releases)`);
    return;
  }

  const version = arg('version').replace(/^v/i, '');
  if (!parseVersion(version)) {
    console.error('usage: release-notes.mjs --version X.Y.Z [--from TAG] [--to REF] [--severity normal|important|critical] [--reason TEXT] [--markdown FILE]');
    process.exit(2);
  }
  const severity = arg('severity', 'normal');
  if (!SEVERITIES.includes(severity)) {
    console.error(`severity must be one of ${SEVERITIES.join(', ')}`);
    process.exit(2);
  }
  const reason = arg('reason');
  if (severity === 'critical' && !reason) {
    console.error('a critical release needs --reason so the interface can explain why it is required');
    process.exit(2);
  }

  const from = arg('from') || (() => {
    try { return git(['describe', '--tags', '--abbrev=0', `${version === 'HEAD' ? 'HEAD' : 'HEAD'}^`]); } catch (_) { return ''; }
  })();
  const to = arg('to', 'HEAD');
  const commits = commitsBetween(from && from !== `v${version}` ? from : '', to);
  const changelog = buildChangelog(commits);

  const existing = readManifest(arg('manifest', MANIFEST));
  const previous = existing.releases?.find(item => item.version === version) || {};
  const release = {
    ...previous,
    version,
    releasedAt: arg('date', new Date().toISOString().slice(0, 10)),
    severity,
    summary: summarize(changelog),
    changelog,
  };
  if (reason) release.reason = reason;
  else delete release.reason;
  const minimum = arg('minimum');
  if (minimum) release.minimumSupported = minimum;
  const download = arg('windows');
  if (download) {
    release.downloads = {
      ...(release.downloads || {}),
      windows: {
        url: download,
        sha256: arg('sha256'),
        size: Number(arg('size', '0')) || null,
      },
    };
  }

  const manifest = mergeRelease(existing, release);
  const problems = validateManifest(manifest);
  if (problems.length) {
    console.error(`refusing to write an invalid manifest:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
    process.exit(1);
  }
  const out = arg('manifest', MANIFEST);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, out)} with ${manifest.releases.length} releases; latest ${manifest.latest.version}`);
  console.log(`summary: ${release.summary}`);

  const markdownFile = arg('markdown');
  const markdown = renderMarkdown(release);
  if (markdownFile) {
    fs.mkdirSync(path.dirname(path.resolve(markdownFile)), { recursive: true });
    fs.writeFileSync(markdownFile, markdown);
    console.log(`wrote ${markdownFile}`);
  } else {
    process.stdout.write(`\n${markdown}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) main();
