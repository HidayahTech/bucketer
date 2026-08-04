# Download Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speed up ZIP downloads of many files by fetching up to N files concurrently (bounded prefetch) while the single ZIP writer still appends them serially — overlapping network round-trips with the OPFS append.

**Architecture:** Separate the concurrent DOWNLOAD from the serial WRITE. A bounded pool of N fetch workers downloads files into tier-sized buffers (tiny → memory, medium → OPFS temp, huge → streamed solo), each computing its CRC; a single writer drains ready buffers in completion order into the one staging ZIP. The ZIP writer, resume, gate, and progress feature are reused/extended; `runDownloadJob` and the handoff path are untouched.

**Tech Stack:** Preact, esbuild, `node --test` (unit), fake-indexeddb + fake OPFS + fake fetch (as in `test/zip-job-run.test.js`), jsdom (`npm run test:ui`), Playwright container matrix. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-04-download-concurrency-design.md` — read it first. Its "Operator decisions" and "Panel decisions (D1–D8)" bind this plan.

## Global Constraints

- Branch: `download-concurrency` (off `main` @ v1.47.0, which includes the ZIP download + progress features). Never push without operator confirmation; pre-push hook builds + tests and tags the working-tree version.
- `npm test` (unit) / `npm run test:ui` (component, `../helpers/with-dom.js` first import) / `npm run test:e2e:container` (only source of e2e coverage claims; baseline first per the E2E Evidence Rules).
- **No new npm dependencies.**
- **ZIP path only.** No change to `runDownloadJob` (`download-queue.js`) or the handoff (per-file browser download) tier. All task/job/item model changes additive; a legacy/handoff task renders exactly as today.
- **No SDK/IndexedDB/OPFS I/O inside components.** MasterQueue reads only via injected props.
- Copy style: sentence case, plain, no exclamation marks.
- **Panel constants (D1/D2):** `CONCURRENCY = 4` (configurable up to 8); `TINY_MAX = 4 MiB`, `MEDIUM_MAX = 64 MiB` (tiny ≤ TINY_MAX → memory; ≤ MEDIUM_MAX → OPFS temp; else solo). `N` bounds total concurrent fetches. Tunable constants in one module.
- **Preserve the ZIP writer format + resume + gate + honest labels.** The writer already accepts records out of physical order (central directory carries offsets) — rely on that for completion-order append.
- Version bump only in the final task, after the operator's level confirmation, with CHANGELOG + rebuilt `dist/index.html` + `src/lib/changelog.js` in the same commit.
- **Phase 2 (in-place offset composition) is OUT OF SCOPE** — documented in the spec, not built here.

---

### Task 0: E2E baseline

**Files:** none changed.

- [ ] **Step 1:** `git status --short` — no modified tracked files.
- [ ] **Step 2:** This branch is based on `main` @ v1.47.0, whose full container matrix was run and recorded on 2026-08-04 (all 10 lanes green: node 53/53; desktop 54/53/0/1; mobile 54/51/0/3; webkit-desktop 54/52/0/2; image `mcr.microsoft.com/playwright:v1.60.0-noble`). Confirm `git merge-base main HEAD` equals the current `main` tip; if so, reuse that recording as the baseline. Otherwise run `npm run test:e2e:container` and record to `.claude-scratch/e2e-baseline-concurrency.txt`.

---

### Task 1: Tier router + concurrency constants

**Files:**
- Create: `src/lib/zip-prefetch.js` (constants + `classifyTier`; extended in Task 3)
- Test: `test/zip-prefetch.test.js`

**Interfaces:**
- Produces:
  - Constants `CONCURRENCY = 4`, `MAX_CONCURRENCY = 8`, `TINY_MAX = 4*1024*1024`, `MEDIUM_MAX = 64*1024*1024`.
  - `classifyTier(size) -> 'memory' | 'temp' | 'solo'` — `size <= TINY_MAX` → `'memory'`; `size <= MEDIUM_MAX` → `'temp'`; else `'solo'`. A missing/zero size → `'memory'` (a 0-byte or unknown file is trivially bufferable).

- [ ] **Step 1: Write `test/zip-prefetch.test.js` (failing):**

```js
// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, TINY_MAX, MEDIUM_MAX, CONCURRENCY } from '../src/lib/zip-prefetch.js';

