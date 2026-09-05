// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-records.js — durable job and per-object state.
//
// The load-bearing test here is atomicity: a manifest page and the continuation token
// that follows it must be committed together. If they can diverge, a crash mid-enumeration
// either loses objects or re-lists ones already recorded, and enumeration stops being
// resumable — which is the whole point of the module.
//
// Requires fake-indexeddb. global.indexedDB must be set before importing any module that
// calls indexedDB.open(), because the connection is cached on first use.
// IDBKeyRange is a real global in the browser; fake-indexeddb exports it separately, so
// it has to be installed here too or every index/cursor query throws ReferenceError.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveJob, loadJob, loadAllJobs, deleteJob,
  appendManifestPage, updateItem, countItemsByStatus,
  eachItemByStatus, takeItemsByStatus, resetFailedToPending, ITEM_STATUS,
  jobMatchesOrigin,
} from '../src/lib/download-records.js';

const job = (over = {}) => ({
  id: 'job-1',
  bucket: 'bkt',
  prefix: 'videos/',
  status: 'enumerating',
  enumeration: { done: false, continuationToken: undefined },
  counters: { total: 0, bytesTotal: 0 },
  ...over,
});

const item = (key, over = {}) => ({ key, size: 10, etag: `"${key}"`, status: ITEM_STATUS.PENDING, ...over });

async function reset() {
  for (const j of await loadAllJobs()) await deleteJob(j.id);
}

describe('download-records', () => {
  beforeEach(reset);

  test('round-trips a job', async () => {
    await saveJob(job());
    const loaded = await loadJob('job-1');
    assert.equal(loaded.bucket, 'bkt');
    assert.equal(loaded.prefix, 'videos/');
  });

  test('returns null for an unknown job', async () => {
    assert.equal(await loadJob('nope'), null);
  });

  test('lists all jobs', async () => {
    await saveJob(job());
    await saveJob(job({ id: 'job-2' }));
    const all = await loadAllJobs();
    assert.deepEqual(all.map(j => j.id).sort(), ['job-1', 'job-2']);
  });

  test('appends a manifest page and advances the token together', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b')], { continuationToken: 't1' });

    const loaded = await loadJob('job-1');
    assert.equal(loaded.enumeration.continuationToken, 't1');
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 2);
  });

  test('accumulates counters across pages', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a', { size: 5 })], { continuationToken: 't1' });
    await appendManifestPage('job-1', [item('b', { size: 7 })], { continuationToken: undefined, done: true });

    const loaded = await loadJob('job-1');
    assert.equal(loaded.counters.total, 2);
    assert.equal(loaded.counters.bytesTotal, 12);
    assert.equal(loaded.enumeration.done, true);
  });

  // The atomicity proof: an item that cannot be structured-cloned aborts the transaction,
  // so neither the items nor the token may survive.
  test('CRASH-SAFETY: a failed page commits neither items nor token', async () => {
    await saveJob(job());
    const poison = { key: 'bad', status: ITEM_STATUS.PENDING, size: 1, boom: () => {} };

    await assert.rejects(() => appendManifestPage('job-1', [item('a'), poison], { continuationToken: 't1' }));

    const loaded = await loadJob('job-1');
    assert.equal(loaded.enumeration.continuationToken, undefined);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 0);
  });

  test('re-appending the same page is idempotent', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a')], { continuationToken: 't1' });
    await appendManifestPage('job-1', [item('a')], { continuationToken: 't1' });
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 1);
  });

  test('keeps identical keys in different jobs apart', async () => {
    await saveJob(job());
    await saveJob(job({ id: 'job-2' }));
    await appendManifestPage('job-1', [item('same')], {});
    await appendManifestPage('job-2', [item('same')], {});

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 1);
    assert.equal(await countItemsByStatus('job-2', ITEM_STATUS.PENDING), 1);
  });

  test('updates a single item', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b')], {});
    await updateItem('job-1', 'a', { status: ITEM_STATUS.DONE });

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.DONE), 1);
  });

  test('iterates by status with a cursor rather than loading everything', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b'), item('c')], {});
    await updateItem('job-1', 'b', { status: ITEM_STATUS.DONE });

    const seen = [];
    await eachItemByStatus('job-1', ITEM_STATUS.PENDING, it => { seen.push(it.key); });
    assert.deepEqual(seen.sort(), ['a', 'c']);
  });

  test('stops iterating when the callback returns false', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b'), item('c')], {});

    const seen = [];
    await eachItemByStatus('job-1', ITEM_STATUS.PENDING, it => { seen.push(it.key); return false; });
    assert.equal(seen.length, 1);
  });

  test('takes a bounded batch rather than the whole job', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b'), item('c')], {});

    const batch = await takeItemsByStatus('job-1', ITEM_STATUS.PENDING, 2);
    assert.equal(batch.length, 2);
  });

  test('take returns everything when the limit exceeds the count', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a')], {});
    assert.equal((await takeItemsByStatus('job-1', ITEM_STATUS.PENDING, 50)).length, 1);
  });

  test('deleting a job removes its items too', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b')], {});
    await deleteJob('job-1');

    assert.equal(await loadJob('job-1'), null);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 0);
  });
});

