import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyObjectMultipart } from '../src/lib/move-multipart.js';

// Multipart server-side copy (UploadPartCopy) for objects above the 5 GiB single-request
// cap. The correctness traps pinned here: inclusive CopySourceRange byte boundaries,
// metadata carried forward via HeadObject (UploadPartCopy copies bytes only), ETag read
// from CopyPartResult, and best-effort abort on any failure (source never deleted).

function mockClient({ partCopyRejectOn, networkFailOncePart } = {}) {
  const calls = [];
  const partAttempts = new Map(); // PartNumber → attempt count, for retry simulation
  return {
    calls,
    partAttempts,
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
        case 'UploadPartCopyCommand': {
          const attempt = (partAttempts.get(input.PartNumber) ?? 0) + 1;
          partAttempts.set(input.PartNumber, attempt);
          if (partCopyRejectOn === input.PartNumber) {
            return Promise.reject(new Error('PartFailed'));
          }
          // Simulate one transient browser fetch failure ("Failed to fetch" is a TypeError
          // in Chromium) on the first attempt of the named part, then succeed on retry.
          if (networkFailOncePart === input.PartNumber && attempt === 1) {
            return Promise.reject(new TypeError('Failed to fetch'));
          }
          return Promise.resolve({ CopyPartResult: { ETag: `etag-${input.PartNumber}` } });
        }
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
  // 12,000,000 bytes split into 5,000,000-byte parts → 3 parts (last one smaller).
  // These tests exercise the split/range mechanics, so they pin preferredPartBytes to
  // 5 MB explicitly rather than relying on the default copy part size (now 1 GiB, which
  // would put this whole object in a single part).
  const SIZE = 12_000_000;
  const PART = 5_000_000;

  test('HeadObjects the source and carries its metadata onto CreateMultipartUpload', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE, preferredPartBytes: PART });

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
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE, preferredPartBytes: PART });

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
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE, preferredPartBytes: PART });
    const part = client.calls.find(c => c.name === 'UploadPartCopyCommand');
    assert.equal(part.input.CopySource, 'bk/big.bin');
  });

  test('reads part ETags from CopyPartResult and completes with sorted parts', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE, preferredPartBytes: PART });

    const complete = client.calls.find(c => c.name === 'CompleteMultipartUploadCommand');
    assert.deepEqual(complete.input.MultipartUpload.Parts, [
      { PartNumber: 1, ETag: 'etag-1' },
      { PartNumber: 2, ETag: 'etag-2' },
      { PartNumber: 3, ETag: 'etag-3' },
    ]);
  });

  test('does not abort on success', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: SIZE, preferredPartBytes: PART });
    assert.ok(!client.calls.some(c => c.name === 'AbortMultipartUploadCommand'));
  });
});

describe('copyObjectMultipart — failure', () => {
  test('aborts the multipart upload and rethrows when a part copy fails', async () => {
    const client = mockClient({ partCopyRejectOn: 2 });
    await assert.rejects(
      copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: 12_000_000, preferredPartBytes: 5_000_000 }),
      /PartFailed/,
    );
    const abort = client.calls.find(c => c.name === 'AbortMultipartUploadCommand');
    assert.ok(abort, 'must abort the orphaned multipart upload');
    assert.equal(abort.input.UploadId, 'up-1');
    assert.ok(!client.calls.some(c => c.name === 'CompleteMultipartUploadCommand'), 'must not complete');
  });
});

const GiB = 1024 * 1024 * 1024;