describe('classifyTier', () => {
  test('tiny/medium/solo boundaries', () => {
    assert.equal(classifyTier(0), 'memory');
    assert.equal(classifyTier(TINY_MAX), 'memory');
    assert.equal(classifyTier(TINY_MAX + 1), 'temp');
    assert.equal(classifyTier(MEDIUM_MAX), 'temp');
    assert.equal(classifyTier(MEDIUM_MAX + 1), 'solo');
  });
  test('missing size is bufferable', () => {
    assert.equal(classifyTier(undefined), 'memory');
    assert.equal(classifyTier(null), 'memory');
  });
  test('default concurrency is 4', () => { assert.equal(CONCURRENCY, 4); });
});
```

- [ ] **Step 2:** `node --test test/zip-prefetch.test.js` — FAIL.
- [ ] **Step 3: Implement `src/lib/zip-prefetch.js`:**

```js
// Copyright (C) 2026 HidayahTech, LLC
// Bounded-prefetch tuning + the file-size tier router for concurrent ZIP downloads.
// See docs/superpowers/specs/2026-08-04-download-concurrency-design.md (D1, D2).

export const CONCURRENCY = 4;        // default concurrent fetches
export const MAX_CONCURRENCY = 8;    // ceiling
export const TINY_MAX = 4 * 1024 * 1024;    // <= this: buffer in memory
export const MEDIUM_MAX = 64 * 1024 * 1024; // <= this: buffer in an OPFS temp file; else stream solo

