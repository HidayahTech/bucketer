import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isVhostShardable, uploadPartsAcrossLanes } from '../src/lib/upload-sharding.js';

// ── isVhostShardable ──────────────────────────────────────────────────────────
// Multi-origin sharding routes some parts via virtual-hosted addressing
// (bucket.s3.region.host). That only works if the bucket name is a single DNS
// label (B2's cert wildcard is one level) and the provider accepts both styles.

describe('isVhostShardable', () => {
  test('accepts a simple DNS-safe bucket on B2', () => {
    assert.equal(isVhostShardable('mybucket', 'b2'), true);
  });

  test('accepts hyphenated lowercase names', () => {
    assert.equal(isVhostShardable('my-bucket-123', 'b2'), true);
  });

  test('rejects names with a dot (single-label wildcard cert would not cover them)', () => {
    assert.equal(isVhostShardable('my.bucket', 'b2'), false);
  });

  test('rejects uppercase', () => {
    assert.equal(isVhostShardable('MyBucket', 'b2'), false);
  });

  test('rejects underscores', () => {
    assert.equal(isVhostShardable('my_bucket', 'b2'), false);
  });

  test('rejects too-short (<3) and too-long (>63) names', () => {
    assert.equal(isVhostShardable('ab', 'b2'), false);
    assert.equal(isVhostShardable('a'.repeat(64), 'b2'), false);
  });

  test('rejects names starting or ending with a hyphen', () => {
    assert.equal(isVhostShardable('-abc', 'b2'), false);
    assert.equal(isVhostShardable('abc-', 'b2'), false);
  });

  test('rejects providers not verified for dual-style addressing', () => {
    assert.equal(isVhostShardable('mybucket', 'r2'), false);
    assert.equal(isVhostShardable('mybucket', 'minio'), false);
    assert.equal(isVhostShardable('mybucket', 'generic'), false);
  });
});

// ── uploadPartsAcrossLanes ────────────────────────────────────────────────────

describe('uploadPartsAcrossLanes', () => {
  test('processes all parts exactly once across lanes', async () => {
    const seen = new Set();
    const A = { id: 'A' }, B = { id: 'B' };
    await uploadPartsAcrossLanes(
      [1, 2, 3, 4, 5, 6],
      [{ client: A, concurrency: 2 }, { client: B, concurrency: 2 }],
      async (n) => { seen.add(n); },
    );
    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  });

  test('distributes work across both lane clients', async () => {
    const byClient = new Map();
    const A = { id: 'A' }, B = { id: 'B' };
    await uploadPartsAcrossLanes(
      Array.from({ length: 20 }, (_, i) => i + 1),
      [{ client: A, concurrency: 2 }, { client: B, concurrency: 2 }],
      async (n, client) => {
        byClient.set(client.id, (byClient.get(client.id) || 0) + 1);
        await new Promise(r => setTimeout(r, 2));
      },
    );
    assert.ok(byClient.get('A') > 0 && byClient.get('B') > 0, 'both lanes must do work');
  });

  test('respects per-lane concurrency; total peak equals sum of lanes', async () => {
    const inFlight = new Map(), peak = new Map();
    let total = 0, peakTotal = 0;
    const A = { id: 'A' }, B = { id: 'B' };
    await uploadPartsAcrossLanes(
      Array.from({ length: 30 }, (_, i) => i + 1),
      [{ client: A, concurrency: 3 }, { client: B, concurrency: 2 }],
      async (n, client) => {
        const c = (inFlight.get(client.id) || 0) + 1;
        inFlight.set(client.id, c);
        peak.set(client.id, Math.max(peak.get(client.id) || 0, c));
        total++; peakTotal = Math.max(peakTotal, total);
        await new Promise(r => setTimeout(r, 5));
        inFlight.set(client.id, inFlight.get(client.id) - 1); total--;
      },
    );
    assert.ok(peak.get('A') <= 3, `lane A peak ${peak.get('A')} must be <= 3`);
    assert.ok(peak.get('B') <= 2, `lane B peak ${peak.get('B')} must be <= 2`);
    assert.ok(peakTotal <= 5, `total peak ${peakTotal} must be <= 5`);
    assert.ok(peakTotal > 2, `must parallelize across lanes (peak ${peakTotal})`);
  });

  test('propagates errors from workFn', async () => {
    const A = { id: 'A' };
    await assert.rejects(
      uploadPartsAcrossLanes([1], [{ client: A, concurrency: 1 }], async () => { throw new Error('lane fail'); }),
      { message: 'lane fail' },
    );
  });

  test('treats concurrency < 1 as 1', async () => {
    const seen = [];
    const A = { id: 'A' };
    await uploadPartsAcrossLanes([1, 2, 3], [{ client: A, concurrency: 0 }], async (n) => { seen.push(n); });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3]);
  });
});
