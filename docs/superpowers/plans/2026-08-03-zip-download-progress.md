# ZIP Download Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a running ZIP download real byte/speed/ETA progress with a progress bar, expandable to an active-focused per-file detail — at parity with uploads.

**Architecture:** A pure sliding-window rate tracker (`rate-tracker.js`) + a thin interval-sampling hook (`useRate.js`) derive speed/ETA from the task's already-threaded `bytesDone`. `zip-job.js` adds the currently-streaming file (`active`) to its `onProgress` payload; `handleZipStart` sets a static `bytesTotal` and forwards `active` onto the task and tags it with the download `jobId`. `MasterQueue.jsx` renders the enriched line + bar for running ZIP tasks and, when expanded, an active-focused detail whose completed/failed file names are read from IndexedDB via an injected reader (`loadZipDetail`) — preserving the component's no-SDK/no-IndexedDB rule.

**Tech Stack:** Preact + preact/hooks, esbuild, `node --test` (unit), jsdom via `npm run test:ui` (component), fake-indexeddb, Playwright container matrix. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-03-zip-download-progress-design.md` — read it first. Its "Operator decisions" bind this plan.

## Global Constraints

- Branch: `zip-download-progress` (off `main` @ v1.46.0). Never push without operator confirmation; the pre-push hook builds + tests and tags the working-tree `package.json` version.
- `npm test` (unit) / `npm run test:ui` (component, `../helpers/with-dom.js` first import) / `npm run test:e2e:container` (only source of e2e coverage claims; baseline first per the E2E Evidence Rules).
- **No new npm dependencies.**
- **ZIP-only.** No change to the handoff (per-file browser download) tier. All task/job/item model changes additive; a legacy/handoff task (`delivery` undefined) renders exactly as today.
- **No SDK/IndexedDB/OPFS/`navigator.storage` I/O inside components.** `MasterQueue.jsx` reads per-file detail only through an injected function, never a direct `download-records`/IndexedDB import.
- Copy style: sentence case, plain, no exclamation marks.
- Reuse `formatBytes`/`formatSpeed`/`formatEta` from `src/lib/format.js`; do not add a percent helper (compute inline, as the upload components do).
- Version bump only in the final task, only after operator confirms level, with CHANGELOG + rebuilt `dist/index.html` + `src/lib/changelog.js` in the same commit.
- **Deferred (do NOT do here):** unifying `BatchSummary.jsx` onto `rate-tracker.js`. Leave the upload path untouched.

---

### Task 0: E2E baseline

**Files:** none changed.

- [ ] **Step 1:** `git status --short` — no modified tracked files.
- [ ] **Step 2:** This branch forks from `main` @ the v1.46.0 commit, whose full container matrix was run and recorded on 2026-08-03 (all 10 lanes green: node 53/53; desktop lanes 54/53/0/1; mobile lanes 54/51/0/3; webkit desktop 54/52/0/2; image `mcr.microsoft.com/playwright:v1.60.0-noble`). The untouched tree of this branch is byte-identical to that commit, so that recording IS the baseline — reuse it. Confirm `git merge-base main HEAD` equals the current `main` tip before relying on this.
- [ ] **Step 3:** Only if the merge-base differs from the recorded baseline commit: run `npm run test:e2e:container` to completion and record per-lane counts to `.claude-scratch/e2e-baseline-progress.txt`. Otherwise note the reuse and proceed.

---

### Task 1: Rate tracking — `rate-tracker.js` (pure) + `useRate.js` (hook)

**Files:**
- Create: `src/lib/rate-tracker.js`
- Create: `src/hooks/useRate.js`
- Test: `test/rate-tracker.test.js`, `test/components/use-rate.test.jsx`

**Interfaces:**
- Produces:
  - `createRateTracker({ windowMs = 6000, minSpanMs = 500 } = {}) -> { sample(t, bytes), rate(t?) }` — `sample` pushes a `{t, bytes}` cumulative-byte sample and evicts samples older than `windowMs`; `rate(t)` returns bytes/second across the retained window, or `null` until there are ≥2 samples spanning ≥ `minSpanMs`.
  - `useRate(bytes, active, { now = () => Date.now(), intervalMs = 250 } = {}) -> number | null` — while `active`, samples `bytes` on an interval into a fresh tracker and returns the current speed; `null` when inactive or not yet enough samples.

- [ ] **Step 1: Write `test/rate-tracker.test.js` (failing):**

```js
// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRateTracker } from '../src/lib/rate-tracker.js';

