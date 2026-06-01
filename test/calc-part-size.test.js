import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calcPartSize, preparePutBody } from '../src/lib/upload-queue.js';

const MB  = 1_000_000;       // decimal MB (S3 spec uses decimal)
const MiB = 1024 * 1024;     // binary MiB

describe('calcPartSize', () => {
  // ── 5 MB floor ──────────────────────────────────────────────────────────────

  test('returns 5 MB floor for a tiny file', () => {
    assert.equal(calcPartSize(1, undefined), 5 * MB);
  });

  test('returns 5 MB floor when preferred is below 5 MB', () => {
    assert.equal(calcPartSize(10 * MB, 4 * MB), 5 * MB);
  });

  test('returns 5 MB floor when preferred is exactly 5 MB', () => {
    // preferred === floor means preferred is NOT > floor, so floor wins
    assert.equal(calcPartSize(10 * MB, 5 * MB), 5 * MB);
  });

  // ── preferred size honoured above floor ─────────────────────────────────────

  test('honours preferred when preferred > 5 MB floor', () => {
    assert.equal(calcPartSize(10 * MB, 8 * MB), 8 * MB);
  });

  test('honours a 100 MiB preferred part size for a 1 GB file', () => {
    assert.equal(calcPartSize(1024 * MiB, 100 * MiB), 100 * MiB);
  });

  // ── 10,000-part limit ────────────────────────────────────────────────────────
  // For large files the floor rises so that fileSize / partSize <= 10,000.

  test('raises floor for a 100 GB file so parts stay within 10,000', () => {
    const fileSize = 100 * 1024 * MiB; // 100 GiB
    const size = calcPartSize(fileSize, undefined);
    assert.ok(size >= Math.ceil(fileSize / 10000), 'floor must cover 10,000-part limit');
    const parts = Math.ceil(fileSize / size);
    assert.ok(parts <= 10000, `part count ${parts} must not exceed 10,000`);
  });

  test('raises floor for a 5 TB file — the S3 maximum object size', () => {
    const fileSize = 5 * 1024 * 1024 * MiB; // 5 TiB
    const size = calcPartSize(fileSize, undefined);
    assert.ok(size >= 5 * MB, 'floor must never drop below 5 MB');
    const parts = Math.ceil(fileSize / size);
    assert.ok(parts <= 10000, `part count ${parts} must not exceed 10,000 for 5 TiB`);
  });

  test('ignores preferred when it would produce too many parts', () => {
    // 50 GB file, user requests 4 MB parts → that would need 12,500 parts (> 10,000).
    // calcPartSize must override the preferred and use the computed floor instead.
    const fileSize = 50 * 1024 * MiB;
    const size = calcPartSize(fileSize, 4 * MB);
    const parts = Math.ceil(fileSize / size);
    assert.ok(parts <= 10000, `part count ${parts} must not exceed 10,000`);
  });

  // ── edge cases ───────────────────────────────────────────────────────────────

  test('undefined preferred returns floor', () => {
    assert.equal(calcPartSize(20 * MB, undefined), 5 * MB);
  });

  test('zero preferred returns floor', () => {
    assert.equal(calcPartSize(20 * MB, 0), 5 * MB);
  });

  test('null preferred returns floor', () => {
    assert.equal(calcPartSize(20 * MB, null), 5 * MB);
  });
});

// ── preparePutBody (BUG-003) ──────────────────────────────────────────────────

describe('preparePutBody', () => {
  // BUG-003: The AWS SDK v3 browser fetch handler calls .getReader() on the Body,
  // expecting a ReadableStream. File and Blob don't have .getReader(). This function
  // converts the file to Uint8Array which the SDK can handle in all environments.

  test('returns a Uint8Array', async () => {
    const blob = new Blob(['hello world']);
    const result = await preparePutBody(blob);
    assert.ok(result instanceof Uint8Array, 'must return Uint8Array, not File or Blob');
  });

  test('result is not a Blob or File', async () => {
    const blob = new Blob(['test data']);
    const result = await preparePutBody(blob);
    assert.ok(!(result instanceof Blob), 'must not be a Blob — SDK cannot call .getReader() on Blob');
  });

  test('content is preserved through the conversion', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Blob([data]);
    const result = await preparePutBody(blob);
    assert.deepEqual(Array.from(result), [1, 2, 3, 4, 5]);
  });

  test('empty file produces empty Uint8Array', async () => {
    const blob = new Blob([]);
    const result = await preparePutBody(blob);
    assert.equal(result.length, 0);
  });
});
