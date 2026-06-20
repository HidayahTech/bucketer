// Drives the stateful mock S3 server through the REAL @aws-sdk/client-s3 over HTTP and asserts
// actual bucket state. This both tests the mock and proves the SDK request/response wiring works.
// Run via the e2e runner (npm run test:e2e) or directly: node --test test/e2e/mock-s3/server.test.mjs
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  DeleteObjectCommand, DeleteObjectsCommand, CopyObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, ListPartsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createMockS3 } from './server.mjs';

const BUCKET = 'test-bucket';
let mock, port, client;

before(async () => {
  mock = createMockS3({ host: '127.0.0.1' });
  port = await mock.listen(0); // ephemeral
  client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,
  });
});
after(() => mock.close());
beforeEach(() => mock.reset());

const body = (s) => new TextEncoder().encode(s);
async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

describe('mock S3 — object round-trip', () => {
  test('PutObject then HeadObject preserves custom metadata + content-type', async () => {
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: 'docs/a.txt', Body: body('hello'),
      ContentType: 'text/plain', Metadata: { 'file-mtime': '2026-01-01T00:00:00.000Z', 'bucketer-content-hash': 'sha256-ht64k:abc' },
    }));
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'docs/a.txt' }));
    assert.equal(head.ContentType, 'text/plain');
    assert.equal(head.ContentLength, 5);
    assert.equal(head.Metadata['file-mtime'], '2026-01-01T00:00:00.000Z');
    assert.equal(head.Metadata['bucketer-content-hash'], 'sha256-ht64k:abc');
    assert.ok(head.ETag && head.ETag.length > 2, 'a real ETag is returned');
  });

  test('GetObject returns the stored bytes', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: body('payload') }));
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
    assert.equal(await streamToString(got.Body), 'payload');
  });

  test('GetObject with a Range returns 206 + the slice', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: body('0123456789') }));
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k', Range: 'bytes=2-5' }));
    assert.equal(await streamToString(got.Body), '2345');
  });

  test('presigned GET is served (query-auth ignored)', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: body('signed') }));
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }), { expiresIn: 3600 });
    const resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), 'signed');
  });
});

describe('mock S3 — listing', () => {
  test('ListObjectsV2 with Delimiter returns CommonPrefixes + Contents', async () => {
    for (const k of ['top.txt', 'photos/a.jpg', 'photos/b.jpg', 'docs/x.md']) {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: body('x') }));
    }
    const resp = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: '/' }));
    assert.deepEqual((resp.CommonPrefixes || []).map((p) => p.Prefix).sort(), ['docs/', 'photos/']);
    assert.deepEqual((resp.Contents || []).map((o) => o.Key), ['top.txt']);
  });

  test('ListObjectsV2 paginates via ContinuationToken', async () => {
    for (let i = 0; i < 5; i++) await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: `f${i}`, Body: body('x') }));
    const p1 = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2 }));
    assert.equal(p1.IsTruncated, true);
    assert.equal((p1.Contents || []).length, 2);
    const p2 = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2, ContinuationToken: p1.NextContinuationToken }));
    assert.equal((p2.Contents || []).length, 2);
  });
});

describe('mock S3 — delete', () => {
  test('DeleteObject removes the object', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'gone', Body: body('x') }));
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'gone' }));
    const resp = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    assert.equal((resp.Contents || []).length, 0);
  });

  test('DeleteObjects batch deletes many', async () => {
    for (const k of ['a', 'b', 'c']) await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: body('x') }));
    const resp = await client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: 'a' }, { Key: 'b' }], Quiet: true } }));
    assert.ok(!resp.Errors || resp.Errors.length === 0);
    const list = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    assert.deepEqual((list.Contents || []).map((o) => o.Key), ['c']);
  });

  test('STRICT: DeleteObjects rejects more than 1000 keys', async () => {
    const Objects = Array.from({ length: 1001 }, (_, i) => ({ Key: `k${i}` }));
    await assert.rejects(client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects } })));
  });
});

describe('mock S3 — multipart', () => {
  test('Create → UploadPart×2 → ListParts → Complete assembles the object', async () => {
    const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'big', ContentType: 'application/octet-stream', Metadata: { 'file-mtime': 'm' } }));
    const part1 = new Uint8Array(5 * 1024 * 1024).fill(65); // 5 MiB of 'A' (non-last must be >= 5 MB)
    const part2 = body('TAIL');
    const r1 = await client.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'big', UploadId, PartNumber: 1, Body: part1 }));
    const r2 = await client.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'big', UploadId, PartNumber: 2, Body: part2 }));

    const parts = await client.send(new ListPartsCommand({ Bucket: BUCKET, Key: 'big', UploadId }));
    assert.equal((parts.Parts || []).length, 2);

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET, Key: 'big', UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: r1.ETag }, { PartNumber: 2, ETag: r2.ETag }] },
    }));
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'big' }));
    assert.equal(head.ContentLength, 5 * 1024 * 1024 + 4);
    assert.equal(head.Metadata['file-mtime'], 'm', 'multipart metadata round-trips');
  });

  test('STRICT: Complete rejects a non-last part smaller than 5 MB', async () => {
    const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'small' }));
    const r1 = await client.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'small', UploadId, PartNumber: 1, Body: body('tiny') }));
    const r2 = await client.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'small', UploadId, PartNumber: 2, Body: body('tail') }));
    await assert.rejects(client.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET, Key: 'small', UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: r1.ETag }, { PartNumber: 2, ETag: r2.ETag }] },
    })));
  });
});

