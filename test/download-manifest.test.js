// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-manifest.js — checkpointed enumeration.
//
// Enumeration of a TB-scale prefix can itself take long enough to be interrupted, so it
// has to be resumable in its own right: every page is committed with the token that
// follows it, and a resumed run must not re-list what it already recorded.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateJob } from '../src/lib/download-manifest.js';
import {
  saveJob, loadJob, loadAllJobs, deleteJob,
  countItemsByStatus, eachItemByStatus, ITEM_STATUS,
} from '../src/lib/download-records.js';
import { NAMING_MODES } from '../src/lib/download-naming.js';

function mockClient(pages) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      calls.push({ ...cmd.input });
      const idx = pages.findIndex(p => (p.token ?? undefined) === cmd.input.ContinuationToken);
      const page = pages[idx === -1 ? 0 : idx];
      return { Contents: page.contents, IsTruncated: !!page.next, NextContinuationToken: page.next };
    },
  };
}

const obj = (Key, Size = 10) => ({ Key, Size, ETag: `"${Key}"`, LastModified: new Date(1700000000000) });

const job = (over = {}) => ({
  id: 'job-1', bucket: 'bkt', prefix: '', mode: NAMING_MODES.LEAF,
  status: 'enumerating', enumeration: {}, counters: { total: 0, bytesTotal: 0 }, ...over,
});

// Multi-prefix crawls need pages keyed by (Prefix, token), not token alone.
function mockClientByPrefix(byPrefix) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      calls.push({ ...cmd.input });
      const pages = byPrefix[cmd.input.Prefix ?? ''] || [{ contents: [] }];
      const idx = pages.findIndex(p => (p.token ?? undefined) === cmd.input.ContinuationToken);
      const page = pages[idx === -1 ? 0 : idx];
      return { Contents: page.contents, IsTruncated: !!page.next, NextContinuationToken: page.next };
    },
  };
}

const fRoot = (key, size = 10, storageClass = null) =>
  ({ type: 'file', key, size, etag: `"${key}"`, lastModified: 1700000000000, storageClass });
const pRoot = (prefix) => ({ type: 'prefix', prefix });

async function reset() {
  for (const j of await loadAllJobs()) await deleteJob(j.id);
}

async function keysOf(jobId, status = ITEM_STATUS.PENDING) {
  const out = [];
  await eachItemByStatus(jobId, status, it => { out.push(it.key); });
  return out.sort();
}

