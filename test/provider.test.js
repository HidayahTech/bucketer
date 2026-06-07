import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, extractRegion, requiresPathStyle, defaultMaxKeys, needsCorsConfig, buildEndpoint, PROVIDERS } from '../src/lib/provider.js';

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

  test('Wasabi: extracts region from subdomain', () =>
    assert.equal(extractRegion('https://s3.us-east-1.wasabisys.com', PROVIDERS.WASABI), 'us-east-1'));

  test('Wasabi: bare s3.wasabisys.com resolves to us-east-1 (legacy default endpoint)', () =>
    assert.equal(extractRegion('https://s3.wasabisys.com', PROVIDERS.WASABI), 'us-east-1'));

  test('AWS: extracts region from service endpoint', () =>
    assert.equal(extractRegion('https://s3.ap-southeast-1.amazonaws.com', PROVIDERS.AWS), 'ap-southeast-1'));

  // T3-3: AWS Console shows virtual-hosted bucket URLs — users paste them directly.
  // Without these patterns, extractRegion returns null → falls back to us-east-1 →
  // SignatureDoesNotMatch for any bucket outside us-east-1.
  test('AWS: virtual-hosted bucket URL (T3-3)', () =>
    assert.equal(extractRegion('https://mybucket.s3.us-west-2.amazonaws.com', PROVIDERS.AWS), 'us-west-2'));

  test('AWS: dualstack endpoint (T3-3)', () =>
    assert.equal(extractRegion('https://s3.dualstack.eu-central-1.amazonaws.com', PROVIDERS.AWS), 'eu-central-1'));

  test('AWS: FIPS endpoint (T3-3)', () =>
    assert.equal(extractRegion('https://s3-fips.us-gov-west-1.amazonaws.com', PROVIDERS.AWS), 'us-gov-west-1'));

  test('AWS: legacy dash-style endpoint (T3-3)', () =>
    assert.equal(extractRegion('https://s3-ap-southeast-1.amazonaws.com', PROVIDERS.AWS), 'ap-southeast-1'));

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

describe('extractRegion — Wasabi legacy alias endpoints (T5-14)', () => {
  // Wasabi has legacy alias hostnames (nl-1, de-1, uk-1, etc.) that are detected as
  // Wasabi by the pattern but return alias slugs rather than canonical SigV4 region
  // names. This causes subtle SigV4 signing errors for users on these old endpoints.
  // Aliases from: docs/review-v1.14.0/06-providers/wasabi.md
  test('nl-1 alias → eu-central-1 (T5-14)', () =>
    assert.equal(extractRegion('https://s3.nl-1.wasabisys.com', PROVIDERS.WASABI), 'eu-central-1'));

  test('de-1 alias → eu-central-2 (T5-14)', () =>
    assert.equal(extractRegion('https://s3.de-1.wasabisys.com', PROVIDERS.WASABI), 'eu-central-2'));

  test('uk-1 alias → eu-west-1 (T5-14)', () =>
    assert.equal(extractRegion('https://s3.uk-1.wasabisys.com', PROVIDERS.WASABI), 'eu-west-1'));

  test('fr-1 alias → eu-west-2 (T5-14)', () =>
    assert.equal(extractRegion('https://s3.fr-1.wasabisys.com', PROVIDERS.WASABI), 'eu-west-2'));

  test('uk-2 alias → eu-west-3 (T5-14)', () =>
    assert.equal(extractRegion('https://s3.uk-2.wasabisys.com', PROVIDERS.WASABI), 'eu-west-3'));

  test('it-1 alias → eu-south-1 (T5-14)', () =>
    assert.equal(extractRegion('https://s3.it-1.wasabisys.com', PROVIDERS.WASABI), 'eu-south-1'));

  test('canonical Wasabi endpoint passes through unchanged', () =>
    assert.equal(extractRegion('https://s3.us-east-1.wasabisys.com', PROVIDERS.WASABI), 'us-east-1'));
});

