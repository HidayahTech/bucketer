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

// ── Range and conditional support ────────────────────────────────────────────────
//
// Everything the chunked-download work needs from the mock. A resumable transfer discovers
// range support from Accept-Ranges, resumes with Range, guards against the object changing
// underneath it with If-Match, and must survive a connection dropped mid-body. None of that
// could be tested before these existed.
describe('mock S3 — range support', () => {
  const url = (key, qs = '') => `http://127.0.0.1:${port}/${BUCKET}/${key}${qs}`;

  beforeEach(async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'r', Body: body('0123456789') }));
  });

  test('advertises Accept-Ranges on a plain GET', async () => {
    const resp = await fetch(url('r'));
    assert.equal(resp.headers.get('accept-ranges'), 'bytes');
  });

  test('advertises Accept-Ranges on HEAD, where a client looks first', async () => {
    const resp = await fetch(url('r'), { method: 'HEAD' });
    assert.equal(resp.headers.get('accept-ranges'), 'bytes');
  });

  test('serves a closed range as 206 with Content-Range', async () => {
    const resp = await fetch(url('r'), { headers: { Range: 'bytes=2-5' } });
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await resp.text(), '2345');
  });

  test('serves an open-ended range, which is how a resume asks', async () => {
    const resp = await fetch(url('r'), { headers: { Range: 'bytes=6-' } });
    assert.equal(resp.status, 206);
    assert.equal(await resp.text(), '6789');
  });

  test('serves a suffix range', async () => {
    const resp = await fetch(url('r'), { headers: { Range: 'bytes=-3' } });
    assert.equal(resp.status, 206);
    assert.equal(await resp.text(), '789');
  });

  test('rejects a range beyond the object with 416', async () => {
    const resp = await fetch(url('r'), { headers: { Range: 'bytes=99-' } });
    assert.equal(resp.status, 416);
    assert.equal(resp.headers.get('content-range'), 'bytes */10');
  });

  test('CORS exposes the headers a ranged reader must read', async () => {
    const resp = await fetch(url('r'), { headers: { Origin: 'http://app.test', Range: 'bytes=0-1' } });
    const expose = (resp.headers.get('access-control-expose-headers') || '').toLowerCase();
    assert.ok(expose.includes('content-range'), `expected Content-Range exposed, got: ${expose}`);
    assert.ok(expose.includes('accept-ranges'), `expected Accept-Ranges exposed, got: ${expose}`);
  });
});

describe('mock S3 — conditional requests', () => {
  const url = (key) => `http://127.0.0.1:${port}/${BUCKET}/${key}`;

  test('If-Match passes when the object is unchanged', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'c', Body: body('hello') }));
    const head = await fetch(url('c'), { method: 'HEAD' });
    const resp = await fetch(url('c'), { headers: { 'If-Match': head.headers.get('etag') } });
    assert.equal(resp.status, 200);
  });

  // The case that matters: an object replaced mid-transfer must not silently yield a file
  // assembled from two different versions.
  test('If-Match fails with 412 once the object has changed', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'c', Body: body('hello') }));
    const head = await fetch(url('c'), { method: 'HEAD' });
    const stale = head.headers.get('etag');
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'c', Body: body('goodbye') }));

    const resp = await fetch(url('c'), { headers: { 'If-Match': stale, Range: 'bytes=0-2' } });
    assert.equal(resp.status, 412);
  });

  test('If-Range serves the full object when the validator no longer matches', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'c', Body: body('hello') }));
    const head = await fetch(url('c'), { method: 'HEAD' });
    const stale = head.headers.get('etag');
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'c', Body: body('goodbye') }));

    const resp = await fetch(url('c'), { headers: { 'If-Range': stale, Range: 'bytes=0-2' } });
    assert.equal(resp.status, 200, 'a stale If-Range means start over, not a partial');
    assert.equal(await resp.text(), 'goodbye');
  });
});

