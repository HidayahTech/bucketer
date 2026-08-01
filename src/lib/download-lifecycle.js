// Copyright (C) 2026 HidayahTech, LLC
// One classifier for what a persisted download job means to the user right now.
//
// WHY THIS EXISTS. The panel used to build its lists from two independent filters
// (status ≠ DONE ∧ remaining > 0; issued > 0 ∧ never-verified). Their overlap showed one
// job as two rows, and their gap stranded jobs entirely: a verified DONE job with missing
// files satisfied neither filter, so it had no resume, no re-check, and no Discard, on any
// browser, forever (postmortem F3/F6, catalog 18). Deriving every row from ONE total
// classification makes those states unrepresentable, and the cross-product test in
// test/download-lifecycle.test.js proves totality mechanically.
//
// THE REACHABILITY INVARIANT. Every persisted job classifies into exactly one class, and
// every class renders a row that carries Discard. Capability gates (showDirectoryPicker
// is Chromium-only) may hide a class's ACTION, never its row.
//
//   'unfinished' — pending or failed items exist. Work remains: Resume + Discard.
//   'sent'       — nothing left to send, but ISSUED items exist whose arrival only the
//                  read-only folder check can confirm: Check-folder (gated) + Discard.
//   'settled'    — nothing pending, failed, or unconfirmed. Summary + Discard; keeping
//                  the manifest until the user discards it is deliberate (the record of
//                  what was downloaded is theirs to keep or drop).
//
// `verifiedAt` is informational only ("last checked …"). It is never a classification or
// list-exclusion key — filtering on it is what made re-verification impossible.

export const JOB_CLASS = {
  UNFINISHED: 'unfinished',
  SENT: 'sent',
  SETTLED: 'settled',
};

// classifyJob(counts) → one of JOB_CLASS. `counts` = { pending, failed, issued } item
// counts. Deliberately independent of job.status: status says what a RUN was doing;
// the item counts say what remains, and rows describe what remains. (A RUNNING job with
// a live task is excluded from listing by the caller — see App's download API — because
// while a run is in flight its row is the task queue's business, not the panel's.)
export function classifyJob({ pending = 0, failed = 0, issued = 0 } = {}) {
  if (pending + failed > 0) return JOB_CLASS.UNFINISHED;
  if (issued > 0) return JOB_CLASS.SENT;
  return JOB_CLASS.SETTLED;
}
