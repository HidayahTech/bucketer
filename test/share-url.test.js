import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// share-url.js reads window.location at call time, so setting global.window before
// any function calls is sufficient — no dynamic import needed.
const loc = { protocol: 'https:', origin: 'https://app.example.com', pathname: '/', hash: '' };
global.window = { get location() { return loc; } };

import { encodePresignedUrl, decodePresignedUrl, buildShareLink, readShareLink } from '../src/lib/share-url.js';

const SAMPLE_URL = 'https://s3.us-west-000.backblazeb2.com/my-bucket/week-7/file.braw?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F20260611%2Fus-west-000%2Fs3%2Faws4_request&X-Amz-Date=20260611T203417Z&X-Amz-Expires=604800&X-Amz-Signature=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890&X-Amz-SignedHeaders=host&x-id=GetObject';

describe('encodePresignedUrl / decodePresignedUrl', () => {
  test('round-trips a presigned URL without modification', () => {
    const encoded = encodePresignedUrl(SAMPLE_URL);
    assert.equal(decodePresignedUrl(encoded), SAMPLE_URL);
  });

  test('encoded output contains only base64url-safe characters (A-Za-z0-9-_)', () => {
    const encoded = encodePresignedUrl(SAMPLE_URL);
    assert.match(encoded, /^[A-Za-z0-9\-_]+$/);
  });

  test('encoded output contains no base64 padding (=)', () => {
    const encoded = encodePresignedUrl(SAMPLE_URL);
    assert.ok(!encoded.includes('='), 'must not contain padding characters');
  });

  test('decodePresignedUrl throws on non-HTTPS decoded value', () => {
    // Encode a non-HTTPS string manually
    const malicious = Buffer.from('http://example.com/evil').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    assert.throws(() => decodePresignedUrl(malicious), /https/i);
  });

  test('decodePresignedUrl throws on garbage input', () => {
    assert.throws(() => decodePresignedUrl('!!!not-valid-base64!!!'));
  });

  test('decodePresignedUrl throws on ftp:// URL', () => {
    const ftpEncoded = Buffer.from('ftp://evil.example.com/file').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    assert.throws(() => decodePresignedUrl(ftpEncoded), /https/i);
  });
});

describe('buildShareLink', () => {
  beforeEach(() => { loc.hash = ''; loc.protocol = 'https:'; });

  test('places encoded blob in the hash fragment, never the query string', () => {
    const link = buildShareLink(SAMPLE_URL);
    assert.ok(link.includes('#'), 'must use hash fragment');
    assert.ok(!link.includes('?'), 'must not introduce a query string');
  });

  test('uses the dl= parameter name', () => {
    const link = buildShareLink(SAMPLE_URL);
    const hash = link.split('#')[1];
    const p = new URLSearchParams(hash);
    assert.ok(p.has('dl'), 'hash must contain dl= parameter');
  });

  test('encoded blob round-trips back to original URL', () => {
    const link = buildShareLink(SAMPLE_URL);
    const hash = link.split('#')[1];
    const encoded = new URLSearchParams(hash).get('dl');
    assert.equal(decodePresignedUrl(encoded), SAMPLE_URL);
  });

  test('base URL is origin + pathname', () => {
    const link = buildShareLink(SAMPLE_URL);
    assert.ok(link.startsWith('https://app.example.com/'), 'must use origin + pathname');
  });

  test('returns null when protocol is file://', () => {
    loc.protocol = 'file:';
    assert.equal(buildShareLink(SAMPLE_URL), null);
  });
});

describe('readShareLink', () => {
  beforeEach(() => { loc.hash = ''; loc.protocol = 'https:'; });

  test('returns the decoded presigned URL when dl= is in the hash', () => {
    const encoded = encodePresignedUrl(SAMPLE_URL);
    loc.hash = `#dl=${encoded}`;
    assert.equal(readShareLink(), SAMPLE_URL);
  });

  test('returns null when hash is empty', () => {
    assert.equal(readShareLink(), null);
  });

  test('returns null when hash contains other params but no dl=', () => {
    loc.hash = '#endpoint=https%3A%2F%2Fs3.example.com&bucket=my-bucket';
    assert.equal(readShareLink(), null);
  });

  test('returns null when dl= value is invalid', () => {
    loc.hash = '#dl=!!!garbage!!!';
    assert.equal(readShareLink(), null);
  });
});
