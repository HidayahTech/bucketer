// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-verify.js — read-only folder verification.
//
// matchDownloads is the pure reference implementation of the verdict logic; verifyJob is
// the streaming implementation the browser uses (paged item walk, per-name folder
// lookups, no whole-job materialisation — BUG-021's rule). Both are covered here, and the
// postmortem regressions each carry their F/catalog number.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { collisionBase, matchDownloads, verifyJob } from '../src/lib/download-verify.js';
import {
  saveJob, loadJob, loadAllJobs, deleteJob, appendManifestPage,
  countItemsByStatus, ITEM_STATUS, JOB_STATUS,
} from '../src/lib/download-records.js';

const job = (over = {}) => ({
  id: 'job-1', bucket: 'bkt', prefix: '', status: JOB_STATUS.DONE,
  enumeration: { done: true }, counters: { total: 0, bytesTotal: 0 }, ...over,
});
const item = (key, size, over = {}) => ({
  key, size, etag: `"${key}"`, localName: key, status: ITEM_STATUS.ISSUED, ...over,
});

async function reset() {
  for (const j of await loadAllJobs()) await deleteJob(j.id);
}

// A synthetic FileSystemDirectoryHandle: only what verifyJob touches.
function fakeDir(files) {
  const byName = new Map(files.map((f) => [f.name, f.size]));
  return {
    values: async function* () {
      for (const [name, size] of byName) yield { kind: 'file', name, getFile: async () => ({ size }) };
    },
    getFileHandle: async (name) => {
      if (!byName.has(name)) { const e = new Error(name); e.name = 'NotFoundError'; throw e; }
      return { getFile: async () => ({ size: byName.get(name) }) };
    },
  };
}

describe('collisionBase', () => {
  test('strips the browser collision suffix before the extension', () => {
    assert.equal(collisionBase('a (1).txt'), 'a.txt');
    assert.equal(collisionBase('noext (2)'), 'noext');
  });

  test('a suffix buried before a double extension is not the collision shape', () => {
    // Chromium appends " (n)" directly before the FINAL extension; anything else is the
    // file's own name.
    assert.equal(collisionBase('report (12).tar.gz'), 'report (12).tar.gz');
  });

  test('returns non-matching names unchanged', () => {
    assert.equal(collisionBase('a.txt'), 'a.txt');
    assert.equal(collisionBase('parens (in) middle.txt'), 'parens (in) middle.txt');
  });
});

describe('matchDownloads — the verdict logic', () => {
  const items = [
    { key: 'k/ok.bin', localName: 'ok.bin', size: 10 },
    { key: 'k/short.bin', localName: 'short.bin', size: 10 },
    { key: 'k/gone.bin', localName: 'gone.bin', size: 10 },
  ];

  test('name and size both matching is the only path to confirmed', () => {
    const out = matchDownloads(items, new Map([['ok.bin', 10], ['short.bin', 7]]));
    assert.deepEqual(out.confirmed, ['k/ok.bin']);
    assert.deepEqual(out.mismatched, [{ key: 'k/short.bin', expected: 10, actual: 7 }]);
    assert.deepEqual(out.missing, ['k/gone.bin']);
  });

  test('two items claiming one local name are ambiguous, never confirmed', () => {
    const dupes = [
      { key: 'a/x.txt', localName: 'x.txt', size: 5 },
      { key: 'b/x.txt', localName: 'x.txt', size: 5 },
    ];
    const out = matchDownloads(dupes, new Map([['x.txt', 5]]));
    assert.deepEqual(out.ambiguous.sort(), ['a/x.txt', 'b/x.txt']);
    assert.equal(out.confirmed.length, 0);
  });

  test('a collision-renamed variant of the right size reads as probably arrived', () => {
    const out = matchDownloads(
      [{ key: 'k/a.txt', localName: 'a.txt', size: 9 }],
      new Map([['a (1).txt', 9]]),
    );
    assert.deepEqual(out.renamed, ['k/a.txt']);
    assert.equal(out.missing.length, 0);
  });

  // Catalog defect 20 regression: the user's own unrelated "report (1).pdf" must not
  // silence a genuinely missing report.pdf. The size gate is what tells them apart.
  test('a collision-suffixed file of the WRONG size does not suppress a missing verdict', () => {
    const out = matchDownloads(
      [{ key: 'k/report.pdf', localName: 'report.pdf', size: 1000 }],
      new Map([['report (1).pdf', 555]]),
    );
    assert.deepEqual(out.missing, ['k/report.pdf']);
    assert.equal(out.renamed.length, 0);
  });
});

