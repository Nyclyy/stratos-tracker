import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installersFor, objectKey, canonicalRequest, sign } from '../scripts/publish-installers.mjs';

test('installers land under their tag, never at a shared mutable path', () => {
  assert.equal(objectKey('v2.1.25', 'Stratos-Setup.exe'), 'v2.1.25/Stratos-Setup.exe');
  assert.equal(objectKey('2.1.25', 'Stratos-Setup.exe'), 'v2.1.25/Stratos-Setup.exe', 'a bare version still gets its v');
  assert.equal(objectKey('v2.1.26', 'Stratos-2.1.26-mac-arm64.dmg'), 'v2.1.26/Stratos-2.1.26-mac-arm64.dmg');
  // Two releases never share a key, so a cached or bootstrapped file can only
  // name the build it was written for.
  assert.notEqual(objectKey('v2.1.25', 'Stratos-Setup.exe'), objectKey('v2.1.26', 'Stratos-Setup.exe'));
});

test('the canonical request is the one S3 expects', () => {
  const canonical = canonicalRequest({
    method: 'GET',
    path: '/test.txt',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.equal(canonical, [
    'GET',
    '/test.txt',
    '',
    'host:examplebucket.s3.amazonaws.com',
    'range:bytes=0-9',
    'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date:20130524T000000Z',
    '',
    'host;range;x-amz-content-sha256;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'));
});

test('a signature matches AWS’s published example', () => {
  // The worked example in the S3 SigV4 documentation ("Example: GET Object"),
  // with its documented credentials, date and expected signature.
  const signed = sign({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    requestPath: '/test.txt',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    extraHeaders: { range: 'bytes=0-9' },
    region: 'us-east-1',
    service: 's3',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(signed.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8/);
  assert.equal(signed.headers['x-amz-date'], '20130524T000000Z');
});

test('a PUT is signed over the exact bytes being sent', () => {
  const body = Buffer.from('installer-bytes');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const signed = sign({
    method: 'PUT',
    host: 'acct.r2.cloudflarestorage.com',
    requestPath: '/stratos-downloads/v2.1.25/Stratos-Setup.exe',
    accessKey: 'key',
    secretKey: 'secret',
    payloadHash: digest,
    contentType: 'application/octet-stream',
    now: new Date('2026-10-25T12:00:00Z'),
  });
  assert.equal(signed.headers['x-amz-content-sha256'], digest);
  assert.match(signed.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  // The same request signed twice is the same signature; a different body is not.
  const again = sign({
    method: 'PUT',
    host: 'acct.r2.cloudflarestorage.com',
    requestPath: '/stratos-downloads/v2.1.25/Stratos-Setup.exe',
    accessKey: 'key',
    secretKey: 'secret',
    payloadHash: digest,
    contentType: 'application/octet-stream',
    now: new Date('2026-10-25T12:00:00Z'),
  });
  const other = sign({
    method: 'PUT',
    host: 'acct.r2.cloudflarestorage.com',
    requestPath: '/stratos-downloads/v2.1.25/Stratos-Setup.exe',
    accessKey: 'key',
    secretKey: 'secret',
    payloadHash: crypto.createHash('sha256').update('other').digest('hex'),
    contentType: 'application/octet-stream',
    now: new Date('2026-10-25T12:00:00Z'),
  });
  assert.equal(again.signature, signed.signature);
  assert.notEqual(other.signature, signed.signature);
});

test('a release directory is read as the four installers, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-installers-'));
  try {
    for (const name of [
      'Stratos-Setup.exe',
      'Stratos-Setup.exe.blockmap',
      'Stratos-Setup.exe.sha256',
      'Stratos-2.1.25-mac-arm64.dmg',
      'Stratos-2.1.25-mac-arm64.zip',
      'Stratos-2.1.25-mac-x64.dmg',
      'Stratos-2.1.25-linux-x64.AppImage',
      'latest.yml',
      'releases.json',
    ]) {
      fs.writeFileSync(path.join(dir, name), name);
    }
    const found = installersFor(dir);
    assert.deepEqual(found.map(item => item.key), ['windows', 'mac-arm64', 'mac-x64', 'linux-x64']);
    assert.equal(found.find(item => item.key === 'windows').name, 'Stratos-Setup.exe');
    assert.ok(found.every(item => !/\.(zip|blockmap|sha256|yml|json)$/.test(item.name)));
    assert.equal(found.find(item => item.key === 'mac-arm64').type, 'application/x-apple-diskimage');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