export function classifyTier(size) {
  const n = size || 0;
  if (n <= TINY_MAX) return 'memory';
  if (n <= MEDIUM_MAX) return 'temp';
  return 'solo';
}
```

- [ ] **Step 4:** `node --test test/zip-prefetch.test.js` PASS; `npm test` green.
- [ ] **Step 5: Commit:**

```bash
git add src/lib/zip-prefetch.js test/zip-prefetch.test.js
git commit -m "feat: tier router and concurrency constants for prefetch"
```

---

### Task 2: OPFS temp store (medium-tier buffers)

**Files:**
- Modify: `src/lib/zip-prefetch.js` (add the temp store)
- Test: `test/zip-prefetch.test.js` (extend, using the fake OPFS root from `test/zip-job-run.test.js`)

**Interfaces:**
- Produces `createTempStore(root)` returning:
  - `async put(name, chunksIterable) -> { size }` — streams chunks into an OPFS temp file `bucketer-tmp-<name>` via `createWritable()`, returns the byte size.
  - `async open(name) -> { stream() -> AsyncIterable<Uint8Array> }` — reads the temp file back in chunks (via `getFile()` then a chunked read) so the writer can stream it in without materializing the whole file.
  - `async remove(name)` — best-effort delete.
  - `async removeAll()` — delete every `bucketer-tmp-*` file this store created (cleanup on cancel/failure).

- [ ] **Step 1: Write failing tests** — reuse the `fakeOpfsRoot()` helper from `test/zip-job-run.test.js` (import/copy it): `put` writes bytes and reports size; `open().stream()` yields the same bytes back; `remove` deletes; `removeAll` clears all temp files but leaves non-temp files. Assert against the fake root's `files` map.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** `createTempStore` in `zip-prefetch.js`. Track the set of temp names created so `removeAll` can target them. `open().stream()` reads via `getFile()` and yields `TEMP_CHUNK`-sized (e.g. 8 MiB) slices.
- [ ] **Step 4:** Tests PASS; `npm test` green.
- [ ] **Step 5: Commit:**

```bash
git add src/lib/zip-prefetch.js test/zip-prefetch.test.js
git commit -m "feat: OPFS temp store for medium-tier prefetch buffers"
```

---

### Task 3: The prefetch pool + serial-writer orchestration

**Files:**
- Modify: `src/lib/zip-prefetch.js` (add `runPrefetch`)
- Test: `test/zip-prefetch-run.test.js` (new; fake fetch + fake OPFS)

**Interfaces:**
- Consumes: `classifyTier`, `createTempStore` (Tasks 1–2); the reusable worker-pool pattern in `uploadPartsWithPool` (`src/lib/upload-queue.js`) — generalize it or mirror it (N workers pulling from a shared queue).
- Produces:
  - `async runPrefetch(items, { fetchImpl, presign, probe, root, concurrency = CONCURRENCY, thresholds, onReady, onProgress, shouldCancel = () => false }) -> { failed: [{item, message}], denied, cancelled }`
    - Runs up to `concurrency` concurrent fetch workers. Each worker: takes the next PENDING item; `probe`s it (reuse the existing probe → DENIED/NETWORK/etc. handling); on OK, `presign`s and `fetchImpl`s it; buffers by tier (`memory` → accumulate a Uint8Array; `temp` → `tempStore.put`; `solo` → hand the live stream straight to `onReady` without buffering); computes the CRC while streaming; then calls `onReady({ item, tier, crc, size, bytes: () => AsyncIterable })` and WAITS for `onReady` to resolve before taking the next item (backpressure: this bounds ready buffers).
    - `onReady(entry)` is the SERIAL writer callback (Task 4 supplies it — it appends the entry to the ZIP and returns when done). runPrefetch guarantees `onReady` is never called concurrently (a single-slot mutex/lock), so the writer stays serial while fetches overlap.
    - `onProgress` reports the in-flight set for the progress feature: `onProgress({ active: [ {key,size,bytes} for each in-flight fetch ], bytesDone })` where `bytesDone` = total bytes downloaded across all workers so far (committed + in-flight). Emitted as bytes stream in.
    - Failures: a fetch/probe failure on an item → record `{item, message}` in `failed`, discard its buffer/temp, do NOT call `onReady`; the worker continues. The DENIED breaker is a **rolling count** — trip `denied` (job-wide) when consecutive-independent DENIED reaches 3; reset on any success (D4).
    - `shouldCancel()` truthy → stop taking new items, abort in-flight fetches (each `fetchImpl` gets an `AbortSignal`), set `cancelled`.

- [ ] **Step 1: Write `test/zip-prefetch-run.test.js` (failing).** Use a deterministic fake `fetchImpl` (bodies keyed by URL, multi-chunk, with an `AbortSignal`), the fake OPFS root, and a recording `onReady` that appends `{key}` to an array. Test cases:
  1. **Overlap + completion order:** 5 tiny items with staggered fake-fetch delays → `onReady` is called for all 5, never concurrently (assert a "writer busy" flag is never doubly-set), in COMPLETION order (fastest first), and `onProgress` saw `active.length > 1` at some point (proving concurrency) with monotonic `bytesDone`.
  2. **Tier routing:** a mix of tiny/medium/solo (sizes around the thresholds) → memory items never touch the temp store; medium items create+delete a temp file; solo items stream without buffering (assert via the fake root's `files` map and a temp-put spy).
  3. **Backpressure:** a slow `onReady` (writer) with fast fetches → assert the number of buffers held at once never exceeds ~concurrency (a counter incremented on fetch-complete, decremented on onReady-done, max asserted ≤ concurrency+1).
  4. **Failure isolation:** one item's fetch throws mid-body → it lands in `failed` with a message, its buffer/temp is gone (temp `removeAll`-able / not left behind), the other items still complete and `onReady`.
  5. **Rolling DENIED breaker:** a probe returning DENIED for 3 items → `denied` is set (job-wide), matching the existing 3-streak behavior.
  6. **Cancel:** `shouldCancel` flips true after 2 completions → remaining fetches abort, `cancelled` true, no `onReady` after cancel.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement `runPrefetch`.** Generalize `uploadPartsWithPool` (or add a `runPool(items, worker, n)` to `upload-queue.js` and reuse it for both). Use a single-slot async lock around `onReady` for serial writes. Track in-flight active entries for `onProgress`. Wire `AbortController` per fetch for cancel. Keep the tier buffering + CRC as specified.
- [ ] **Step 4:** `node --test test/zip-prefetch-run.test.js` PASS; `npm test` green.
- [ ] **Step 5: Commit:**

```bash
git add src/lib/zip-prefetch.js src/lib/upload-queue.js test/zip-prefetch-run.test.js test/upload-queue.test.js
git commit -m "feat: bounded prefetch pool feeding a serial writer in completion order"
```

---

### Task 4: Integrate concurrency into `runZipJob`

**Files:**
- Modify: `src/lib/zip-job.js` (the orchestration inside `runZipJob`)
- Test: `test/zip-job-run.test.js` (extend)

**Interfaces:**
- Consumes: `runPrefetch` (Task 3); the existing `createZipWriter`, OPFS staging, item-status helpers, `promoteIssuedToDone`, resume logic.
- Produces: `runZipJob` now downloads concurrently. Its `issue`-per-item sequential path (via `runDownloadJob`) is REPLACED with `runPrefetch` feeding a serial `onReady` that appends the entry through the existing `createZipWriter` (memory buffer → `update` the bytes; temp → stream the temp file's chunks through `update`; solo → stream the live body through `update`), then persists the DONE item + entry record exactly as today (`updateItem(..., { status: DONE, ...rec })`). `runDownloadJob` is NO LONGER called by `runZipJob`; the handoff path keeps using it. Resume, finish-from-persisted-records, the quota-pause (`jobBlock`/STORAGE), and cancel are preserved — mapped onto `runPrefetch`'s `failed`/`denied`/`cancelled` results.

- [ ] **Step 1: Read `src/lib/zip-job.js` fully.** The current `runZipJob` uses `runDownloadJob` with an injected `issue` closure. You are replacing that with `runPrefetch(...)` + a serial `onReady` writer. Keep EVERYTHING else: the staging open/truncate/resume (`resumeAt`), the mid-run `promoteIssuedToDone`→DONE model (now: `onReady` writes the entry then `updateItem` DONE directly — no ISSUED clobber to work around, since `runDownloadJob` is gone; write DONE directly after the descriptor), the finish-from-DONE-records, the quota `jobBlock`→STORAGE pause, and the discard/cleanup.
- [ ] **Step 2: Write failing tests** — extend `test/zip-job-run.test.js`. Keep ALL existing tests passing (they now exercise the concurrent path). Add:
  1. A multi-item job downloads concurrently and produces a byte-valid ZIP with all entries + correct CRCs (reuse the shared reader); `active` was a LIST at some point during the run.
  2. Resume after interruption still yields a byte-valid ZIP (the existing resume test, now over the concurrent path).
  3. A QuotaExceededError while writing/temping pauses the job (STORAGE block), and `tempStore.removeAll` freed the temps (assert no `bucketer-tmp-*` left in the fake root).
  4. Cancel aborts fetches, deletes temps, leaves the job resumable.
- [ ] **Step 3:** Run — FAIL.
- [ ] **Step 4: Implement.** Replace the `runDownloadJob` call with `runPrefetch`; write the serial `onReady`; map failures/denied/cancelled onto the existing result shape `{ issued, failed, cancelled, errors, blocked, finished }`. On any exit path, `tempStore.removeAll()`. Preserve the resume/finish/quota logic.
- [ ] **Step 5:** `node --test test/zip-job-run.test.js` PASS; `npm test` green.
- [ ] **Step 6: Commit:**

```bash
git add src/lib/zip-job.js test/zip-job-run.test.js
git commit -m "feat: runZipJob downloads concurrently via the prefetch pool"
```

---

### Task 5: Progress — migrate `active` (single) to a list

**Files:**
- Modify: `src/lib/zip-job.js` (`onProgress` emits `active` as an array — from `runPrefetch`'s in-flight set)
- Modify: `src/components/App.jsx` (`handleZipStart` forwards the `active` array; `bytesDone` aggregate is already forwarded)
- Modify: `src/components/MasterQueue.jsx` (render an active-LIST — one `▶` row per in-flight file)
- Test: `test/zip-job-run.test.js`, `test/components/master-queue-download.test.jsx` (extend)

**Interfaces:**
- `runZipJob`'s `onProgress` payload: `active` becomes `[{ key, size, bytes }]` (0..N entries), `null`/`[]` when nothing in flight. `bytesDone` unchanged (aggregate).
- `MasterQueue` detail: replace the single active row with `task.active.map(a => <activeRow>)`. Everything else in the detail (done/failed/queued) unchanged.

- [ ] **Step 1: Write failing tests:** zip-job — `onProgress` payloads include an `active` ARRAY with >1 entry during a concurrent run. Component — a running zip task with `active: [{...},{...},{...}]` renders three `▶` rows (each with its own bytes/%), and `active: []`/absent renders none; the aggregate line + done/failed/queued unchanged.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** zip-job: pass `runPrefetch`'s in-flight active set (already a list) straight through. App: `active` is forwarded verbatim (already is — it just holds an array now). MasterQueue: map over `task.active` (guard: treat a non-array/absent as empty; a single-object `active` from a legacy in-flight task, if any, wrap as `[active]` for safety). Keep copy sentence-case.
- [ ] **Step 4:** `npm run test:ui`, `npm test`, `npm run build` green. Restore `dist/index.html`, drop stale `dist/integrity.json`.
- [ ] **Step 5: Commit:**

```bash
git add src/lib/zip-job.js src/components/App.jsx src/components/MasterQueue.jsx test/zip-job-run.test.js test/components/master-queue-download.test.jsx
git commit -m "feat: show the N concurrently-downloading files in the progress detail"
```

---

### Task 6: App wiring — quota temp reserve, cancel/discard cleanup, concurrency config

**Files:**
- Modify: `src/components/App.jsx` (`handleZipStart` passes `concurrency` + `root`; discard/cancel path)
- Modify: `src/lib/zip-job.js` (`zipGate`/fit check reserves temp headroom) OR `src/lib/browser-capability.js` — wherever the fit gate lives
- Test: `test/zip-job.test.js` (the gate), `test/source-invariants.test.js` (App wiring)

**Interfaces:**
- The fit gate reserves `CONCURRENCY * MEDIUM_MAX` on top of `sendableBytes`: `sendableBytes + CONCURRENCY*MEDIUM_MAX <= QUOTA_SAFETY * free` (D4). (Confirm where the fit check is — `zipGate` in `zip-job.js`; add the reserve there, keeping unknown-quota optimistic.)
- `handleZipStart` passes `concurrency: CONCURRENCY` (a constant for now; a Settings knob is out of scope for this task) and the OPFS `root` through to `runZipJob`.
- `downloadApi.discard` / cancel for a zip job already deletes staging; ensure it also triggers `tempStore.removeAll` (runZipJob does this on its exit paths — confirm the cancel path reaches it).

- [ ] **Step 1: Write failing tests:** `zip-job.test.js` — `zipGate` returns `needs-storage`/`unavailable` when `sendableBytes + CONCURRENCY*MEDIUM_MAX` exceeds headroom but `sendableBytes` alone would fit (the reserve tips it over); unknown-quota still optimistic. Source-invariant — `handleZipStart` passes `concurrency`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** the gate reserve + the App wiring.
- [ ] **Step 4:** `npm test`, `npm run test:ui`, `npm run build` green; restore dist.
- [ ] **Step 5: Commit:**

```bash
git add src/lib/zip-job.js src/components/App.jsx test/zip-job.test.js test/source-invariants.test.js
git commit -m "feat: reserve quota headroom for prefetch temps; pass concurrency through"
```

---

### Task 7: E2E — concurrent ZIP + full matrix

**Files:**
- Modify: `test/e2e/browser/download-zip.test.mjs` (add a many-small-files arm) OR a new spec
- Test: full container matrix.

- [ ] **Step 1: Add an e2e arm** (chromium + firefox lanes): seed ~12 small files under a folder; download as ZIP; assert ONE download event and the ZIP parses with all 12 files, correct bytes/CRCs (the observable is unchanged from the ZIP feature — concurrency must not change correctness). The interruption/resume arm already exists; confirm it still passes over the concurrent path. Selectors verified against the real DOM first. Do NOT assert timing/concurrency in e2e (timing-sensitive — the probe measures that).
- [ ] **Step 2:** Full `npm run test:e2e:container` — all lanes green; compare to the Task 0 baseline; the browser lanes gain exactly the new arm's count (attributable), no pre-existing spec regresses. A regression → report BLOCKED.
- [ ] **Step 3: Commit:**

```bash
git add test/e2e/browser/download-zip.test.mjs
git commit -m "test: e2e — a many-file ZIP downloads correctly over the concurrent path"
```

---

### Task 8: Throughput probe (spec-mandated, D6)

**Files:**
- Create: `docs/review-download-parity/probe/zip-concurrency-scale.md` (results)
- Possibly extend the parity probe harness under `docs/review-download-parity/probe/` (read its README first).

- [ ] **Step 1:** Build/extend a probe that runs a many-small-files ZIP download (e.g. 200 × ~1 MiB from the mock) SEQUENTIALLY (concurrency 1) vs CONCURRENTLY (concurrency 4), in the containerized chromium + firefox, measuring wall-clock, peak process memory, and peak OPFS usage. Follow `docs/review-download-parity/README.md`'s method (fresh browser per measurement, reps, a control).
- [ ] **Step 2:** Record in `zip-concurrency-scale.md`: the speedup (concurrent vs sequential wall-clock) and confirmation that peak memory ≤ ~N×TINY_MAX and peak OPFS ≤ ZIP + ~N×MEDIUM_MAX (bounded). If concurrency does NOT beat sequential, or memory/OPFS is unbounded, report the numbers and STOP for the operator.
- [ ] **Step 3: Commit the results (+ probe changes):**

```bash
git add docs/review-download-parity/probe/zip-concurrency-scale.md
git commit -m "docs: measured concurrent-vs-sequential ZIP download — speedup + bounded memory"
```

---

### Task 9: Release gate (operator-in-the-loop)

- [ ] **Step 1:** Present the change summary and proposed **minor** bump (v1.47.0 → **v1.48.0**); confirm the level (operator has pre-authorized minor-by-default for this arc — proceed unless told otherwise).
- [ ] **Step 2:** `npm version <confirmed> --no-git-tag-version`.
- [ ] **Step 3:** CHANGELOG top entry (first line self-contained):

```markdown
## [<x.y.0>] — <date> — Download in parallel

