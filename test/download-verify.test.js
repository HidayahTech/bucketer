// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-verify.js — read-only confirmation of what actually arrived.
//
// The browser-managed tier can only observe that it ISSUED a download; it never learns
// whether the file arrived. Reading the destination folder afterwards is the only way to
// promote ISSUED to DONE, and it costs no requests at all. What it must never do is claim
// more than it knows — a name on disk is not proof that OUR file is the one there.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { matchDownloads, readFolder, verifyJob, VERIFY } from '../src/lib/download-verify.js';
import {
  saveJob, loadJob, loadAllJobs, deleteJob, appendManifestPage,
  countItemsByStatus, ITEM_STATUS,
} from '../src/lib/download-records.js';

async function reset() {
  for (const j of await loadAllJobs()) await deleteJob(j.id);
}

const item = (key, localName, size) => ({ key, localName, size });
const onDisk = (pairs) => new Map(pairs);

describe('matchDownloads', () => {
  test('confirms a file whose name and size both match', () => {
    const r = matchDownloads([item('a.txt', 'a.txt', 10)], onDisk([['a.txt', 10]]));
    assert.deepEqual(r.confirmed, ['a.txt']);
    assert.deepEqual(r.missing, []);
  });

  test('reports a file absent from the folder as missing', () => {
    const r = matchDownloads([item('a.txt', 'a.txt', 10)], onDisk([]));
    assert.deepEqual(r.missing, ['a.txt']);
    assert.deepEqual(r.confirmed, []);
  });

  // A truncated or interrupted download leaves a file of the right name and the wrong size.
  // Calling that DONE would be the exact lie this feature exists to prevent.
  test('does not confirm a name match whose size is wrong', () => {
    const r = matchDownloads([item('a.txt', 'a.txt', 10)], onDisk([['a.txt', 3]]));
    assert.deepEqual(r.confirmed, []);
    assert.equal(r.mismatched.length, 1);
    assert.deepEqual(r.mismatched[0], { key: 'a.txt', expected: 10, actual: 3 });
  });

  // Flatten mode can map two different keys onto the same local name. One file on disk
  // cannot confirm two downloads, and there is no way to tell which one it is.
  test('confirms neither of two items sharing a local name', () => {
    const r = matchDownloads(
      [item('x/a.txt', 'a.txt', 10), item('y/a.txt', 'a.txt', 10)],
      onDisk([['a.txt', 10]]),
    );
    assert.deepEqual(r.confirmed, []);
    assert.deepEqual(r.ambiguous.sort(), ['x/a.txt', 'y/a.txt']);
  });

  test('an ambiguous name is not also reported missing', () => {
    const r = matchDownloads(
      [item('x/a.txt', 'a.txt', 10), item('y/a.txt', 'a.txt', 10)],
      onDisk([]),
    );
    assert.deepEqual(r.missing, [], 'unknowable is not the same as absent');
    assert.equal(r.ambiguous.length, 2);
  });

  test('handles a mixed folder without confusing the categories', () => {
    const r = matchDownloads(
      [item('a', 'a.txt', 10), item('b', 'b.txt', 20), item('c', 'c.txt', 30)],
      onDisk([['a.txt', 10], ['b.txt', 999]]),
    );
    assert.deepEqual(r.confirmed, ['a']);
    assert.deepEqual(r.mismatched.map(m => m.key), ['b']);
    assert.deepEqual(r.missing, ['c']);
  });

  // The browser renames collisions itself ("a.txt" -> "a (1).txt") and never tells the page.
  // Such a file probably did arrive, but under a name we cannot attribute — reporting it as
  // plainly missing would send the user hunting for a file that is sitting right there.
  test('notes a probable collision rename rather than calling it missing', () => {
    const r = matchDownloads([item('a', 'a.txt', 10)], onDisk([['a (1).txt', 10]]));
    assert.deepEqual(r.confirmed, [], 'a renamed file cannot be attributed with certainty');
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.renamed, ['a']);
  });

  test('an empty job verifies as empty rather than failing', () => {
    const r = matchDownloads([], onDisk([['stray.txt', 1]]));
    assert.deepEqual(r, { confirmed: [], missing: [], mismatched: [], ambiguous: [], renamed: [] });
  });

  test('extra files in the folder are ignored, not reported', () => {
    const r = matchDownloads([item('a', 'a.txt', 10)], onDisk([['a.txt', 10], ['unrelated.txt', 5]]));
    assert.deepEqual(r.confirmed, ['a']);
  });
});

describe('VERIFY', () => {
  test('exposes the outcome names the UI renders', () => {
    assert.deepEqual(
      Object.keys(VERIFY).sort(),
      ['AMBIGUOUS', 'CONFIRMED', 'MISMATCHED', 'MISSING', 'RENAMED'],
    );
  });
});