describe('enumerateJob', () => {
  beforeEach(reset);

  test('persists every object and marks enumeration done', async () => {
    await saveJob(job());
    const client = mockClient([{ token: undefined, contents: [obj('a'), obj('b')] }]);

    const result = await enumerateJob(client, await loadJob('job-1'), {});

    assert.deepEqual(await keysOf('job-1'), ['a', 'b']);
    assert.equal(result.done, true);
    assert.equal((await loadJob('job-1')).enumeration.done, true);
  });

  test('records size and etag for later verification', async () => {
    await saveJob(job());
    const client = mockClient([{ token: undefined, contents: [obj('a', 42)] }]);
    await enumerateJob(client, await loadJob('job-1'), {});

    let found;
    await eachItemByStatus('job-1', ITEM_STATUS.PENDING, it => { found = it; });
    assert.equal(found.size, 42);
    assert.equal(found.etag, '"a"');
    assert.equal(found.lastModified, 1700000000000);
  });

  // A zero-byte key ending in "/" is a folder marker, not a file anyone wants downloaded.
  test('skips directory markers', async () => {
    await saveJob(job());
    const client = mockClient([{ token: undefined, contents: [obj('videos/', 0), obj('videos/a.mp4')] }]);
    await enumerateJob(client, await loadJob('job-1'), {});

    assert.deepEqual(await keysOf('job-1'), ['videos/a.mp4']);
    assert.equal((await loadJob('job-1')).counters.total, 1);
  });

  test('assigns a local name per naming mode', async () => {
    await saveJob(job({ mode: NAMING_MODES.FLATTEN }));
    const client = mockClient([{ token: undefined, contents: [obj('videos/2024/a.mp4')] }]);
    await enumerateJob(client, await loadJob('job-1'), {});

    let found;
    await eachItemByStatus('job-1', ITEM_STATUS.PENDING, it => { found = it; });
    assert.equal(found.localName, 'videos__2024__a.mp4');
  });

  test('resumes from the stored token without re-listing', async () => {
    await saveJob(job({ enumeration: { continuationToken: 't1' } }));
    const client = mockClient([
      { token: undefined, contents: [obj('a')], next: 't1' },
      { token: 't1', contents: [obj('b')] },
    ]);
    await enumerateJob(client, await loadJob('job-1'), {});

    assert.deepEqual(await keysOf('job-1'), ['b']);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].ContinuationToken, 't1');
  });

  test('a cancelled enumeration leaves a resumable token and is not done', async () => {
    await saveJob(job());
    const client = mockClient([
      { token: undefined, contents: [obj('a')], next: 't1' },
      { token: 't1', contents: [obj('b')], next: 't2' },
      { token: 't2', contents: [obj('c')] },
    ]);

    let pages = 0;
    const result = await enumerateJob(client, await loadJob('job-1'), {
      onProgress: () => { pages += 1; },
      shouldCancel: () => pages >= 1,
    });

    assert.equal(result.cancelled, true);
    assert.equal(result.done, false);
    const stored = await loadJob('job-1');
    assert.equal(stored.enumeration.continuationToken, 't1');
    assert.equal(stored.enumeration.done, undefined);
    assert.deepEqual(await keysOf('job-1'), ['a']);
  });

  test('reports running totals as it goes', async () => {
    await saveJob(job());
    const client = mockClient([
      { token: undefined, contents: [obj('a', 5)], next: 't1' },
      { token: 't1', contents: [obj('b', 7)] },
    ]);

    const seen = [];
    await enumerateJob(client, await loadJob('job-1'), { onProgress: p => seen.push({ ...p }) });

    assert.equal(seen.length, 2);
    assert.deepEqual(seen[seen.length - 1], { objects: 2, bytes: 12 });
  });

  test('an empty prefix completes with nothing recorded', async () => {
    await saveJob(job());
    const client = mockClient([{ token: undefined, contents: [] }]);
    const result = await enumerateJob(client, await loadJob('job-1'), {});

    assert.equal(result.objects, 0);
    assert.equal(result.done, true);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.PENDING), 0);
  });

  test('a page of nothing but directory markers still advances the token', async () => {
    await saveJob(job());
    const client = mockClient([
      { token: undefined, contents: [obj('a/', 0)], next: 't1' },
      { token: 't1', contents: [obj('a/x.txt')] },
    ]);
    await enumerateJob(client, await loadJob('job-1'), {});

    assert.deepEqual(await keysOf('job-1'), ['a/x.txt']);
    assert.equal((await loadJob('job-1')).enumeration.done, true);
  });

  test('file roots enumerate with zero requests', async () => {
    await saveJob(job({ roots: [fRoot('a.txt', 5), fRoot('b.txt', 7)] }));
    const client = mockClient([{ token: undefined, contents: [] }]);
    const result = await enumerateJob(client, await loadJob('job-1'), {});
    assert.equal(client.calls.length, 0);
    assert.deepEqual(await keysOf('job-1'), ['a.txt', 'b.txt']);
    assert.equal(result.objects, 2);
    assert.equal(result.bytes, 12);
    assert.equal((await loadJob('job-1')).enumeration.done, true);
  });

  test('mixed roots: prefixes crawl, files append, counts accumulate across all', async () => {
    await saveJob(job({ roots: [pRoot('p/'), fRoot('loose.txt', 100)] }));
    const client = mockClientByPrefix({ 'p/': [{ token: undefined, contents: [obj('p/one', 10), obj('p/two', 20)] }] });
    const result = await enumerateJob(client, await loadJob('job-1'), {});
    assert.deepEqual(await keysOf('job-1'), ['loose.txt', 'p/one', 'p/two']);
    assert.equal(result.objects, 3);
    assert.equal(result.bytes, 130);
  });

  test('an archived file root is recorded SKIPPED, never PENDING', async () => {
    await saveJob(job({ provider: 'aws', roots: [fRoot('cold.bin', 50, 'GLACIER'), fRoot('warm.bin', 5)] }));
    const result = await enumerateJob(mockClient([{ token: undefined, contents: [] }]), await loadJob('job-1'), {});
    assert.deepEqual(await keysOf('job-1', ITEM_STATUS.SKIPPED), ['cold.bin']);
    assert.deepEqual(await keysOf('job-1'), ['warm.bin']);
    assert.equal(result.archived, 1);
    assert.equal(result.archivedBytes, 50);
  });

  test('resumes between roots: a completed root is never re-crawled', async () => {
    await saveJob(job({
      roots: [pRoot('done/'), pRoot('todo/')],
      enumeration: { rootIndex: 1 },   // checkpoint says done/ already committed
    }));
    const client = mockClientByPrefix({ 'todo/': [{ token: undefined, contents: [obj('todo/x')] }] });
    await enumerateJob(client, await loadJob('job-1'), {});
    assert.ok(client.calls.every(c => c.Prefix === 'todo/'), 'done/ must not be re-listed');
    assert.deepEqual(await keysOf('job-1'), ['todo/x']);
  });

  test('resumes mid-prefix within a root using the stored token', async () => {
    await saveJob(job({
      roots: [pRoot('p/')],
      enumeration: { rootIndex: 0, continuationToken: 't2' },
    }));
    const client = mockClientByPrefix({
      'p/': [
        { token: undefined, contents: [obj('p/page1')], next: 't2' },
        { token: 't2', contents: [obj('p/page2')] },
      ],
    });
    await enumerateJob(client, await loadJob('job-1'), {});
    assert.deepEqual(await keysOf('job-1'), ['p/page2']);
    assert.equal(client.calls[0].ContinuationToken, 't2');
  });

  test('a legacy prefix-only job still enumerates (read-path shim)', async () => {
    await saveJob(job({ prefix: 'old/' }));  // no roots field at all
    const client = mockClientByPrefix({ 'old/': [{ token: undefined, contents: [obj('old/a')] }] });
    const result = await enumerateJob(client, await loadJob('job-1'), {});
    assert.deepEqual(await keysOf('job-1'), ['old/a']);
    assert.equal(result.done, true);
  });

  test('done commits only with the final root', async () => {
    await saveJob(job({ roots: [fRoot('a.txt'), pRoot('p/')] }));
    const client = mockClientByPrefix({ 'p/': [{ token: undefined, contents: [obj('p/x')] }] });
    await enumerateJob(client, await loadJob('job-1'), {});
    const j = await loadJob('job-1');
    assert.equal(j.enumeration.done, true);
    assert.equal(j.enumeration.rootIndex, 2);
  });
});

