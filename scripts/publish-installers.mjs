#!/usr/bin/env node
/* Upload the release installers to our own download host.

   The website's download endpoint resolves a platform to whatever URL the
   published manifest carries. This script moves that URL onto a domain we
   control — the R2 bucket behind https://downloads.stratos-tracker.com — so a
   visitor never sees a third-party file host and the link stays ours.

   Objects are versioned by tag and never rewritten in place:

       v2.1.25/Stratos-Setup.exe
       v2.1.25/Stratos-2.1.25-mac-arm64.dmg
       …
       v2.1.25/downloads.json        (the table the site can point at)

   so a bootstrap checksum, a stale manifest or a cached installer can only
   ever name the build it was written for.

   Credentials come from the environment (R2, S3-compatible):

       R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY
       R2_BUCKET      R2_PUBLIC_BASE

   Usage:
       node scripts/publish-installers.mjs --dir dist --tag v2.1.25 [--dry-run]

   `--dry-run` prints the work and uploads nothing. After an upload each file is
   fetched again from the public host, so a bucket that is not actually served
   fails here rather than on a visitor's click. The script signs its own
   requests (SigV4) and needs no dependencies. */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const INSTALLERS = [
  { key: 'windows', file: /^Stratos-Setup\.exe$/, type: 'application/octet-stream' },
  { key: 'mac-arm64', file: /^Stratos-\d[^/]*-mac-arm64\.dmg$/, type: 'application/x-apple-diskimage' },
  { key: 'mac-x64', file: /^Stratos-\d[^/]*-mac-x64\.dmg$/, type: 'application/x-apple-diskimage' },
  { key: 'linux-x64', file: /^Stratos-\d[^/]*-linux-x64\.AppImage$/, type: 'application/octet-stream' },
];

function parseArgs(argv) {
  const args = { dir: 'dist', tag: '', dryRun: false, manifest: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dir') args.dir = argv[++i];
    else if (flag === '--tag') args.tag = argv[++i];
    else if (flag === '--manifest') args.manifest = argv[++i];
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function config(env) {
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE']
    .filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. See README-DEPLOY.md ("Downloads from our own domain").`);
  return {
    account: env.R2_ACCOUNT_ID,
    accessKey: env.R2_ACCESS_KEY_ID,
    secretKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicBase: env.R2_PUBLIC_BASE.replace(/\/+$/, ''),
  };
}

/* ── SigV4, the minimum S3 needs ─────────────────────────────────────── */

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function amzDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function objectKey(tag, filename) {
  return `${tag.replace(/^v?/, 'v')}/${filename}`;
}

export function canonicalRequest({ method, path: requestPath, headers, payloadHash }) {
  const names = Object.keys(headers).map(name => name.toLowerCase()).sort();
  const canonicalHeaders = names.map(name => `${name}:${String(headers[name]).trim()}\n`).join('');
  return [method, requestPath, '', canonicalHeaders, names.join(';'), payloadHash].join('\n');
}

export function sign({ method, host, requestPath, accessKey, secretKey, payloadHash, contentType, extraHeaders = {}, region = 'auto', service = 's3', now = new Date() }) {
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  if (contentType) headers['content-type'] = contentType;
  for (const [name, value] of Object.entries(extraHeaders)) headers[name.toLowerCase()] = value;
  const canonical = canonicalRequest({ method, path: requestPath, headers, payloadHash });
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(Buffer.from(canonical, 'utf8'))].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${Object.keys(headers).map(n => n.toLowerCase()).sort().join(';')}, Signature=${signature}`,
    },
    canonical,
    signature,
  };
}

/* ── storage operations ─────────────────────────────────────────────── */

function objectUrl(settings, key) {
  const host = `${settings.account}.r2.cloudflarestorage.com`;
  return { host, path: `/${settings.bucket}/${key}` };
}