// The folder read is kept separate from the matching so the matcher stays pure. A fake
// handle exercises it in plain Node — the real one comes from showDirectoryPicker().
describe('readFolder', () => {
  const fakeDir = (entries) => ({
    async *values() {
      for (const [name, e] of entries) yield e.dir
        ? { kind: 'directory', name }
        : { kind: 'file', name, getFile: async () => ({ size: e.size }) };
    },
  });

  test('reads name and size for every file', async () => {
    const map = await readFolder(fakeDir([['a.txt', { size: 10 }], ['b.bin', { size: 20 }]]));
    assert.deepEqual([...map.entries()].sort(), [['a.txt', 10], ['b.bin', 20]]);
  });

  // The handoff tier writes a flat list into one folder; descending would be slow on a
  // Downloads directory full of unrelated subfolders and would confirm nothing extra.
  test('ignores subdirectories rather than descending into them', async () => {
    const map = await readFolder(fakeDir([['a.txt', { size: 1 }], ['nested', { dir: true }]]));
    assert.deepEqual([...map.keys()], ['a.txt']);
  });

  test('an unreadable file is skipped rather than failing the whole verification', async () => {
    const dir = {
      async *values() {
        yield { kind: 'file', name: 'ok.txt', getFile: async () => ({ size: 5 }) };
        yield { kind: 'file', name: 'locked.txt', getFile: async () => { throw new Error('denied'); } };
      },
    };
    const map = await readFolder(dir);
    assert.deepEqual([...map.keys()], ['ok.txt'], 'one bad entry must not lose the whole read');
  });

  test('an empty folder reads as an empty map', async () => {
    assert.equal((await readFolder(fakeDir([]))).size, 0);
  });
});

// verifyJob turns a folder reading into durable status changes. What it marks FAILED is
// what a resume will retry, so it must only mark things it actually knows about: a name it
// cannot attribute is left alone rather than re-downloaded.
describe('verifyJob', () => {
  beforeEach(reset);

  const seed = async (items) => {
    await saveJob({ id: 'job-1', bucket: 'b', prefix: '', counters: { total: 0, bytesTotal: 0 }, enumeration: {} });
    await appendManifestPage('job-1', items.map(i => ({ ...i, status: ITEM_STATUS.ISSUED })), {});
  };

  test('promotes a confirmed file to done', async () => {
    await seed([{ key: 'a', localName: 'a.txt', size: 10 }]);

    const r = await verifyJob('job-1', new Map([['a.txt', 10]]));

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.DONE), 1);
    assert.equal(r.confirmed, 1);
  });

  test('marks a file absent from the folder failed so a resume retries it', async () => {
    await seed([{ key: 'a', localName: 'a.txt', size: 10 }]);

    await verifyJob('job-1', new Map());

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.DONE), 0);
  });

  test('marks a wrong-sized file failed: a truncated download is not a download', async () => {
    await seed([{ key: 'a', localName: 'a.txt', size: 10 }]);

    await verifyJob('job-1', new Map([['a.txt', 3]]));

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 1);
  });

  // Re-downloading a file that is probably already on disk under a browser-assigned name
  // wastes egress the user pays for. "Cannot tell" must not become "retry".
  test('leaves a collision-renamed file alone rather than retrying it', async () => {
    await seed([{ key: 'a', localName: 'a.txt', size: 10 }]);

    const r = await verifyJob('job-1', new Map([['a (1).txt', 10]]));

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 0);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.ISSUED), 1);
    assert.equal(r.renamed, 1);
  });

  test('leaves an ambiguous name alone rather than retrying it', async () => {
    await seed([
      { key: 'x/a', localName: 'a.txt', size: 10 },
      { key: 'y/a', localName: 'a.txt', size: 10 },
    ]);

    const r = await verifyJob('job-1', new Map([['a.txt', 10]]));

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 0);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.ISSUED), 2);
    assert.equal(r.ambiguous, 2);
  });

  test('records when the job was verified so it is not offered forever', async () => {
    await seed([{ key: 'a', localName: 'a.txt', size: 10 }]);

    await verifyJob('job-1', new Map([['a.txt', 10]]));

    assert.equal(typeof (await loadJob('job-1')).verifiedAt, 'number');
  });

  // Items already DONE from an earlier verification must not be re-examined and downgraded.
  test('only examines items still marked issued', async () => {
    await seed([{ key: 'a', localName: 'a.txt', size: 10 }]);
    await verifyJob('job-1', new Map([['a.txt', 10]]));

    const second = await verifyJob('job-1', new Map());

    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.DONE), 1, 'a done item stays done');
    assert.equal(second.confirmed, 0);
  });
});
