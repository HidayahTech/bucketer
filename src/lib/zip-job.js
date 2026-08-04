// Copyright (C) 2026 HidayahTech, LLC
// ZIP delivery: entry naming, the quota gate, and (below) job orchestration.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md and, for the concurrent
// engine below, docs/superpowers/specs/2026-08-04-download-concurrency-design.md (D7):
// a bounded prefetch pool (zip-prefetch.js's runPrefetch) feeds a single serial writer,
// replacing the old strictly-sequential runDownloadJob loop for the ZIP path only — the
// handoff (per-file browser download) tier still uses runDownloadJob, unchanged.

import { QUOTA_SAFETY, inPlaceSupported } from './browser-capability.js';
import { createZipWriter } from './zip-writer.js';
import { runPrefetch, CONCURRENCY, MEDIUM_MAX } from './zip-prefetch.js';
import { PROBE_KIND } from './download-preflight.js';
import { updateItem, eachItemByStatus, countItemsByStatus, ITEM_STATUS } from './download-records.js';
import { runInPlaceJob } from './zip-inplace.js';
import { zipEntryPath, zipFileName, stagingName } from './zip-naming.js';

// Re-exported for existing importers (App.jsx, test/zip-job.test.js, test/zip-job-run.test.js)
// — the definitions now live in zip-naming.js, see its header comment for why.
export { zipEntryPath, zipFileName };

// The gate, in the spec's order: capability, then fit, then the lazy-persist path.
// Unknown quota is optimistic per selectTier's philosophy — a quota failure is catchable
// at runtime, refusing up front denies the mechanism to browsers that will not say.
//
// The fit check reserves CONCURRENCY*MEDIUM_MAX on top of sendableBytes (D4): up to
// CONCURRENCY prefetch workers can each have a medium-tier item buffered in an OPFS temp
// file at once, on top of the staging zip itself, so the raw sendable total understates
// worst-case peak usage without this headroom. When denied, the reason text reports the
// full amount actually required (sendableBytes + reserve) — reporting sendableBytes alone
// would read as self-contradictory (e.g. "needs 0.1 GB; 0.3 GB available" while still
// being denied) since the reserve is what actually tipped the job over the line.
export function zipGate({ caps, sendableBytes, quota, persisted }) {
  if (!caps?.opfs || !caps?.streamingFetch || !caps?.writableFiles) {
    return { state: 'unavailable', reason: 'This browser cannot stage a ZIP.' };
  }
  if (quota?.quotaBytes == null) return { state: 'offered', reason: null };
  const free = Math.max(0, quota.quotaBytes - (quota.usageBytes ?? 0));
  const reserve = CONCURRENCY * MEDIUM_MAX;
  if (sendableBytes + reserve <= free * QUOTA_SAFETY) return { state: 'offered', reason: null };
  const gb = (n) => (n / 1e9).toFixed(1);
  const reason = `Needs about ${gb(sendableBytes + reserve)} GB of temporary browser storage (including headroom for concurrent downloads); ${gb(free)} GB available.`;
  return persisted ? { state: 'unavailable', reason } : { state: 'needs-storage', reason };
}

// Job orchestration: stage a zip into OPFS via runPrefetch's bounded concurrent fetch
// pool feeding this module's own serial writer, resuming at file granularity from
// persisted entry records and finishing only once nothing is left PENDING or FAILED.
//
// Note on entry names: zipEntryPath(key, prefix) returns '' when key === prefix (a
// zero-name entry). That can only happen for a folder-marker key (one ending in '/', or
// the empty root ''); download-manifest.js's enumerateJob filters every key for which
// isDirectoryMarker(key) is true (i.e. every key ending in '/') out of the manifest
// before it ever becomes an item — see its `.filter(o => !isDirectoryMarker(o.Key))`
// (prefix-crawl path) and the equivalent check on the file-root path. Since a job's
// prefix is itself always '' or slash-terminated, key === prefix is only reachable for a
// key that ends in '/' (or is '', which is never a real object key), so this case cannot
// occur among a zip job's items and no extra filtering is added here.

