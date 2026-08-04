// Copyright (C) 2026 HidayahTech, LLC
// In-place ZIP composition: the main-thread orchestrator. Computes the whole byte layout up
// front (zip-layout.js), then runs N concurrent fetches (upload-queue.js's runPool) whose
// bytes stream straight to their final positioned slot via the assembler worker
// (assembler-client.js) — no serial rewrite pass, no data-descriptor patch. Returns the same
// shape as zip-job.js's runZipJob so callers are unchanged.
// See docs/superpowers/specs/2026-08-04-inplace-offset-composition-design.md.

import { computeZipLayout } from './zip-layout.js';
import { createAssemblerClient } from './assembler-client.js';
import { runPool } from './upload-queue.js';
import { PROBE_KIND } from './download-preflight.js';
import {
  takeItemsPage, updateItem, countItemsByStatus, eachItemByStatus, ITEM_STATUS,
} from './download-records.js';

// Duplicated from zip-job.js (not exported there) — both must name the exact same staging
// file for a given job id, since the two engines share OPFS staging by design (D8's runtime
// fallback resumes the SAME file the in-place engine was writing).
const stagingName = (jobId) => `bucketer-zip-${jobId}.zip`;

// Mirrors zip-job.js's own constant of the same name — see its comment for why only the
// returned SAMPLE is capped, not how many items are actually marked FAILED.
const MAX_ERROR_SAMPLE = 50;

// Mirrors zip-prefetch.js's DENIED_BLOCK_STREAK — three consecutive DENIED probes, rolling
// across concurrent workers, blocks the whole job.
const DENIED_BLOCK_STREAK = 3;

const PAGE_SIZE = 500;

// Walk every item of a job in stable key order via takeItemsPage's pagination — the
// deterministic, resume-safe order the layout is built from.
async function loadAllItems(jobId) {
  const items = [];
  let afterKey = null;
  for (;;) {
    const page = await takeItemsPage(jobId, afterKey, PAGE_SIZE);
    if (page.length === 0) break;
    items.push(...page);
    afterKey = page[page.length - 1].key;
    if (page.length < PAGE_SIZE) break;
  }
  return items;
}

