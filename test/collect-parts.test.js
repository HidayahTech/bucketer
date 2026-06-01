// Tests for collectParts() — paginated ListParts wrapper (BUG-007).
//
// BUG-007: the original ListParts call inside handleResume stopped after the
// first page. ListParts returns at most 1000 parts per call. A multipart upload
// with more than 1000 ACK'd parts (e.g. a very large file with small part size)
// would re-upload the parts from the second page, potentially corrupting the
// session. The fix: paginate until IsTruncated is false.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// collectParts imports ListPartsCommand statically from @aws-sdk/client-s3.
// We intercept client.send() — no need to mock the SDK module itself.
import { collectParts } from '../src/lib/upload-queue.js';

// ── Mock S3 client factory ────────────────────────────────────────────────────

// pages: array of {parts: [{PartNumber, ETag}], isTruncated, nextMarker}
// send() inspects PartNumberMarker on the incoming command to select the right page.
function mockClient(pages) {
  return {
    send(cmd) {
      const input = cmd.input ?? cmd;
      const marker = input.PartNumberMarker;
      const page = marker
        ? pages.find(p => p.nextMarkerTrigger === marker)
        : pages[0];
      if (!page) return Promise.reject(new Error(`unexpected marker: ${marker}`));
      return Promise.resolve({
        Parts: page.parts,
        IsTruncated: page.isTruncated ?? false,
        NextPartNumberMarker: page.nextMarker,
      });
    },
  };
}

const PARAMS = { bucket: 'my-bucket', key: 'uploads/video.mp4', uploadId: 'mpu-abc' };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('collectParts — single page', () => {
  test('returns all parts from a single non-truncated response', async () => {
    const parts = [
      { PartNumber: 1, ETag: '"aaa"' },
      { PartNumber: 2, ETag: '"bbb"' },
    ];
    const client = mockClient([{ parts, isTruncated: false }]);
    const result = await collectParts(client, PARAMS);
    assert.deepEqual(result, parts);
  });

  test('returns empty array when no parts have been uploaded yet', async () => {
    const client = mockClient([{ parts: [], isTruncated: false }]);
    assert.deepEqual(await collectParts(client, PARAMS), []);
  });

  test('handles undefined Parts in response (provider omits empty array)', async () => {
    const client = mockClient([{ parts: undefined, isTruncated: false }]);
    assert.deepEqual(await collectParts(client, PARAMS), []);
  });
});

describe('collectParts — pagination (BUG-007)', () => {
  // BUG-007: stopping after the first page would miss parts 1001+ and re-upload them.

  test('collects parts across two pages', async () => {
    const page1Parts = Array.from({ length: 3 }, (_, i) => ({ PartNumber: i + 1, ETag: `"e${i+1}"` }));
    const page2Parts = [{ PartNumber: 4, ETag: '"e4"' }, { PartNumber: 5, ETag: '"e5"' }];
    const client = mockClient([
      { parts: page1Parts, isTruncated: true,  nextMarker: 3, nextMarkerTrigger: undefined },
      { parts: page2Parts, isTruncated: false, nextMarkerTrigger: 3 },
    ]);
    const result = await collectParts(client, PARAMS);
    assert.equal(result.length, 5, 'must collect all 5 parts from both pages');
    assert.deepEqual(result.map(p => p.PartNumber), [1, 2, 3, 4, 5]);
  });

  test('collects parts across three pages', async () => {
    const pages = [
      { parts: [{ PartNumber: 1, ETag: '"e1"' }], isTruncated: true,  nextMarker: 1, nextMarkerTrigger: undefined },
      { parts: [{ PartNumber: 2, ETag: '"e2"' }], isTruncated: true,  nextMarker: 2, nextMarkerTrigger: 1 },
      { parts: [{ PartNumber: 3, ETag: '"e3"' }], isTruncated: false, nextMarkerTrigger: 2 },
    ];
    const client = mockClient(pages);
    const result = await collectParts(client, PARAMS);
    assert.equal(result.length, 3, 'must collect all 3 parts across three pages');
  });

  test('stops paginating when IsTruncated is false', async () => {
    let callCount = 0;
    const client = {
      send() {
        callCount++;
        return Promise.resolve({ Parts: [{ PartNumber: callCount, ETag: `"e${callCount}"` }], IsTruncated: false });
      },
    };
    await collectParts(client, PARAMS);
    assert.equal(callCount, 1, 'must stop after the first non-truncated page');
  });

  test('preserves PartNumber and ETag from each page', async () => {
    const client = mockClient([
      { parts: [{ PartNumber: 1, ETag: '"etag1"' }], isTruncated: true,  nextMarker: 1, nextMarkerTrigger: undefined },
      { parts: [{ PartNumber: 2, ETag: '"etag2"' }], isTruncated: false, nextMarkerTrigger: 1 },
    ]);
    const result = await collectParts(client, PARAMS);
    assert.equal(result[0].ETag, '"etag1"');
    assert.equal(result[1].ETag, '"etag2"');
  });
});
