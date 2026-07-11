import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// url-params.js reads window at call time, so setting global.window before
// any function calls is sufficient — no dynamic import needed.
const loc = { protocol: 'https:', origin: 'https://app.example.com', pathname: '/', hash: '' };
const historyLog = [];
global.window = {
  get location() { return loc; },
  history: {
    pushState:    (state, _, url) => historyLog.push({ type: 'push',    state, url }),
    replaceState: (state, _, url) => historyLog.push({ type: 'replace', state, url }),
  },
};

import { readUrlParams, hasUrlParams, buildShareUrl, pushPrefixHistory } from '../src/lib/url-params.js';

describe('buildShareUrl', () => {
  beforeEach(() => { loc.hash = ''; loc.protocol = 'https:'; });

  // BUG-013: params were previously in the query string and appeared in server access logs.
  // They must live in the hash fragment, which browsers strip before sending HTTP requests.
  test('all params appear in the hash fragment, never the query string (BUG-013)', () => {
    const url = buildShareUrl({ endpoint: 'https://s3.example.com', bucket: 'my-bucket', provider: 'b2', regionOverride: 'us-west-1' });
    assert.ok(url.includes('#'), 'URL must contain a hash fragment');
    assert.ok(!url.includes('?'), 'URL must not use a query string');
  });

  test('keyId and secretKey are never included in the output', () => {
    const url = buildShareUrl({ endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: 'AKID123', secretKey: 'supersecret' });
    assert.ok(!url.includes('AKID123'),    'key ID must not appear in share URL');
    assert.ok(!url.includes('supersecret'), 'secret key must not appear in share URL');
    assert.ok(!url.includes('keyId'),      'keyId param must not appear');
    assert.ok(!url.includes('secretKey'),  'secretKey param must not appear');
  });

  test('endpoint and bucket are encoded in the hash', () => {
    const url = buildShareUrl({ endpoint: 'https://s3.example.com', bucket: 'my-bucket' });
    const hash = url.split('#')[1];
    const p = new URLSearchParams(hash);
    assert.equal(p.get('endpoint'), 'https://s3.example.com');
    assert.equal(p.get('bucket'), 'my-bucket');
  });

  test('returns null when protocol is file://', () => {
    loc.protocol = 'file:';
    assert.equal(buildShareUrl({ endpoint: 'https://s3.example.com', bucket: 'my-bucket' }), null);
  });

  test('returns base URL without hash when credentials are all empty', () => {
    const url = buildShareUrl({});
    assert.equal(url, 'https://app.example.com/');
    assert.ok(!url.includes('#'));
  });

  test('includeKeyId:true embeds the key ID in the hash', () => {
    const url = buildShareUrl(
      { endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: 'AKID123' },
      { includeKeyId: true },
    );
    const p = new URLSearchParams(url.split('#')[1]);
    assert.equal(p.get('keyId'), 'AKID123');
  });

  test('includeKeyId:true still never includes the secret key', () => {
    const url = buildShareUrl(
      { endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: 'AKID123', secretKey: 'supersecret' },
      { includeKeyId: true },
    );
    assert.ok(!url.includes('supersecret'), 'secret key must never appear');
    assert.ok(!url.includes('secretKey'), 'secretKey param must never appear');
  });

  test('includeKeyId:true with an empty keyId omits the param', () => {
    const url = buildShareUrl(
      { endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: '' },
      { includeKeyId: true },
    );
    assert.ok(!url.includes('keyId'), 'empty keyId must not add the param');
  });
});

