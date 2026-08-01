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
// WHY EVERY FILE IS PROBED. Two shipped defects (BUG-052, BUG-053) taught that "issued"
// silently overstated reality. The probe — a one-byte Range GET against the exact URL
// about to be issued — now runs before EVERY file, for two reasons:
//   1. Honesty: a file whose probe fails is marked FAILED with the reason, instead of
//      being issued into a download that cannot succeed and reported as sent.
//   2. Pacing: the probe awaits a full round trip to the bucket, so the gap between two
//      src assignments always covers at least one real network round trip — which is what
//      keeps a pending download navigation from being replaced before its response
//      arrives (BUG-053). This is measured behavior, not theory: in the postmortem's
//      experiments, the arm where every file was probed lost nothing at 1000 ms latency
//      while the sampled arm lost every unprobed file.
// The cost is one extra 1-byte GET per file. The original design sampled ~20 probes per
// job to save that cost; the saving bought silent file loss, so correctness wins.
//
// WHY A SINGLE DENIED NO LONGER STOPS THE JOB. AWS returns 403, not 404, for a missing
// key when the caller lacks s3:ListBucket — so "denied" on one file may mean "that one
// file is gone", and stopping the whole job on it refused entire downloads over one
// deleted object (postmortem, catalog defect 7). A denial now fails that file; only a
// STREAK of consecutive denials (a wholesale deny: bad credentials, clock skew) blocks
// the job. A NETWORK failure still blocks immediately — CORS and offline are genuinely
// job-wide. [AWS 403-for-missing behavior: documented, not yet measured against real AWS
// — see docs/manual-checks/preflight-real-providers.md]
//
// `presign` and `issue` are injected so this module touches neither the SDK nor the DOM.

import { takeItemsByStatus, updateItem, ITEM_STATUS } from './download-records.js';
import { PROBE_KIND } from './download-preflight.js';

const BATCH = 100;
const DEFAULT_MAX_ERRORS = 50;

// Three consecutive denials = a wholesale deny. One or two can be individually-missing
// keys surfacing as 403 (above); three unrelated keys all denied is credentials/clock.
const DENIED_BLOCK_STREAK = 3;

const defaultWait = (ms) => new Promise(r => setTimeout(r, ms));

// runDownloadJob(job, { presign, issue, probe, onProgress, shouldCancel, wait },
//                     { delayMs, maxErrors })
//
// Returns { issued, failed, cancelled, errors, blocked } — counts plus a capped error
// sample. `blocked` is the probe result that stopped the job, or null.
//
// `probe` is optional. Without it the engine issues without pre-checking, which keeps it
// runnable in plain Node with no network — but also without BUG-053's pacing protection,
// so the real app always passes one.
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
} = {}) {
  let issued = 0;
  let failed = 0;
  let consecutiveDenied = 0;
  const errors = [];

  const failItem = async (it, message) => {
    failed += 1;
    await updateItem(job.id, it.key, { status: ITEM_STATUS.FAILED, error: message });
    if (errors.length < maxErrors) errors.push({ key: it.key, message });
  };

  for (;;) {
    // Re-queried each round rather than held: a job can hold a million items, and items
    // leave PENDING as they are processed, so this converges without an index into a list.
    const batch = await takeItemsByStatus(job.id, ITEM_STATUS.PENDING, BATCH);
    if (batch.length === 0) break;

    for (const it of batch) {
      if (shouldCancel()) return { issued, failed, cancelled: true, errors, blocked: null };

      let issuedThis = false;
      try {
        const url = await presign(it.key, it.localName);

        if (probe) {
          const result = await probe(url);

          if (result.kind === PROBE_KIND.NETWORK) {
            // CORS or offline: job-wide by nature. The item stays PENDING — a job-wide
            // fault is not this item's fault, and a resume must retry it.
            return { issued, failed, cancelled: false, errors, blocked: result };
          }

          if (result.kind === PROBE_KIND.DENIED) {
            consecutiveDenied += 1;
            await failItem(it, `The bucket refused to serve this file (${result.message}).`);
            if (consecutiveDenied >= DENIED_BLOCK_STREAK) {
              return { issued, failed, cancelled: false, errors, blocked: result };
            }
          } else if (result.kind === PROBE_KIND.MISSING || result.kind === PROBE_KIND.TRANSIENT) {
            consecutiveDenied = 0;
            await failItem(it, `Could not read this file before sending it (${result.message}).`);
          } else {
            consecutiveDenied = 0;
            await issue(url, it.localName);
            await updateItem(job.id, it.key, { status: ITEM_STATUS.ISSUED, issuedAt: Date.now() });
            issued += 1;
            issuedThis = true;
          }
        } else {
          await issue(url, it.localName);
          await updateItem(job.id, it.key, { status: ITEM_STATUS.ISSUED, issuedAt: Date.now() });
          issued += 1;
          issuedThis = true;
        }
      } catch (err) {
        // One bad key must not stop a job of thousands. The item leaves PENDING either
        // way, so the outer loop always makes progress and cannot spin.
        await failItem(it, err?.message || String(err));
      }

      onProgress?.({ issued, failed, total: job.counters?.total ?? 0 });

      // Browsers throttle or prompt on rapid programmatic downloads; pacing keeps the
      // request stream something the download manager will actually accept. Only an
      // actual issue needs it — a probe-failed file handed nothing to the manager.
      if (issuedThis && delayMs > 0) await wait(delayMs);
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
// file arrived, so the manifest is the only record of what was expected — and therefore
// the only thing the read-only folder verification can check against. Deleting it on
// success means a user can never find out whether their download actually landed. The
// manifest goes when they discard it — and every retained job is guaranteed a visible
// Discard by the classifier's reachability invariant (download-lifecycle.js), which is
// the guarantee whose absence made this retention a defect the first time it shipped.
export function jobOutcome({ cancelled = false, failed = 0, blocked = null, issued = 0 } = {}) {
  return (cancelled || failed > 0 || blocked || issued > 0) ? { keep: true } : { keep: false };
}
