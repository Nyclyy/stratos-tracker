import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import {
  PLATFORMS,
  downloadPromptEligible,
  formatSize,
  initDownloadPrompt,
  installersFromManifest,
  installersFromRelease,
} from '../app/js/downloads.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../app/releases.json', import.meta.url), 'utf8'));

function memoryStorage() {
  const store = new Map();
  return {
    store,
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
  };
}

function mountable() {
  const { window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
  return { window, document: window.document };
}

test('the download offer is website-only, never the app or the bridge page', () => {
  // The public site.
  assert.equal(downloadPromptEligible({ protocol: 'https:', hostname: 'www.stratos-tracker.com', desktop: null }), true);
  // The packaged desktop app loads its pages over file:// and exposes the bridge API.
  assert.equal(downloadPromptEligible({ protocol: 'file:', hostname: '', desktop: {} }), false);
  assert.equal(downloadPromptEligible({ protocol: 'https:', hostname: 'example.com', desktop: { getStatus() {} } }), false);
  // The PC bridge serves over plain http, usually from a LAN address, and the
  // dev server runs on loopback: neither is the public website.
  assert.equal(downloadPromptEligible({ protocol: 'http:', hostname: '192.168.1.50', desktop: null }), false);
  assert.equal(downloadPromptEligible({ protocol: 'http:', hostname: '127.0.0.1', desktop: null }), false);
  assert.equal(downloadPromptEligible({ protocol: 'https:', hostname: 'localhost', desktop: null }), false);
});

test('the offer lists exactly the installers the published manifest carries', () => {
  const result = installersFromManifest(manifest);
  const downloads = manifest.latest.downloads;
  assert.ok(downloads, 'the manifest on main carries the download table');
  assert.equal(result.version, manifest.latest.version);
  assert.deepEqual(result.items.map(item => item.key), PLATFORMS.filter(platform => downloads[platform.key]).map(platform => platform.key));
  assert.equal(result.items.length, 4, 'Windows, both macOS builds and Linux');
  for (const item of result.items) {
    assert.equal(item.url, downloads[item.key].url, `${item.key} uses the release's own URL`);
    assert.match(item.url, /^https:\/\/github\.com\/Nyclyy\/stratos-tracker\/releases\/download\//);
    assert.ok(item.size.endsWith('MB'), 'the published size is shown');
    assert.ok(item.label && item.note, 'each installer states its platform');
  }
  const windows = result.items.find(item => item.key === 'windows');
  assert.match(windows.url, /Stratos-Setup\.exe$/);
  assert.match(result.items.find(item => item.key === 'mac-arm64').url, /mac-arm64\.dmg$/);
});

test('a manifest with no table offers the release page instead of inventing links', () => {
  const result = installersFromManifest({ latest: { version: '9.9.9', downloads: null } });
  assert.equal(result.items.length, 0);
  assert.equal(result.fallback, 'https://github.com/Nyclyy/stratos-tracker/releases');
  assert.equal(installersFromManifest(null).items.length, 0);
  // A row whose URL is not a web address is dropped, not rendered dead.
  const partial = installersFromManifest({
    latest: { version: '1.0.0', downloads: { windows: { url: 'javascript:alert(1)', size: 10 }, 'linux-x64': { url: 'https://example.com/a.AppImage', size: 2048 } } },
  });
  assert.deepEqual(partial.items.map(item => item.key), ['linux-x64']);
});

test('a freshly published release fills the gap from its own attached assets', () => {
  const release = {
    tag_name: 'v2.1.26',
    assets: [
      { name: 'latest.yml', size: 10, browser_download_url: 'https://github.com/x/y/releases/download/v2.1.26/latest.yml' },
      { name: 'Stratos-Setup.exe', size: 107000000, browser_download_url: 'https://github.com/x/y/releases/download/v2.1.26/Stratos-Setup.exe' },
      { name: 'Stratos-Setup.exe.blockmap', size: 100, browser_download_url: 'https://github.com/x/y/releases/download/v2.1.26/Stratos-Setup.exe.blockmap' },
      { name: 'Stratos-2.1.26-mac-arm64.dmg', size: 123000000, browser_download_url: 'https://github.com/x/y/releases/download/v2.1.26/Stratos-2.1.26-mac-arm64.dmg' },
      { name: 'Stratos-2.1.26-mac-arm64.zip', size: 123300000, browser_download_url: 'https://github.com/x/y/releases/download/v2.1.26/Stratos-2.1.26-mac-arm64.zip' },
      { name: 'Stratos-2.1.26-mac-x64.dmg', size: 128000000, browser_download_url: 'https://github.com/x/y/releases/download/v2.1.26/Stratos-2.1.26-mac-x64.dmg' },
      { name: 'Stratos-2.1.26-linux-x64.AppImage', size: 144000000, browser_download_url: 'https://github.com/x/y/releases/download/v2.1.26/Stratos-2.1.26-linux-x64.AppImage' },
    ],
  };
  const result = installersFromRelease(release);
  assert.equal(result.version, '2.1.26');
  assert.deepEqual(result.items.map(item => item.key), ['windows', 'mac-arm64', 'mac-x64', 'linux-x64']);
  for (const item of result.items) {
    assert.doesNotMatch(item.url, /\.(zip|blockmap|yml)$/, 'only installers are offered');
  }
  assert.equal(formatSize(107334063), '102 MB');
  assert.equal(formatSize(undefined), '');
});

test('the panel reads the manifest, closes to a Downloads control and reopens', async () => {
  const { window, document } = mountable();
  const storage = memoryStorage();
  const offer = await initDownloadPrompt({
    window,
    document,
    storage,
    protocol: 'https:',
    hostname: 'www.stratos-tracker.com',
    desktop: null,
    readInstallers: async () => installersFromManifest(manifest),
  });
  assert.ok(offer, 'the website gets the offer');
  const panel = document.getElementById('dlOffer');
  const chip = document.getElementById('dlChip');
  assert.ok(panel, 'the panel is in the page');
  assert.ok(document.getElementById('app').contains(panel), 'it mounts with the map, not over the bar');
  assert.equal(panel.querySelectorAll('a.dl-btn').length, 4, 'a button for every installer');
  assert.match(panel.textContent, /Download Stratos/, 'the offer says what it is');
  assert.match(panel.textContent, /Windows/);
  assert.match(panel.textContent, /Linux/);
  assert.ok(panel.querySelector('.dl-x'), 'there is a close control');
  assert.equal(chip.hidden, true, 'the way back in stays out of the way while the panel is open');

  panel.querySelector('.dl-x').dispatchEvent(new window.Event('click'));
  assert.equal(panel.hidden, true, 'closing hides the panel without a reload');
  assert.equal(chip.hidden, false, 'and leaves a Downloads control');
  assert.equal(storage.getItem('stratos.downloads.dismissed'), manifest.latest.version, 'the dismissal names the build');

  chip.dispatchEvent(new window.Event('click'));
  assert.equal(panel.hidden, false, 'the Downloads control reopens it');
  assert.equal(chip.hidden, true);
});

test('a dismissed build stays dismissed on the next visit', async () => {
  const { window, document } = mountable();
  const storage = memoryStorage();
  storage.setItem('stratos.downloads.dismissed', manifest.latest.version);
  await initDownloadPrompt({
    window, document, storage, protocol: 'https:', hostname: 'stratos-tracker.com', desktop: null,
    readInstallers: async () => installersFromManifest(manifest),
  });
  assert.equal(document.getElementById('dlOffer').hidden, true);
  assert.equal(document.getElementById('dlChip').hidden, false);
});

test('no panel is mounted inside the app or on the bridge page', async () => {
  for (const options of [
    { protocol: 'file:', hostname: '', desktop: { getStatus() {} } },
    { protocol: 'http:', hostname: '192.168.1.20', desktop: null },
  ]) {
    const { window, document } = mountable();
    const result = await initDownloadPrompt({
      window, document, storage: memoryStorage(), readInstallers: async () => installersFromManifest(manifest), ...options,
    });
    assert.equal(result, null);
    assert.equal(document.getElementById('dlOffer'), null);
    assert.equal(document.getElementById('dlChip'), null);
  }
});

test('an unreadable manifest still leaves a real way to the releases page', async () => {
  const { window, document } = mountable();
  await initDownloadPrompt({
    window, document, storage: memoryStorage(), protocol: 'https:', hostname: 'stratos-tracker.com', desktop: null,
    readInstallers: async () => ({ version: '', items: [], fallback: 'https://github.com/Nyclyy/stratos-tracker/releases' }),
  });
  const panel = document.getElementById('dlOffer');
  assert.equal(panel.querySelectorAll('a.dl-btn').length, 1);
  assert.match(panel.textContent, /could not be read/);
  assert.equal(panel.querySelector('a.dl-btn').href, 'https://github.com/Nyclyy/stratos-tracker/releases');
});

test('every website page can reach the offer, and the app page wires it up', () => {
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /import \{ initDownloadPrompt \} from '\.\/js\/downloads\.js'/, 'the map page loads it');
  assert.match(page, /initDownloadPrompt\(\)/, 'and initialises it');
  for (const name of ['pilot.html', 'efb.html', 'logbook.html', 'discover.html']) {
    const html = fs.readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');
    assert.equal(html.includes('initDownloadPrompt'), false, `${name} does not add the website offer`);
  }
  const module = fs.readFileSync(new URL('../app/js/downloads.js', import.meta.url), 'utf8');
  assert.match(module, /releases\.json/, 'the installers come from the published manifest');
  assert.match(module, /api\.github\.com\/repos\/\$\{REPO\}\/releases\/latest/, 'with the release as the fallback');
  assert.equal(/href\s*=\s*['"][^'"]*Setup\.exe/.test(module), false, 'no asset URL is constructed by hand');
});
