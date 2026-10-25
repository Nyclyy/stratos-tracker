import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'app', 'js');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\b/.test(source)) names.add('default');
  return names;
}

test('every local ES module import resolves and is exported', () => {
  const files = walk(ROOT);
  const sources = new Map(files.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const exports = new Map([...sources].map(([file, source]) => [file, exportedNames(source)]));
  const problems = [];

  for (const [file, source] of sources) {
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[2];
      if (!specifier.startsWith('.')) continue;
      let target = path.resolve(path.dirname(file), specifier);
      if (!path.extname(target)) target += '.js';
      if (!fs.existsSync(target)) {
        problems.push(`${path.relative(ROOT, file)}: missing ${specifier}`);
        continue;
      }
      const available = exports.get(target) || exportedNames(fs.readFileSync(target, 'utf8'));
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name && !available.has(name)) {
          problems.push(`${path.relative(ROOT, file)}: ${name} is not exported by ${specifier}`);
        }
      }
    }
    for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      let target = path.resolve(path.dirname(file), specifier);
      if (!path.extname(target)) target += '.js';
      if (!fs.existsSync(target)) problems.push(`${path.relative(ROOT, file)}: missing dynamic ${specifier}`);
    }
  }

  assert.deepEqual(problems, []);
});

test('pilot section modules evaluate without a browser DOM', async () => {
  const sections = ['career', 'landings', 'replay', 'briefing', 'routes', 'airports', 'charts', 'settings'];
  for (const section of sections) {
    await assert.doesNotReject(
      import(`../app/js/pilot/${section}.js`),
      `${section}.js must not throw while being imported`,
    );
  }
});

test('the shipped version is stamped the same in the app, the bridge and the package', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const pkg = JSON.parse(read('package.json')).version;
  const bridge = read('bridge_logbook_addon.py').match(/^VERSION = "([^"]+)"/m)?.[1];
  const appVersion = read('app/js/lib/version.js').match(/APP_VERSION = '([^']+)'/)?.[1];
  assert.match(pkg, /^\d+\.\d+\.\d+$/, 'package.json carries a release version');
  assert.equal(bridge, pkg, 'the bridge reports the release version');
  assert.equal(appVersion, pkg, 'the web app has one version constant and it matches the build');
  assert.match(read('app/js/pilot/settings.js'), /APP_VERSION/, 'Settings reads the shared version instead of a second literal');
  const stamp = read('scripts/stamp-version.py');
  for (const file of ['bridge_logbook_addon.py', 'app/js/lib/version.js', 'app/sw.js']) {
    assert.ok(stamp.includes(file), `the release stamp updates ${file}`);
  }
  // The tag now matches the committed version, so the build's stamp must accept
  // an unchanged version instead of failing the release.
  assert.match(read('.github/workflows/release.yml'), /--allow-same-version/);
});

