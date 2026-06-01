import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, extractRegion, requiresPathStyle, defaultMaxKeys, needsCorsConfig, PROVIDERS } from '../src/lib/provider.js';

describe('detectProvider', () => {
  test('Backblaze B2', () => assert.equal(detectProvider('https://s3.us-west-004.backblazeb2.com'), PROVIDERS.B2));
  test('Cloudflare R2', () => assert.equal(detectProvider('https://abc123.r2.cloudflarestorage.com'), PROVIDERS.R2));
  test('Wasabi', () => assert.equal(detectProvider('https://s3.us-east-1.wasabisys.com'), PROVIDERS.WASABI));
  test('AWS S3', () => assert.equal(detectProvider('https://s3.eu-west-1.amazonaws.com'), PROVIDERS.AWS));
  test('DigitalOcean Spaces', () => assert.equal(detectProvider('https://nyc3.digitaloceanspaces.com'), PROVIDERS.DO_SPACES));
  test('unknown endpoint → generic', () => assert.equal(detectProvider('https://minio.example.com'), PROVIDERS.GENERIC));
  test('empty string → generic', () => assert.equal(detectProvider(''), PROVIDERS.GENERIC));
  // MinIO has no detectable pattern — must use manual override (spec §4.8)
  test('MinIO-style URL → generic (not detectable)', () => assert.equal(detectProvider('https://play.min.io'), PROVIDERS.GENERIC));

  // Hostname-anchoring: provider domain in path or as a suffix must NOT match.
  // Detection tests against hostname only; $ anchor prevents suffix-based false positives.
  test('B2 domain in URL path → generic', () =>
    assert.equal(detectProvider('https://proxy.example.com/s3.us-west-004.backblazeb2.com/'), PROVIDERS.GENERIC));
  test('hostname with B2 suffix → generic', () =>
    assert.equal(detectProvider('https://mybackblazeb2.com'), PROVIDERS.GENERIC));
  test('R2 domain in URL path → generic', () =>
    assert.equal(detectProvider('https://proxy.example.com/abc123.r2.cloudflarestorage.com/'), PROVIDERS.GENERIC));
  test('AWS domain in URL path → generic', () =>
    assert.equal(detectProvider('https://proxy.example.com/s3.eu-west-1.amazonaws.com/'), PROVIDERS.GENERIC));
});

describe('extractRegion', () => {
  test('B2: extracts region from subdomain', () =>
    assert.equal(extractRegion('https://s3.us-west-004.backblazeb2.com', PROVIDERS.B2), 'us-west-004'));

  test('B2: different region', () =>
    assert.equal(extractRegion('https://s3.eu-central-003.backblazeb2.com', PROVIDERS.B2), 'eu-central-003'));

  test('Wasabi: extracts region', () =>
    assert.equal(extractRegion('https://s3.us-east-1.wasabisys.com', PROVIDERS.WASABI), 'us-east-1'));

  test('AWS: extracts region', () =>
    assert.equal(extractRegion('https://s3.ap-southeast-1.amazonaws.com', PROVIDERS.AWS), 'ap-southeast-1'));

  test('DO Spaces: extracts region from subdomain', () =>
    assert.equal(extractRegion('https://nyc3.digitaloceanspaces.com', PROVIDERS.DO_SPACES), 'nyc3'));

  // R2 has no region in the URL — always returns 'auto' (spec §5 Group C)
  test('R2: always returns auto', () =>
    assert.equal(extractRegion('https://abc123.r2.cloudflarestorage.com', PROVIDERS.R2), 'auto'));

  test('Generic/MinIO: returns null', () =>
    assert.equal(extractRegion('https://minio.example.com', PROVIDERS.GENERIC), null));

  test('invalid URL: returns null without throwing', () =>
    assert.equal(extractRegion('not-a-url', PROVIDERS.B2), null));
});

describe('requiresPathStyle', () => {
  // BUG context: wrong forcePathStyle causes auth-like errors (spec §5 Group A)
  test('B2 requires path style', () => assert.equal(requiresPathStyle(PROVIDERS.B2), true));
  test('MinIO requires path style', () => assert.equal(requiresPathStyle(PROVIDERS.MINIO), true));
  test('R2 does not require path style', () => assert.equal(requiresPathStyle(PROVIDERS.R2), false));
  test('AWS does not require path style', () => assert.equal(requiresPathStyle(PROVIDERS.AWS), false));
  test('Wasabi does not require path style', () => assert.equal(requiresPathStyle(PROVIDERS.WASABI), false));
  test('DO Spaces does not require path style', () => assert.equal(requiresPathStyle(PROVIDERS.DO_SPACES), false));
  test('Generic does not require path style', () => assert.equal(requiresPathStyle(PROVIDERS.GENERIC), false));
});

describe('defaultMaxKeys', () => {
  // B2 bills per list call (Class C) so default is lower (spec §4.7)
  test('B2 default is 200', () => assert.equal(defaultMaxKeys(PROVIDERS.B2), 200));
  test('R2 default is 1000', () => assert.equal(defaultMaxKeys(PROVIDERS.R2), 1000));
  test('AWS default is 1000', () => assert.equal(defaultMaxKeys(PROVIDERS.AWS), 1000));
  test('Wasabi default is 1000', () => assert.equal(defaultMaxKeys(PROVIDERS.WASABI), 1000));
  test('MinIO default is 1000', () => assert.equal(defaultMaxKeys(PROVIDERS.MINIO), 1000));
  test('DO Spaces default is 1000', () => assert.equal(defaultMaxKeys(PROVIDERS.DO_SPACES), 1000));
  test('Generic default is 1000', () => assert.equal(defaultMaxKeys(PROVIDERS.GENERIC), 1000));
});

describe('needsCorsConfig', () => {
  // Wasabi auto-applies CORS; all others require manual configuration (spec §5 Group D)
  test('Wasabi does not need CORS config', () => assert.equal(needsCorsConfig(PROVIDERS.WASABI), false));
  test('B2 needs CORS config', () => assert.equal(needsCorsConfig(PROVIDERS.B2), true));
  test('R2 needs CORS config', () => assert.equal(needsCorsConfig(PROVIDERS.R2), true));
  test('AWS needs CORS config', () => assert.equal(needsCorsConfig(PROVIDERS.AWS), true));
  test('Generic needs CORS config', () => assert.equal(needsCorsConfig(PROVIDERS.GENERIC), true));
});