export async function runInPlaceJob(job, {
  presign, probe, fetchImpl = fetch, root, concurrency, makeWorker, onProgress, shouldCancel = () => false,
}) {
  const prefix = job.prefix ?? '';

  // 1. All non-SKIPPED items in key order -> the layout every offset is computed from.
  const rawItems = await loadAllItems(job.id);
  const allItems = rawItems.filter((it) => it.status !== ITEM_STATUS.SKIPPED);
  const layout = computeZipLayout(allItems, prefix);
  const layoutByKey = new Map(layout.entries.map((e) => [e.key, e]));

  // 2. Resume guard — BEFORE the worker inits (its init truncates/creates the staging file,
  // which would mask an eviction). Only touches OPFS when there is something to resume; a
  // fresh job (no DONE items) never calls root.getFileHandle at all.
  const doneItems = allItems.filter((it) => it.status === ITEM_STATUS.DONE);
  if (doneItems.length > 0) {
    const fh = await root.getFileHandle(stagingName(job.id)).catch(() => null);
    const size = fh ? (await fh.getFile()).size : 0;
    if (size < layout.totalDataEnd) {
      for (const it of doneItems) {
        await updateItem(job.id, it.key, {
          status: ITEM_STATUS.PENDING, zipOffset: null, zipEnd: null, crc: null, time: null, date: null,
        });
        it.status = ITEM_STATUS.PENDING; // keep the in-memory copy in sync for the rest of this run
      }
    }
  }

  const priorCompleted = allItems.filter((it) => it.status === ITEM_STATUS.DONE).length;
  const priorBytes = allItems
    .filter((it) => it.status === ITEM_STATUS.DONE)
    .reduce((n, it) => n + (it.size || 0), 0);
  const pendingItems = allItems.filter((it) => it.status === ITEM_STATUS.PENDING);
  const freshKeys = pendingItems.map((it) => it.key);

  const worker = makeWorker();
  const client = createAssemblerClient(worker);

  let completed = priorCompleted;
  let liveBytes = 0;
  const activeState = new Map(); // key -> { key, size, bytes } — mirrors zip-prefetch's activeState
  const snapshotActive = () => Array.from(activeState.values()).map((a) => ({ ...a }));
  const emitProgress = (activeOverride) => {
    onProgress?.({ done: completed, bytesDone: priorBytes + liveBytes, active: activeOverride ?? snapshotActive() });
  };

  const inFlightControllers = new Set();
  const abortAllInFlight = () => {
    for (const c of inFlightControllers) { try { c.abort(); } catch { /* already settled */ } }
  };

  let quotaBlocked = null; // set by client.onFatal — STORAGE for QuotaExceededError, else a generic block
  let jobBlocked = null;   // set on a NETWORK probe result
  let denied = false;
  let consecutiveDenied = 0;
  let stopIntake = false;
  let cancelledFlag = false;

  // Combines the caller's own shouldCancel with a worker-fatal-driven stop request, exactly
  // as zip-job.js wraps runPrefetch's shouldCancel with `quotaBlocked !== null || shouldCancel()`.
  const combinedShouldCancel = () => quotaBlocked !== null || shouldCancel();
  const noteCancelIfRequested = () => {
    if (!cancelledFlag && combinedShouldCancel()) {
      cancelledFlag = true;
      stopIntake = true;
      abortAllInFlight();
    }
  };

  const failed = [];

  try {
    const { supported } = await client.init(stagingName(job.id), layout, freshKeys);
    if (!supported) {
      // Runtime fallback (design D8): nothing was fetched. runZipJob sees this sentinel and
      // runs the serial engine instead.
      return { unsupported: true };
    }

    client.onFatal(({ name, message }) => {
      if (quotaBlocked) return;
      quotaBlocked = name === 'QuotaExceededError'
        ? { kind: 'STORAGE', message: 'Ran out of temporary browser storage while building the ZIP.' }
        : { kind: 'FATAL', message: message || 'A fatal problem stopped the ZIP.' };
      stopIntake = true;
      abortAllInFlight();
    });

    async function processItem(item) {
      noteCancelIfRequested();
      if (stopIntake) return; // cancelled or blocked: leave PENDING for a resume.

      const controller = new AbortController();
      inFlightControllers.add(controller);

      const bump = (n) => {
        liveBytes += n;
        const cur = activeState.get(item.key);
        if (cur) cur.bytes += n;
        emitProgress();
      };

      try {
        const url = await presign(item.key, item.localName);

        if (probe) {
          const result = await probe(url);
          if (result.kind === PROBE_KIND.NETWORK) {
            if (!jobBlocked) {
              jobBlocked = result;
              stopIntake = true;
              abortAllInFlight();
            }
            return;
          }
          if (result.kind !== PROBE_KIND.OK) {
            if (result.kind === PROBE_KIND.DENIED) {
              consecutiveDenied += 1;
              if (consecutiveDenied >= DENIED_BLOCK_STREAK) {
                denied = true;
                stopIntake = true;
              }
            }
            failed.push({ item, message: result.message || `probe: ${result.kind}` });
            return;
          }
        }

        activeState.set(item.key, { key: item.key, size: item.size ?? 0, bytes: 0 });
        emitProgress();

        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res || !res.ok || !res.body) {
          throw new Error(`fetch failed (${res?.status ?? 'no response'})`);
        }

        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          client.writeChunk(item.key, value);
          bump(value.length);
        }

        activeState.delete(item.key);
        emitProgress();

        const rec = await client.endEntry(item.key);
        const layoutEntry = layoutByKey.get(item.key);
        await updateItem(job.id, item.key, {
          status: ITEM_STATUS.DONE,
          zipOffset: layoutEntry.headerOffset,
          zipEnd: layoutEntry.entryEnd,
          crc: rec.crc,
          size: rec.size,
          time: layoutEntry.time,
          date: layoutEntry.date,
        });
        completed += 1;
        emitProgress();

        consecutiveDenied = 0;
        noteCancelIfRequested();
      } catch (err) {
        if ((cancelledFlag || jobBlocked || quotaBlocked) && err?.name === 'AbortError') {
          // Cut off by our own cancel- or block-triggered abort: not this item's fault.
          // Leave it untouched (neither DONE nor FAILED) for a resume to re-fetch.
        } else {
          failed.push({ item, message: err?.message || String(err) });
        }
        activeState.delete(item.key);
        emitProgress();
      } finally {
        inFlightControllers.delete(controller);
      }
    }

    await runPool(pendingItems, processItem, concurrency);

    // Nothing streams once runPool has returned — emit unconditionally so the run's final
    // payload always carries an empty active list (mirrors zip-job.js's own rationale).
    emitProgress([]);

    // A worker-fatal pause always wins: it is a real error, never reported as "cancelled".
    const cancelled = quotaBlocked ? false : cancelledFlag;
    const blocked = quotaBlocked
      || jobBlocked
      || (denied ? { kind: PROBE_KIND.DENIED, status: null, message: 'Too many files in a row were denied.' } : null);

    const errors = [];
    for (const { item, message } of failed) {
      await updateItem(job.id, item.key, { status: ITEM_STATUS.FAILED, error: message });
      if (errors.length < MAX_ERROR_SAMPLE) errors.push({ key: item.key, message });
    }

    const pending = await countItemsByStatus(job.id, ITEM_STATUS.PENDING);
    const failedCount = await countItemsByStatus(job.id, ITEM_STATUS.FAILED);
    let finished = false;
    if (!cancelled && !blocked && pending === 0 && failedCount === 0) {
      const doneByKey = new Map();
      await eachItemByStatus(job.id, ITEM_STATUS.DONE, (it) => { doneByKey.set(it.key, it); });
      const records = layout.entries.map((e) => {
        const d = doneByKey.get(e.key);
        return { path: e.path, zipOffset: e.headerOffset, size: d.size, crc: d.crc, time: e.time, date: e.date };
      });
      await client.finish(records);
      finished = true;
    } else {
      client.abort();
    }

    return { issued: completed - priorCompleted, failed: failedCount, cancelled, errors, blocked, finished };
  } finally {
    // Carried finding from Task 4's review: the worker does not close its OPFS sync handle
    // if finish() throws (its own fatal path), so the exclusive lock leaks unless this runs
    // unconditionally on every exit path — success, fallback, cancel, block, fatal, exception.
    worker.terminate();
  }
}
