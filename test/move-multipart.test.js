import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyObjectMultipart } from '../src/lib/move-multipart.js';

// Multipart server-side copy (UploadPartCopy) for objects above the 5 GiB single-request
// cap. The correctness traps pinned here: inclusive CopySourceRange byte boundaries,
// metadata carried forward via HeadObject (UploadPartCopy copies bytes only), ETag read
// from CopyPartResult, and best-effort abort on any failure (source never deleted).

function mockClient({ partCopyRejectOn } = {}) {
  const calls = [];
  return {
    calls,
    send(cmd) {
      const name = cmd.constructor?.name ?? '';
      const input = cmd.input;
      calls.push({ name, input });
      switch (name) {
        case 'HeadObjectCommand':
          return Promise.resolve({
            ContentType: 'image/png',
            Metadata: { 'file-mtime': '123' },
            CacheControl: 'max-age=1',
            ContentEncoding: 'identity',
          });
        case 'CreateMultipartUploadCommand':
          return Promise.resolve({ UploadId: 'up-1' });
        case 'UploadPartCopyCommand':
          if (partCopyRejectOn === input.PartNumber) {
            return Promise.reject(new Error('PartFailed'));
          }
          return Promise.resolve({ CopyPartResult: { ETag: `etag-${input.PartNumber}` } });
        case 'CompleteMultipartUploadCommand':
          return Promise.resolve({ ETag: 'final-etag' });
        case 'AbortMultipartUploadCommand':
          return Promise.resolve({});
        default:
          return Promise.reject(new Error(`unexpected command: ${name}`));
      }
    },
  };
}

describe('copyObjectMultipart — happy path', () => {
  // 12,000,000 bytes with the 5,000,000-byte floor → 3 parts (last one smaller).
  const SIZE = 12_000_000;

  test('HeadObjects the source and carries its metadata onto CreateMultipartUpload', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE });

    const head = client.calls.find(c => c.name === 'HeadObjectCommand');
    assert.equal(head.input.Key, 'big.bin');

    const create = client.calls.find(c => c.name === 'CreateMultipartUploadCommand');
    assert.equal(create.input.Key, 'arch/big.bin');
    assert.equal(create.input.ContentType, 'image/png');
    assert.deepEqual(create.input.Metadata, { 'file-mtime': '123' });
    assert.equal(create.input.CacheControl, 'max-age=1');
  });

  test('uses inclusive CopySourceRange boundaries with a smaller final part', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE });

    const ranges = client.calls
      .filter(c => c.name === 'UploadPartCopyCommand')
      .map(c => c.input.CopySourceRange);
    assert.deepEqual(ranges, [
      'bytes=0-4999999',
      'bytes=5000000-9999999',
      'bytes=10000000-11999999', // final part: 2,000,000 bytes, not a full 5 MB
    ]);
  });

  test('CopySource points at the source key', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE });
    const part = client.calls.find(c => c.name === 'UploadPartCopyCommand');
    assert.equal(part.input.CopySource, 'bk/big.bin');
  });

  test('reads part ETags from CopyPartResult and completes with sorted parts', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE });

    const complete = client.calls.find(c => c.name === 'CompleteMultipartUploadCommand');
    assert.deepEqual(complete.input.MultipartUpload.Parts, [
      { PartNumber: 1, ETag: 'etag-1' },
      { PartNumber: 2, ETag: 'etag-2' },
      { PartNumber: 3, ETag: 'etag-3' },
    ]);
  });

  test('does not abort on success', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE });
    assert.ok(!client.calls.some(c => c.name === 'AbortMultipartUploadCommand'));
  });
});

describe('copyObjectMultipart — failure', () => {
  test('aborts the multipart upload and rethrows when a part copy fails', async () => {
    const client = mockClient({ partCopyRejectOn: 2 });
    await assert.rejects(
      copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: 12_000_000 }),
      /PartFailed/,
    );
    const abort = client.calls.find(c => c.name === 'AbortMultipartUploadCommand');
    assert.ok(abort, 'must abort the orphaned multipart upload');
    assert.equal(abort.input.UploadId, 'up-1');
    assert.ok(!client.calls.some(c => c.name === 'CompleteMultipartUploadCommand'), 'must not complete');
  });
});
