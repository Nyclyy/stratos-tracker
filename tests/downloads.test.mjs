import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import {
  PLATFORMS,
  downloadPromptEligible,
  downloadUrl,
  formatSize,
  initDownloadPrompt,
  installersFromManifest,
  installersFromRelease,
} from '../app/js/downloads.js';
import handler, { resolveAsset, resolveDownload } from '../api/download.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../app/releases.json', import.meta.url), 'utf8'));

/* The checked-in manifest can legitimately carry a newest release whose
   installers are still being built: the release workflow runs this suite before
   it uploads anything and writes the download table only once the assets exist,
   so a version bump sits on main with no table for a few minutes. The offer and
   endpoint tests below therefore run against the newest release that does carry
   a table — still the published data from the same file — and the last test pins
   that a release is never left half-filled. */
const releases = [manifest.latest, ...manifest.releases].filter(Boolean);
const newestWithTable = releases.find(release => release.downloads && Object.keys(release.downloads).length) || manifest.latest;
const published = newestWithTable === manifest.latest ? manifest : { ...manifest, latest: newestWithTable };

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

function fakeResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function fakeRes() {
  const res = {
    headers: {},
    statusCode: 0,
    ended: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end(body) { this.ended = true; if (typeof body === 'string') this.body = JSON.parse(body); return this; },
  };
  return res;
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
  const result = installersFromManifest(published);
  const downloads = published.latest.downloads;
  assert.ok(downloads, 'the manifest on main carries the download table');
  assert.equal(result.version, published.latest.version);
  assert.deepEqual(result.items.map(item => item.key), PLATFORMS.filter(platform => downloads[platform.key]).map(platform => platform.key));
  assert.equal(result.items.length, 4, 'Windows, both macOS builds and Linux');
  for (const item of result.items) {
    assert.equal(item.url, downloadUrl(item.key), `${item.key} uses the site's own link`);
    assert.equal(item.url, `/api/download?p=${item.key}`);
    assert.ok(item.size.endsWith('MB'), 'the published size is shown');
    assert.ok(item.label && item.note, 'each installer states its platform');
  }
  // The page must not expose a third-party download address, in a link or in
  // the text a visitor reads.
  const serialised = JSON.stringify(result);
  assert.equal(/github|githubusercontent/i.test(serialised), false, 'no external download host is shown');
});

test('a manifest with no table offers a retry instead of inventing links', () => {
  const result = installersFromManifest({ latest: { version: '9.9.9', downloads: null } });
  assert.equal(result.items.length, 0);
  assert.equal(installersFromManifest(null).items.length, 0);
  assert.equal(/github/i.test(JSON.stringify(result)), false);
  // A row whose asset URL is not a web address is dropped, not rendered dead.
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
    assert.equal(item.url, `/api/download?p=${item.key}`, 'the site link, not the asset URL');
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
    readInstallers: async () => installersFromManifest(published),
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
  assert.equal(panel.innerHTML.includes('github'), false, 'no third-party link in the markup');
  assert.ok(panel.querySelector('.dl-x'), 'there is a close control');
  assert.equal(chip.hidden, true, 'the way back in stays out of the way while the panel is open');

  panel.querySelector('.dl-x').dispatchEvent(new window.Event('click'));
  assert.equal(panel.hidden, true, 'closing hides the panel without a reload');
  assert.equal(chip.hidden, false, 'and leaves a Downloads control');
  assert.equal(storage.getItem('stratos.downloads.dismissed'), published.latest.version, 'the dismissal names the build');

  chip.dispatchEvent(new window.Event('click'));
  assert.equal(panel.hidden, false, 'the Downloads control reopens it');
  assert.equal(chip.hidden, true);
});

test('a dismissed build stays dismissed on the next visit', async () => {
  const { window, document } = mountable();
  const storage = memoryStorage();
  storage.setItem('stratos.downloads.dismissed', published.latest.version);
  await initDownloadPrompt({
    window, document, storage, protocol: 'https:', hostname: 'stratos-tracker.com', desktop: null,
    readInstallers: async () => installersFromManifest(published),
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
      window, document, storage: memoryStorage(), readInstallers: async () => installersFromManifest(published), ...options,
    });
    assert.equal(result, null);
    assert.equal(document.getElementById('dlOffer'), null);
    assert.equal(document.getElementById('dlChip'), null);
  }
});

