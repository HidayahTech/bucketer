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

const BATCH = 100;
const DEFAULT_MAX_ERRORS = 50;

const defaultWait = (ms) => new Promise(r => setTimeout(r, ms));

// runDownloadJob(job, { presign, issue, onProgress, shouldCancel, wait }, { delayMs, maxErrors })
//
// Returns { issued, failed, cancelled, errors } — counts plus a capped error sample.
export async function runDownloadJob(job, {
  presign,
  issue,
  onProgress,
  shouldCancel = () => false,
  wait = defaultWait,
} = {}, {
  delayMs = 0,
  maxErrors = DEFAULT_MAX_ERRORS,
} = {}) {
  const total = job.counters?.total ?? 0;
  let issued = 0;
  let failed = 0;
  const errors = [];

  for (;;) {
    // Re-queried each round rather than held: a job can hold a million items, and items
    // leave PENDING as they are processed, so this converges without an index into a list.
    const batch = await takeItemsByStatus(job.id, ITEM_STATUS.PENDING, BATCH);
    if (batch.length === 0) break;

    for (const it of batch) {
      if (shouldCancel()) return { issued, failed, cancelled: true, errors };

      try {
        const url = await presign(it.key, it.localName);
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

      onProgress?.({ issued, failed, total });

      // Browsers throttle or prompt on rapid programmatic downloads; pacing keeps the
      // request stream something the download manager will actually accept.
      if (delayMs > 0) await wait(delayMs);
    }
  }

  return { issued, failed, cancelled: false, errors };
}
