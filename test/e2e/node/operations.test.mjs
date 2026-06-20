// Node-integration e2e: run the REAL lib orchestrators against the stateful mock S3 server
// over HTTP and assert ACTUAL bucket state. This catches protocol-level bugs the unit
// `mockClient` (constructor-name stub) cannot — real CopyObject metadata, real multipart
// ETags, real ListObjectsV2 XML, real DeleteObjects batching.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { runMoveOperation } from '../../../src/lib/move-queue.js';
import { runDeleteOperation } from '../../../src/lib/delete-queue.js';
import { copyObjectMultipart } from '../../../src/lib/move-multipart.js';
import { startMock, BUCKET } from '../harness.mjs';

let ctx;
before(async () => { ctx = await startMock(); });
after(() => ctx.mock.close());
beforeEach(() => ctx.mock.reset());

const seed = (key, content = 'x', meta) =>
  ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: new TextEncoder().encode(content), ...(meta ? { Metadata: meta } : {}) }));

async function listKeys() {
  const out = [];
  let token;
  do {
    const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    (r.Contents || []).forEach((o) => out.push(o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort();
}
function collect() { const u = []; return { onProgress: (x) => u.push({ ...x }), updates: u, done: () => u.find((x) => x.phase === 'done') }; }

describe('runMoveOperation against real S3 protocol', () => {
  test('moves loose files to a new prefix (dest has them, source gone)', async () => {
    await seed('reports/a.txt', 'A');
    await seed('reports/b.txt', 'B');
    const c = collect();
    await runMoveOperation(ctx.client, BUCKET, { files: [{ key: 'reports/a.txt', size: 1 }, { key: 'reports/b.txt', size: 1 }], prefixes: [], dest: 'archive/', capturedPrefix: 'reports/' }, c.onProgress);
    assert.equal(c.done().moved, 2);
    assert.deepEqual(await listKeys(), ['archive/a.txt', 'archive/b.txt']);
  });

  test('folder move preserves nested structure under the destination', async () => {
    await seed('photos/2024/a.jpg', 'A');
    await seed('photos/2024/jan/b.jpg', 'B');
    const c = collect();
    await runMoveOperation(ctx.client, BUCKET, { files: [], prefixes: ['photos/2024/'], dest: 'archive/', capturedPrefix: 'photos/' }, c.onProgress);
    assert.deepEqual(c.done().movedPrefixes, ['photos/2024/']);
    assert.deepEqual(await listKeys(), ['archive/2024/a.jpg', 'archive/2024/jan/b.jpg']);
  });

  test('never overwrites: a colliding destination key is skipped, both sides untouched', async () => {
    await seed('reports/q1.pdf', 'SOURCE');
    await seed('archive/q1.pdf', 'EXISTING');
    const c = collect();
    await runMoveOperation(ctx.client, BUCKET, { files: [{ key: 'reports/q1.pdf', size: 6 }], prefixes: [], dest: 'archive/', capturedPrefix: 'reports/' }, c.onProgress);
    const done = c.done();
    assert.equal(done.moved, 0);
    assert.ok(done.errors.some((e) => e.skipped), 'collision is reported as skipped');
    // Both copies intact, with original contents.
    assert.deepEqual(await listKeys(), ['archive/q1.pdf', 'reports/q1.pdf']);
    const existing = await ctx.client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'archive/q1.pdf' }));
    assert.equal(existing.ContentLength, 8, 'the pre-existing destination object was not overwritten');
  });

  test('preserves Content-Type and custom metadata across a move (MetadataDirective COPY)', async () => {
    await seed('a/x.bin', 'data', { 'file-mtime': 'keepme', 'bucketer-content-hash': 'sha256-ht64k:zzz' });
    await runMoveOperation(ctx.client, BUCKET, { files: [{ key: 'a/x.bin', size: 4 }], prefixes: [], dest: 'b/', capturedPrefix: 'a/' }, () => {});
    const head = await ctx.client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'b/x.bin' }));
    assert.equal(head.Metadata['file-mtime'], 'keepme');
    assert.equal(head.Metadata['bucketer-content-hash'], 'sha256-ht64k:zzz');
  });
});

describe('copyObjectMultipart against real S3 protocol', () => {
  test('multipart copy reproduces bytes and carries metadata forward', async () => {
    await seed('src/big.bin', 'multipart-source-bytes', { 'file-mtime': 'mt' });
    await copyObjectMultipart(ctx.client, { bucket: BUCKET, sourceKey: 'src/big.bin', destKey: 'dst/big.bin', size: 'multipart-source-bytes'.length });
    const head = await ctx.client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'dst/big.bin' }));
    assert.equal(head.ContentLength, 'multipart-source-bytes'.length);
    assert.equal(head.Metadata['file-mtime'], 'mt', 'UploadPartCopy path carries metadata via HeadObject');
  });
});

describe('runDeleteOperation against real S3 protocol', () => {
  test('deletes loose files and whole folders', async () => {
    await seed('keep.txt');
    await seed('junk/a');
    await seed('junk/b');
    await seed('one.txt');
    const c = collect();
    await runDeleteOperation(ctx.client, BUCKET, { files: ['one.txt'], prefixes: ['junk/'], capturedPrefix: '' }, c.onProgress);
    const done = c.done();
    assert.equal(done.errors.length, 0);
    assert.deepEqual(done.deletedPrefixes, ['junk/']);
    assert.deepEqual(await listKeys(), ['keep.txt']);
  });

  test('batches a delete of more than 1000 objects', async () => {
    const files = [];
    for (let i = 0; i < 1100; i++) { await seed(`bulk/f${i}`); files.push(`bulk/f${i}`); }
    const c = collect();
    await runDeleteOperation(ctx.client, BUCKET, { files, prefixes: [], capturedPrefix: '' }, c.onProgress);
    assert.equal(c.done().deleted, 1100);
    assert.deepEqual(await listKeys(), []);
  });
});

describe('fault injection', () => {
  test('AccessDenied on copy leaves the source in place and reports an error', async () => {
    await seed('a/x.txt', 'data');
    ctx.mock.configure({ faults: [{ op: 'CopyObject', status: 403, code: 'AccessDenied', message: 'Forbidden' }] });
    const c = collect();
    await runMoveOperation(ctx.client, BUCKET, { files: [{ key: 'a/x.txt', size: 4 }], prefixes: [], dest: 'b/', capturedPrefix: 'a/' }, c.onProgress);
    ctx.mock.configure({ faults: [] });
    assert.equal(c.done().moved, 0);
    assert.ok(c.done().errors.length >= 1);
    assert.deepEqual(await listKeys(), ['a/x.txt'], 'source untouched after a denied copy');
  });
});