const MB = 1024 * 1024;

describe('rate-tracker', () => {
  test('null until two samples spanning minSpanMs', () => {
    const r = createRateTracker();
    assert.equal(r.rate(0), null);            // no samples
    r.sample(0, 0);
    assert.equal(r.rate(0), null);            // one sample
    r.sample(200, MB);
    assert.equal(r.rate(200), null);          // span 200 < 500
  });

  test('reports bytes/second across the window', () => {
    const r = createRateTracker();
    r.sample(0, 0);
    r.sample(1000, 10 * MB);                  // 10 MiB in 1 s
    assert.equal(Math.round(r.rate(1000) / MB), 10);
  });

  test('evicts samples older than windowMs', () => {
    const r = createRateTracker({ windowMs: 6000 });
    r.sample(0, 0);                           // will age out
    r.sample(7000, 70 * MB);
    r.sample(8000, 80 * MB);                  // last 1 s: 10 MiB
    // The 0-sample is older than 8000-6000=2000, so it's gone; rate is from the recent pair.
    assert.equal(Math.round(r.rate(8000) / MB), 10);
  });

  test('a decreasing byte count yields null (never negative)', () => {
    const r = createRateTracker();
    r.sample(0, 100 * MB);
    r.sample(1000, 50 * MB);
    assert.equal(r.rate(1000), null);
  });

  test('an idle gap decays the rate rather than reporting stale throughput', () => {
    const r = createRateTracker({ windowMs: 6000 });
    r.sample(0, 0);
    r.sample(1000, 10 * MB);                  // 10 MiB/s burst
    // Long idle: bytes unchanged across a wide span.
    r.sample(7000, 10 * MB);
    r.sample(8000, 10 * MB);
    assert.equal(r.rate(8000), 0);            // 0 gained across the retained window
  });
});
```

- [ ] **Step 2:** `node --test test/rate-tracker.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/rate-tracker.js`:**

```js
// Copyright (C) 2026 HidayahTech, LLC
// Sliding-window byte-rate tracker: from timestamped cumulative-byte samples, report the
// throughput over a recent window. Pure and clock-free (timestamps are inputs), so it is
// deterministically unit-testable. Modeled on the 6-second window inside BatchSummary.jsx.

export function createRateTracker({ windowMs = 6000, minSpanMs = 500 } = {}) {
  const samples = []; // { t, bytes } — cumulative bytes at time t (ms), oldest first
  return {
    sample(t, bytes) {
      samples.push({ t, bytes });
      const cutoff = t - windowMs;
      while (samples.length && samples[0].t < cutoff) samples.shift();
    },
    rate(t) {
      if (samples.length < 2) return null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const span = last.t - first.t;
      if (span < minSpanMs) return null;
      const gained = last.bytes - first.bytes;
      return gained >= 0 ? gained / (span / 1000) : null;
    },
  };
}
```

- [ ] **Step 4:** `node --test test/rate-tracker.test.js` — PASS.

- [ ] **Step 5: Write `test/components/use-rate.test.jsx` (failing).** This uses `node:test` mock timers (which also mock `Date`) so the interval + clock are deterministic:

```jsx
import '../helpers/with-dom.js';
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../helpers/render.js';
import { useRate } from '../../src/hooks/useRate.js';

const MB = 1024 * 1024;

function Probe({ bytes, active }) {
  const speed = useRate(bytes, active);
  return <span data-testid="speed">{speed == null ? 'null' : String(Math.round(speed / MB))}</span>;
}