// StorageClass rides along on every ListObjectsV2 entry, so archived objects are knowable
// at enumeration for free. They are marked SKIPPED rather than issued: a GET against
// GLACIER or DEEP_ARCHIVE fails until a restore completes, and this tier cannot observe
// that failure — it would report thousands of "issued" downloads that never arrive.
describe('enumerateJob — archived objects', () => {
  beforeEach(reset);

  const archived = (Key, StorageClass) => ({ ...obj(Key), StorageClass });
  // The provider is recorded on the job at creation; enumeration reads it from there.
  const seed = async (provider) => { await saveJob(job({ provider })); return loadJob('job-1'); };

  test('marks GLACIER and DEEP_ARCHIVE objects skipped on AWS, leaving the rest pending', async () => {
    const client = mockClient([{ contents: [
      archived('cold.bin', 'GLACIER'),
      archived('frozen.bin', 'DEEP_ARCHIVE'),
      archived('warm.bin', 'STANDARD'),
    ] }]);

    const result = await enumerateJob(client, await seed('aws'), {});

    assert.deepEqual(await keysOf('job-1', ITEM_STATUS.PENDING), ['warm.bin']);
    assert.deepEqual(await keysOf('job-1', ITEM_STATUS.SKIPPED), ['cold.bin', 'frozen.bin']);
    assert.equal(result.archived, 2, 'the count is what the panel warns with');
  });

  test('leaves GLACIER_IR pending: instant retrieval serves a GET normally', async () => {
    const client = mockClient([{ contents: [archived('ir.bin', 'GLACIER_IR')] }]);

    const result = await enumerateJob(client, await seed('aws'), {});

    assert.deepEqual(await keysOf('job-1', ITEM_STATUS.PENDING), ['ir.bin']);
    assert.equal(result.archived, 0);
  });

  test('flags nothing when the job has no recorded provider', async () => {
    const client = mockClient([{ contents: [archived('cold.bin', 'GLACIER')] }]);

    const result = await enumerateJob(client, await seed(undefined), {});

    assert.deepEqual(await keysOf('job-1', ITEM_STATUS.PENDING), ['cold.bin']);
    assert.equal(result.archived, 0);
  });

  test('flags nothing on a non-AWS provider', async () => {
    const client = mockClient([{ contents: [archived('cold.bin', 'GLACIER')] }]);

    const result = await enumerateJob(client, await seed('b2'), {});

    assert.deepEqual(await keysOf('job-1', ITEM_STATUS.PENDING), ['cold.bin']);
    assert.equal(result.archived, 0);
  });

  // Postmortem F5 / catalog defect 19 regression: archived items must not inflate what
  // the task row and offer promise. total/bytesTotal remain manifest truth (everything
  // enumerated); sendable/bytesSendable describe only what can actually be issued, and
  // both UI surfaces read the sendable pair.
  test('archived items are counted in the manifest totals but not the sendable counters', async () => {
    const client = mockClient([{ contents: [
      { ...archived('cold.bin', 'GLACIER'), Size: 100 },
      { ...archived('warm.bin', 'STANDARD'), Size: 7 },
    ] }]);

    const result = await enumerateJob(client, await seed('aws'), {});
    const j = await loadJob('job-1');

    assert.equal(j.counters.total, 2);
    assert.equal(j.counters.bytesTotal, 107);
    assert.equal(j.counters.sendable, 1, 'the task row must be able to say "Sent 1 of 1"');
    assert.equal(j.counters.bytesSendable, 7, 'the offer size must describe the sendable set');
    assert.equal(result.archivedBytes, 100, 'the enumeration result reports what was set aside');
  });
});
