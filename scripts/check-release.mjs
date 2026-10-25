#!/usr/bin/env node
// Check that a Stratos release is actually installable on every platform.
//
//   node scripts/check-release.mjs                 # version from package.json
//   node scripts/check-release.mjs 2.2.0           # a specific release
//   node scripts/check-release.mjs 2.2.0 --draft   # a draft, before it is published
//   node scripts/check-release.mjs 2.2.0 --deep    # also read the Windows version resource
//
// For Windows, macOS (arm64 and x64) and Linux it checks that the installer and
// the update files are attached, that GitHub's digest and the published bytes
// agree, that the update feeds describe those exact bytes, and that the release
// manifest points each platform at its installer. Assets are read through the
// API, so a draft can be checked before it becomes the release the updater sees.
// Exits non-zero on the first broken expectation so it can gate CI or a terminal.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const draftMode = args.includes('--draft');
const deep = args.includes('--deep');
const positional = args.filter(arg => !arg.startsWith('--'));

const REPO = 'Nyclyy/stratos-tracker';
const MIN_INSTALLER_BYTES = 30 * 1000 * 1000;
// The installers are also mirrored to our own host (scripts/publish-installers.mjs),
// and the manifest the site serves then points there. Both are legitimate; any
// other address would offer a file nobody published.
const MIRROR_BASE = (process.env.R2_PUBLIC_BASE || 'https://downloads.stratos-tracker.com').replace(/\/+$/, '');

const root = path.resolve(import.meta.dirname, '..');
const version = (positional[0] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).replace(/^v/, '');
const tag = `v${version}`;

// The app asks for a download by platform key; each key's installer is the file a
// person runs by hand, and the feeds carry the files the updater swaps in.
const PLATFORMS = [
  { key: 'windows', installer: 'Stratos-Setup.exe' },
  { key: 'mac-arm64', installer: `Stratos-${version}-mac-arm64.dmg` },
  { key: 'mac-x64', installer: `Stratos-${version}-mac-x64.dmg` },
  { key: 'linux-x64', installer: `Stratos-${version}-linux-x64.AppImage` },
];

const FEEDS = {
  'latest.yml': { files: ['Stratos-Setup.exe'] },
  'latest-mac.yml': { files: [`Stratos-${version}-mac-arm64.zip`, `Stratos-${version}-mac-x64.zip`] },
  'latest-linux.yml': { files: [`Stratos-${version}-linux-x64.AppImage`] },
};

const failures = [];
const pass = message => console.log(`  ok   ${message}`);
const fail = message => { failures.push(message); console.log(`  FAIL ${message}`); };

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'stratos-release-check' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const bytesCache = new Map();