describe('useRate', () => {
  test('returns a bytes/second rate once samples span the minimum, null when inactive', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    try {
      const m = mount(<Probe bytes={0} active={true} />);        // mount tick samples (0, 0)
      assert.equal(m.query('[data-testid=speed]').textContent, 'null');
      mock.timers.tick(250);                                     // t=250, sample (250, 0)
      m.render(<Probe bytes={5 * MB} active={true} />);          // bytes bumps
      mock.timers.tick(250);                                     // t=500, sample (500, 5 MiB) → span 500
      mock.timers.tick(250);                                     // t=750, sample (750, 5 MiB)
      const shown = Number(m.query('[data-testid=speed]').textContent);
      assert.ok(shown >= 6 && shown <= 7, `~6.7 MiB/s expected, got ${shown}`); // 5 MiB / 0.75 s
      m.render(<Probe bytes={5 * MB} active={false} />);         // deactivate
      assert.equal(m.query('[data-testid=speed]').textContent, 'null');
    } finally {
      mock.timers.reset();
      m?.cleanup?.();
    }
  });
});
```

Note: confirm the shared `mount` helper (`test/helpers/render.js`) exposes a re-render (`render`) on the returned handle; if it does not, use its documented re-render mechanism (mount the same component with new props). Adapt the assertion mechanics to the helper, keeping the meaning (speed is null until a spanning sample pair, then ~6.7 MiB/s, null when inactive).

- [ ] **Step 6:** `npm run test:ui -- ...use-rate...` (or `npm run test:ui`) — FAIL (hook missing).

- [ ] **Step 7: Implement `src/hooks/useRate.js`:**

```js
// Copyright (C) 2026 HidayahTech, LLC
// Sample a cumulative-byte value on an interval into a rate tracker and expose bytes/second.
// Only the SPEED needs periodic sampling — the displayed byte count comes straight from the
// reactive value. An interval (not rAF) because we sample a rate, not a smooth counter;
// background-tab timer throttling only sparsens samples, which the window rate tolerates.
import { useState, useEffect, useRef } from 'preact/hooks';
import { createRateTracker } from '../lib/rate-tracker.js';

