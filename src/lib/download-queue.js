// Copyright (C) 2026 HidayahTech, LLC
// The browser-managed download engine.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// WHAT THIS TIER CAN AND CANNOT DO. The app presigns a URL and hands it to the browser's
// own download manager. It can observe that it *issued* a download. It cannot observe
// bytes transferred, completion, or failure — that transfer belongs to the browser.
//
// Everything here is built around that limit rather than around it:
//   - progress is counted in files issued, never bytes, never a percentage, never an ETA;
//   - cancel means "stop issuing further downloads", and the UI must say exactly that,
//     because downloads already handed over keep running;
//   - an item's terminal state is ISSUED, not DONE. Only the optional read-only folder
//     verification can promote ISSUED to DONE, and only when the name is unambiguous.
//
// Claiming more than this is the failure docs/intent/master-queue.md named: "a queue row
// would be a lie — it would show 'running' with no real progress and a cancel button that
// can't work."
//
// `presign` and `issue` are injected so this module touches neither the SDK nor the DOM.

import { takeItemsByStatus, updateItem, ITEM_STATUS } from './download-records.js';
import { isBlocking, sampleInterval } from './download-preflight.js';

const BATCH = 100;
const DEFAULT_MAX_ERRORS = 50;
const DEFAULT_PROBE_BUDGET = 20;

const defaultWait = (ms) => new Promise(r => setTimeout(r, ms));

// runDownloadJob(job, { presign, issue, probe, onProgress, shouldCancel, wait },
//                     { delayMs, maxErrors, probeBudget })
//
// Returns { issued, failed, cancelled, errors, blocked } — counts plus a capped error
// sample. `blocked` is the probe result that stopped the job, or null.
//
// `probe` is optional. Without it the engine behaves exactly as it did before probing
// existed, which is what keeps it runnable in plain Node with no network at all.
export async function runDownloadJob(job, {
  presign,
  issue,
  probe,
  onProgress,
  shouldCancel = () => false,
  wait = defaultWait,
} = {}, {
  delayMs = 0,
  maxErrors = DEFAULT_MAX_ERRORS,
  probeBudget = DEFAULT_PROBE_BUDGET,
} = {}) {
  const total = job.counters?.total ?? 0;
  let issued = 0;
  let failed = 0;
  const errors = [];

  // Index 0 is the pre-flight; the rest are the periodic samples. An unknown total yields
  // an infinite interval, which probes once at the start and never again — the honest
  // behaviour when there is no run length to spread a budget over.
  const interval = sampleInterval(total, probeBudget);
  let index = 0;

  for (;;) {
    // Re-queried each round rather than held: a job can hold a million items, and items
    // leave PENDING as they are processed, so this converges without an index into a list.
    const batch = await takeItemsByStatus(job.id, ITEM_STATUS.PENDING, BATCH);
    if (batch.length === 0) break;

    for (const it of batch) {
      if (shouldCancel()) return { issued, failed, cancelled: true, errors, blocked: null };

      try {
        const url = await presign(it.key, it.localName);

        // Probing the exact URL about to be issued costs no extra presign and proves
        // something about this download rather than about a similar one. A blocking result
        // returns immediately and leaves the item PENDING: a job-wide fault is not this
        // item's fault, and marking it FAILED would misreport what a resume has to retry.
        if (probe && index % interval === 0) {
          const result = await probe(url);
          if (isBlocking(result)) return { issued, failed, cancelled: false, errors, blocked: result };
        }

        await issue(url, it.localName);
        await updateItem(job.id, it.key, { status: ITEM_STATUS.ISSUED, issuedAt: Date.now() });
        issued += 1;
      } catch (err) {
        // One bad key must not stop a job of thousands. The item leaves PENDING either
        // way, so the outer loop always makes progress and cannot spin.
        failed += 1;
        const message = err?.message || String(err);
        await updateItem(job.id, it.key, { status: ITEM_STATUS.FAILED, error: message });
        if (errors.length < maxErrors) errors.push({ key: it.key, message });
      }

      // Advanced on both paths: leaving it behind on a failure would pin the index at a
      // sample point and probe every remaining file.
      index += 1;
      onProgress?.({ issued, failed, total });

      // Browsers throttle or prompt on rapid programmatic downloads; pacing keeps the
      // request stream something the download manager will actually accept.
      if (delayMs > 0) await wait(delayMs);
    }
  }

  return { issued, failed, cancelled: false, errors, blocked: null };
}

// What to do with the manifest once a run ends.
//
// A manifest is dead weight only when the run left nothing worth acting on.
//
// Failures must be kept: discarding them throws away the record of WHICH files failed, and
// re-running then re-enumerates and re-issues the entire job — the worst possible outcome
// in exactly the large-job case this feature exists for.
//
// `blocked` is the subtle one: a job stopped by a job-wide fault has nothing cancelled and
// nothing failed, so it reads as a clean run. Discarding its manifest would throw away the
// enumeration of a whole prefix because a credential expired.
//
// `issued` is why even a perfectly clean run is kept. This tier cannot observe whether a
// file arrived, so the manifest is the only record of what was expected — and therefore the
// only thing the read-only folder verification can check against. Deleting it on success
// means a user can never find out whether their download actually landed. The manifest goes
// when they verify or discard it, which is a decision only they can make.
export function jobOutcome({ cancelled = false, failed = 0, blocked = null, issued = 0 } = {}) {
  return (cancelled || failed > 0 || blocked || issued > 0) ? { keep: true } : { keep: false };
}