ZIP downloads now fetch several files at once instead of one at a time, so a folder of many small files finishes much faster. Small files buffer in memory, medium files in the browser's private storage, and large files stream one at a time; the archive is assembled the same way, and resume, progress, and the single save dialog are unchanged. The expanded progress detail shows the files downloading right now.
```

- [ ] **Step 4:** `npm run build`, `npm test`, `npm run test:ui` — green.
- [ ] **Step 5:** Commit bump + `dist/index.html` + `src/lib/changelog.js` + CHANGELOG together; STOP before any push.

---

## Self-review notes

- Spec coverage: tier router + constants → T1; OPFS temp store → T2; pool + serial writer + completion-order + backpressure + rolling-DENIED + cancel → T3; runZipJob integration + resume/finish/quota/temp-cleanup → T4; active→list progress → T5; quota temp reserve + wiring → T6; e2e observable → T7; throughput/memory/OPFS probe (D6) → T8; release → T9. Phase 2 (in-place) explicitly out of scope.
- Type consistency: `active` is `[{key,size,bytes}]` in T5 (producer zip-job, consumer MasterQueue); `onReady(entry)`/`onProgress({active,bytesDone})` from `runPrefetch` (T3) consumed by `runZipJob` (T4); `classifyTier`/temp-store (T1/T2) used by `runPrefetch` (T3).
- Reuse: `uploadPartsWithPool`'s N-worker pattern (upload-queue.js) is generalized in T3 rather than reinvented.
- Backward-compat: `runDownloadJob` + handoff untouched (T4 replaces only the ZIP path's use of it); all model changes additive.
```