export function useRate(bytes, active, { now = () => Date.now(), intervalMs = 250 } = {}) {
  const [speed, setSpeed] = useState(null);
  const bytesRef = useRef(bytes);
  bytesRef.current = bytes;
  useEffect(() => {
    if (!active) { setSpeed(null); return undefined; }
    const tracker = createRateTracker();
    const tick = () => { const t = now(); tracker.sample(t, bytesRef.current); setSpeed(tracker.rate(t)); };
    tick();
    const h = setInterval(tick, intervalMs);
    return () => clearInterval(h);
  }, [active]);
  return speed;
}
```

- [ ] **Step 8:** `npm run test:ui` — PASS. `npm test` — no regressions.
- [ ] **Step 9: Commit:**

```bash
git add src/lib/rate-tracker.js src/hooks/useRate.js test/rate-tracker.test.js test/components/use-rate.test.jsx
git commit -m "feat: sliding-window rate tracker and the useRate hook"
```

---

### Task 2: `zip-job.js` — emit the active file in onProgress

**Files:**
- Modify: `src/lib/zip-job.js` (the `issue` closure inside `runZipJob`)
- Test: `test/zip-job-run.test.js` (extend)

**Interfaces:**
- Produces: `runZipJob`'s `onProgress` payload gains `active`: `onProgress({ done, bytesDone, active })` where `active` is `{ key, size, bytes }` for the file currently streaming, or `null` when no entry is in flight (after `endEntry`, and after the whole run). `done` and `bytesDone` are unchanged. (`bytesTotal` is NOT emitted here — App sets it once from the job counters; see Task 4.)

- [ ] **Step 1: Read `src/lib/zip-job.js` fully.** Locate the `issue` closure inside `runZipJob` (the one that tracks `inFlightBytes`, `bytesDone`, `completed`). Every `onProgress?.({ done, bytesDone })` call there becomes `onProgress?.({ done, bytesDone, active })`.

- [ ] **Step 2: Write the failing test** — extend `test/zip-job-run.test.js`. Model it on the existing `runZipJob` happy-path test (same fake OPFS root, fake fetch, fake-indexeddb `job()` factory). Capture every `onProgress` payload and assert:
  - While a file is streaming, at least one payload has `active` with `{ key: <that item's key>, size: <that item's size>, bytes > 0 }` and `active.bytes <= active.size`.
  - The final payload (after the last `endEntry`) has `active === null`.
  - `bytesDone` is still cumulative and monotonic (existing assertion preserved).

```js
// inside test/zip-job-run.test.js, a new test in the existing describe:
test('onProgress reports the active file while streaming and null between/after', async () => {
  // ... build a 2-item job with known keys/sizes and deterministic bodies (reuse the
  // file's existing helpers) ...
  const payloads = [];
  await runZipJob(job, { presign, probe, fetchImpl, root, onProgress: (p) => payloads.push({ ...p }) });
  const active = payloads.filter(p => p.active);
  assert.ok(active.length > 0, 'saw an active file while streaming');
  assert.ok(active.every(p => p.active.bytes > 0 && p.active.bytes <= p.active.size));
  assert.ok(active.some(p => p.active.key === job.items[0].key)); // adapt to the real item shape
  assert.equal(payloads[payloads.length - 1].active, null, 'active cleared at the end');
});
```

- [ ] **Step 3:** `node --test test/zip-job-run.test.js` — FAIL (payloads have no `active`).

- [ ] **Step 4: Implement.** In the `issue` closure: track the active descriptor. Set `let active = { key: item.key, size: item.size ?? 0, bytes: 0 }` at entry start; on each chunk set `active.bytes = inFlightBytes` and pass `active` in the `onProgress` call; after `endEntry` set the closure's `active` reference used by `onProgress` back to `null` and emit one `onProgress({ done, bytesDone, active: null })`. The active reference must live where every `onProgress` call in the closure can read it (declare it alongside `inFlightBytes`). Do NOT change frequency, `done`, `bytesDone`, resume, or the mid-entry recovery.

- [ ] **Step 5:** `node --test test/zip-job-run.test.js` — PASS. `npm test` — no regressions.
- [ ] **Step 6: Commit:**

```bash
git add src/lib/zip-job.js test/zip-job-run.test.js
git commit -m "feat: zip job reports the active file in its progress payload"
```

---

### Task 3: `loadZipDetail` — capped per-file read for the detail view

**Files:**
- Modify: `src/lib/download-records.js` (add `loadZipDetail`)
- Test: `test/indexeddb-storage.test.js` OR a focused `test/zip-detail.test.js` (fake-indexeddb)

**Interfaces:**
- Consumes: the existing item store + `eachItemByStatus`/`ITEM_STATUS` in `download-records.js`.
- Produces: `async loadZipDetail(jobId, { doneCap = 20, failedCap = 20 } = {}) -> { done: [{ key, size }], failed: [{ key }], doneCount, failedCount }` — `done` is the most-recently-completed DONE items (up to `doneCap`), `failed` up to `failedCap`; `doneCount`/`failedCount` are the full counts. "Most recent" = the natural completion order; if items carry no completion timestamp, return the last `doneCap` in iteration order and document that.

- [ ] **Step 1: Read `src/lib/download-records.js`** — the item record shape, `eachItemByStatus`, `countItemsByStatus`, `ITEM_STATUS`. Confirm whether a DONE item carries an ordering field (e.g. `zipEnd`, `issuedAt`) usable for "most recent"; `zipEnd` (byte offset, ascending with completion) is a good proxy for zip jobs.

- [ ] **Step 2: Write the failing test** (fake-indexeddb; model on `test/indexeddb-storage.test.js`): seed a job with, say, 25 DONE items (with sizes and ascending `zipEnd`), 3 FAILED, 5 PENDING. Assert `loadZipDetail(jobId)` returns `done.length === 20` (the 20 highest `zipEnd`, i.e. most recent), each `{ key, size }`; `failed.length === 3` each `{ key }`; `doneCount === 25`, `failedCount === 3`.

- [ ] **Step 3:** Run — FAIL.

- [ ] **Step 4: Implement `loadZipDetail`** in `download-records.js`: gather DONE items via `eachItemByStatus` into an array, sort by `zipEnd` descending (fallback: leave in iteration order), slice `doneCap`, map to `{ key, size }`; FAILED similarly to `{ key }`; counts via `countItemsByStatus` (or the gathered lengths). Keep it best-effort/no-op-safe without IndexedDB, consistent with the file's other readers.

- [ ] **Step 5:** Run the new test — PASS. `npm test` — no regressions.
- [ ] **Step 6: Commit:**

```bash
git add src/lib/download-records.js test/zip-detail.test.js
git commit -m "feat: capped per-file detail read for zip progress"
```

---

### Task 4: App wiring — static bytesTotal, forward active, jobId, pass the detail reader

**Files:**
- Modify: `src/components/App.jsx` (`handleZipStart`; the `<MasterQueue .../>` render site)
- Modify: `src/lib/queue-tasks.js` (`createDownloadTask` gains `jobId`, `bytesTotal`)
- Test: `test/source-invariants.test.js` (extend)

**Interfaces:**
- Consumes: `runZipJob`'s enriched `onProgress` (Task 2); `loadZipDetail` (Task 3); the job sendable-bytes counter.
- Produces:
  - Task fields (additive): `jobId`, `bytesTotal`, `active` (in addition to the existing `bytesDone`).
  - The `<MasterQueue>` element gets a `readZipDetail` prop: `(jobId) => loadZipDetail(jobId, …)`.

- [ ] **Step 1: Read `handleZipStart` and the `<MasterQueue>` render site in `App.jsx`.** Find how the job's sendable **bytes** total is available (the job-row counters — see `download-records.js:124-130`; if App already builds job rows with `counters`, reuse `counters.bytesSendable`; otherwise sum the sizes of non-SKIPPED items once at start). Find where `<MasterQueue>` is rendered and what props it currently takes.

- [ ] **Step 2: Write the failing source-invariant tests** in `test/source-invariants.test.js` (this file asserts on `App.jsx`/`queue-tasks.js` source text, the pattern already used for `handleZipStart`):
  - `handleZipStart` sets `bytesTotal` on the task (matches `bytesTotal` in the task creation/update near `handleZipStart`).
  - `handleZipStart`'s `onProgress` forwards `active` (the update call includes `active`).
  - `handleZipStart` tags the task with `jobId`.
  - `createDownloadTask` accepts and stores `jobId` and `bytesTotal`.
  - `<MasterQueue` is passed a `readZipDetail` prop.

- [ ] **Step 3:** Run — FAIL.

- [ ] **Step 4: Implement.**
  - `queue-tasks.js`: `createDownloadTask({ …, jobId, bytesTotal })` stores both (additive; omitted → undefined).
  - `handleZipStart`: pass `jobId: fresh.id` and `bytesTotal: <sendable bytes>` into `createDownloadTask`/the initial `taskStore.update`; change the `onProgress` from `{ current: done, bytesDone }` to `{ current: done, bytesDone, active }`.
  - Render site: `<MasterQueue … readZipDetail={(jobId) => loadZipDetail(jobId)} />` (import `loadZipDetail`).

- [ ] **Step 5:** `npm test` — PASS. `npm run build` — succeeds; then restore `dist/index.html` (`git checkout -- dist/index.html`) and remove any stale untracked `dist/integrity.json`. Commit only source/test.
- [ ] **Step 6: Commit:**

```bash
git add src/components/App.jsx src/lib/queue-tasks.js test/source-invariants.test.js
git commit -m "feat: thread bytesTotal, active file, and jobId onto the zip task"
```

---

### Task 5: `MasterQueue.jsx` — enriched line, bar, and the active-focused detail

**Files:**
- Modify: `src/components/MasterQueue.jsx`
- Test: `test/components/master-queue-download.test.jsx` (extend)

**Interfaces:**
- Consumes: `useRate` (Task 1); `formatBytes/formatSpeed/formatEta` (`src/lib/format.js`); the task fields `current, total, bytesDone, bytesTotal, active, failed, delivery, status`; the `readZipDetail` prop (Task 4).

- [ ] **Step 1: Read `MasterQueue.jsx`** — `downloadSummary`, `TaskRow`, the existing expand toggle (`expanded = isSettled && hasErrors && !task.collapsed`), and the row markup. Note where the summary line and the (settled) errors section render.

- [ ] **Step 2: Write failing component tests** in `test/components/master-queue-download.test.jsx` (model on the file's existing `addZip` helper and fakes). Cover:
  1. A running zip task with `{ delivery:'zip', status:'running', current:12, total:4231, bytesDone: 1.2e9, bytesTotal: 3.4e9, failed:1 }` renders the files line `Zipping · 12 of 4,231 files · 1 failed` and a byte line containing `of` and a formatted total (exact `formatBytes` string), and a progress bar element at ~35%.
  2. With no `speed` available (fresh), the byte line has NO `/s` or `ETA`; the test can force a speed by rendering after enough sampled frames OR by asserting the speed/ETA are gated (assert absence when the rate is null).
  3. The expand toggle is present while `status:'running'` for a zip task (today it's only present when settled+errors).
  4. Expanding calls `readZipDetail(task.jobId)` and, given a resolved `{ done:[{key,size}], failed:[{key}], doneCount, failedCount }`, renders: the active row (`▶ key  bytes / size (pct%)`) from `task.active`, the completed `✓` rows, the failed `✗` rows, and a footer `…and N queued · M more done` (queued = `total - doneCount - failedCount`; overflow when `doneCount > done.length`). Use a fake `readZipDetail` returning a resolved promise.
  5. A non-zip (handoff) running task is unchanged (regression guard) and a `delivery:'zip'` PAUSED task still shows the existing `Paused — N of M zipped, K failed` label (do not break the honest-label states).

- [ ] **Step 3:** `npm run test:ui` — FAIL.

- [ ] **Step 4: Implement.**
  - Import `formatBytes/formatSpeed/formatEta` and `useRate`.
  - In `TaskRow` for a `delivery === 'zip'` running task: `const speed = useRate(task.bytesDone ?? 0, task.status === 'running')`. Render two info lines (files line; byte line with speed/ETA gated on `speed > 0` and on `bytesTotal`); a progress bar `bytesDone / bytesTotal` (fallback to count-only when `bytesTotal` is falsy). Keep the existing non-zip `downloadSummary` output for other tasks.
  - Open the expand toggle for a running zip task (extend the `expanded`/toggle gate so `delivery === 'zip' && status === 'running'` can expand). When expanded on a zip task, call `readZipDetail(task.jobId)` (via a `useState` + `useEffect` that re-reads when `task.current` changes while open), and render the active-focused detail (active row from `task.active`, `done`/`failed` rows, queued/overflow footer). Cap rendering to what `loadZipDetail` returns (already capped).
  - All copy sentence-case, no exclamation marks. The detail read is via the injected `readZipDetail` prop only — no `download-records`/IndexedDB import in this component.

- [ ] **Step 5:** `npm run test:ui`, `npm test`, `npm run build` — green. Restore `dist/index.html`, drop stale `dist/integrity.json`; commit only source/test.
- [ ] **Step 6: Commit:**

```bash
git add src/components/MasterQueue.jsx test/components/master-queue-download.test.jsx
git commit -m "feat: the master queue shows zip byte/speed/ETA progress and an expandable file detail"
```

---

### Task 6: Full container regression matrix

**Files:** none changed.

- [ ] **Step 1:** Run `npm run test:e2e:container` to completion (babysit — no output for 5+ min means kill, diagnose, re-run). This change touched e2e-relevant code (`MasterQueue.jsx`, `zip-job.js`, `App.jsx`), so confirm the existing zip arms and the handoff path are unaffected.
- [ ] **Step 2:** Compare to the Task 0 baseline: browser lanes must remain **54 tests/lane, 0 failures** — this feature adds NO e2e specs, so counts must be UNCHANGED (not +N). Any count change or red lane is a regression from Tasks 4–5 → report BLOCKED; do not modify existing specs.
- [ ] **Step 3:** Record the result to `.claude-scratch/e2e-progress-matrix.txt` (do not commit).

---

### Task 7: Release gate (operator-in-the-loop)

- [ ] **Step 1:** Present the change summary and proposed **minor** bump (v1.46.0 → **v1.47.0**; new user-facing feature); STOP for the operator's confirmation of the level.
- [ ] **Step 2:** `npm version <confirmed> --no-git-tag-version`.
- [ ] **Step 3:** CHANGELOG top entry (first line self-contained):

```markdown
## [<x.y.0>] — <date> — Watch the ZIP fill

