// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-job.js's orchestration layer — runZipJob, openZipStaging,
// discardZipStaging.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md, Section 1.
//
// This drives runZipJob against a fake OPFS root (below — the model for what the real
// code needs from OPFS: getFileHandle/removeEntry, createWritable/getFile) and a
// deterministic fetch fake, and reads the result back with the shared mini ZIP reader
// (test/helpers/zip-reader.js) as an independent witness — the same reader zip-writer.test.js
// uses to check createZipWriter directly.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openZipStaging, discardZipStaging, runZipJob, zipEntryPath } from '../src/lib/zip-job.js';
import {
  saveJob, loadJob, loadAllJobs, deleteJob, appendManifestPage,
  countItemsByStatus, eachItemByStatus, resetFailedToPending, ITEM_STATUS,
} from '../src/lib/download-records.js';
import { readZip } from './helpers/zip-reader.js';

// Fake OPFS directory: enough surface for openZipStaging — getFileHandle(name,
// {create}), removeEntry(name); file handles expose createWritable({keepExistingData})
// and getFile(). Backed by a Uint8Array per file.
function fakeOpfsRoot() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
        files.set(name, new Uint8Array(0));
      }
      return {
        async createWritable({ keepExistingData = false } = {}) {
          let buf = keepExistingData ? Uint8Array.from(files.get(name)) : new Uint8Array(0);
          let pos = buf.length;
          return {
            async write(u8) {
              const grown = new Uint8Array(Math.max(buf.length, pos + u8.length));
              grown.set(buf); grown.set(u8, pos); buf = grown; pos += u8.length;
            },
            async truncate(n) { buf = buf.slice(0, n); pos = Math.min(pos, n); },
            async seek(n) { pos = n; },
            async close() { files.set(name, buf); },
          };
        },
        async getFile() { const b = files.get(name); return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
}

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);

const job = (over = {}) => ({
  id: 'zjob-1', bucket: 'bkt', prefix: 'videos/', status: 'running',
  enumeration: { done: true }, counters: { total: 0, bytesTotal: 0 }, ...over,
});

const item = (key, body, over = {}) => ({
  key, size: enc(body).length, etag: `"${key}"`, localName: key.split('/').pop(),
  lastModified: 1700000000000, status: ITEM_STATUS.PENDING, ...over,
});

async function reset() {
  for (const j of await loadAllJobs()) await deleteJob(j.id);
}

// A ReadableStream-shaped body: getReader().read() yields `chunks` in order, then EOF.
// A chunk that is an Error instance is thrown instead of yielded — models a stream that
// dies mid-body.
function fakeBody(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const c = chunks[i++];
          if (c instanceof Error) throw c;
          return { done: false, value: c };
        },
      };
    },
  };
}

// Deterministic fetch fake: bodies keyed by the S3 key embedded in the presigned URL.
// `attempts` lets a per-key body plan change between the first and later fetches of the
// same key (test 3: item 2 dies on its first attempt, succeeds on retry).
function fetchFake(bodyPlans) {
  const attempts = {};
  const calls = [];
  const fn = async (url) => {
    const key = new URL(url).searchParams.get('key');
    calls.push(key);
    attempts[key] = (attempts[key] ?? 0) + 1;
    const plans = bodyPlans[key];
    const plan = Array.isArray(plans[0]) || plans[0] instanceof Error ? plans : [plans];
    // plan is an array of "attempts"; each attempt is an array of chunks (Uint8Array or Error).
    const chunks = plan[Math.min(attempts[key] - 1, plan.length - 1)];
    return { ok: true, status: 200, body: fakeBody(chunks) };
  };
  fn.calls = calls;
  return fn;
}

const presign = async (key) => `https://signed/x?key=${encodeURIComponent(key)}`;

async function statusesOf(jobId) {
  const out = {};
  for (const s of Object.values(ITEM_STATUS)) out[s] = await countItemsByStatus(jobId, s);
  return out;
}

