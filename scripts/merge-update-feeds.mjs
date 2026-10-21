#!/usr/bin/env node
// Merge the per-architecture macOS update feeds into the one latest-mac.yml that
// electron-updater reads. Each Mac runner writes its own feed, so the release
// job renames them and passes them here: both architectures must be listed, or
// one group of Macs would never be offered an update.
//
// Usage: node scripts/merge-update-feeds.mjs OUT.yml FEED.yml [FEED.yml ...]

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export function mergeFeeds(feeds) {
  if (!feeds.length) throw new Error('at least one feed is required');
  const version = feeds[0].version;
  for (const feed of feeds) {
    if (!feed || typeof feed !== 'object') throw new Error('a feed is not an object');
    if (feed.version !== version) {
      throw new Error(`feeds disagree on the version: ${feed.version} and ${version}`);
    }
  }

  // The same zip can appear in more than one feed only when a runner is re-run;
  // keep one entry per URL so electron-updater never sees a duplicate.
  const files = new Map();
  for (const feed of feeds) {
    for (const file of feed.files || []) {
      if (!file || typeof file.url !== 'string' || typeof file.sha512 !== 'string') {
        throw new Error('a feed file entry has no url or sha512');
      }
      files.set(file.url, file);
    }
  }
  const merged = [...files.values()];
  const zips = merged.filter(file => file.url.endsWith('.zip'));
  for (const arch of ['arm64', 'x64']) {
    if (!zips.some(file => file.url.includes(arch))) {
      throw new Error(`no ${arch} update zip is listed; both Mac architectures are required`);
    }
  }

  // Older electron-updater builds read the top-level path/sha512 instead of
  // files. Point them at the Intel zip, which runs on every supported Mac.
  const legacy = zips.find(file => file.url.includes('x64')) || zips[0];
  return {
    version,
    files: merged,
    path: legacy.url,
    sha512: legacy.sha512,
    releaseDate: feeds[0].releaseDate,
  };
}

function main() {
  const [out, ...inputs] = process.argv.slice(2);
  if (!out || !inputs.length) {
    console.error('usage: merge-update-feeds.mjs OUT.yml FEED.yml [FEED.yml ...]');
    process.exit(2);
  }
  const feeds = inputs.map(file => yaml.load(fs.readFileSync(file, 'utf8')));
  let merged;
  try {
    merged = mergeFeeds(feeds);
  } catch (error) {
    console.error(`refusing to write an invalid update feed: ${error.message}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, yaml.dump(merged, { lineWidth: -1, noRefs: true }));
  console.log(`wrote ${out} with ${merged.files.length} files for ${merged.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) main();
