// IndexedDB resume record and file hash tests.
//
// Requires fake-indexeddb (devDependency) to provide an in-memory IndexedDB
// implementation. global.indexedDB must be set before any module that calls
// indexedDB.open() is imported — the module caches the connection on first use.
import { indexedDB } from 'fake-indexeddb';
global.indexedDB = indexedDB;

// The tab-conflict functions use localStorage; provide a minimal mock so the
// module doesn't throw when it tries to read it on import.
global.localStorage = (() => {
  const s = {};
  return {
    getItem:  k     => Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null,
    setItem:  (k,v) => { s[k] = String(v); },
    removeItem: k   => { delete s[k]; },
  };
})();

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveResumeRecord,
  loadResumeRecord,
  deleteResumeRecord,
  computeFileHash,
} from '../src/lib/indexeddb.js';

// ── Resume record lifecycle ───────────────────────────────────────────────────

const BASE = {
  provider: 'r2',
  endpoint: 'https://r2.example.com',
  bucket: 'test-bucket',
  destinationKey: 'uploads/video.mp4',
  uploadId: 'mpu-abc123',
  partSize: 5_000_000,
  fileIdentity: { name: 'video.mp4', size: 104857600, lastModified: 1700000000000 },
  startedAt: 1700000000000,
};

describe('saveResumeRecord / loadResumeRecord', () => {
  test('round-trips a full resume record', async () => {
    await saveResumeRecord(BASE);
    const rec = await loadResumeRecord(BASE);
    assert.equal(rec.uploadId,  BASE.uploadId);
    assert.equal(rec.partSize,  BASE.partSize);
    assert.equal(rec.provider,  BASE.provider);
    assert.equal(rec.bucket,    BASE.bucket);
    assert.deepEqual(rec.fileIdentity, BASE.fileIdentity);
  });

  test('returns null for a key that does not exist', async () => {
    const result = await loadResumeRecord({ ...BASE, destinationKey: 'nonexistent/key.mp4' });
    assert.equal(result, null);
  });

  test('overwrites an existing record at the same key', async () => {
    const updated = { ...BASE, uploadId: 'mpu-updated' };
    await saveResumeRecord(updated);
    const rec = await loadResumeRecord(BASE);
    assert.equal(rec.uploadId, 'mpu-updated');
  });

  test('distinct keys are independent', async () => {
    const keyA = { ...BASE, destinationKey: 'a/file.mp4', uploadId: 'uid-a' };
    const keyB = { ...BASE, destinationKey: 'b/file.mp4', uploadId: 'uid-b' };
    await saveResumeRecord(keyA);
    await saveResumeRecord(keyB);
    const recA = await loadResumeRecord(keyA);
    const recB = await loadResumeRecord(keyB);
    assert.equal(recA.uploadId, 'uid-a');
    assert.equal(recB.uploadId, 'uid-b');
  });
});

describe('deleteResumeRecord', () => {
  test('removes a record so subsequent load returns null', async () => {
    const params = { ...BASE, destinationKey: 'delete-test/file.mp4', uploadId: 'uid-del' };
    await saveResumeRecord(params);
    await deleteResumeRecord(params);
    assert.equal(await loadResumeRecord(params), null);
  });

  test('delete of a non-existent key resolves without error', async () => {
    await assert.doesNotReject(() =>
      deleteResumeRecord({ ...BASE, destinationKey: 'ghost/file.mp4' })
    );
  });

  test('deleting one key leaves others intact', async () => {
    const keep = { ...BASE, destinationKey: 'keep/file.mp4', uploadId: 'uid-keep' };
    const drop = { ...BASE, destinationKey: 'drop/file.mp4', uploadId: 'uid-drop' };
    await saveResumeRecord(keep);
    await saveResumeRecord(drop);
    await deleteResumeRecord(drop);
    assert.equal((await loadResumeRecord(keep)).uploadId, 'uid-keep');
    assert.equal(await loadResumeRecord(drop), null);
  });
});

// ── computeFileHash ───────────────────────────────────────────────────────────

describe('computeFileHash', () => {
  test('returns a 64-character hex string for a non-empty file', async () => {
    const blob = new Blob([new Uint8Array(1024).fill(1)]);
    const hash = await computeFileHash(blob);
    assert.ok(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
      `expected 64-char hex string, got: ${hash}`);
  });

  test('same content produces the same hash', async () => {
    const data = new Uint8Array(2048).fill(7);
    const h1 = await computeFileHash(new Blob([data]));
    const h2 = await computeFileHash(new Blob([data]));
    assert.equal(h1, h2);
  });

  test('different content produces a different hash', async () => {
    const a = new Blob([new Uint8Array(512).fill(0)]);
    const b = new Blob([new Uint8Array(512).fill(255)]);
    assert.notEqual(await computeFileHash(a), await computeFileHash(b));
  });

  test('large file (> 64 KB) hashes first and last chunk only', async () => {
    // Two blobs with same first+last 64 KB but different middle should yield same hash.
    const CHUNK = 64 * 1024;
    const head = new Uint8Array(CHUNK).fill(1);
    const tail = new Uint8Array(CHUNK).fill(2);
    const middleA = new Uint8Array(CHUNK).fill(10);
    const middleB = new Uint8Array(CHUNK).fill(20);
    const blobA = new Blob([head, middleA, tail]);
    const blobB = new Blob([head, middleB, tail]);
    assert.equal(await computeFileHash(blobA), await computeFileHash(blobB),
      'files with identical head+tail but different middle must hash the same');
  });
});