describe('buildEndpoint', () => {
  // B2 — template https://s3.{region}.backblazeb2.com, no exceptions
  // Source: https://www.backblaze.com/docs/cloud-storage-data-regions (fetched 2026-06-04)
  test('B2 us-west-004', () => assert.equal(buildEndpoint('b2', 'us-west-004'), 'https://s3.us-west-004.backblazeb2.com'));
  test('B2 eu-central-003', () => assert.equal(buildEndpoint('b2', 'eu-central-003'), 'https://s3.eu-central-003.backblazeb2.com'));
  test('B2 us-east-005', () => assert.equal(buildEndpoint('b2', 'us-east-005'), 'https://s3.us-east-005.backblazeb2.com'));

  // Wasabi — legacy us-east-1 exception (bare hostname, no region segment)
  // Source: https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions (fetched 2026-06-04, 2026-06-07)
  test('Wasabi us-east-1 legacy endpoint', () => assert.equal(buildEndpoint('wasabi', 'us-east-1'), 'https://s3.wasabisys.com'));
  test('Wasabi us-east-2 regional', () => assert.equal(buildEndpoint('wasabi', 'us-east-2'), 'https://s3.us-east-2.wasabisys.com'));
  test('Wasabi eu-central-1 regional', () => assert.equal(buildEndpoint('wasabi', 'eu-central-1'), 'https://s3.eu-central-1.wasabisys.com'));
  test('Wasabi ap-southeast-2 regional', () => assert.equal(buildEndpoint('wasabi', 'ap-southeast-2'), 'https://s3.ap-southeast-2.wasabisys.com'));
  // Legacy alias slug — builds alias URL (valid; extractRegion maps nl-1→eu-central-1 for signing)
  test('Wasabi nl-1 alias builds alias URL', () => assert.equal(buildEndpoint('wasabi', 'nl-1'), 'https://s3.nl-1.wasabisys.com'));

  // AWS — template https://s3.{region}.amazonaws.com, no exceptions
  // Source: https://docs.aws.amazon.com/general/latest/gr/s3.html (fetched 2026-06-04)
  test('AWS us-east-1', () => assert.equal(buildEndpoint('aws', 'us-east-1'), 'https://s3.us-east-1.amazonaws.com'));
  test('AWS eu-west-2', () => assert.equal(buildEndpoint('aws', 'eu-west-2'), 'https://s3.eu-west-2.amazonaws.com'));
  test('AWS ap-southeast-1', () => assert.equal(buildEndpoint('aws', 'ap-southeast-1'), 'https://s3.ap-southeast-1.amazonaws.com'));

  // DO Spaces — template https://{region}.digitaloceanspaces.com, no exceptions
  // Source: https://docs.digitalocean.com/products/spaces/details/availability/ (fetched 2026-06-04)
  test('DO Spaces nyc3', () => assert.equal(buildEndpoint('do_spaces', 'nyc3'), 'https://nyc3.digitaloceanspaces.com'));
  test('DO Spaces ams3', () => assert.equal(buildEndpoint('do_spaces', 'ams3'), 'https://ams3.digitaloceanspaces.com'));
  test('DO Spaces syd1', () => assert.equal(buildEndpoint('do_spaces', 'syd1'), 'https://syd1.digitaloceanspaces.com'));

  // No-inference providers — endpoint requires info beyond region
  // R2: needs account ID. Source: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/ (fetched 2026-06-04)
  test('R2 returns null', () => assert.equal(buildEndpoint('r2', 'auto'), null));
  test('MinIO returns null', () => assert.equal(buildEndpoint('minio', 'us-east-1'), null));
  test('Generic returns null', () => assert.equal(buildEndpoint('generic', 'us-east-1'), null));

  // Null/empty guards
  test('null region returns null', () => assert.equal(buildEndpoint('b2', null), null));
  test('empty string region returns null', () => assert.equal(buildEndpoint('b2', ''), null));
  test('unknown provider returns null', () => assert.equal(buildEndpoint('unknown', 'us-east-1'), null));
});
