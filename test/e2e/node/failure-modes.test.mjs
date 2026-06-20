// Node-integration e2e — The Saboteur's suite: the destructive failure modes where a bug
// silently destroys, corrupts, or duplicates data. Each runs the REAL lib orchestrator against
// the stateful mock over HTTP, drives a fault, and asserts the bucket is left in a safe state.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, ListObjectsV2Command, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { runMoveOperation } from '../../../src/lib/move-queue.js';
import { runDeleteOperation } from '../../../src/lib/delete-queue.js';
import { copyObjectMultipart } from '../../../src/lib/move-multipart.js';
import { collectParts } from '../../../src/lib/upload-queue.js';
import { streamsIdentical } from '../../../src/lib/verify-bytes.js';
import { startMock, BUCKET } from '../harness.mjs';

let ctx;
before(async () => { ctx = await startMock(); });
after(() => ctx.mock.close());
beforeEach(() => ctx.mock.reset());

const seed = (key, content = 'x', meta) =>
  ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: new TextEncoder().encode(content), ...(meta ? { Metadata: meta } : {}) }));
async function listKeys() {
  const out = []; let token;
  do { const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token })); (r.Contents || []).forEach((o) => out.push(o.Key)); token = r.IsTruncated ? r.NextContinuationToken : undefined; } while (token);
  return out.sort();
}
function collect() { const u = []; return { onProgress: (x) => u.push({ ...x }), done: () => u.find((x) => x.phase === 'done'), all: () => u }; }

// ── N1: delete-denied-after-copy = duplicate (the scariest move outcome) ─────────
describe('N1 — move: copy succeeds but source delete is denied', () => {
  test('object ends in BOTH places, not counted moved, source retained, distinct error', async () => {
    await seed('a/x.txt', 'data', { 'file-mtime': 'm' });
    // Copy (PUT to dest) is allowed; only the source DeleteObject is denied.
    ctx.mock.configure({ faults: [{ op: 'DeleteObject', method: 'DELETE', keyPrefix: 'a/x.txt', status: 403, code: 'AccessDenied', message: 'no delete' }] });
    const c = collect();
    await runMoveOperation(ctx.client, BUCKET, { files: [{ key: 'a/x.txt', size: 4 }], prefixes: [], dest: 'b/', capturedPrefix: 'a/' }, c.onProgress);
    ctx.mock.configure({ faults: [] });

    const done = c.done();
    assert.equal(done.moved, 0, 'a copy-without-delete is NOT a completed move');
    assert.ok(done.errors.length >= 1, 'an error is reported');
    assert.match(done.errors[0].message, /both places/i, 'the duplicate is surfaced explicitly');
    // Both copies exist — the dest copy is intentionally NOT rolled back (could clobber data).
    assert.deepEqual(await listKeys(), ['a/x.txt', 'b/x.txt']);
  });
});

// ── N2: multipart copy failure must abort cleanly (no orphan, no half-object) ────
describe('N2 — multipart copy: a part-copy failure aborts the session', () => {
  test('AbortMultipartUpload fires, no destination object, source untouched', async () => {
    await seed('src/big.bin', 'multipart-source-bytes');
    ctx.mock.configure({ faults: [{ op: 'UploadPartCopy', method: 'PUT', status: 500, code: 'InternalError', message: 'boom' }] });
    await assert.rejects(copyObjectMultipart(ctx.client, { bucket: BUCKET, sourceKey: 'src/big.bin', destKey: 'dst/big.bin', size: 'multipart-source-bytes'.length }));
    ctx.mock.configure({ faults: [] });
    // The destination object was never completed; only the source remains.
    assert.deepEqual(await listKeys(), ['src/big.bin']);
    // No orphaned multipart session left behind (abort cleared it).
    const bucket = ctx.mock.buckets.get(BUCKET);
    assert.equal(bucket.uploads.size, 0, 'the orphaned multipart upload was aborted');
  });
});

