import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFeeds } from '../scripts/merge-update-feeds.mjs';

const arm = {
  version: '2.2.0',
  releaseDate: '2026-10-21T00:00:00.000Z',
  files: [
    { url: 'Stratos-2.2.0-mac-arm64.zip', sha512: 'arm', size: 100 },
    { url: 'Stratos-2.2.0-mac-arm64.dmg', sha512: 'armdmg', size: 90 },
  ],
  path: 'Stratos-2.2.0-mac-arm64.zip',
  sha512: 'arm',
};
const intel = {
  version: '2.2.0',
  releaseDate: '2026-10-21T00:00:00.000Z',
  files: [{ url: 'Stratos-2.2.0-mac-x64.zip', sha512: 'x64', size: 110 }],
  path: 'Stratos-2.2.0-mac-x64.zip',
  sha512: 'x64',
};

test('merges both Mac architectures into one feed', () => {
  const merged = mergeFeeds([arm, intel]);
  assert.equal(merged.version, '2.2.0');
  assert.deepEqual(merged.files.map(file => file.url).sort(), [
    'Stratos-2.2.0-mac-arm64.dmg',
    'Stratos-2.2.0-mac-arm64.zip',
    'Stratos-2.2.0-mac-x64.zip',
  ]);
  assert.equal(merged.path, 'Stratos-2.2.0-mac-x64.zip', 'legacy field points at the Intel zip');
  assert.equal(merged.sha512, 'x64');
});

test('refuses a feed set that lacks one architecture', () => {
  assert.throws(() => mergeFeeds([arm]), /x64 update zip/);
  assert.throws(() => mergeFeeds([intel]), /arm64 update zip/);
});

test('refuses feeds that disagree on the version', () => {
  assert.throws(() => mergeFeeds([arm, { ...intel, version: '2.2.1' }]), /disagree/);
});

test('keeps one entry when the same file is listed twice', () => {
  const merged = mergeFeeds([arm, arm, intel]);
  assert.equal(merged.files.filter(file => file.url.endsWith('arm64.zip')).length, 1);
});
