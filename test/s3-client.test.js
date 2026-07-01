// Tests for createS3Client — S3Client factory configuration.
//
// The factory sets region (with a three-tier priority order) and forcePathStyle
// based on provider. We inspect the returned client's config rather than
// intercepting SDK internals.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Client } from '../src/lib/s3-client.js';

const CREDS = { bucket: 'b', keyId: 'AKID', secretKey: 'secret' };

// ── Region resolution ─────────────────────────────────────────────────────────
// Priority order: regionOverride > extractRegion(endpoint) > 'us-east-1'

describe('createS3Client — region resolution', () => {
  test('uses regionOverride when provided (highest priority)', async () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.us-west-004.backblazeb2.com', provider: 'b2', regionOverride: 'my-custom-region' });
    assert.equal(await c.config.region(), 'my-custom-region');
  });

  test('extracts region from B2 endpoint when no override', async () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.us-west-004.backblazeb2.com', provider: 'b2' });
    assert.equal(await c.config.region(), 'us-west-004');
  });

  test('extracts region from AWS endpoint when no override', async () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.eu-central-1.amazonaws.com', provider: 'aws' });
    assert.equal(await c.config.region(), 'eu-central-1');
  });

  test('falls back to us-east-1 for generic/MinIO endpoints with no extractable region', async () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://minio.local:9000', provider: 'generic' });
    assert.equal(await c.config.region(), 'us-east-1');
  });

  test('regionOverride wins over an endpoint that contains a region', async () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.eu-central-1.amazonaws.com', provider: 'aws', regionOverride: 'ap-southeast-1' });
    assert.equal(await c.config.region(), 'ap-southeast-1');
  });

  test('R2 always extracts "auto" as its region', async () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://abc123.r2.cloudflarestorage.com', provider: 'r2' });
    assert.equal(await c.config.region(), 'auto');
  });
});

// ── forcePathStyle ────────────────────────────────────────────────────────────

describe('createS3Client — forcePathStyle', () => {
  test('B2 uses path style', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.us-west-004.backblazeb2.com', provider: 'b2' });
    assert.equal(c.config.forcePathStyle, true);
  });

  test('MinIO uses path style', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://minio.local:9000', provider: 'minio' });
    assert.equal(c.config.forcePathStyle, true);
  });

  test('R2 does not use path style', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://abc123.r2.cloudflarestorage.com', provider: 'r2' });
    assert.equal(c.config.forcePathStyle, false);
  });

  test('AWS does not use path style', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.us-east-1.amazonaws.com', provider: 'aws' });
    assert.equal(c.config.forcePathStyle, false);
  });

  test('generic does not use path style', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://storage.example.com', provider: 'generic' });
    assert.equal(c.config.forcePathStyle, false);
  });
});

// ── forcePathStyle override (multi-origin sharding) ───────────────────────────
// The sharded upload path builds a second client that addresses the same bucket
// virtual-hosted (forcePathStyle:false) to obtain a second connection-pool origin.
// createS3Client accepts an explicit override that wins over the provider default.

describe('createS3Client — forcePathStyle override', () => {
  test('explicit forcePathStyle:false overrides the provider path-style default (B2)', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.us-west-004.backblazeb2.com', provider: 'b2' }, { forcePathStyle: false });
    assert.equal(c.config.forcePathStyle, false);
  });

  test('explicit forcePathStyle:true overrides a virtual-hosted provider default (R2)', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://abc123.r2.cloudflarestorage.com', provider: 'r2' }, { forcePathStyle: true });
    assert.equal(c.config.forcePathStyle, true);
  });

  test('omitting the override keeps the provider default', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.us-west-004.backblazeb2.com', provider: 'b2' });
    assert.equal(c.config.forcePathStyle, true);
  });
});

// ── Request checksum calculation ──────────────────────────────────────────────
// The factory opts out of the SDK's default automatic CRC32 on uploads (WHEN_SUPPORTED
// since v3.729.0): we never request a checksum, so it is redundant per-part work and
// has broken some S3-compatible providers. WHEN_REQUIRED disables the optional CRC32.

describe('createS3Client — request checksum calculation', () => {
  test('configures WHEN_REQUIRED to suppress the automatic per-part CRC32', async () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.us-west-004.backblazeb2.com', provider: 'b2' });
    const v = c.config.requestChecksumCalculation;
    const resolved = typeof v === 'function' ? await v() : v;
    assert.equal(resolved, 'WHEN_REQUIRED');
  });
});

// ── Instance type ─────────────────────────────────────────────────────────────

describe('createS3Client — return type', () => {
  test('returns an S3Client instance', () => {
    const c = createS3Client({ ...CREDS, endpoint: 'https://s3.example.com', provider: 'generic' });
    assert.ok(c instanceof S3Client, 'must return an S3Client instance');
  });
});