export async function openZipStaging(jobId, { root }) {
  const handle = await root.getFileHandle(stagingName(jobId), { create: true });
  const file = await handle.getFile();
  return {
    size: file.size,
    handle,
    async truncate(bytes) {
      const w = await handle.createWritable({ keepExistingData: true });
      await w.truncate(bytes); await w.close();
    },
    async openAppend(at) {
      const w = await handle.createWritable({ keepExistingData: true });
      await w.seek(at);
      return { write: (u8) => w.write(u8), close: () => w.close() };
    },
    getFile: () => handle.getFile(),
  };
}

export async function discardZipStaging(jobId, { root }) {
  try { await root.removeEntry(stagingName(jobId)); } catch { /* best effort */ }
}

// LEGACY RECOVERY: nothing in the current engine ever writes ITEM_STATUS.ISSUED any
// more — onReady (below) persists DONE directly, in one step, once an entry's local
// header, streamed bytes, and data descriptor are fully written and the item's zip
// metadata is saved. This sweep only exists to recover a job whose staging/records
// predate that change, or a genuine crash between an old build's `issue()` (which used
// to write ISSUED right after runDownloadJob's issue() resolved, and only promoted it to
// DONE at the end of that run) and its own end-of-run promotion — otherwise such an item
// would be stuck at ISSUED forever (not PENDING, so never resumed; not DONE, so never
// counted toward resumeAt or the central directory). Called once, defensively, at the
// very start of every run, before resumeAt is computed.
async function promoteIssuedToDone(jobId) {
  const items = [];
  await eachItemByStatus(jobId, ITEM_STATUS.ISSUED, (it) => { items.push(it); });
  for (const it of items) {
    await updateItem(jobId, it.key, { status: ITEM_STATUS.DONE });
  }
}

// Cap on the returned error SAMPLE only — mirrors download-queue.js's own
// DEFAULT_MAX_ERRORS. Every failed item is still marked FAILED regardless of the cap;
// only how many land in the `errors` array returned to the caller is bounded, so a job
// with thousands of denials doesn't grow that array without limit.
const MAX_ERROR_SAMPLE = 50;

// Optimistic gate (D8): opfs+streamingFetch+webWorker are the only main-thread-detectable
// prerequisites for the in-place engine. `createSyncAccessHandle` itself lives in worker
// scope only and cannot be checked here — the worker self-reports at runtime instead, and
// runZipJob falls back to the serial engine if it can't.
export function selectZipEngine(caps, makeWorker) {
  return (inPlaceSupported(caps) && makeWorker) ? 'inplace' : 'serial';
}

export async function runZipJob(job, opts) {
  if (selectZipEngine(opts.caps, opts.makeWorker) === 'inplace') {
    const r = await runInPlaceJob(job, opts);
    if (!r || !r.unsupported) return r; // in-place ran: done
    // else: worker lacked the sync handle at runtime — fall through to serial (design D8)
  }
  return runSerialZipJob(job, opts);
}

