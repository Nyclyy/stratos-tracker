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
  const sections = ['career', 'landings', 'replay', 'briefing', 'routes', 'airports', 'settings'];
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
  const settings = read('app/js/pilot/settings.js')
    .match(/<strong>Stratos<\/strong><span class="tag">v([\d.]+)<\/span>/)?.[1];
  assert.match(pkg, /^\d+\.\d+\.\d+$/, 'package.json carries a release version');
  assert.equal(bridge, pkg, 'the bridge reports the release version');
  assert.equal(settings, pkg, 'the Settings page shows the release version');
  const stamp = read('scripts/stamp-version.py');
  for (const file of ['bridge_logbook_addon.py', 'app/js/pilot/settings.js']) {
    assert.ok(stamp.includes(file), `the release stamp updates ${file}`);
  }
  // The tag now matches the committed version, so the build's stamp must accept
  // an unchanged version instead of failing the release.
  assert.match(read('.github/workflows/release-windows.yml'), /--allow-same-version/);
});