// Resuming must actually retry what failed. Items are left in FAILED so the run can report
// them, but a resume that only picks up PENDING would skip them forever.
describe('resetFailedToPending', () => {
  beforeEach(reset);   // sibling of the block above, so it needs its own isolation

  test('returns failed items to the queue and reports how many', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b'), item('c')], {});
    await updateItem('job-1', 'a', { status: ITEM_STATUS.FAILED, error: 'boom' });
    await updateItem('job-1', 'b', { status: ITEM_STATUS.ISSUED });

    assert.equal(await resetFailedToPending('job-1'), 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 2);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 0);
  });

  test('leaves items that already succeeded alone', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a')], {});
    await updateItem('job-1', 'a', { status: ITEM_STATUS.ISSUED });

    assert.equal(await resetFailedToPending('job-1'), 0);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.ISSUED), 1);
  });

  test('does not reach into another job', async () => {
    await saveJob(job());
    await saveJob(job({ id: 'job-2' }));
    await appendManifestPage('job-1', [item('a')], {});
    await appendManifestPage('job-2', [item('a')], {});
    await updateItem('job-2', 'a', { status: ITEM_STATUS.FAILED });

    assert.equal(await resetFailedToPending('job-1'), 0);
    assert.equal(await countItemsByStatus('job-2', ITEM_STATUS.FAILED), 1);
  });
});

// jobMatchesOrigin — a download job must belong to the FULL origin (bucket + provider +
// endpoint), mirroring the move-jobs credential-confusion guard. Bucket-name-only matching
// let two accounts that reuse a bucket name (backups/media/assets) cross-surface each
// other's download jobs. Pure function; no IndexedDB.
describe('download-records — jobMatchesOrigin', () => {
  const ORIGIN = { bucket: 'backups', provider: 'b2', endpoint: 'https://s3.us-west-002.backblazeb2.com' };

  test('matches a job with the identical full origin', () => {
    assert.equal(jobMatchesOrigin({ bucket: 'backups', provider: 'b2', endpoint: ORIGIN.endpoint }, ORIGIN), true);
  });

  test('rejects a same-bucket same-provider job from a different endpoint (credential confusion)', () => {
    const otherB2Account = { bucket: 'backups', provider: 'b2', endpoint: 'https://s3.eu-central-003.backblazeb2.com' };
    assert.equal(jobMatchesOrigin(otherB2Account, ORIGIN), false);
  });

  test('rejects a job for a different bucket', () => {
    assert.equal(jobMatchesOrigin({ bucket: 'photos', provider: 'b2', endpoint: ORIGIN.endpoint }, ORIGIN), false);
  });

  test('rejects a same-bucket job on a different provider', () => {
    assert.equal(jobMatchesOrigin({ bucket: 'backups', provider: 'aws', endpoint: 'https://s3.amazonaws.com' }, ORIGIN), false);
  });

  test('legacy job without an endpoint falls back to bucket + provider', () => {
    assert.equal(jobMatchesOrigin({ bucket: 'backups', provider: 'b2' }, ORIGIN), true);
    assert.equal(jobMatchesOrigin({ bucket: 'backups', provider: 'aws' }, ORIGIN), false);
  });

  test('very old job without endpoint or provider matches on bucket alone', () => {
    assert.equal(jobMatchesOrigin({ bucket: 'backups' }, ORIGIN), true);
    assert.equal(jobMatchesOrigin({ bucket: 'other' }, ORIGIN), false);
  });

  test('returns false for a null/absent job', () => {
    assert.equal(jobMatchesOrigin(null, ORIGIN), false);
    assert.equal(jobMatchesOrigin(undefined, ORIGIN), false);
  });
});