// Drafts are only visible through the release list, and their assets only through
// the API URL with a token, so both paths are used for every check.
async function findRelease() {
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} listing releases: ${(await response.text()).slice(0, 200)}`);
    const list = await response.json();
    const found = list.find(item => item.tag_name === tag);
    if (found || list.length < 100) return found || null;
  }
  return null;
}

async function downloadAsset(asset) {
  if (bytesCache.has(asset.name)) return bytesCache.get(asset.name);
  const response = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${asset.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  bytesCache.set(asset.name, bytes);
  return bytes;
}

const digestOf = asset => (asset.digest || '').replace(/^sha256:/, '').toLowerCase();
const sha256Hex = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha512Base64 = bytes => crypto.createHash('sha512').update(bytes).digest('base64');

console.log(`Checking ${REPO} release ${tag}${draftMode ? ' before publication' : ''}`);

let release;
try {
  release = await findRelease();
} catch (error) {
  console.error(`  FAIL ${error.message}`);
  process.exit(1);
}
if (!release) {
  console.error(`  FAIL no release exists for ${tag} (the build never reached publication)`);
  process.exit(1);
}

release.tag_name === tag ? pass(`release exists for ${tag}`) : fail(`release tag is ${release.tag_name}, expected ${tag}`);
/^v\d+\.\d+\.\d+$/.test(release.tag_name) ? pass('tag is a version tag') : fail(`tag ${release.tag_name} is not vX.Y.Z`);
if (draftMode) pass(release.draft ? 'release is a draft awaiting publication' : 'release is already published');
else release.draft ? fail('release is still a draft') : pass('release is published');

const byName = new Map((release.assets || []).map(asset => [asset.name, asset]));
const required = new Set([
  ...PLATFORMS.map(platform => platform.installer),
  ...Object.values(FEEDS).flatMap(feed => feed.files),
  ...Object.keys(FEEDS),
  'Stratos-Setup.exe.sha256',
  'releases.json',
]);

let attached = 0;
for (const name of required) {
  const asset = byName.get(name);
  if (!asset) {
    fail(`${name} is not attached`);
    continue;
  }
  if (asset.state !== 'uploaded') fail(`${name} state is ${asset.state}`);
  else if (!digestOf(asset)) fail(`GitHub reported no sha256 digest for ${name}`);
  else if (/\.(exe|dmg|zip|AppImage)$/.test(name) && asset.size < MIN_INSTALLER_BYTES) {
    fail(`${name} is only ${asset.size} bytes, below the ${MIN_INSTALLER_BYTES}-byte floor; app assets are probably missing`);
  } else attached += 1;
}
if (attached === required.size) pass(`all ${required.size} expected assets are attached and uploaded`);

// The checksum file is the human-facing proof for the Windows installer.
const winAsset = byName.get('Stratos-Setup.exe');
const checksumAsset = byName.get('Stratos-Setup.exe.sha256');
if (winAsset && checksumAsset) {
  const text = (await downloadAsset(checksumAsset)).toString('utf8');
  const match = text.trim().match(/^([a-f0-9]{64})\s+\*?Stratos-Setup\.exe$/i);
  if (!match) fail(`checksum file is not in "<sha256>  Stratos-Setup.exe" form: ${JSON.stringify(text.slice(0, 80))}`);
  else if (digestOf(winAsset) !== match[1].toLowerCase()) fail(`published checksum does not match the installer (${match[1]} vs ${digestOf(winAsset)})`);
  else pass(`Windows checksum describes the installer (${match[1].slice(0, 12)}…)`);
}

// The manifest is what the app reads for version, notes and downloads. A download
// that points anywhere but this tag's installer would offer one the user cannot run.
let latest = null;
const manifestAsset = byName.get('releases.json');
if (manifestAsset) {
  const { validateManifest } = await import('../app/js/lib/updates.js');
  let raw = null;
  try {
    raw = JSON.parse((await downloadAsset(manifestAsset)).toString('utf8'));
  } catch (error) {
    fail(`release manifest could not be read: ${error.message}`);
  }
  if (raw) {
    const checked = validateManifest(raw);
    checked.ok ? pass('release manifest is valid') : fail(`release manifest is invalid: ${checked.problems.join('; ')}`);
    latest = checked.manifest?.latest || null;
  }
}
if (!latest) {
  if (manifestAsset) fail('release manifest has no latest release');
} else {
  latest.version === version ? pass(`manifest latest is ${latest.version}`) : fail(`manifest latest is ${latest.version}, expected ${version}`);
  for (const platform of PLATFORMS) {
    const entry = latest.downloads?.[platform.key];
    const asset = byName.get(platform.installer);
    if (!entry) {
      fail(`manifest has no ${platform.key} download`);
      continue;
    }
    if (!asset) continue;
    const releaseUrl = `https://github.com/${REPO}/releases/download/${tag}/${platform.installer}`;
    const mirrorUrl = `${MIRROR_BASE}/${tag}/${platform.installer}`;
    if (entry.url !== releaseUrl && entry.url !== mirrorUrl) fail(`manifest ${platform.key} download points at ${entry.url}`);
    else if (entry.sha256 !== digestOf(asset)) fail(`manifest ${platform.key} checksum ${entry.sha256 || '(none)'} does not match the published ${digestOf(asset)}`);
    else if (entry.size !== asset.size) fail(`manifest ${platform.key} size ${entry.size} does not match the published ${asset.size}`);
    else if (entry.url === mirrorUrl) {
      // Our own host is only useful if it really serves the same bytes.
      const answered = await fetch(mirrorUrl, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
      const served = answered ? Number(answered.headers.get('content-length') || 0) : 0;
      if (!answered || answered.status !== 200) fail(`manifest ${platform.key} download ${mirrorUrl} answers ${answered ? answered.status : 'nothing'}`);
      else if (served && served !== asset.size) fail(`manifest ${platform.key} download ${mirrorUrl} serves ${served} bytes, expected ${asset.size}`);
      else pass(`manifest ${platform.key} download is ${platform.installer} on our own host, with the published digest and size`);
    } else pass(`manifest ${platform.key} download is ${platform.installer} with the published digest and size`);
  }
}

// Each feed is what electron-updater downloads and trusts. Its hashes must describe
// the exact bytes GitHub serves, or an update would be refused or, worse, accepted
// from a file that differs from what was tested.
for (const [name, spec] of Object.entries(FEEDS)) {
  const feedAsset = byName.get(name);
  if (!feedAsset) continue;
  let feed = null;
  try {
    feed = yaml.load((await downloadAsset(feedAsset)).toString('utf8'));
  } catch (error) {
    fail(`${name} could not be parsed: ${error.message}`);
    continue;
  }
  feed?.version === version ? pass(`${name} is for ${version}`) : fail(`${name} is for ${feed?.version}, expected ${version}`);
  const listed = new Map((feed?.files || []).map(file => [file.url, file]));
  for (const file of spec.files) {
    const entry = listed.get(file);
    const target = byName.get(file);
    if (!entry) {
      fail(`${name} does not list ${file}`);
      continue;
    }
    if (!target) continue;
    const bytes = await downloadAsset(target);
    if (entry.sha512 !== sha512Base64(bytes)) fail(`${name} sha512 for ${file} does not match the published bytes`);
    else if (sha256Hex(bytes) !== digestOf(target)) fail(`${file} bytes do not match GitHub's digest`);
    else if (Number(entry.size) !== bytes.length) fail(`${name} size for ${file} is ${entry.size}, published bytes are ${bytes.length}`);
    else pass(`${name} describes ${file} exactly`);
  }
}

// --deep reads the version resource Windows shows in the installer's Properties,
// which is the version an installed copy reports.
if (deep && winAsset) {
  const { readExeVersion } = await import('./pe-version.mjs');
  try {
    const info = readExeVersion(await downloadAsset(winAsset));
    const embedded = info.productVersion.split('.').slice(0, 3).join('.');
    embedded === version
      ? pass(`installer reports product version ${info.productVersion} (file version ${info.fileVersion})`)
      : fail(`installer reports product version ${info.productVersion}, expected ${version}`);
  } catch (error) {
    fail(`could not read the installer's version resource: ${error.message}`);
  }
}

console.log(failures.length ? `\n${failures.length} problem(s) with ${tag}` : `\n${tag} looks installable on every platform`);
process.exit(failures.length ? 1 : 0);