describe('verifyJob — streaming verification with durable outcomes', () => {
  beforeEach(reset);

  test('promotes confirmed items to DONE and fails missing and wrong-size items', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a.txt', 5), item('b.txt', 5), item('c.txt', 5)], {});

    const counts = await verifyJob('job-1', fakeDir([
      { name: 'a.txt', size: 5 },      // confirmed
      { name: 'b.txt', size: 999 },    // wrong size
      /* c.txt absent */
    ]));

    assert.deepEqual(counts, { confirmed: 1, missing: 1, mismatched: 1, ambiguous: 0, renamed: 0 });
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.DONE), 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 2);
  });

  // Postmortem F3 regression — the stranded-job defect. Failures found by verification
  // must be reachable by the resume path, which only lists non-DONE jobs; the old code
  // left the job DONE and both lists excluded it forever.
  test('a DONE job that gains failures is demoted to PAUSED so a resume can reach it', async () => {
    await saveJob(job({ status: JOB_STATUS.DONE }));
    await appendManifestPage('job-1', [item('a.txt', 5), item('gone.txt', 5)], {});

    await verifyJob('job-1', fakeDir([{ name: 'a.txt', size: 5 }]));

    const j = await loadJob('job-1');
    assert.equal(j.status, JOB_STATUS.PAUSED, 'failures are only retryable from a listed job');
    assert.ok(j.verifiedAt, 'the check is recorded');
    assert.equal(j.lastVerify.missing, 1, 'the summary survives the panel closing');
  });

  test('a clean verification leaves a DONE job DONE and records the summary', async () => {
    await saveJob(job({ status: JOB_STATUS.DONE }));
    await appendManifestPage('job-1', [item('a.txt', 5)], {});

    await verifyJob('job-1', fakeDir([{ name: 'a.txt', size: 5 }]));

    const j = await loadJob('job-1');
    assert.equal(j.status, JOB_STATUS.DONE);
    assert.equal(j.lastVerify.confirmed, 1);
  });

  // Catalog defect 37 regression: verifiedAt must not gate anything — a second check must
  // still examine what the first left unresolved.
  test('a job can be verified again after a first verification', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a.txt', 5), item('late.txt', 5)], {});

    const first = await verifyJob('job-1', fakeDir([{ name: 'a.txt', size: 5 }]));
    assert.equal(first.missing, 1);

    // The user resumes; the failed item is re-issued out-of-band — simulate by putting it
    // back to ISSUED, then the file appears on disk and a second check confirms it.
    const { updateItem } = await import('../src/lib/download-records.js');
    await updateItem('job-1', 'late.txt', { status: ITEM_STATUS.ISSUED, error: undefined });
    const second = await verifyJob('job-1', fakeDir([
      { name: 'a.txt', size: 5 }, { name: 'late.txt', size: 5 },
    ]));

    assert.equal(second.confirmed, 1, 'the re-issued file is confirmable on the second pass');
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.DONE), 2);
  });

  test('ambiguous and renamed items stay ISSUED and are never downgraded', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [
      item('a/x.txt', 5, { localName: 'x.txt' }),
      item('b/x.txt', 5, { localName: 'x.txt' }),
      item('r.txt', 9),
    ], {});

    const counts = await verifyJob('job-1', fakeDir([
      { name: 'x.txt', size: 5 },
      { name: 'r (1).txt', size: 9 },   // right-size collision variant of r.txt
    ]));

    assert.equal(counts.ambiguous, 2);
    assert.equal(counts.renamed, 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.ISSUED), 3,
      'unknown is not absent: nothing here may be failed or confirmed');
  });

  test('SKIPPED (archived) items are never examined or altered', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [
      item('warm.bin', 5),
      item('cold.bin', 5, { status: ITEM_STATUS.SKIPPED, skipReason: 'archived' }),
    ], {});

    const counts = await verifyJob('job-1', fakeDir([{ name: 'warm.bin', size: 5 }]));

    assert.equal(counts.confirmed, 1);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.SKIPPED), 1);
  });

  // BUG-021's rule, behaviorally: a job larger than the page size verifies correctly,
  // including the status updates the walk itself performs — the paging must be immune to
  // items leaving ISSUED mid-walk (the by-status cursor shape would loop or skip).
  test('a job spanning multiple pages verifies every item exactly once', async () => {
    await saveJob(job());
    const many = Array.from({ length: 1200 }, (_, i) => item(`f${String(i).padStart(4, '0')}.bin`, 8));
    await appendManifestPage('job-1', many, {});
    const onDisk = many.slice(0, 900).map((it) => ({ name: it.localName, size: 8 }));

    const counts = await verifyJob('job-1', fakeDir(onDisk));

    assert.equal(counts.confirmed, 900);
    assert.equal(counts.missing, 300);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.DONE), 900);
    assert.equal(await countItemsByStatus('job-1', ITEM_STATUS.FAILED), 300);
  });

  test('an unreadable directory entry is treated as absent, not fatal', async () => {
    await saveJob(job());
    await appendManifestPage('job-1', [item('a.txt', 5)], {});
    const dir = fakeDir([{ name: 'a.txt', size: 5 }]);
    dir.getFileHandle = async () => { throw new DOMException('denied', 'NotAllowedError'); };

    const counts = await verifyJob('job-1', dir);

    assert.equal(counts.missing, 1, 'one bad entry must not abort the verification');
  });
});
