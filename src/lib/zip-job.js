// Copyright (C) 2026 HidayahTech, LLC
// ZIP delivery: entry naming, the quota gate, and (below, Task 3) job orchestration.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md.

import { sanitizeSegment } from './download-naming.js';
import { QUOTA_SAFETY } from './browser-capability.js';
import { createZipWriter } from './zip-writer.js';
import { runDownloadJob } from './download-queue.js';
import { updateItem, eachItemByStatus, countItemsByStatus, ITEM_STATUS } from './download-records.js';

// Keys keep their real folder structure inside the zip — that is the point of the format.
// Relative to the scope's captured prefix; a key outside it (possible in a selection with
// mixed roots) keeps its full path rather than escaping upward.
export function zipEntryPath(key, capturedPrefix = '') {
  const rel = capturedPrefix && key.startsWith(capturedPrefix) ? key.slice(capturedPrefix.length) : key;
  return rel.split('/').filter(Boolean).map(sanitizeSegment).join('/');
}

export function zipFileName(bucket, capturedPrefix = '', now = new Date()) {
  const segs = capturedPrefix.split('/').filter(Boolean);
  const base = sanitizeSegment(segs.length ? segs[segs.length - 1] : bucket);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${base}-${stamp}.zip`;
}

// The gate, in the spec's order: capability, then fit, then the lazy-persist path.
// Unknown quota is optimistic per selectTier's philosophy — a quota failure is catchable
// at runtime, refusing up front denies the mechanism to browsers that will not say.
export function zipGate({ caps, sendableBytes, quota, persisted }) {
  if (!caps?.opfs || !caps?.streamingFetch || !caps?.writableFiles) {
    return { state: 'unavailable', reason: 'This browser cannot stage a ZIP.' };
  }
  if (quota?.quotaBytes == null) return { state: 'offered', reason: null };
  const free = Math.max(0, quota.quotaBytes - (quota.usageBytes ?? 0));
  if (sendableBytes <= free * QUOTA_SAFETY) return { state: 'offered', reason: null };
  const gb = (n) => (n / 1e9).toFixed(1);
  const reason = `Needs about ${gb(sendableBytes)} GB of temporary browser storage; ${gb(free)} GB available.`;
  return persisted ? { state: 'unavailable', reason } : { state: 'needs-storage', reason };
}

// Job orchestration: stage a zip into OPFS via runDownloadJob's engine, resuming at
// file granularity from persisted entry records and finishing only once nothing is
// left PENDING or FAILED.
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

const stagingName = (jobId) => `bucketer-zip-${jobId}.zip`;

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

// ADAPTATION (from the design's assumed shape): runDownloadJob writes
// ITEM_STATUS.ISSUED unconditionally right after `issue()` resolves (download-queue.js
// — both the probed and unprobed branches), regardless of what `issue()` itself wrote to
// the item. Confirmed by the existing suite: download-queue.test.js's "marks issued
// items so a resume does not re-issue them" asserts the post-run status IS ISSUED, not
// whatever a caller wrote. So the injected `issue` in runZipJob records only the zip
// entry metadata (no status field — writing DONE there would just be clobbered a moment
// later); promoteIssuedToDone is what actually advances the status, once every item this
// run touched is known. For a zip job "issued" and "done" are the same fact regardless:
// issue() only resolves once the entry's local header, streamed bytes, and data
// descriptor are fully written and the item's zip metadata is persisted.
//
// Called twice per run: once defensively at the very start, in case an earlier run was
// interrupted between runDownloadJob returning and ITS end-of-run call to this same
// function — otherwise those items would be stuck at ISSUED forever (not PENDING, so
// never resumed; not DONE, so never counted toward resumeAt or the central directory) —
// and once after runDownloadJob returns, for this run's own completions, before
// resume/finish logic reads DONE as ground truth.
async function promoteIssuedToDone(jobId) {
  const items = [];
  await eachItemByStatus(jobId, ITEM_STATUS.ISSUED, (it) => { items.push(it); });
  for (const it of items) {
    await updateItem(jobId, it.key, { status: ITEM_STATUS.DONE });
  }
}

export async function runZipJob(job, { presign, probe, fetchImpl = fetch, root, onProgress, shouldCancel = () => false }) {
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

  let bytesDone = done.reduce((n, it) => n + (it.size || 0), 0);
  let completed = done.length;

  // The injected issue: fetch, stream through the writer, record the entry's zip
  // metadata. See the ADAPTATION note above for why no status field is written here.
  const issue = async (url, _localName, item) => {
    const entryStart = writer.offset;
    let inFlightBytes = 0;
    // The file currently streaming, for the UI's "active file" display. Local to this
    // call (one issue() invocation per item, run sequentially — see download-queue.js),
    // so no cross-item leakage; cleared to null once the entry is done.
    let active = { key: item.key, size: item.size ?? 0, bytes: 0 };
    try {
      await writer.beginEntry(zipEntryPath(item.key, prefix), {
        mtime: item.lastModified, declaredSize: item.size ?? 0,
      });
      const res = await fetchImpl(url);
      if (!res.ok || !res.body) throw new Error(`fetch failed (${res.status})`);
      const reader = res.body.getReader();
      for (;;) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        await writer.update(value);
        inFlightBytes += value.length;
        active.bytes = inFlightBytes;
        onProgress?.({ done: completed, bytesDone: bytesDone + inFlightBytes, active });
      }
      const rec = await writer.endEntry();
      await updateItem(job.id, item.key, { ...rec });
      completed += 1; bytesDone += rec.size;
      active = null;
      onProgress?.({ done: completed, bytesDone, active: null });
    } catch (err) {
      // Mid-entry failure: the writer is left wedged (a local header and maybe some
      // streamed bytes with no data descriptor — or, on endEntry's declared-size
      // mismatch, cur already cleared but the bad bytes already flushed). Never reuse
      // it: truncate the staging file back to this entry's start, reopen the append
      // stream there, and build a brand new writer before rethrowing so
      // runDownloadJob records the item FAILED and the writer is never touched again
      // after an inconsistent write (zip-writer's update() mutates crc/size before the
      // sink write is awaited, so a rejected write leaves the old instance's internal
      // state untrustworthy).
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
      // (§2) it must PAUSE the job (download-queue.js's .jobBlock signal) rather than FAIL
      // only this one item. The recovery above already ran regardless of which way this
      // rethrows, so staging is intact either way for the eventual resume. Checked by
      // `.name` (not `instanceof DOMException`) so a fake/non-DOMException error with the
      // same name — as a test double might construct — is still recognized.
      if (err?.name === 'QuotaExceededError') {
        const blockedErr = new Error('Ran out of temporary browser storage while building the ZIP.');
        blockedErr.jobBlock = { kind: 'STORAGE', message: blockedErr.message };
        throw blockedErr;
      }
      throw err;
    }
  };

  const result = await runDownloadJob(job, { presign, probe, issue, shouldCancel,
    onProgress: () => {} /* byte progress comes from the issue closure */ });

  // Promote this run's completions (see ADAPTATION note) before resume/finish logic
  // reads DONE as ground truth.
  await promoteIssuedToDone(job.id);

  // 2. Finish only when nothing remains to send.
  const pending = await countItemsByStatus(job.id, ITEM_STATUS.PENDING);
  const failed = await countItemsByStatus(job.id, ITEM_STATUS.FAILED);
  let finished = false;
  if (!result.cancelled && !result.blocked && pending === 0 && failed === 0) {
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
  return { ...result, finished };
}
