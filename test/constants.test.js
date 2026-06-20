import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MULTIPART_THRESHOLD, LARGE_FILE_WARN, DEFAULT_FILE_CONCURRENCY, PART_CONCURRENCY,
  PRESIGN_EXPIRES, TEXT_PREVIEW_LIMIT, COPY_LINK_PRESETS, COPY_MULTIPART_THRESHOLD,
} from '../src/lib/constants.js';

describe('constants', () => {
  test('MULTIPART_THRESHOLD is 5 MiB', () => {
    assert.equal(MULTIPART_THRESHOLD, 5 * 1024 * 1024);
  });

  test('LARGE_FILE_WARN is 50 GiB', () => {
    assert.equal(LARGE_FILE_WARN, 50 * 1024 * 1024 * 1024);
  });

  test('DEFAULT_FILE_CONCURRENCY is 3', () => {
    assert.equal(DEFAULT_FILE_CONCURRENCY, 3);
  });

  test('PART_CONCURRENCY is 4', () => {
    assert.equal(PART_CONCURRENCY, 4);
  });

  test('COPY_MULTIPART_THRESHOLD is 5 GiB (single-request CopyObject cap)', () => {
    assert.equal(COPY_MULTIPART_THRESHOLD, 5 * 1024 * 1024 * 1024);
  });

  test('PRESIGN_EXPIRES is 3600 seconds (1 hour)', () => {
    assert.equal(PRESIGN_EXPIRES, 3600);
  });

  test('TEXT_PREVIEW_LIMIT is 100 KiB', () => {
    assert.equal(TEXT_PREVIEW_LIMIT, 100 * 1024);
  });

  test('COPY_LINK_PRESETS is a non-empty array of {label, seconds} objects', () => {
    assert.ok(Array.isArray(COPY_LINK_PRESETS));
    assert.ok(COPY_LINK_PRESETS.length > 0);
    for (const p of COPY_LINK_PRESETS) {
      assert.ok(typeof p.label === 'string', `label must be a string: ${JSON.stringify(p)}`);
      assert.ok(typeof p.seconds === 'number', `seconds must be a number: ${JSON.stringify(p)}`);
      assert.ok(p.seconds > 0, `seconds must be positive: ${JSON.stringify(p)}`);
    }
  });

  test('COPY_LINK_PRESETS max is at most 7 days (604800 s)', () => {
    const max = Math.max(...COPY_LINK_PRESETS.map(p => p.seconds));
    assert.ok(max <= 7 * 24 * 3600, `max preset (${max}s) exceeds 7 days`);
  });
});
