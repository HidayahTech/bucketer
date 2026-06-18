// Tests for durable duplicate-scan results. A scan over a large bucket (tens of thousands
// of objects) is expensive, so its result is persisted per (endpoint, bucket) and restored
// when the report is reopened — the user should not have to re-scan. Persistence is
// best-effort: when IndexedDB is unavailable (e.g. jsdom, private browsing) the functions
// degrade to null/false instead of throwing.
import { indexedDB } from 'fake-indexeddb';
global.indexedDB = indexedDB;

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { saveScanResult, loadScanResult, deleteScanResult } from '../src/lib/dedup-scan-store.js';

function record(bucket, extra = {}) {
  return {
    endpoint: 'https://s3.example.com',
    bucket,
    scope: 'bucket',
    prefix: '',
    scannedAt: 1700000000000,
    objectCount: 30000,
    groups: [{
      id: 'g0', size: 10, matchedBy: 'md5', confidence: 'verified', verified: true,
      reclaimableBytes: 10, keeperKey: 'a',
      members: [{ Key: 'a', Size: 10, LastModified: new Date(0) }, { Key: 'b', Size: 10, LastModified: new Date(1) }],
    }],
    ...extra,
  };
}

describe('dedup-scan-store', () => {
  test('round-trips a saved scan, preserving groups and verified state', async () => {
    await saveScanResult(record('bk1'));
    const loaded = await loadScanResult('https://s3.example.com', 'bk1');
    assert.equal(loaded.objectCount, 30000);
    assert.equal(loaded.scannedAt, 1700000000000);
    assert.equal(loaded.groups[0].verified, true);
    assert.equal(loaded.groups[0].members.length, 2);
  });

  test('returns null when no scan is stored for that bucket', async () => {
    assert.equal(await loadScanResult('https://s3.example.com', 'never-scanned'), null);
  });

  test('the latest scan overwrites the previous one for the same bucket', async () => {
    await saveScanResult(record('bk2', { scannedAt: 1 }));
    await saveScanResult(record('bk2', { scannedAt: 2 }));
    const loaded = await loadScanResult('https://s3.example.com', 'bk2');
    assert.equal(loaded.scannedAt, 2);
  });

  test('different buckets are isolated', async () => {
    await saveScanResult(record('bk3', { objectCount: 111 }));
    await saveScanResult(record('bk4', { objectCount: 222 }));
    assert.equal((await loadScanResult('https://s3.example.com', 'bk3')).objectCount, 111);
    assert.equal((await loadScanResult('https://s3.example.com', 'bk4')).objectCount, 222);
  });

  test('delete removes a saved scan', async () => {
    await saveScanResult(record('bk5'));
    await deleteScanResult('https://s3.example.com', 'bk5');
    assert.equal(await loadScanResult('https://s3.example.com', 'bk5'), null);
  });

  test('degrades gracefully when IndexedDB is unavailable', async () => {
    const saved = global.indexedDB;
    global.indexedDB = undefined;
    try {
      assert.equal(await loadScanResult('https://s3.example.com', 'bk1'), null);
      assert.equal(await saveScanResult(record('bk6')), false);
    } finally {
      global.indexedDB = saved;
    }
  });
});