A running ZIP download now shows real progress — bytes done and total, transfer speed, and time remaining, with a progress bar — instead of just "Zipping…". Expand it to see the file downloading right now, the files already added, any that failed, and how many remain. Matches how uploads report progress. The per-file browser download is unchanged.
```

- [ ] **Step 4:** `npm run build`, `npm test`, `npm run test:ui` — green.
- [ ] **Step 5:** Commit bump + `dist/index.html` + `src/lib/changelog.js` + CHANGELOG together; STOP before any push.

---

## Self-review notes

- Spec coverage: rate tracker + hook → T1; active-file emission → T2; capped per-file read (IndexedDB, no-SDK-in-component) → T3; static `bytesTotal` + forward `active` + `jobId` + inject reader → T4; enriched line/bar + expand-while-running + active-focused detail + edge fallbacks → T5; regression (no new e2e claim) → T6; release → T7.
- `bytesTotal` handled as static-set-once (App, T4), a refinement over the spec's "emit it" — same result, simpler; the spec's intent (bytesTotal available to the UI) is met.
- Type consistency: `active = { key, size, bytes }` used identically in T2 (producer), T4 (forwarded), T5 (rendered); `loadZipDetail` return `{ done:[{key,size}], failed:[{key}], doneCount, failedCount }` used identically in T3 (producer) and T5 (consumer via `readZipDetail`).
- No-SDK rule: only T3 (`download-records.js`) and T4 (App wrapper) touch IndexedDB; T5 reads detail solely through the injected `readZipDetail` prop.