async function head(settings, key) {
  const { host, path: requestPath } = objectUrl(settings, key);
  const signed = sign({ method: 'HEAD', host, requestPath, accessKey: settings.accessKey, secretKey: settings.secretKey, payloadHash: sha256('') });
  const response = await fetch(`https://${host}${requestPath}`, { method: 'HEAD', headers: signed.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HEAD ${key} answered ${response.status}`);
  return { size: Number(response.headers.get('content-length') || 0) };
}

async function put(settings, key, body, contentType) {
  const { host, path: requestPath } = objectUrl(settings, key);
  const payloadHash = sha256(body);
  const signed = sign({
    method: 'PUT', host, requestPath, accessKey: settings.accessKey, secretKey: settings.secretKey,
    payloadHash, contentType,
  });
  const response = await fetch(`https://${host}${requestPath}`, { method: 'PUT', headers: signed.headers, body });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`PUT ${key} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
}

async function publicHead(url) {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  return { status: response.status, size: Number(response.headers.get('content-length') || 0) };
}

/* Rewrite the URLs in a manifest for the version just uploaded. Digests and
   sizes are left as published; only the address changes. */
export function pointManifest(file, version, table) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const apply = release => {
    if (!release || release.version !== version || !release.downloads) return;
    for (const [platform, entry] of Object.entries(table)) {
      if (release.downloads[platform]) release.downloads[platform].url = entry.url;
    }
  };
  apply(manifest.latest);
  for (const release of manifest.releases || []) apply(release);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`→ ${file} now points ${version} at ${Object.values(table)[0].url.replace(/\/[^/]+$/, '/')}`);
}

/* ── main ───────────────────────────────────────────────────────────── */

export function installersFor(dir) {
  const files = fs.readdirSync(dir);
  const found = [];
  for (const platform of INSTALLERS) {
    const name = files.find(file => platform.file.test(file));
    if (!name) continue;
    const full = path.join(dir, name);
    found.push({
      key: platform.key,
      name,
      path: full,
      type: platform.type,
      size: fs.statSync(full).size,
    });
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/publish-installers.mjs --dir dist --tag v2.1.25 [--manifest app/releases.json] [--dry-run]');
    return;
  }
  if (!args.tag) throw new Error('--tag is required (for example --tag v2.1.25)');
  const settings = config(process.env);
  const installers = installersFor(args.dir);
  if (!installers.length) throw new Error(`No installers found in ${args.dir}`);
  const missing = INSTALLERS.map(platform => platform.key).filter(key => !installers.some(item => item.key === key));
  if (missing.length) throw new Error(`Incomplete release: ${missing.join(', ')} missing from ${args.dir}`);

  const downloads = {};
  for (const item of installers) {
    const key = objectKey(args.tag, item.name);
    const url = `${settings.publicBase}/${key}`;
    const existing = args.dryRun ? null : await head(settings, key);
    if (existing && existing.size === item.size) {
      console.log(`= ${key} already uploaded (${existing.size} bytes)`);
    } else if (args.dryRun) {
      console.log(`→ would upload ${key} (${item.size} bytes) to ${url}`);
    } else {
      const body = fs.readFileSync(item.path);
      await put(settings, key, body, item.type);
      console.log(`↑ ${key} (${item.size} bytes)`);
    }
    downloads[item.key] = { url, sha256: sha256(fs.readFileSync(item.path)), size: item.size };
  }

  // What a visitor actually gets: the public host, fetched by name.
  if (!args.dryRun) {
    for (const [platform, entry] of Object.entries(downloads)) {
      const answered = await publicHead(entry.url);
      if (answered.status !== 200) throw new Error(`${platform}: ${entry.url} answers ${answered.status} on the public host`);
      if (answered.size && answered.size !== entry.size) throw new Error(`${platform}: public size ${answered.size} does not match ${entry.size}`);
      console.log(`✓ ${platform} ${entry.url} (${answered.size || entry.size} bytes)`);
    }
  }

  if (Object.keys(downloads).length) {
    const table = path.join(args.dir, 'downloads.own.json');
    if (!args.dryRun) fs.writeFileSync(table, JSON.stringify(downloads, null, 2));
    // An already-published version can be moved to this host in one pass: the
    // manifest keeps each entry's digest and size and only the URL changes.
    if (args.manifest && !args.dryRun) pointManifest(args.manifest, args.tag.replace(/^v/, ''), downloads);
    console.log(JSON.stringify(downloads, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`publish-installers: ${error.message}`);
    process.exit(1);
  });
}