describe('runZipJob', () => {
  beforeEach(reset);

  test('1. a clean 3-item run produces a valid, complete zip and truthful DONE records', async () => {
    await saveJob(job());
    await appendManifestPage('zjob-1', [
      item('videos/a.txt', 'alpha'),
      item('videos/b.txt', 'bravo-body'),
      item('videos/c.txt', 'charlie!!'),
    ], {});

    const root = fakeOpfsRoot();
    const fetchImpl = fetchFake({
      'videos/a.txt': [[enc('alpha')]],
      'videos/b.txt': [[enc('bravo-body')]],
      'videos/c.txt': [[enc('charlie!!')]],
    });
    const progress = [];
    const result = await runZipJob(await loadJob('zjob-1'), {
      presign, fetchImpl, root, onProgress: (p) => progress.push({ ...p }),
    });

    assert.equal(result.finished, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.blocked, null);

    const statuses = await statusesOf('zjob-1');
    assert.equal(statuses[ITEM_STATUS.DONE], 3);
    assert.equal(statuses[ITEM_STATUS.PENDING], 0);
    assert.equal(statuses[ITEM_STATUS.FAILED], 0);
    assert.equal(statuses[ITEM_STATUS.ISSUED], 0, 'no item may be left at the engine\'s interim ISSUED status');

    const staging = await root.getFileHandle('bucketer-zip-zjob-1.zip');
    const file = await staging.getFile();
    const entries = readZip(new Uint8Array(await file.arrayBuffer()));
    assert.deepEqual(entries.map(e => e.name).sort(), ['a.txt', 'b.txt', 'c.txt']);
    const byName = Object.fromEntries(entries.map(e => [e.name, e]));
    assert.equal(dec(byName['a.txt'].data), 'alpha');
    assert.equal(dec(byName['b.txt'].data), 'bravo-body');
    assert.equal(dec(byName['c.txt'].data), 'charlie!!');

    assert.ok(progress.length > 0, 'onProgress must have been called');
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i].bytesDone >= progress[i - 1].bytesDone, 'bytesDone must never regress');
    }
    const total = enc('alpha').length + enc('bravo-body').length + enc('charlie!!').length;
    assert.equal(progress[progress.length - 1].bytesDone, total);
  });

  test('2. interrupting after item 1 leaves a resumable partial zip; the second run finishes it', async () => {
    await saveJob(job());
    await appendManifestPage('zjob-1', [
      item('videos/a.txt', 'alpha'),
      item('videos/b.txt', 'bravo-body'),
      item('videos/c.txt', 'charlie!!'),
    ], {});

    const root = fakeOpfsRoot();
    const fetchImpl = fetchFake({
      'videos/a.txt': [[enc('alpha')]],
      'videos/b.txt': [[enc('bravo-body')]],
      'videos/c.txt': [[enc('charlie!!')]],
    });

    let doneCount = 0;
    const result1 = await runZipJob(await loadJob('zjob-1'), {
      presign, fetchImpl, root,
      shouldCancel: () => doneCount >= 1,
      onProgress: (p) => { doneCount = p.done; },
    });

    assert.equal(result1.cancelled, true);
    assert.equal(result1.finished, false);
    const mid = await statusesOf('zjob-1');
    assert.equal(mid[ITEM_STATUS.DONE], 1);
    assert.equal(mid[ITEM_STATUS.PENDING], 2);

    let doneItem;
    await eachItemByStatus('zjob-1', ITEM_STATUS.DONE, (it) => { doneItem = it; });
    const staging = await root.getFileHandle('bucketer-zip-zjob-1.zip');
    assert.equal((await staging.getFile()).size, doneItem.zipEnd, 'run 1 committed exactly its one entry');

    // Second run: must truncate down to (in this case, stay at) the resume point before
    // growing again — assert the pre-resume size matches doneItem.zipEnd, i.e. nothing
    // beyond the last good entry survives into the resumed run.
    const result2 = await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root });
    assert.equal(result2.finished, true);

    const final = await statusesOf('zjob-1');
    assert.equal(final[ITEM_STATUS.DONE], 3);

    const file = await staging.getFile();
    const entries = readZip(new Uint8Array(await file.arrayBuffer()));
    assert.deepEqual(entries.map(e => e.name).sort(), ['a.txt', 'b.txt', 'c.txt']);
  });

  test('3. a mid-body fetch failure fails only that item and recovers the writer for the next entry', async () => {
    await saveJob(job());
    await appendManifestPage('zjob-1', [
      item('videos/a.txt', 'alpha'),
      item('videos/b.txt', 'bravo-body'),
      item('videos/c.txt', 'charlie!!'),
    ], {});

    const root = fakeOpfsRoot();
    const fetchImpl = fetchFake({
      'videos/a.txt': [[enc('alpha')]],
      // First attempt: one good chunk, then the stream dies. Second attempt (after
      // resetFailedToPending): succeeds cleanly.
      'videos/b.txt': [
        [enc('brav'), new Error('stream reset')],
        [enc('bravo-body')],
      ],
      'videos/c.txt': [[enc('charlie!!')]],
    });

    const result1 = await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root });
    assert.equal(result1.finished, false);
    assert.equal(result1.failed, 1);

    const afterRun1 = await statusesOf('zjob-1');
    assert.equal(afterRun1[ITEM_STATUS.DONE], 2);
    assert.equal(afterRun1[ITEM_STATUS.FAILED], 1);
    let failedItem;
    await eachItemByStatus('zjob-1', ITEM_STATUS.FAILED, (it) => { failedItem = it; });
    assert.equal(failedItem.key, 'videos/b.txt');
    assert.ok(failedItem.error, 'the failure reason must be recorded');

    // The writer must not be left wedged: the staging file must parse as a container
    // holding exactly the two successful entries so far (no dangling partial entry).
    const staging = await root.getFileHandle('bucketer-zip-zjob-1.zip');
    const midFile = await staging.getFile();
    // Not yet finished (no central directory), but the partial 'b' bytes must be gone:
    // reconstruct what a fresh writer would need by checking size == max(DONE zipEnd).
    let maxEnd = 0;
    await eachItemByStatus('zjob-1', ITEM_STATUS.DONE, (it) => { maxEnd = Math.max(maxEnd, it.zipEnd); });
    assert.equal(midFile.size, maxEnd, 'a failed entry must not leave a partial tail after it');

    const reset1 = await resetFailedToPending('zjob-1');
    assert.equal(reset1, 1);

    const result2 = await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root });
    assert.equal(result2.finished, true);

    const finalStatuses = await statusesOf('zjob-1');
    assert.equal(finalStatuses[ITEM_STATUS.DONE], 3);
    assert.equal(finalStatuses[ITEM_STATUS.FAILED], 0);

    const file = await staging.getFile();
    const entries = readZip(new Uint8Array(await file.arrayBuffer()));
    assert.deepEqual(entries.map(e => e.name).sort(), ['a.txt', 'b.txt', 'c.txt']);
    const byName = Object.fromEntries(entries.map(e => [e.name, e]));
    // The central directory is built in key order (a, b, c) regardless of physical
    // layout — zip-writer's finish() accepts records out of order by design. Physical
    // placement (each entry's local header offset, `lho`) is what actually proves the
    // recovery path: c occupies the space b's failed first attempt vacated (run 1), and
    // b — retried in run 2 — lands after everything already committed to disk.
    assert.ok(byName['a.txt'].lho < byName['c.txt'].lho, 'c must reuse the offset b\'s failed attempt was truncated back from');
    assert.ok(byName['c.txt'].lho < byName['b.txt'].lho, 'the retried b must be appended after everything already on disk');
    assert.equal(dec(byName['b.txt'].data), 'bravo-body');
  });

  test('4. staging vanishing between runs resets every recorded DONE item back to PENDING', async () => {
    await saveJob(job());
    await appendManifestPage('zjob-1', [
      item('videos/a.txt', 'alpha'),
      item('videos/b.txt', 'bravo-body'),
      item('videos/c.txt', 'charlie!!'),
    ], {});

    const root = fakeOpfsRoot();
    const fetchImpl = fetchFake({
      'videos/a.txt': [[enc('alpha')]],
      'videos/b.txt': [[enc('bravo-body')]],
      'videos/c.txt': [[enc('charlie!!')]],
    });

    let doneCount = 0;
    await runZipJob(await loadJob('zjob-1'), {
      presign, fetchImpl, root,
      shouldCancel: () => doneCount >= 2,
      onProgress: (p) => { doneCount = p.done; },
    });
    const afterRun1 = await statusesOf('zjob-1');
    assert.equal(afterRun1[ITEM_STATUS.DONE], 2);

    await root.removeEntry('bucketer-zip-zjob-1.zip');

    const result2 = await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root });

    assert.equal(result2.finished, true);

    const finalStatuses = await statusesOf('zjob-1');
    assert.equal(finalStatuses[ITEM_STATUS.DONE], 3);
    assert.equal(finalStatuses[ITEM_STATUS.PENDING], 0);

    // The reset is proved two ways: every item reached DONE again (not just item c, the
    // one that was never touched in run 1), and — decisively — the archive parses at all.
    // If the stale DONE records for a/b had been trusted instead of reset, run 2 would
    // have resumed onto a file the OPFS layer had just recreated as empty, appended item
    // c's bytes at a nonzero offset, and left a zero-filled gap where a/b's entries used
    // to be; readZip's CRC/offset checks below would fail on that corruption.
    const staging = await root.getFileHandle('bucketer-zip-zjob-1.zip');
    const file = await staging.getFile();
    const entries = readZip(new Uint8Array(await file.arrayBuffer()));
    assert.deepEqual(entries.map(e => e.name).sort(), ['a.txt', 'b.txt', 'c.txt']);
    const byName = Object.fromEntries(entries.map(e => [e.name, e]));
    assert.equal(dec(byName['a.txt'].data), 'alpha');
    assert.equal(dec(byName['b.txt'].data), 'bravo-body');
    assert.equal(dec(byName['c.txt'].data), 'charlie!!');
  });

  test('5. a DENIED streak trips the shared 3-consecutive-denial breaker through the injected probe', async () => {
    await saveJob(job());
    await appendManifestPage('zjob-1', [
      item('videos/a.txt', 'alpha'),
      item('videos/b.txt', 'bravo-body'),
      item('videos/c.txt', 'charlie!!'),
    ], {});

    const root = fakeOpfsRoot();
    const fetchImpl = fetchFake({
      'videos/a.txt': [[enc('alpha')]],
      'videos/b.txt': [[enc('bravo-body')]],
      'videos/c.txt': [[enc('charlie!!')]],
    });
    const probe = async () => ({ kind: 'denied', message: 'access denied' });

    const result = await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root, probe });

    assert.notEqual(result.blocked, null);
    assert.equal(result.finished, false);
  });

  test('6. discardZipStaging removes the staging file', async () => {
    const root = fakeOpfsRoot();
    await openZipStaging('zjob-1', { root });
    assert.ok(root.files.has('bucketer-zip-zjob-1.zip'));

    await discardZipStaging('zjob-1', { root });
    assert.ok(!root.files.has('bucketer-zip-zjob-1.zip'));

    // Best-effort: discarding an already-absent file must not throw.
    await discardZipStaging('zjob-1', { root });
  });
});

// Sanity: the entry paths produced during a run are exactly what zipEntryPath computes
// for the job's captured prefix, proving runZipJob doesn't invent its own naming.
describe('runZipJob — entry naming', () => {
  beforeEach(reset);

  test('entry names strip the job\'s captured prefix', async () => {
    await saveJob(job({ prefix: 'videos/' }));
    await appendManifestPage('zjob-1', [item('videos/sub/d.txt', 'delta')], {});
    const root = fakeOpfsRoot();
    const fetchImpl = fetchFake({ 'videos/sub/d.txt': [[enc('delta')]] });

    await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root });

    const staging = await root.getFileHandle('bucketer-zip-zjob-1.zip');
    const entries = readZip(new Uint8Array(await (await staging.getFile()).arrayBuffer()));
    assert.deepEqual(entries.map(e => e.name), [zipEntryPath('videos/sub/d.txt', 'videos/')]);
  });
});