async function runSerialZipJob(job, {
  presign, probe, fetchImpl = fetch, root, concurrency, onProgress, shouldCancel = () => false,
}) {
  const prefix = job.prefix ?? '';
  await promoteIssuedToDone(job.id);

  // 1. Reload completed entries; decide the resume point.
  const done = [];
  await eachItemByStatus(job.id, ITEM_STATUS.DONE, (it) => { done.push(it); });
  let resumeAt = done.reduce((m, it) => Math.max(m, it.zipEnd ?? 0), 0);

  const staging = await openZipStaging(job.id, { root });
  if (staging.size < resumeAt) {
    // Eviction or partial loss: the recorded entries are not on disk. Restart cleanly.
    for (const it of done) {
      await updateItem(job.id, it.key, { status: ITEM_STATUS.PENDING, zipOffset: null, zipEnd: null, crc: null, time: null, date: null });
    }
    done.length = 0;
    resumeAt = 0;
  }
  await staging.truncate(resumeAt); // also discards any partial tail past the last entry

  let out = await staging.openAppend(resumeAt);
  let writer = createZipWriter({ write: (u8) => out.write(u8) }, { startOffset: resumeAt });

  const priorCompleted = done.length;
  const priorBytes = done.reduce((n, it) => n + (it.size || 0), 0);
  let completed = priorCompleted;

  // Everything this run will prefetch. App.jsx's handleZipStart (like handleDownloadStart)
  // calls resetFailedToPending before every run, so PENDING is the complete resume set —
  // the same contract the old runDownloadJob-based engine relied on.
  const pendingItems = [];
  await eachItemByStatus(job.id, ITEM_STATUS.PENDING, (it) => { pendingItems.push(it); });

  let quotaBlocked = null; // set by onReady below on a mid-entry QuotaExceededError
  let liveActive = [];     // mirrors runPrefetch's own in-flight `active` list
  let liveBytes = 0;       // mirrors runPrefetch's own `bytesDone` (this run's live total)

  const emitProgress = (activeOverride) => {
    onProgress?.({ done: completed, bytesDone: priorBytes + liveBytes, active: activeOverride ?? liveActive });
  };

  // The serial writer runPrefetch drains ready entries into, one at a time — it
  // guarantees onReady is never called concurrently with itself (zip-prefetch.js's
  // single-slot lock), so `writer`/`out` are safely reassigned here with no locking of
  // our own. `entry.chunks` is always an async iterable of Uint8Array regardless of which
  // tier runPrefetch chose (memory buffer / OPFS temp file / live solo body), so the same
  // loop streams all three through the existing writer identically.
  const onReady = async (entry) => {
    const item = entry.item;
    const entryStart = writer.offset;
    try {
      await writer.beginEntry(zipEntryPath(item.key, prefix), {
        mtime: item.lastModified, declaredSize: item.size ?? 0,
      });
      for await (const chunk of entry.chunks) await writer.update(chunk);
      // The writer computes its own CRC in update() — entry.crc (runPrefetch's
      // pre-computed CRC, memory/temp tiers only) is redundant here and left unused.
      const rec = await writer.endEntry();
      await updateItem(job.id, item.key, { status: ITEM_STATUS.DONE, ...rec });
      completed += 1;
      emitProgress();
    } catch (err) {
      // Mid-entry failure: the writer is left wedged (a local header and maybe some
      // streamed bytes with no data descriptor — or, on endEntry's declared-size
      // mismatch, cur already cleared but the bad bytes already flushed). Never reuse
      // it: truncate the staging file back to this entry's start, reopen the append
      // stream there, and build a brand new writer before deciding how to report the
      // error, so an inconsistent writer (zip-writer's update() mutates crc/size before
      // the sink write is awaited, so a rejected write leaves the old instance's internal
      // state untrustworthy) never leaks into the next onReady call.
      //
      // A REAL sink failure (not just a fetch/body failure) can itself have caused
      // `out`'s underlying stream to error — per Streams semantics, close() on an
      // errored stream also rejects. That must not block standing up the replacement
      // stream/writer below, and must not make runZipJob itself reject instead of
      // resolving with its documented { issued, failed, cancelled, ... } shape: the
      // old stream is being discarded either way, so a failed close on it is moot.
      try { await out.close(); } catch { /* already errored; discard */ }
      await staging.truncate(entryStart);
      out = await staging.openAppend(entryStart);
      writer = createZipWriter({ write: (u8) => out.write(u8) }, { startOffset: entryStart });

      // A QuotaExceededError is not this item's fault — the browser ran out of temporary
      // storage for the whole staging file, not just this entry — so per the design spec
      // (§2) it must PAUSE the job rather than FAIL only this one item. runPrefetch has no
      // built-in notion of a job-wide block raised from inside onReady (that signal only
      // exists on the ZIP path, not in zip-prefetch.js's generic contract), so it is
      // handled entirely here: swallow the error (the item is left untouched — neither
      // DONE nor FAILED — for a resume to re-fetch), remember the STORAGE block, and let
      // the `shouldCancel` wrapper below ask runPrefetch to stop — which aborts every
      // other in-flight fetch and halts new intake, the same job-wide stop a NETWORK
      // probe result gets. The recovery above already ran regardless, so staging is intact
      // either way for the eventual resume. Checked by `.name` (not `instanceof
      // DOMException`) so a fake/non-DOMException error with the same name — as a test
      // double might construct — is still recognized.
      if (err?.name === 'QuotaExceededError') {
        quotaBlocked = { kind: 'STORAGE', message: 'Ran out of temporary browser storage while building the ZIP.' };
        return;
      }
      throw err; // per-item failure: runPrefetch records it in `failed`, mapped below.
    }
  };

  const prefetchResult = await runPrefetch(pendingItems, {
    fetchImpl, presign, probe, root, concurrency,
    onReady,
    onProgress: (p) => { liveActive = p.active; liveBytes = p.bytesDone; emitProgress(p.active); },
    shouldCancel: () => quotaBlocked !== null || shouldCancel(),
  });

  // A STORAGE pause always wins: it is a real error caught above, not an inference from
  // runPrefetch's own cancel bookkeeping (which onReady drove itself, purely to get
  // runPrefetch to stop) — so it is reported as a block, never as the cancelled path.
  const cancelled = quotaBlocked ? false : prefetchResult.cancelled;
  const blocked = quotaBlocked
    || prefetchResult.blocked
    || (prefetchResult.denied
      ? { kind: PROBE_KIND.DENIED, status: null, message: 'Too many files in a row were denied.' }
      : null);

  // Per-file failures (any tier): mark FAILED and accumulate a capped error sample —
  // mirrors download-queue.js's failItem/DEFAULT_MAX_ERRORS.
  const errors = [];
  for (const { item, message } of prefetchResult.failed) {
    await updateItem(job.id, item.key, { status: ITEM_STATUS.FAILED, error: message });
    if (errors.length < MAX_ERROR_SAMPLE) errors.push({ key: item.key, message });
  }

  // Nothing streams once runPrefetch has returned. Emit unconditionally so the run's
  // final payload always carries an empty active list — otherwise, if the run stopped
  // mid-stream (cancel, a block, or the last item failing mid-body), the last-emitted
  // payload could still show a file as active, a phantom "still downloading" indicator
  // for a file that is no longer in flight. Harmlessly redundant on a clean run.
  emitProgress([]);

  // 2. Finish only when nothing remains to send.
  const pending = await countItemsByStatus(job.id, ITEM_STATUS.PENDING);
  const failed = await countItemsByStatus(job.id, ITEM_STATUS.FAILED);
  let finished = false;
  if (!cancelled && !blocked && pending === 0 && failed === 0) {
    const entries = [];
    await eachItemByStatus(job.id, ITEM_STATUS.DONE, (it) => {
      entries.push({ path: zipEntryPath(it.key, prefix), zipOffset: it.zipOffset, zipEnd: it.zipEnd, size: it.size, crc: it.crc, time: it.time, date: it.date });
    });
    await writer.finish(entries);
    finished = true;
  }
  // Guarded for the same reason as the mid-entry recovery close above: runZipJob must
  // always resolve with its documented shape, never reject because the final close on
  // an already-errored stream also rejects.
  try { await out.close(); } catch { /* best effort; result is already computed */ }
  return { issued: completed - priorCompleted, failed, cancelled, errors, blocked, finished };
}
