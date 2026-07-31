// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-queue.js — the browser-managed download engine.
//
// This tier hands each file to the browser's own download manager. The app can observe
// that it *issued* a download; it cannot observe bytes, completion, or failure. Every
// test here is written against that limit rather than around it — the engine reports
// "issued", never "downloaded", and cancel means "stop issuing", not "stop transferring".
//
// Presign and issue are injected so the engine stays free of the SDK and the DOM, which
// is what makes all of this testable in plain Node.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runDownloadJob, jobOutcome } from '../src/lib/download-queue.js';
import {
  saveJob, loadJob, loadAllJobs, deleteJob,
  appendManifestPage, countItemsByStatus, ITEM_STATUS,
} from '../src/lib/download-records.js';

const job = (over = {}) => ({
  id: 'job-1', bucket: 'bkt', prefix: '', status: 'running',
  enumeration: { done: true }, counters: { total: 0, bytesTotal: 0 }, ...over,
});

const item = (key, over = {}) => ({
  key, size: 10, etag: `"${key}"`, localName: key, status: ITEM_STATUS.PENDING, ...over,
});

async function reset() {
  for (const j of await loadAllJobs()) await deleteJob(j.id);
}

function harness(over = {}) {
  const issued = [];
  return {
    issued,
    presign: async (key, filename) => `https://signed/${key}?as=${filename}`,
    issue:   async (url, filename) => { issued.push({ url, filename }); },
    wait:    async () => {},
    ...over,
  };
}

describe('runDownloadJob', () => {
  beforeEach(reset);

  test('issues every pending item', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b')], {});
    const h = harness();

    const result = await runDownloadJob(await loadJob('job-1'), h);

    assert.deepEqual(h.issued.map(i => i.filename).sort(), ['a', 'b']);
    assert.equal(result.issued, 2);
    assert.equal(result.cancelled, false);
  });

  test('marks issued items so a resume does not re-issue them', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b')], {});
    await runDownloadJob(await loadJob('job-1'), harness());

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 0);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.ISSUED), 2);

    const second = harness();
    const result = await runDownloadJob(await loadJob('job-1'), second);
    assert.equal(second.issued.length, 0);
    assert.equal(result.issued, 0);
  });

  test('passes the suggested local name to the browser', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('videos/2024/a.mp4', { localName: 'a.mp4' })], {});
    const h = harness();
    await runDownloadJob(await loadJob('job-1'), h);

    assert.equal(h.issued[0].filename, 'a.mp4');
    assert.equal(h.issued[0].url.includes('videos/2024/a.mp4'), true);
  });

  test('stops issuing when cancelled and says so', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b'), item('c')], {});
    const h = harness();
    const result = await runDownloadJob(await loadJob('job-1'), {
      ...h,
      shouldCancel: () => h.issued.length >= 1,
    });

    assert.equal(h.issued.length, 1);
    assert.equal(result.cancelled, true);
    // The remaining work is still pending, so resuming later picks it up.
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 2);
  });

  test('a presign failure fails only that item', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('bad'), item('c')], {});
    const h = harness({
      presign: async (key) => {
        if (key === 'bad') throw new Error('denied');
        return `https://signed/${key}`;
      },
    });

    const result = await runDownloadJob(await loadJob('job-1'), h);

    assert.equal(h.issued.length, 2);
    assert.equal(result.failed, 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.ISSUED), 2);
  });

  test('records why an item failed', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('bad')], {});
    const result = await runDownloadJob(await loadJob('job-1'), harness({
      presign: async () => { throw new Error('AccessDenied'); },
    }));

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].key, 'bad');
    assert.equal(result.errors[0].message.includes('AccessDenied'), true);
  });

  // BUG-021: a 15,000-row list froze Firefox. A million-item job must not accumulate a
  // million error objects either.
  test('caps retained errors', async () => {
    await saveJob(job());
    const many = Array.from({ length: 60 }, (_, i) => item(`k${i}`));
    await appendManifestPage('job-1', many, {});
    const result = await runDownloadJob(await loadJob('job-1'), harness({
      presign: async () => { throw new Error('nope'); },
    }), { maxErrors: 10 });

    assert.equal(result.failed, 60);
    assert.equal(result.errors.length, 10);
  });

  test('reports progress as it issues', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b')], {});
    const seen = [];
    await runDownloadJob(await loadJob('job-1'), harness({ onProgress: p => seen.push({ ...p }) }));

    assert.equal(seen.length, 2);
    assert.deepEqual(seen[seen.length - 1], { issued: 2, failed: 0, total: 2 });
  });

  test('paces issuing so the browser is not flooded', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a'), item('b')], {});
    const waits = [];
    await runDownloadJob(await loadJob('job-1'), harness({
      wait: async (ms) => { waits.push(ms); },
    }), { delayMs: 250 });

    assert.equal(waits.length, 2);
    assert.deepEqual(waits, [250, 250]);
  });

  test('does nothing for a job with no pending work', async () => {
    await saveJob(job());
    const h = harness();
    const result = await runDownloadJob(await loadJob('job-1'), h);
    assert.equal(h.issued.length, 0);
    assert.equal(result.issued, 0);
  });
});

// A manifest is only dead weight when every item succeeded. Deleting it after a run with
// failures loses the record of WHICH files failed, and re-running then re-enumerates and
// re-issues the whole job — the worst outcome precisely in the large-job case this feature
// exists for.
describe('jobOutcome', () => {
  test('a clean run has nothing worth keeping', () => {
    assert.deepEqual(jobOutcome({ cancelled: false, failed: 0 }), { keep: false });
  });

  test('a run with failures keeps its manifest so the failures can be retried', () => {
    assert.equal(jobOutcome({ cancelled: false, failed: 3 }).keep, true);
  });

  test('a cancelled run keeps its manifest so it can be resumed', () => {
    assert.equal(jobOutcome({ cancelled: true, failed: 0 }).keep, true);
  });
});