test('a manifest that cannot be read offers a retry that works', async () => {
  const { window, document } = mountable();
  let calls = 0;
  await initDownloadPrompt({
    window, document, storage: memoryStorage(), protocol: 'https:', hostname: 'stratos-tracker.com', desktop: null,
    readInstallers: async () => {
      calls += 1;
      return calls === 1 ? { version: '', items: [] } : installersFromManifest(published);
    },
  });
  let panel = document.getElementById('dlOffer');
  assert.equal(panel.querySelectorAll('a.dl-btn').length, 0, 'no invented installer');
  assert.match(panel.textContent, /could not be read/);
  const retry = panel.querySelector('.dl-retry');
  assert.ok(retry, 'the panel offers a retry');
  retry.dispatchEvent(new window.Event('click'));
  await new Promise(resolve => setTimeout(resolve, 20));
  panel = document.getElementById('dlOffer');
  assert.equal(panel.querySelectorAll('a.dl-btn').length, 4, 'the retry reads the real installers');
  assert.equal(panel.hidden, false);
});

test('the site endpoint resolves a platform to the published installer', async () => {
  const asset = published.latest.downloads.windows.url;
  assert.equal(resolveDownload(published, 'windows'), asset);
  assert.equal(resolveDownload(published, 'linux-x64'), published.latest.downloads['linux-x64'].url);
  assert.equal(resolveDownload({ latest: { downloads: null } }, 'windows'), null);
  assert.equal(resolveDownload(published, 'amiga'), null);
  assert.equal(resolveDownload({ latest: { downloads: { windows: { url: 'ftp://x/y' } } } }, 'windows'), null);

  const release = { assets: [{ name: 'Stratos-Setup.exe', browser_download_url: 'https://example.test/Setup.exe' }] };
  assert.equal(resolveAsset(release, 'windows'), 'https://example.test/Setup.exe');
  assert.equal(resolveAsset(release, 'linux-x64'), null);

  // The handler answers with the manifest's own file, cached briefly at the edge.
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => fakeResponse(published);
    const res = fakeRes();
    await handler({ query: { p: 'windows' }, headers: { host: 'www.stratos-tracker.com' } }, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, asset);
    assert.match(res.headers['cache-control'], /s-maxage=300/);
    assert.equal(res.ended, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('the endpoint rejects what it cannot resolve without inventing a file', async () => {
  const res = fakeRes();
  await handler({ query: { p: 'amiga' }, headers: { host: 'x.test' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['cache-control'], 'no-store');

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => fakeResponse(published);
    const missing = fakeRes();
    await handler({ query: { p: 'mac-arm64' }, headers: { host: 'x.test' } }, missing);
    // The manifest does carry it, so this one resolves rather than 404s.
    assert.equal(missing.statusCode, 302);

    globalThis.fetch = async () => fakeResponse({ message: 'rate limited' }, false);
    const failed = fakeRes();
    await handler({ query: { p: 'windows' }, headers: { host: 'x.test' } }, failed);
    assert.equal(failed.statusCode, 404);
    assert.match(failed.body.error, /No installer is published/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a release carries either a complete download table or none at all', () => {
  // Half a table is the one thing the site must never show: a version whose
  // Windows build downloads and whose macOS build does not exist.
  const expected = PLATFORMS.map(platform => platform.key).sort();
  for (const release of releases) {
    const table = release.downloads || {};
    const filled = Object.keys(table);
    // No table at all is normal: the releases before the site offered downloads
    // never had one, and the release being built has none until its installers
    // exist. What must never happen is a table that lists only some of them.
    if (!filled.length) continue;
    assert.deepEqual(filled.sort(), expected, `${release.version} lists every installer or none`);
    for (const [key, entry] of Object.entries(table)) {
      assert.match(entry.url, /^https:\/\//, `${release.version} ${key} has a web address`);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${release.version} ${key} carries its hash`);
      assert.ok(entry.size > 0, `${release.version} ${key} carries its size`);
    }
  }
});

test('the website carries no third-party download link anywhere', () => {
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /import \{ initDownloadPrompt \} from '\.\/js\/downloads\.js'/, 'the map page loads it');
  assert.match(page, /initDownloadPrompt\(\)/, 'and initialises it');
  for (const name of ['pilot.html', 'efb.html', 'logbook.html', 'discover.html']) {
    const html = fs.readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');
    assert.equal(html.includes('initDownloadPrompt'), false, `${name} does not add the website offer`);
  }
  const landing = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(/github/i.test(landing), false, 'the landing page shows no GitHub link or address');
  assert.match(landing, /href="\/api\/download\?p=windows"/, 'its Windows buttons use the site endpoint');
  for (const key of ['mac-arm64', 'mac-x64', 'linux-x64']) {
    assert.match(landing, new RegExp(`/api/download\\?p=${key}`), `${key} is offered from the site too`);
  }
  const module = fs.readFileSync(new URL('../app/js/downloads.js', import.meta.url), 'utf8');
  assert.match(module, /releases\.json/, 'the installers come from the published manifest');
  assert.match(module, /DOWNLOAD_ENDPOINT = '\/api\/download'/, 'and link through the site endpoint');
});
