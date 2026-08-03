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
import { createZipWriter } from '../src/lib/zip-writer.js';
import {
  saveJob, loadJob, loadAllJobs, deleteJob, appendManifestPage,
  updateItem, countItemsByStatus, eachItemByStatus, resetFailedToPending, ITEM_STATUS,
} from '../src/lib/download-records.js';
import { readZip } from './helpers/zip-reader.js';

// Fake OPFS directory: enough surface for openZipStaging — getFileHandle(name,
// {create}), removeEntry(name); file handles expose createWritable({keepExistingData})
// and getFile(). Backed by a Uint8Array per file.
//
// Extended with armWriteFailure (not part of the brief's original fake) so Finding-1's
// regression test can inject a real sink/IO failure — distinct from a fetch/body
// failure — and prove recovery survives it. Once a write() on a given file fails, that
// stream instance is marked errored and every later call on THE SAME instance (write,
// truncate, seek, close) also fails, mirroring real WritableStream semantics: a rejected
// write leaves the stream errored, and close() on an errored stream rejects too.
function fakeOpfsRoot() {
  const files = new Map();
  const writeFaults = new Map(); // name -> { afterSuccesses, count }
  return {
    files,
    // Let `afterSuccesses` writes to `name` succeed, then fail the next one.
    armWriteFailure(name, afterSuccesses = 0) {
      writeFaults.set(name, { afterSuccesses, count: 0 });
    },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
        files.set(name, new Uint8Array(0));
      }
      return {
        async createWritable({ keepExistingData = false } = {}) {
          let buf = keepExistingData ? Uint8Array.from(files.get(name)) : new Uint8Array(0);
          let pos = buf.length;
          let errored = false;
          return {
            async write(u8) {
              if (errored) throw new Error('write on an already-errored stream');
              const fault = writeFaults.get(name);
              if (fault) {
                if (fault.count === fault.afterSuccesses) {
                  writeFaults.delete(name);
                  errored = true;
                  throw new Error('simulated OPFS write failure');
                }
                fault.count += 1;
              }
              const grown = new Uint8Array(Math.max(buf.length, pos + u8.length));
              grown.set(buf); grown.set(u8, pos); buf = grown; pos += u8.length;
            },
            async truncate(n) { if (errored) throw new Error('truncate on an errored stream'); buf = buf.slice(0, n); pos = Math.min(pos, n); },
            async seek(n) { if (errored) throw new Error('seek on an errored stream'); pos = n; },
            async close() { if (errored) throw new Error('close on an errored stream'); files.set(name, buf); },
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

  // Finding 1 (Task 3 fix review): the mid-entry recovery's `out.close()` was unguarded.
  // zip-writer's update() mutates crc/size before awaiting the sink write, so a rejected
  // sink.write() (a real OPFS write failure — quota/IO, not a fetch/body failure) leaves
  // the stream errored, and close() on an errored stream rejects too. Unguarded, that
  // would abort recovery mid-catch (never reaching truncate/openAppend/recreate) and
  // leave `writer`/`cur` wedged — cascading every remaining item to failure via
  // beginEntry's "previous entry not ended" — and the same unguarded close at
  // end-of-function would make runZipJob itself reject instead of resolving with its
  // documented shape.
  test('7. a mid-entry OPFS write failure (not a fetch failure) recovers cleanly and resolves', async () => {
    await saveJob(job());
    await appendManifestPage('zjob-1', [
      item('videos/m.txt', 'mno-body'),
      item('videos/n.txt', 'november'),
    ], {});

    const root = fakeOpfsRoot();
    const fetchImpl = fetchFake({
      // Two body chunks so the armed fault lands after m's header write, mid-body —
      // a real sink failure, not a fetch failure (test 3 already covers that case).
      'videos/m.txt': [[enc('mno-'), enc('body')]],
      'videos/n.txt': [[enc('november')]],
    });
    // m is processed first (key order) and is the very first item this fresh run
    // touches, so nothing durable is at risk from the errored stream's close()
    // discarding its (never-yet-committed) buffered writes. Let 1 write through — m's
    // local header — then fail the next one: m's first body-chunk write.
    root.armWriteFailure('bucketer-zip-zjob-1.zip', 1);

    let rejected = false;
    const result = await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root })
      .catch((e) => { rejected = true; throw e; });
    assert.equal(rejected, false, 'runZipJob must resolve, not reject, even when close() on the errored stream also fails');

    assert.equal(result.failed, 1);
    const statuses = await statusesOf('zjob-1');
    assert.equal(statuses[ITEM_STATUS.FAILED], 1);
    assert.equal(statuses[ITEM_STATUS.DONE], 1, 'no cascade: only the item that hit the fault failed');
    let failedItem;
    await eachItemByStatus('zjob-1', ITEM_STATUS.FAILED, (it) => { failedItem = it; });
    assert.equal(failedItem.key, 'videos/m.txt');
    assert.ok(failedItem.error, 'the failure reason must be recorded');
    let doneItem;
    await eachItemByStatus('zjob-1', ITEM_STATUS.DONE, (it) => { doneItem = it; });
    assert.equal(doneItem.key, 'videos/n.txt', 'the item after the fault must be written by the recovered writer, not skipped');

    // Prove "written correctly" (not just "recorded DONE"): retry m and confirm the
    // final archive parses, with both entries byte-correct.
    await resetFailedToPending('zjob-1');
    const result2 = await runZipJob(await loadJob('zjob-1'), { presign, fetchImpl, root });
    assert.equal(result2.finished, true);

    const staging = await root.getFileHandle('bucketer-zip-zjob-1.zip');
    const entries = readZip(new Uint8Array(await (await staging.getFile()).arrayBuffer()));
    assert.deepEqual(entries.map(e => e.name).sort(), ['m.txt', 'n.txt']);
    const byName = Object.fromEntries(entries.map(e => [e.name, e]));
    assert.equal(dec(byName['m.txt'].data), 'mno-body');
    assert.equal(dec(byName['n.txt'].data), 'november');
  });

  // Finding 2 (Task 3 fix review): the start-of-run defensive promoteIssuedToDone sweep
  // (zip-job.js, the call right at the top of runZipJob) had zero coverage — every
  // existing test only ever observed the END-of-run promotion. That start-of-run sweep
  // is the entire mechanism that makes the residual crash window self-healing: it's what
  // recovers an item a PRIOR run left at ISSUED because it crashed between
  // runDownloadJob returning and that run's OWN end-of-run promotion call.
  test('8. a stray ISSUED item from a crashed prior run is promoted to DONE at the start of the next run', async () => {
    await saveJob(job());
    await appendManifestPage('zjob-1', [
      item('videos/p.txt', 'papa'),
      item('videos/q.txt', 'quebec'),
    ], {});

    const root = fakeOpfsRoot();
    // Simulate the crash: physically write p's entry into the staging file (exactly what
    // runZipJob's issue() closure does), then leave the item record at ISSUED with the
    // complete, correct rec — the state runDownloadJob leaves behind right after issue()
    // resolves, before a crash could reach this run's own end-of-run promotion.
    const staging = await openZipStaging('zjob-1', { root });
    const setupOut = await staging.openAppend(0);
    const setupWriter = createZipWriter({ write: (u8) => setupOut.write(u8) }, { startOffset: 0 });
    await setupWriter.beginEntry('p.txt', { declaredSize: enc('papa').length, mtime: 1700000000000 });
    await setupWriter.update(enc('papa'));
    const rec = await setupWriter.endEntry();
    await setupOut.close();
    await updateItem('zjob-1', 'videos/p.txt', { status: ITEM_STATUS.ISSUED, ...rec });

    assert.equal((await statusesOf('zjob-1'))[ITEM_STATUS.ISSUED], 1, 'setup sanity: p really is stranded at ISSUED before the run');

    const fetchImpl = fetchFake({ 'videos/q.txt': [[enc('quebec')]] });
    const progress = [];
    const result = await runZipJob(await loadJob('zjob-1'), {
      presign, fetchImpl, root, onProgress: (p) => progress.push({ ...p }),
    });

    assert.equal(result.finished, true);
    const statuses = await statusesOf('zjob-1');
    assert.equal(statuses[ITEM_STATUS.DONE], 2);
    assert.equal(statuses[ITEM_STATUS.ISSUED], 0);
    assert.equal(statuses[ITEM_STATUS.PENDING], 0);

    // Promoted BEFORE resumeAt was computed: q (the only item runDownloadJob actually
    // touched this run) must resume after p's entry, not overwrite it.
    let pItem, qItem;
    await eachItemByStatus('zjob-1', ITEM_STATUS.DONE, (it) => {
      if (it.key === 'videos/p.txt') pItem = it;
      if (it.key === 'videos/q.txt') qItem = it;
    });
    assert.equal(pItem.zipOffset, 0);
    assert.equal(qItem.zipOffset, pItem.zipEnd, 'q must resume after p, proving p was counted toward resumeAt');

    // Counted toward bytesDone/completed: the final progress event must include p's
    // pre-seeded bytes and count it toward "done", even though only q went through
    // this run's issue() closure.
    const last = progress[progress.length - 1];
    assert.equal(last.done, 2, 'p (pre-seeded) plus q must both count toward "done"');
    assert.equal(last.bytesDone, enc('papa').length + enc('quebec').length);

    // Included in the finished archive's central directory, byte-correct.
    const file = await staging.getFile();
    const entries = readZip(new Uint8Array(await file.arrayBuffer()));
    assert.deepEqual(entries.map(e => e.name).sort(), ['p.txt', 'q.txt']);
    const byName = Object.fromEntries(entries.map(e => [e.name, e]));
    assert.equal(dec(byName['p.txt'].data), 'papa');
    assert.equal(dec(byName['q.txt'].data), 'quebec');
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