// A server-side copy part never enters the browser (UploadPartCopy is a byte-range copy),
// so — unlike an upload part, which is a live ArrayBuffer — there is no client-memory cost
// to large parts. Large parts mean far fewer requests: at the upload 5 MB floor a big file
// is pinned at the 10,000-part cap; at 1 GiB a 10 GiB object is just 10 parts.
describe('copyObjectMultipart — copy part sizing', () => {
  function partCount(client) {
    return client.calls.filter(c => c.name === 'UploadPartCopyCommand').length;
  }

  test('defaults to 1 GiB parts (10 GiB object → 10 parts, not thousands)', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin', size: 10 * GiB });
    assert.equal(partCount(client), 10);
  });

  test('clamps an oversized preferred part size to the 4 GB universal ceiling', async () => {
    // 20 GB with a 10 GB preferred part would be 2 parts if honoured; clamped to 4 GB it is
    // 5 parts. 4 GB (decimal) is the largest value safe on every supported provider — under
    // both the 5 GB camp (B2/Wasabi/DO) and the 5 GiB camp (AWS/R2/MinIO) — and below 2^32.
    const client = mockClient();
    await copyObjectMultipart(client, {
      bucket: 'bk', sourceKey: 'big.bin', destKey: 'arch/big.bin',
      size: 20_000_000_000, preferredPartBytes: 10_000_000_000,
    });
    assert.equal(partCount(client), 5);
  });
});

// Cloudflare R2 requires every part except the last to be the same size. Our fixed-part-size
// algorithm satisfies this; this test guards against a future change to variable-size parts
// that would silently break moves on R2.
describe('copyObjectMultipart — R2 uniform part size', () => {
  test('all parts except the last are identical in size', async () => {
    const client = mockClient();
    // 3 GiB + 500 bytes at 1 GiB parts → three full 1 GiB parts and a 500-byte tail.
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'd', size: 3 * GiB + 500 });
    const lengths = client.calls
      .filter(c => c.name === 'UploadPartCopyCommand')
      .map(c => {
        const [, a, b] = c.input.CopySourceRange.match(/bytes=(\d+)-(\d+)/);
        return Number(b) - Number(a) + 1;
      });
    const nonLast = lengths.slice(0, -1);
    assert.ok(nonLast.every(len => len === nonLast[0]), 'non-final parts must be uniform');
    assert.equal(nonLast[0], GiB);
    assert.equal(lengths[lengths.length - 1], 500);
  });
});

// The queue shows byte progress for a move; a large single-file copy would otherwise sit at
// "0 of 1" for the whole transfer. copyObjectMultipart reports each copied part's byte count
// so the bar advances at part granularity.
describe('copyObjectMultipart — per-part progress', () => {
  test('reports each copied part\'s byte count, summing to the object size', async () => {
    const client = mockClient();
    const chunks = [];
    // 12 MB in 5 MB parts → 5,000,000 + 5,000,000 + 2,000,000.
    await copyObjectMultipart(client, {
      bucket: 'bk', sourceKey: 's', destKey: 'd', size: 12_000_000, preferredPartBytes: 5_000_000,
      onPartCopied: (bytes) => chunks.push(bytes),
    });
    assert.deepEqual(chunks.slice().sort((a, b) => b - a), [5_000_000, 5_000_000, 2_000_000]);
    assert.equal(chunks.reduce((a, b) => a + b, 0), 12_000_000);
  });

  test('is optional — a copy without the callback still completes', async () => {
    const client = mockClient();
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 's', destKey: 'd', size: 12_000_000, preferredPartBytes: 5_000_000 });
    assert.ok(client.calls.some(c => c.name === 'CompleteMultipartUploadCommand'));
  });
});

// A 4 GB part holds its connection open far longer than a 5 MB one, so it is more exposed
// to a transient network drop. The copy path must retry those (a dropped/reset connection),
// not only server throttling — otherwise one blip aborts the entire large-file copy.
describe('copyObjectMultipart — transient network retry', () => {
  test('retries a part copy that fails once with a transient fetch error, then completes', async () => {
    const client = mockClient({ networkFailOncePart: 2 });
    await copyObjectMultipart(client, { bucket: 'bk', sourceKey: 'big.bin', destKey: 'd', size: 12_000_000, preferredPartBytes: 5_000_000 });
    assert.equal(client.partAttempts.get(2), 2, 'part 2 must be attempted twice (one retry)');
    assert.ok(client.calls.some(c => c.name === 'CompleteMultipartUploadCommand'), 'copy must complete');
    assert.ok(!client.calls.some(c => c.name === 'AbortMultipartUploadCommand'), 'must not abort');
  });
});
