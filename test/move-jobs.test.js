// Tests for src/lib/move-jobs.js — durable state for resumable move jobs.
// Requires fake-indexeddb; global.indexedDB must be set before importing the module.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveMoveJob, loadMoveJob, loadAllMoveJobs, updateMoveJob, deleteMoveJob, clearAllMoveJobs,
} from '../src/lib/move-jobs.js';

const job = (over = {}) => ({
  id: 'mv-1', provider: 'b2', endpoint: 'https://e', bucket: 'bkt', mode: 'move',
  dest: 'arch/', capturedPrefix: '', createdAt: 0,
  items: [{ sourceKey: 'a.bin', destKey: 'arch/a.bin', size: 100 }],
  inflight: null, ...over,
});

describe('move-jobs', () => {
  beforeEach(async () => { await clearAllMoveJobs(); });

  test('saves a job and loads it back by id', async () => {
    await saveMoveJob(job());
    const j = await loadMoveJob('mv-1');
    assert.equal(j.bucket, 'bkt');
    assert.deepEqual(j.items, [{ sourceKey: 'a.bin', destKey: 'arch/a.bin', size: 100 }]);
  });

  test('loadMoveJob returns null for an unknown id', async () => {
    assert.equal(await loadMoveJob('nope'), null);
  });

  test('loadAllMoveJobs returns every saved job', async () => {
    await saveMoveJob(job({ id: 'mv-1' }));
    await saveMoveJob(job({ id: 'mv-2' }));
    const all = await loadAllMoveJobs();
    assert.deepEqual(all.map(j => j.id).sort(), ['mv-1', 'mv-2']);
  });

  test('updateMoveJob merges a patch into one row, leaving other fields intact', async () => {
    await saveMoveJob(job());
    await updateMoveJob('mv-1', { inflight: { sourceKey: 'a.bin', uploadId: 'up', partSize: 1000 } });
    const j = await loadMoveJob('mv-1');
    assert.equal(j.inflight.uploadId, 'up');
    assert.equal(j.bucket, 'bkt', 'untouched fields survive');
  });

  test('updateMoveJob on an unknown id is a no-op, not a crash', async () => {
    await updateMoveJob('nope', { inflight: null });
    assert.equal(await loadMoveJob('nope'), null);
  });

  test('deleteMoveJob removes the job', async () => {
    await saveMoveJob(job());
    await deleteMoveJob('mv-1');
    assert.equal(await loadMoveJob('mv-1'), null);
  });
});
