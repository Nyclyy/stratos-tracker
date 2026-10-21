#!/usr/bin/env node
/* Check the receipt from a Windows update smoke run.

   The workflow installs a published Stratos release, launches it with
   `--update-smoke`, and the app writes one JSON receipt after the updater has
   downloaded and verified the next release. This script turns that receipt into
   a pass/fail so the workflow never treats "the process started" as success:

     node scripts/check-update-smoke.mjs receipt.json --from 2.1.13 --to 2.1.14
*/
import fs from 'node:fs';
import path from 'node:path';
import { parseVersion, compareVersions } from '../app/js/lib/updates.js';

const clean = value => String(value || '').trim().replace(/^v/i, '');

export function checkSmokeReceipt(receipt, { from, to } = {}) {
  const problems = [];
  if (!receipt || typeof receipt !== 'object') return ['the receipt is not an object'];
  if (receipt.error) problems.push(`the updater reported: ${receipt.error}`);
  if (!parseVersion(receipt.currentVersion)) problems.push(`currentVersion ${JSON.stringify(receipt.currentVersion)} is not a version`);
  if (!parseVersion(receipt.downloadedVersion)) problems.push(`downloadedVersion ${JSON.stringify(receipt.downloadedVersion)} is not a version`);
  if (receipt.verified !== true) problems.push('the download was not reported as verified');
  if (receipt.platform && receipt.platform !== 'win32') problems.push(`the smoke run was on ${receipt.platform}, not Windows`);
  if (from) {
    if (clean(receipt.currentVersion) !== clean(from)) {
      problems.push(`the running build was ${receipt.currentVersion}, expected ${from}`);
    }
  }
  if (to) {
    if (clean(receipt.downloadedVersion) !== clean(to)) {
      problems.push(`the downloaded build was ${receipt.downloadedVersion}, expected ${to}`);
    }
    if (from && parseVersion(from) && parseVersion(to) && compareVersions(to, from) <= 0) {
      problems.push(`${to} is not newer than ${from}`);
    }
  }
  return problems;
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage: check-update-smoke.mjs RECEIPT.json --from X.Y.Z --to X.Y.Z');
    process.exit(2);
  }
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    console.error(`could not read ${file}: ${error.message}`);
    process.exit(1);
  }
  const problems = checkSmokeReceipt(receipt, { from: arg('from'), to: arg('to') });
  if (problems.length) {
    console.error(`update smoke test failed:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`update smoke test passed: ${receipt.currentVersion} -> ${receipt.downloadedVersion}, verified`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) main();
