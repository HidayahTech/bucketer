// Copyright (C) 2026 HidayahTech, LLC
// Tests for loadZipDetail (src/lib/download-records.js) — the capped per-file read that
// backs the ZIP progress detail view (docs/superpowers/specs/2026-08-03-zip-download-progress-design.md).
//
// Requires fake-indexeddb (devDependency) to provide an in-memory IndexedDB
// implementation. global.indexedDB must be set before any module that calls
// indexedDB.open() is imported — the module caches the connection on first use.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  saveJob, loadAllJobs, deleteJob, appendManifestPage,
  ITEM_STATUS, loadZipDetail,
} from '../src/lib/download-records.js';

const JOB_ID = 'zjob-detail';

const job = (over = {}) => ({
  id: JOB_ID, bucket: 'bkt', prefix: 'videos/', status: 'running',
  enumeration: { done: true }, counters: {}, ...over,
});

async function reset() {
  for (const j of await loadAllJobs()) await deleteJob(j.id);
}

describe('loadZipDetail', () => {
  beforeEach(reset);

  test('returns the 20 most-recently-completed DONE items (highest zipEnd first), capped FAILED, and full counts', async () => {
    await saveJob(job());

    // 25 DONE items with ascending zipEnd (n=25 finished last, i.e. is "most recent").
    const doneItems = Array.from({ length: 25 }, (_, idx) => {
      const n = idx + 1;
      return {
        key: `videos/done-${n}.txt`, size: n * 111, zipEnd: n * 1000,
        status: ITEM_STATUS.DONE,
      };
    });
    const failedItems = [1, 2, 3].map(n => ({
      key: `videos/failed-${n}.txt`, size: 50, status: ITEM_STATUS.FAILED,
    }));
    const pendingItems = [1, 2, 3, 4, 5].map(n => ({
      key: `videos/pending-${n}.txt`, size: 10, status: ITEM_STATUS.PENDING,
    }));

    await appendManifestPage(JOB_ID, [...doneItems, ...failedItems, ...pendingItems], {});

    const result = await loadZipDetail(JOB_ID);

    // done: 20 items, highest zipEnd (n=25) first, descending down to n=6, each {key,size}
    // only (no zipEnd/status leaking through).
    assert.equal(result.done.length, 20);
    const expectedDone = Array.from({ length: 20 }, (_, idx) => {
      const n = 25 - idx;
      return { key: `videos/done-${n}.txt`, size: n * 111 };
    });
    assert.deepEqual(result.done, expectedDone);

    // failed: all 3, each {key} only.
    assert.deepEqual(result.failed, [
      { key: 'videos/failed-1.txt' },
      { key: 'videos/failed-2.txt' },
      { key: 'videos/failed-3.txt' },
    ]);

    // counts are the FULL counts, not the capped array lengths.
    assert.equal(result.doneCount, 25);
    assert.equal(result.failedCount, 3);
  });

  test('respects custom doneCap/failedCap and honors default caps of 20', async () => {
    await saveJob(job());
    const doneItems = Array.from({ length: 5 }, (_, idx) => ({
      key: `videos/d${idx}.txt`, size: 1, zipEnd: idx + 1, status: ITEM_STATUS.DONE,
    }));
    const failedItems = Array.from({ length: 5 }, (_, idx) => ({
      key: `videos/f${idx}.txt`, size: 1, status: ITEM_STATUS.FAILED,
    }));
    await appendManifestPage(JOB_ID, [...doneItems, ...failedItems], {});

    const result = await loadZipDetail(JOB_ID, { doneCap: 2, failedCap: 1 });
    assert.equal(result.done.length, 2);
    assert.equal(result.failed.length, 1);
    assert.equal(result.doneCount, 5);
    assert.equal(result.failedCount, 5);
  });

  test('an unknown job returns empty arrays and zero counts rather than throwing', async () => {
    const result = await loadZipDetail('no-such-job');
    assert.deepEqual(result, { done: [], failed: [], doneCount: 0, failedCount: 0 });
  });
});