describe('readUrlParams', () => {
  beforeEach(() => { loc.hash = ''; });

  test('reads endpoint and bucket from hash', () => {
    loc.hash = '#endpoint=https%3A%2F%2Fs3.example.com&bucket=my-bucket';
    const p = readUrlParams();
    assert.equal(p.endpoint, 'https://s3.example.com');
    assert.equal(p.bucket, 'my-bucket');
  });

  test('maps the region param to regionOverride', () => {
    loc.hash = '#region=us-east-1';
    assert.equal(readUrlParams().regionOverride, 'us-east-1');
  });

  test('reads provider param when it is a valid identifier', () => {
    loc.hash = '#provider=b2';
    assert.equal(readUrlParams().provider, 'b2');
  });

  test('ignores provider param containing spaces (BUG-016)', () => {
    loc.hash = '#provider=b2Key+ID%3A+000abc+Secret+Key%3A+xyz';
    assert.equal(readUrlParams().provider, undefined);
  });

  test('ignores provider param exceeding 20 chars (BUG-016)', () => {
    loc.hash = '#provider=this_is_a_very_long_provider_name';
    assert.equal(readUrlParams().provider, undefined);
  });

  test('returns empty object when hash is empty', () => {
    assert.deepEqual(readUrlParams(), {});
  });

  test('ignores unrecognised params', () => {
    loc.hash = '#foo=bar&baz=qux';
    assert.deepEqual(readUrlParams(), {});
  });

  // T2-4: endpoint must be validated against http/https — an attacker-controlled
  // share link with endpoint=javascript:... or endpoint=ftp:// would silently
  // pre-fill the credential form with a malicious URL.
  test('rejects endpoint with javascript: scheme (T2-4)', () => {
    loc.hash = '#endpoint=javascript%3Aalert(1)';
    assert.equal(readUrlParams().endpoint, undefined,
      'endpoint with javascript: scheme must be silently ignored');
  });

  test('rejects endpoint with ftp: scheme (T2-4)', () => {
    loc.hash = '#endpoint=ftp%3A%2F%2Fattacker.example.com';
    assert.equal(readUrlParams().endpoint, undefined,
      'endpoint with ftp: scheme must be silently ignored');
  });

  test('accepts endpoint with https: scheme (T2-4)', () => {
    loc.hash = '#endpoint=https%3A%2F%2Fs3.us-west-2.amazonaws.com';
    assert.equal(readUrlParams().endpoint, 'https://s3.us-west-2.amazonaws.com');
  });

  test('accepts endpoint with http: scheme (T2-4)', () => {
    loc.hash = '#endpoint=http%3A%2F%2Flocalhost%3A9000';
    assert.equal(readUrlParams().endpoint, 'http://localhost:9000');
  });

  test('rejects bucket containing path traversal sequences (T2-4)', () => {
    loc.hash = '#bucket=..%2F..%2F..%2Fetc%2Fpasswd';
    assert.equal(readUrlParams().bucket, undefined,
      'bucket with .. path traversal must be silently ignored');
  });

  test('rejects bucket containing forward slashes (T2-4)', () => {
    loc.hash = '#bucket=legit%2Finjected-path';
    assert.equal(readUrlParams().bucket, undefined,
      'bucket with / must be silently ignored — S3 bucket names never contain slashes');
  });

  test('accepts a valid bucket name (T2-4)', () => {
    loc.hash = '#bucket=my-valid-bucket-123';
    assert.equal(readUrlParams().bucket, 'my-valid-bucket-123');
  });

  test('reads a valid keyId from the hash', () => {
    loc.hash = '#keyId=AKID0123456789';
    assert.equal(readUrlParams().keyId, 'AKID0123456789');
  });

  test('ignores a keyId containing whitespace', () => {
    loc.hash = '#keyId=AKID+with+spaces';
    assert.equal(readUrlParams().keyId, undefined);
  });

  test('ignores a keyId longer than 128 chars', () => {
    loc.hash = '#keyId=' + 'A'.repeat(129);
    assert.equal(readUrlParams().keyId, undefined);
  });
});

describe('hasUrlParams', () => {
  beforeEach(() => { loc.hash = ''; });

  test('true when endpoint is present', () => {
    loc.hash = '#endpoint=https%3A%2F%2Fs3.example.com';
    assert.equal(hasUrlParams(), true);
  });

  test('true when only bucket is present', () => {
    loc.hash = '#bucket=my-bucket';
    assert.equal(hasUrlParams(), true);
  });

  test('false when hash is empty', () => {
    assert.equal(hasUrlParams(), false);
  });

  test('false when hash contains only unrecognised params', () => {
    loc.hash = '#foo=bar';
    assert.equal(hasUrlParams(), false);
  });

  test('true when only keyId is present', () => {
    loc.hash = '#keyId=AKID123';
    assert.equal(hasUrlParams(), true);
  });
});

describe('pushPrefixHistory', () => {
  beforeEach(() => { loc.hash = ''; historyLog.length = 0; });

  test('prefix is placed in the hash, not the query string', () => {
    pushPrefixHistory('photos/2024/');
    const { url } = historyLog[historyLog.length - 1];
    assert.ok(url.includes('#'), 'must use hash fragment');
    assert.ok(!url.includes('?'), 'must not use query string');
  });

  test('uses pushState by default', () => {
    pushPrefixHistory('a/b/');
    assert.equal(historyLog[historyLog.length - 1].type, 'push');
  });

  test('uses replaceState when replace=true', () => {
    pushPrefixHistory('a/b/', true);
    assert.equal(historyLog[historyLog.length - 1].type, 'replace');
  });

  test('preserves existing hash params when updating prefix', () => {
    loc.hash = '#bucket=my-bucket&endpoint=https%3A%2F%2Fs3.example.com';
    pushPrefixHistory('docs/');
    const { url } = historyLog[historyLog.length - 1];
    const p = new URLSearchParams(url.split('#')[1]);
    assert.equal(p.get('bucket'), 'my-bucket');
    assert.equal(p.get('endpoint'), 'https://s3.example.com');
    assert.equal(p.get('prefix'), 'docs/');
  });

  test('removes prefix key when navigating to root', () => {
    loc.hash = '#prefix=photos%2F&bucket=my-bucket';
    pushPrefixHistory('');
    const { url } = historyLog[historyLog.length - 1];
    const p = new URLSearchParams(url.split('#')[1] || '');
    assert.equal(p.get('prefix'), null);
    assert.equal(p.get('bucket'), 'my-bucket'); // other params preserved
  });
});