// Prefix-scoped keys (#60): scopePrefix models a credential restricted to a
// key-name prefix (B2 namePrefix / IAM s3:prefix) as a standing per-instance
// constraint — the mock ignores signatures, so there is no per-request identity.
// Scope is a hard boundary, checked before faults (deny takes precedence).
describe('mock S3 — prefix scope (scopePrefix)', () => {
  const SCOPE = 'clients/acme/';
  const denied = (err) => err.name === 'AccessDenied' && err.$metadata.httpStatusCode === 403;

  beforeEach(() => mock.configure({ scopePrefix: SCOPE }));

  test('root ListObjectsV2 is denied with 403 AccessDenied', async () => {
    await assert.rejects(client.send(new ListObjectsV2Command({ Bucket: BUCKET })), denied);
  });

  test('listing at the scope and nested under it succeeds', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + '2026/r.pdf', Body: body('x') }));
    const atScope = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: SCOPE, Delimiter: '/' }));
    assert.equal((atScope.CommonPrefixes || []).length, 1);
    const nested = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: SCOPE + '2026/' }));
    assert.equal(nested.KeyCount, 1);
  });

  test('object ops inside the scope succeed', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'f.txt', Body: body('ok') }));
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'f.txt' }));
    assert.equal(await streamToString(got.Body), 'ok');
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'f.txt' }));
  });

  test('PutObject outside the scope is denied', async () => {
    await assert.rejects(client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'clients/other/f.txt', Body: body('no') })), denied);
  });

  test('GetObject/HeadObject outside the scope are denied even when the key exists', async () => {
    mock.configure({ scopePrefix: null });
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'clients/other/f.txt', Body: body('secret') }));
    mock.configure({ scopePrefix: SCOPE });
    await assert.rejects(client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'clients/other/f.txt' })), denied);
    // HEAD error responses carry no XML body (real S3 too), so the SDK can't see the
    // code — the 403 status is the only signal, which is what isPermissionError uses.
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'clients/other/f.txt' })),
      (err) => err.$metadata.httpStatusCode === 403);
  });

  test('CopyObject is denied when either side is outside the scope', async () => {
    mock.configure({ scopePrefix: null });
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'clients/other/src.txt', Body: body('s') }));
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'src.txt', Body: body('s') }));
    mock.configure({ scopePrefix: SCOPE });
    await assert.rejects(client.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: SCOPE + 'dst.txt', CopySource: `${BUCKET}/clients/other/src.txt`,
    })), denied, 'out-of-scope source must be denied');
    await assert.rejects(client.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: 'clients/other/dst.txt', CopySource: `${BUCKET}/${SCOPE}src.txt`,
    })), denied, 'out-of-scope destination must be denied');
  });

  test('multipart initiate outside the scope is denied — nothing to UploadPart against', async () => {
    await assert.rejects(client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'clients/other/big.bin' })), denied);
    const ok = await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: SCOPE + 'big.bin' }));
    assert.ok(ok.UploadId, 'in-scope initiate still works');
  });

  test('batch delete: in-scope keys delete, out-of-scope keys come back as per-key AccessDenied', async () => {
    mock.configure({ scopePrefix: null });
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'a.txt', Body: body('a') }));
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'clients/other/b.txt', Body: body('b') }));
    mock.configure({ scopePrefix: SCOPE });
    const resp = await client.send(new DeleteObjectsCommand({
      Bucket: BUCKET, Delete: { Objects: [{ Key: SCOPE + 'a.txt' }, { Key: 'clients/other/b.txt' }] },
    }));
    assert.ok((resp.Errors || []).some(e => e.Key === 'clients/other/b.txt' && e.Code === 'AccessDenied'));
    mock.configure({ scopePrefix: null });
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'a.txt' })), 'a must be gone');
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'clients/other/b.txt' })); // still there
  });

  test('ListObjectVersions outside the scope is denied; inside succeeds', async () => {
    await assert.rejects(client.send(new ListObjectVersionsCommand({ Bucket: BUCKET })), denied);
    await client.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: SCOPE }));
  });

  test('reset() clears the scope', async () => {
    mock.reset();
    await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  });

  test('requestLog records list requests with their prefix', async () => {
    mock.requestLog.reset();
    await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: SCOPE, Delimiter: '/' }));
    const lists = mock.requestLog.list().filter(r => r.isList);
    assert.equal(lists.length, 1);
    assert.equal(lists[0].listPrefix, SCOPE);
  });
});

describe('mock S3 — fault injection for transfers', () => {
  const url = (key) => `http://127.0.0.1:${port}/${BUCKET}/${key}`;

  test('drops the connection mid-body at a chosen byte', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: body('0123456789') }));
    mock.configure({ faults: [{ op: 'GetObject', killAtByte: 4 }] });

    await assert.rejects(
      async () => { const r = await fetch(url('k')); await r.arrayBuffer(); },
      'a body truncated by a dropped connection must reject, not resolve short',
    );
  });

  test('injects 503 SlowDown, which a retry policy must treat as retryable', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 's', Body: body('x') }));
    mock.configure({ faults: [{ op: 'GetObject', status: 503, code: 'SlowDown' }] });

    const resp = await fetch(url('s'));
    assert.equal(resp.status, 503);
    assert.ok((await resp.text()).includes('SlowDown'));
  });
});
