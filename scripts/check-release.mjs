#!/usr/bin/env node
// Check that a published Stratos release is actually installable.
//
//   node scripts/check-release.mjs            # version from package.json
//   node scripts/check-release.mjs 2.1.5      # a specific release
//
// Verifies the release exists for the matching tag, carries the installer and
// its checksum, that the installer is a plausible size (the packaging step in
// .github/workflows/release-windows.yml fails below 30 MB when app assets go
// missing), and that the published .sha256 really describes the published
// installer. Exits non-zero on the first broken expectation so it can gate a
// release from CI or a terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const deep = process.argv.includes('--deep');

const REPO = 'Nyclyy/stratos-tracker';
const MIN_INSTALLER_BYTES = 30 * 1000 * 1000;

const root = path.resolve(import.meta.dirname, '..');
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = version.startsWith('v') ? version : `v${version}`;

const failures = [];
const pass = message => console.log(`  ok   ${message}`);
const fail = message => { failures.push(message); console.log(`  FAIL ${message}`); };

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'stratos-release-check' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

console.log(`Checking ${REPO} release ${tag}`);

const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers });
if (response.status === 404) {
  console.error(`  FAIL no published release for ${tag} (the tag was probably never pushed, so the build never ran)`);
  process.exit(1);
}
if (!response.ok) {
  console.error(`  FAIL GitHub answered ${response.status} for ${tag}: ${(await response.text()).slice(0, 200)}`);
  process.exit(1);
}
const release = await response.json();

release.tag_name === tag ? pass(`release exists for ${tag}`) : fail(`release tag is ${release.tag_name}, expected ${tag}`);
release.draft ? fail('release is still a draft') : pass('release is published');
/^v\d+\.\d+\.\d+$/.test(release.tag_name) ? pass(`tag is a version tag`) : fail(`tag ${release.tag_name} is not vX.Y.Z`);

const byName = new Map((release.assets || []).map(asset => [asset.name, asset]));
const installer = byName.get('Stratos-Setup.exe');
const checksum = byName.get('Stratos-Setup.exe.sha256');
installer ? pass(`installer attached (${(installer.size / 1e6).toFixed(1)} MB, state ${installer.state})`) : fail('Stratos-Setup.exe is not attached');
checksum ? pass('checksum file attached') : fail('Stratos-Setup.exe.sha256 is not attached');
if (release.assets?.length) pass(`assets: ${release.assets.map(asset => asset.name).join(', ')}`);

if (installer) {
  installer.state === 'uploaded' ? pass('installer finished uploading') : fail(`installer state is ${installer.state}`);
  installer.size >= MIN_INSTALLER_BYTES ? pass('installer is large enough to contain the app') : fail(`installer is only ${installer.size} bytes, below the ${MIN_INSTALLER_BYTES}-byte floor`);
  installer.digest ? pass(`installer digest ${installer.digest}`) : fail('GitHub reported no digest for the installer');
}

let publishedSha = '';
if (installer && checksum) {
  const text = await (await fetch(checksum.browser_download_url, { headers })).text();
  const match = text.trim().match(/^([a-f0-9]{64})\s+\*?Stratos-Setup\.exe$/i);
  if (!match) {
    fail(`checksum file is not in "<sha256>  Stratos-Setup.exe" form: ${JSON.stringify(text.slice(0, 80))}`);
  } else if (installer.digest && installer.digest.toLowerCase() !== `sha256:${match[1].toLowerCase()}`) {
    fail(`published checksum does not match the installer (${match[1]} vs ${installer.digest})`);
  } else {
    publishedSha = match[1].toLowerCase();
    pass(`published checksum describes the installer (${publishedSha.slice(0, 12)}…)`);
  }
}

// The release manifest is what the app reads for version, notes and severity. A
// manifest that points anywhere but this tag's installer would advertise an
// update the user cannot actually install.
const manifestAsset = byName.get('releases.json');
manifestAsset ? pass('release manifest attached') : fail('releases.json is not attached; update checks have no notes');
if (manifestAsset) {
  const { validateManifest } = await import('../app/js/lib/updates.js');
  let manifest = null;
  try {
    manifest = await (await fetch(manifestAsset.browser_download_url, { headers })).json();
  } catch (error) {
    fail(`release manifest could not be read: ${error.message}`);
  }
  if (manifest) {
    const checked = validateManifest(manifest);
    checked.ok ? pass('release manifest is valid') : fail(`release manifest is invalid: ${checked.problems.join('; ')}`);
    const latest = checked.manifest?.latest;
    if (!latest) {
      fail('release manifest has no latest release');
    } else {
      latest.version === version ? pass(`manifest latest is ${latest.version}`) : fail(`manifest latest is ${latest.version}, expected ${version}`);
      const windows = latest.downloads?.windows;
      if (!windows) {
        fail('manifest has no Windows download');
      } else {
        windows.url.includes(`/releases/download/${tag}/`) && windows.url.endsWith('/Stratos-Setup.exe')
          ? pass('manifest download points at this tag\'s installer')
          : fail(`manifest download points at ${windows.url}`);
        if (publishedSha && windows.sha256 !== publishedSha) {
          fail(`manifest checksum ${windows.sha256 || '(none)'} does not match the published ${publishedSha}`);
        } else if (publishedSha) {
          pass('manifest checksum matches the published installer');
        }
      }
    }
  }
}

// --deep downloads the installer and reads the version resource Windows shows in
// its Properties dialog, which is the version an installed copy reports.
if (deep && installer && installer.state === 'uploaded') {
  const { readExeVersion } = await import('./pe-version.mjs');
  const local = path.join(os.tmpdir(), `stratos-setup-${tag}.exe`);
  const cached = fs.existsSync(local) && fs.statSync(local).size === installer.size;
  if (!cached) {
    console.log(`  ..   downloading ${(installer.size / 1e6).toFixed(1)} MB installer`);
    const download = await fetch(installer.browser_download_url, { headers, redirect: 'follow' });
    if (!download.ok) throw new Error(`installer download failed: HTTP ${download.status}`);
    fs.writeFileSync(local, Buffer.from(await download.arrayBuffer()));
  }
  try {
    const info = readExeVersion(fs.readFileSync(local));
    const embedded = info.productVersion.split('.').slice(0, 3).join('.');
    embedded === version
      ? pass(`installer reports product version ${info.productVersion} (file version ${info.fileVersion})`)
      : fail(`installer reports product version ${info.productVersion}, expected ${version}`);
  } catch (error) {
    fail(`could not read the installer's version resource: ${error.message}`);
  }
}

console.log(failures.length ? `\n${failures.length} problem(s) with ${tag}` : `\n${tag} looks installable`);
process.exit(failures.length ? 1 : 0);