describe('mock S3 — copy', () => {
  test('CopyObject with MetadataDirective COPY preserves source metadata', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'src/a.txt', Body: body('data'), ContentType: 'text/plain', Metadata: { 'file-mtime': 'keepme' } }));
    await client.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/src/a.txt`, Key: 'dst/a.txt', MetadataDirective: 'COPY' }));
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'dst/a.txt' }));
    assert.equal(head.ContentType, 'text/plain');
    assert.equal(head.Metadata['file-mtime'], 'keepme');
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'dst/a.txt' }));
    assert.equal(await streamToString(got.Body), 'data');
  });

  test('STRICT: rejects an illegal self-copy with MetadataDirective COPY', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'self', Body: body('x') }));
    await assert.rejects(client.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/self`, Key: 'self', MetadataDirective: 'COPY' })));
  });
});

describe('mock S3 — ListParts pagination (BUG-007 substrate)', () => {
  test('paginates parts at the max-parts page size with IsTruncated + NextPartNumberMarker', async () => {
    const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'paged' }));
    // Upload 5 parts (we'll page at 2). Real S3 caps at 1000; the SDK MaxParts drives our page size.
    for (let n = 1; n <= 5; n++) await client.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'paged', UploadId, PartNumber: n, Body: body(`p${n}`) }));
    const p1 = await client.send(new ListPartsCommand({ Bucket: BUCKET, Key: 'paged', UploadId, MaxParts: 2 }));
    assert.equal(p1.IsTruncated, true);
    assert.equal((p1.Parts || []).length, 2);
    assert.equal(p1.NextPartNumberMarker, '2');
    const p2 = await client.send(new ListPartsCommand({ Bucket: BUCKET, Key: 'paged', UploadId, MaxParts: 2, PartNumberMarker: p1.NextPartNumberMarker }));
    assert.deepEqual((p2.Parts || []).map((p) => p.PartNumber), [3, 4]);
    const p3 = await client.send(new ListPartsCommand({ Bucket: BUCKET, Key: 'paged', UploadId, MaxParts: 2, PartNumberMarker: p2.NextPartNumberMarker }));
    assert.equal(p3.IsTruncated, false);
    assert.deepEqual((p3.Parts || []).map((p) => p.PartNumber), [5]);
  });
});

describe('mock S3 — fault injection on multipart/copy ops', () => {
  test('UploadPartCopy fault is returned as an error', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'src', Body: body('data') }));
    const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'dst' }));
    mock.configure({ faults: [{ op: 'UploadPartCopy', status: 403, code: 'AccessDenied', message: 'no' }] });
    await assert.rejects(client.send(new (await import('@aws-sdk/client-s3')).UploadPartCopyCommand({
      Bucket: BUCKET, Key: 'dst', UploadId, PartNumber: 1, CopySource: `${BUCKET}/src`,
    })));
    mock.configure({ faults: [] });
  });

  test('one-shot SlowDown (times:1) is consumed after one hit — proves retry can recover', async () => {
    // Use raw fetch (not the SDK) so the SDK's built-in retry doesn't mask the one-shot mechanic.
    mock.configure({ faults: [{ op: 'PutObject', method: 'PUT', status: 503, code: 'SlowDown', message: 'slow', times: 1 }] });
    const r1 = await fetch(`http://127.0.0.1:${port}/${BUCKET}/retry`, { method: 'PUT', body: 'x' });
    assert.equal(r1.status, 503, 'first attempt is throttled');
    const r2 = await fetch(`http://127.0.0.1:${port}/${BUCKET}/retry`, { method: 'PUT', body: 'x' });
    assert.equal(r2.status, 200, 'the fault is one-shot — second attempt succeeds');
    mock.configure({ faults: [] });
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'retry' }));
    assert.equal(head.ContentLength, 1);
  });
});

describe('mock S3 — CORS expose honors config (BUG-028 substrate)', () => {
  test('a narrowed exposeHeaders (no x-amz-meta-*) omits metadata from Expose-Headers', async () => {
    mock.configure({ cors: { exposeHeaders: ['ETag', 'Content-Length'] } });
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'm', Body: body('x'), Metadata: { 'file-mtime': 'z' } }));
    // Simulate a browser cross-origin HEAD: send Origin so the mock emits CORS headers.
    const resp = await fetch(`http://127.0.0.1:${port}/${BUCKET}/m`, { method: 'HEAD', headers: { Origin: 'http://app.test' } });
    const expose = (resp.headers.get('access-control-expose-headers') || '').toLowerCase();
    assert.ok(!expose.includes('x-amz-meta-file-mtime'), `metadata must be hidden under narrowed CORS, got: ${expose}`);
    mock.configure({ cors: {} }); // reset to default (exposes x-amz-meta-*)
  });

  test('default exposeHeaders (x-amz-meta-*) includes the metadata header', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'm2', Body: body('x'), Metadata: { 'file-mtime': 'z' } }));
    const resp = await fetch(`http://127.0.0.1:${port}/${BUCKET}/m2`, { method: 'HEAD', headers: { Origin: 'http://app.test' } });
    const expose = (resp.headers.get('access-control-expose-headers') || '').toLowerCase();
    assert.ok(expose.includes('x-amz-meta-file-mtime'), `default CORS must expose metadata, got: ${expose}`);
  });
});

describe('mock S3 — versioning', () => {
  test('with versioning on, delete creates a marker and ListObjectVersions shows history', async () => {
    mock.configure({ bucket: BUCKET, versioning: true });
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'v', Body: body('one') }));
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'v', Body: body('two') }));
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'v' })); // soft delete

    const list = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    assert.equal((list.Contents || []).length, 0, 'a delete marker hides the object from ListObjectsV2');

    const versions = await client.send(new ListObjectVersionsCommand({ Bucket: BUCKET }));
    assert.equal((versions.Versions || []).length, 2, 'both versions retained');
    assert.equal((versions.DeleteMarkers || []).length, 1, 'a delete marker exists');
  });
});