// ── N4: partial DeleteObjects errors exclude the affected folder from deletedPrefixes ──
describe('N4 — delete: a partial per-key error leaves that folder un-cleared', () => {
  test('the sibling key is deleted, the failed key is reported, prefix excluded', async () => {
    await seed('f/ok.txt');
    await seed('f/bad.txt');
    ctx.mock.configure({ faults: [{ op: 'DeleteObject', method: 'POST', keyPrefix: 'f/bad.txt', status: 403, code: 'AccessDenied', message: 'denied' }] });
    const c = collect();
    await runDeleteOperation(ctx.client, BUCKET, { files: [], prefixes: ['f/'], capturedPrefix: '' }, c.onProgress);
    ctx.mock.configure({ faults: [] });

    const done = c.done();
    assert.equal(done.deletedPrefixes.length, 0, 'a folder with a failed key is NOT reported fully deleted');
    assert.ok(done.errors.some((e) => e.key === 'f/bad.txt'), 'the failed key is surfaced');
    assert.deepEqual(await listKeys(), ['f/bad.txt'], 'the deletable sibling was removed, the denied one remains');
  });
});

// ── N5: a transient throttle (503 SlowDown) must NOT fail the operation ──────────
describe('N5 — throttling: a transient 503 does not fail the delete', () => {
  test('a one-shot SlowDown is retried (SDK + app backoff) and the bucket ends correct', async () => {
    await seed('t/a.txt');
    await seed('t/b.txt');
    // One-shot request-level throttle on the batch delete; retry (SDK and/or delete-queue backoff) recovers.
    ctx.mock.configure({ faults: [{ op: 'DeleteObjects', method: 'POST', status: 503, code: 'SlowDown', message: 'slow', times: 1 }] });
    const c = collect();
    await runDeleteOperation(ctx.client, BUCKET, { files: ['t/a.txt', 't/b.txt'], prefixes: [], capturedPrefix: '' }, c.onProgress);
    ctx.mock.configure({ faults: [] });
    assert.deepEqual(await listKeys(), [], 'the operation completed despite the transient throttle');
  });
});

// ── N6: the dedup byte-for-byte gate (the ONLY deletion gate) over real S3 streams ──
describe('N6 — dedup: byte-for-byte gate over real GetObject streams', () => {
  async function streamFor(key) {
    const r = await ctx.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return r.Body; // an async iterable of Uint8Array chunks
  }
  test('two identical objects verify as identical', async () => {
    await seed('d/a', 'identical-content-payload');
    await seed('d/b', 'identical-content-payload');
    assert.equal(await streamsIdentical(await streamFor('d/a'), await streamFor('d/b')), true);
  });
  test('two SAME-SIZE but byte-different objects are NOT identical (no false-positive delete gate)', async () => {
    await seed('d/a', 'AAAAAAAAAAAAAAAA'); // 16 bytes
    await seed('d/c', 'AAAAAAAAAAAAAAAB'); // 16 bytes, last byte differs
    assert.equal(await streamsIdentical(await streamFor('d/a'), await streamFor('d/c')), false);
  });
});

// ── N7: BUG-007 — ListParts pagination on a real >1000-part multipart session ────
describe('N7 — resume: collectParts paginates a >1000-part session (BUG-007)', () => {
  test('every part across all pages is collected, none missed', async () => {
    const { UploadId } = await ctx.client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'huge' }));
    const PARTS = 1001; // > one ListParts page (mock pages at 1000) — the BUG-007 trigger
    // Upload tiny parts in parallel batches (the mock doesn't enforce 5MB on UploadPart, only Complete).
    for (let start = 1; start <= PARTS; start += 100) {
      const batch = [];
      for (let n = start; n < start + 100 && n <= PARTS; n++) {
        batch.push(ctx.client.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'huge', UploadId, PartNumber: n, Body: new TextEncoder().encode(`p${n}`) })));
      }
      await Promise.all(batch);
    }
    const parts = await collectParts(ctx.client, { bucket: BUCKET, key: 'huge', uploadId: UploadId });
    assert.equal(parts.length, PARTS, 'all parts collected across pages (first page would stop at 1000)');
    assert.equal(parts[0].PartNumber, 1);
    assert.equal(parts[PARTS - 1].PartNumber, PARTS);
  });
});
