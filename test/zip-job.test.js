// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-job.js — pure pieces: entry paths, zip name, quota gate.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { zipEntryPath, zipFileName, zipGate } from '../src/lib/zip-job.js';

const CAPS = { opfs: true, streamingFetch: true, writableFiles: true };

describe('zipEntryPath', () => {
  test('strips the captured prefix and keeps folder structure', () => {
    assert.equal(zipEntryPath('photos/2024/trip.jpg', 'photos/'), '2024/trip.jpg');
  });
  test('sanitizes each segment', () => {
    assert.equal(zipEntryPath('a/b:c/d.txt', 'a/'), 'b_c/d.txt');
  });
  test('a key outside the prefix keeps its full (sanitized) path', () => {
    assert.equal(zipEntryPath('other/x.txt', 'photos/'), 'other/x.txt');
  });
  test('empty prefix means the full key', () => {
    assert.equal(zipEntryPath('a/b.txt', ''), 'a/b.txt');
  });
});

describe('zipFileName', () => {
  const now = new Date(2026, 7, 3, 14, 5); // 2026-08-03 14:05 local
  test('uses the last folder segment when there is a prefix', () => {
    assert.equal(zipFileName('bkt', 'photos/2024/', now), '2024-20260803-1405.zip');
  });
  test('falls back to the bucket at the root', () => {
    assert.equal(zipFileName('bkt', '', now), 'bkt-20260803-1405.zip');
  });
});

describe('zipGate', () => {
  const quota = (free) => ({ quotaBytes: free + 100, usageBytes: 100 });
  test('offered when capabilities present and the job fits', () => {
    assert.equal(zipGate({ caps: CAPS, sendableBytes: 10, quota: quota(1000), persisted: false }).state, 'offered');
  });
  test('unavailable without OPFS capability', () => {
    const g = zipGate({ caps: { ...CAPS, opfs: false }, sendableBytes: 10, quota: quota(1000), persisted: false });
    assert.equal(g.state, 'unavailable');
  });
  test('needs-storage when it does not fit and persist has not been granted', () => {
    const g = zipGate({ caps: CAPS, sendableBytes: 5000, quota: quota(1000), persisted: false });
    assert.equal(g.state, 'needs-storage');
    assert.match(g.reason, /storage/);
  });
  test('unavailable (not needs-storage) when persist is already granted and it still does not fit', () => {
    assert.equal(zipGate({ caps: CAPS, sendableBytes: 5000, quota: quota(1000), persisted: true }).state, 'unavailable');
  });
  test('fit respects the QUOTA_SAFETY headroom, not the raw free space', () => {
    // free = 100; safety 0.9 → 90 usable; 95 must NOT fit.
    assert.notEqual(zipGate({ caps: CAPS, sendableBytes: 95, quota: quota(100), persisted: false }).state, 'offered');
  });
  test('unknown quota is optimistic', () => {
    assert.equal(zipGate({ caps: CAPS, sendableBytes: 1e15, quota: null, persisted: false }).state, 'offered');
  });
});