test('a packaged build can update itself from the GitHub releases', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies?.['electron-updater'], 'the updater is a runtime dependency, not a dev one');

  const main = read('electron-main.cjs');
  assert.match(main, /require\('electron-updater'\)/, 'the main process loads the updater');
  assert.match(main, /if \(!app\.isPackaged \|\| !autoUpdater\) return;/, 'development runs never check for updates');
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = true;/, 'a downloaded update installs when the app quits');
  assert.match(main, /ipcMain\.handle\('updater:check'/, 'the renderer can ask for an update check on demand');
  assert.match(main, /ipcMain\.handle\('updater:install'/, 'the renderer can install a downloaded update');
  assert.match(main, /autoUpdater\.quitAndInstall\(\)/, 'installing restarts straight into the new build');
  assert.match(main, /autoUpdater\.quitAndInstall\(true, true\)/, 'a download left from an earlier session is applied at launch, silently, with a relaunch');
  assert.match(main, /!sawDownloadThisRun && Date\.now\(\) - launchedAt < LAUNCH_WINDOW_MS/, 'launch-time apply is limited to the first minutes of a session');
  assert.match(main, /setTimeout\(check, LAUNCH_RECHECK_MS\)/, 'a release published while the app is open is picked up without waiting six hours');

  const preload = read('electron-preload.cjs');
  for (const channel of ['updater:status', 'updater:check', 'updater:install']) {
    assert.ok(preload.includes(channel), `the preload exposes ${channel}`);
  }
  assert.match(main, /ipcMain\.handle\('updater:status'/, 'the cached update state is readable without a network call');

  // The Settings card mounts the shared update centre, which drives the desktop
  // updater when it exists and the service worker otherwise.
  const settings = read('app/js/pilot/settings.js');
  assert.match(settings, /mountUpdateCenter/, 'Settings mounts the shared update centre');
  const centre = read('app/js/update-ui.js');
  assert.match(centre, /desktop\?\.checkForUpdates/, 'the update centre drives the desktop updater');
  assert.match(centre, /desktop\.installUpdate/, 'a ready update can be installed from the centre');
  assert.match(centre, /A new Stratos update is available\./, 'the announcement is the polished dialog');
  const lib = read('app/js/lib/updates.js');
  assert.match(lib, /releases\.json/, 'the app reads the published release manifest');
  assert.match(lib, /compareVersions/, 'versions are compared semantically');

  const config = read('electron-builder.config.cjs');
  assert.match(config, /provider: 'github'/, 'the packaged app-update.yml points at GitHub');
  assert.match(config, /repo: 'stratos-tracker'/, 'the update provider names this repository');

  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /dist\/latest\.yml/, 'the release ships the updater manifest');
  assert.match(workflow, /blockmap/, 'differential update blocks are published too');
  assert.match(workflow, /did not produce latest\.yml/, 'a release without the manifest fails instead of shipping');
  assert.match(workflow, /release-notes\.mjs --version|release-notes\.mjs \"\$\{ARGS/, 'the release generates its own notes and manifest');
  assert.match(workflow, /dist\/releases\.json/, 'the release manifest is attached to the release');
  assert.match(workflow, /check-release\.mjs "\$VERSION" --draft/, 'the draft is verified against every platform before it goes live');
  assert.match(workflow, /--draft --target/, 'the release is created as a draft and only published after checks');
  assert.match(workflow, /gh release edit "\$TAG" --draft=false/, 'the draft is published only after the draft check passes');
  assert.match(workflow, /name: Publish release/, 'the update smoke test gates on the publish job by name');
  assert.match(read('.github/workflows/update-smoke.yml'), /'Release'/, 'the update smoke test runs after the Release workflow');
  assert.match(workflow, /--notes-file dist\/release-notes\.md/, 'the release page uses the categorised changelog');
});

test('the desktop app gives its bridge a network bind a phone can reach', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const main = read('electron-main.cjs');
  // A loopback bind answers "The bridge is reachable only on this PC" to every
  // phone and never starts multicast discovery, which is exactly the state a
  // phone cannot connect from. The desktop still talks to it over loopback.
  assert.match(main, /const BRIDGE_BIND = process\.env\.STRATOS_HOST \|\| '0\.0\.0\.0'/, 'the bridge listens on the network unless a bind address is forced');
  assert.match(main, /STRATOS_HOST: BRIDGE_BIND/, 'the child process is started with that bind');
  assert.match(main, /const BRIDGE_HOST = '127\.0\.0\.1'/, 'the desktop still probes its own loopback address');
  // The exe serves the phone's page itself, so the app files must be bundled.
  const workflow = read('.github/workflows/release.yml');
  assert.equal((workflow.match(/--add-data "\$GITHUB_WORKSPACE\/app[;:]app"/g) || []).length, 3, 'every packaged bridge build carries app/');
});

test('bridge runtime state cannot be committed again', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').map(line => line.trim());
  for (const pattern of ['bridge_token.txt', 'airports_cache*.json', 'relay.json', 'aircraft.json']) {
    assert.ok(ignore.includes(pattern), `.gitignore covers ${pattern}`);
  }
  // The pairing token is a live secret: it must never sit in the working tree as
  // a tracked file after a bridge run.
  assert.ok(!fs.existsSync(path.join(root, 'bridge_token.txt')), 'no stray pairing token in the repository');
});
