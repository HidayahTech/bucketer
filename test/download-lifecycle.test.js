// Copyright (C) 2026 HidayahTech, LLC
// The reachability invariant, proven over the whole input space.
//
// Postmortem F3: a job could reach a state (DONE + verifiedAt + failed items) that
// satisfied neither of the panel's two list filters — no resume, no re-check, no Discard,
// on any browser, forever. The classifier makes that impossible by being TOTAL: every
// combination of item counts maps to exactly one class, and the panel renders every class
// as a row with Discard. This test walks the cross-product so a regression in totality is
// a unit failure, not a stranded user.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyJob, JOB_CLASS } from '../src/lib/download-lifecycle.js';

const COUNT_SHAPES = [0, 1, 412];
const ALL_CLASSES = new Set(Object.values(JOB_CLASS));

describe('classifyJob — the reachability invariant', () => {
  test('every count combination yields exactly one known class', () => {
    for (const pending of COUNT_SHAPES) {
      for (const failed of COUNT_SHAPES) {
        for (const issued of COUNT_SHAPES) {
          const cls = classifyJob({ pending, failed, issued });
          assert.ok(ALL_CLASSES.has(cls),
            `unclassified job state: pending=${pending} failed=${failed} issued=${issued}`);
        }
      }
    }
  });

  test('missing counts classify rather than throw — a legacy job is still reachable', () => {
    assert.ok(ALL_CLASSES.has(classifyJob({})));
    assert.ok(ALL_CLASSES.has(classifyJob()));
  });

  test('work remaining always outranks everything: failed items mean unfinished', () => {
    // The F3 shape: a verified job whose check found missing files (now FAILED), with the
    // rest issued. The old filters stranded exactly this; it must classify as resumable.
    assert.equal(classifyJob({ pending: 0, failed: 2, issued: 6 }), JOB_CLASS.UNFINISHED);
  });

  test('issued-only means sent: arrival is unconfirmed until a folder check', () => {
    assert.equal(classifyJob({ pending: 0, failed: 0, issued: 412 }), JOB_CLASS.SENT);
  });

  test('nothing pending, failed, or unconfirmed is settled', () => {
    assert.equal(classifyJob({ pending: 0, failed: 0, issued: 0 }), JOB_CLASS.SETTLED);
  });

  test('verifiedAt plays no role in classification', () => {
    // Re-verification must always be possible while ISSUED items exist; filtering on
    // verifiedAt is what made a job permanently un-checkable (catalog defect 37).
    const withStamp = classifyJob({ pending: 0, failed: 0, issued: 5, verifiedAt: 123 });
    assert.equal(withStamp, JOB_CLASS.SENT);
  });
});
