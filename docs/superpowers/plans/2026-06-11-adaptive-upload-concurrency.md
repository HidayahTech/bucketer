# Adaptive Upload Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Adaptive concurrency mode that automatically rebalances file and part concurrency across a batch upload, plus a one-shot probe on large files to pick the optimal part concurrency, with observability via console debug output and upload log annotations.

**Architecture:** A new pure module `src/lib/concurrency-strategy.js` holds all budget math and probe logic; `UploadQueue.jsx` wires it in at the two call sites (queue drain and multipart upload). `SettingsPanel.jsx` gets an Adaptive/Manual toggle that hides the concurrency sliders in Adaptive mode. `upload-log.js` gets three new schemaless fields; `UploadLog.jsx` renders a probe annotation line when present.

**Implementation note:** In this phase, only part concurrency is rebalanced dynamically. File concurrency is set to `ADAPTIVE_CONNECTION_BUDGET` (16) in adaptive mode — always allowing the queue to drain as fast as possible. Part concurrency scales up as active uploads drop, so large files at the tail of a batch get maximum parallelism. Dynamic file concurrency (reducing it as the batch winds down) is deferred to a future phase.

**Tech Stack:** Preact, esbuild, `node --test` (unit), jsdom component tests (`npm run test:ui`), AWS SDK v3 manual multipart.

---

## File Map

| File | Status | Change |
|---|---|---|
| `src/lib/constants.js` | Modify | Add `ADAPTIVE_CONNECTION_BUDGET`, `PROBE_THRESHOLD_PARTS` |
| `src/lib/storage.js` | Modify | Add `adaptiveMode` key + `loadAdaptiveMode`/`saveAdaptiveMode` accessors |
| `src/lib/concurrency-strategy.js` | **Create** | `calcAdaptiveConcurrency`, `createProbeState`, `resolveProbe` |
| `src/components/UploadQueue.jsx` | Modify | Sort, `getEffectivePartConcurrency`, rebalancer, probe in `uploadMultipart`, debug helper |
| `src/components/SettingsPanel.jsx` | Modify | Adaptive/Manual toggle; hide sliders in adaptive mode |
| `src/lib/upload-log.js` | Modify | Update schema comment to document new fields |
| `src/components/UploadLog.jsx` | Modify | `formatProbeAnnotation` helper + annotation row in table |
| `test/concurrency-strategy.test.js` | **Create** | Unit tests for all three exported functions |
| `test/storage.test.js` | Modify | Tests for `loadAdaptiveMode`/`saveAdaptiveMode` |
| `test/components/settings-panel.test.jsx` | Modify | Toggle renders; sliders hidden in adaptive mode |
| `test/components/upload-log.test.jsx` | Modify | `formatProbeAnnotation` unit tests |

---

## Task 1: Add constants

**Files:**
- Modify: `src/lib/constants.js`

- [ ] **Step 1: Add the two constants**

  In `src/lib/constants.js`, append after the `PART_CONCURRENCY` line:

  ```js
  // Adaptive mode: target total concurrent HTTP streams across all active uploads.
  export const ADAPTIVE_CONNECTION_BUDGET = 16;

  // Adaptive mode: minimum part count for a file to be eligible for the probe.
  // At default 5 MiB parts this is 100 MiB. Files below this complete too quickly
  // for a meaningful two-phase throughput comparison.
  export const PROBE_THRESHOLD_PARTS = 20;
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/lib/constants.js
  git commit -m "feat: add ADAPTIVE_CONNECTION_BUDGET and PROBE_THRESHOLD_PARTS constants"
  ```

---

## Task 2: Storage — adaptive mode setting

**Files:**
- Modify: `src/lib/storage.js`
- Modify: `test/storage.test.js`

- [ ] **Step 1: Write the failing tests**

  In `test/storage.test.js`, add after the existing import block and before the first `describe`:

  ```js
  import {
    // (add to the existing import list)
    loadAdaptiveMode, saveAdaptiveMode,
  } from '../src/lib/storage.js';
  ```

  Then add a new describe block at the bottom of the file:

  ```js
  describe('loadAdaptiveMode / saveAdaptiveMode', () => {
    test('defaults to true when no value is stored', () => {
      assert.equal(loadAdaptiveMode(), true);
    });

    test('returns false after saveAdaptiveMode(false)', () => {
      saveAdaptiveMode(false);
      assert.equal(loadAdaptiveMode(), false);
    });

    test('returns true after saveAdaptiveMode(true)', () => {
      saveAdaptiveMode(false);
      saveAdaptiveMode(true);
      assert.equal(loadAdaptiveMode(), true);
    });
  });
  ```

- [ ] **Step 2: Run to verify failure**

  ```bash
  node --test test/storage.test.js 2>&1 | tail -20
  ```

  Expected: `SyntaxError` or `not a function` — `loadAdaptiveMode` is not yet exported.

- [ ] **Step 3: Add the setting to storage.js**

  In `src/lib/storage.js`:

  **a)** In the `SETTINGS_KEYS` object (around line 30), add:
  ```js
  adaptiveMode: 's3b_adaptive_mode',
  ```

  **b)** After the `_updateCheckEnabled` accessor (around line 136), add:
  ```js
  const _adaptiveMode = makeSettingAccessors(
    LS_KEYS.adaptiveMode,
    v => v === '' ? true : v === 'true',   // default true
  );
  ```

  **c)** In the export block (after `saveUpdateCheckEnabled`), add:
  ```js
  export const loadAdaptiveMode = _adaptiveMode.load;
  export const saveAdaptiveMode = _adaptiveMode.save;
  ```

- [ ] **Step 4: Run tests to verify pass**

  ```bash
  node --test test/storage.test.js 2>&1 | tail -10
  ```

  Expected: all storage tests pass (no failures).

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/storage.js test/storage.test.js
  git commit -m "feat: add loadAdaptiveMode/saveAdaptiveMode storage accessors"
  ```

---

## Task 3: concurrency-strategy.js — pure module

**Files:**
- Create: `src/lib/concurrency-strategy.js`
- Create: `test/concurrency-strategy.test.js`

- [ ] **Step 1: Write the failing tests**

  Create `test/concurrency-strategy.test.js`:

  ```js
  import { test, describe } from 'node:test';
  import assert from 'node:assert/strict';
  import {
    calcAdaptiveConcurrency,
    createProbeState,
    resolveProbe,
  } from '../src/lib/concurrency-strategy.js';

  describe('calcAdaptiveConcurrency', () => {
    test('1 active file gets full budget as parts', () => {
      const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(1, 16);
      assert.equal(fileConcurrency, 1);
      assert.equal(partsPerFile, 16);
    });

    test('2 active files split budget evenly', () => {
      const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(2, 16);
      assert.equal(fileConcurrency, 2);
      assert.equal(partsPerFile, 8);
    });

    test('4 active files hit 16 total connections exactly', () => {
      const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(4, 16);
      assert.equal(fileConcurrency, 4);
      assert.equal(partsPerFile, 4);
    });

    test('8 active files floor partsPerFile at DEFAULT_PART_CONCURRENCY (4)', () => {
      // floor(16/8) = 2, but 4 is the floor
      const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(8, 16);
      assert.equal(fileConcurrency, 8);
      assert.equal(partsPerFile, 4);
    });

    test('more active files than budget caps fileConcurrency at budget', () => {
      const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(20, 16);
      assert.equal(fileConcurrency, 16);
      assert.equal(partsPerFile, 4);
    });

    test('0 active files treated as 1 (prevents division by zero)', () => {
      const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(0, 16);
      assert.equal(fileConcurrency, 1);
      assert.equal(partsPerFile, 16);
    });

    test('budget=1 always yields fileConcurrency=1, partsPerFile=4', () => {
      const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(2, 1);
      assert.equal(fileConcurrency, 1);
      assert.equal(partsPerFile, 4); // floored at DEFAULT_PART_CONCURRENCY
    });
  });

  describe('createProbeState', () => {
    test('initialises with correct baseline and candidate', () => {
      const s = createProbeState(4, 8);
      assert.equal(s.baseline, 4);
      assert.equal(s.candidate, 8);
      assert.equal(s.phase, 'baseline');
      assert.equal(s.winner, null);
      assert.equal(s.baselineBytes, 0);
      assert.equal(s.candidateBytes, 0);
    });
  });

  describe('resolveProbe', () => {
    test('picks candidate when >10% faster', () => {
      const s = createProbeState(4, 8);
      s.baselineBytes  = 15_000_000; s.baselineMs  = 1000; // 15 MB/s
      s.candidateBytes = 15_000_000; s.candidateMs = 833;  // ~18 MB/s (+20%)
      const r = resolveProbe(s);
      assert.equal(r.winner, 8);
    });

    test('picks baseline when candidate is within 10% threshold', () => {
      const s = createProbeState(4, 8);
      s.baselineBytes  = 15_000_000; s.baselineMs  = 1000; // 15 MB/s
      s.candidateBytes = 15_000_000; s.candidateMs = 926;  // ~16.2 MB/s (+8%)
      const r = resolveProbe(s);
      assert.equal(r.winner, 4);
    });

    test('picks baseline when candidate is slower', () => {
      const s = createProbeState(4, 8);
      s.baselineBytes  = 15_000_000; s.baselineMs  = 1000;
      s.candidateBytes = 15_000_000; s.candidateMs = 1200; // slower
      const r = resolveProbe(s);
      assert.equal(r.winner, 4);
    });

    test('includes baselineMbs and candidateMbs in result', () => {
      const s = createProbeState(4, 8);
      s.baselineBytes  = 10_000_000; s.baselineMs  = 1000;
      s.candidateBytes = 10_000_000; s.candidateMs = 800;
      const r = resolveProbe(s);
      assert.ok(typeof r.baselineMbs === 'number');
      assert.ok(typeof r.candidateMbs === 'number');
      assert.ok(r.candidateMbs > r.baselineMbs);
    });
  });
  ```

- [ ] **Step 2: Run to verify failure**

  ```bash
  node --test test/concurrency-strategy.test.js 2>&1 | tail -10
  ```

  Expected: module not found error.

- [ ] **Step 3: Implement the module**

  Create `src/lib/concurrency-strategy.js`:

  ```js
  // Copyright (C) 2026 HidayahTech, LLC
  // Pure functions for adaptive upload concurrency.
  // No side effects, no DOM, no S3 dependencies — safe to unit-test in Node.
  import { ADAPTIVE_CONNECTION_BUDGET, PART_CONCURRENCY } from './constants.js';

  // Returns the recommended concurrency split for the current number of active uploads.
  // fileConcurrency: how many files the queue should allow to run simultaneously.
  // partsPerFile: how many parts each active file should upload concurrently.
  //
  // Design: partsPerFile = budget / activeFiles, floored at PART_CONCURRENCY (4).
  // The 16-connection total is hit precisely when activeFiles ≤ 4; above that the
  // floor keeps part concurrency from dropping below the useful minimum.
  export function calcAdaptiveConcurrency(activeFiles, budget = ADAPTIVE_CONNECTION_BUDGET) {
    const files = Math.max(1, activeFiles);
    const partsPerFile = Math.max(PART_CONCURRENCY, Math.floor(budget / files));
    const fileConcurrency = Math.min(files, budget);
    return { fileConcurrency, partsPerFile };
  }

  // Creates an empty probe-state object for a large-file one-shot calibration.
  // baseline and candidate are part-concurrency values to compare.
  export function createProbeState(baseline, candidate) {
    return {
      phase: 'baseline',
      baseline,
      candidate,
      baselineBytes: 0,
      baselineMs: 0,
      candidateBytes: 0,
      candidateMs: 0,
      winner: null,
    };
  }

  // Resolves a completed probe by comparing throughput of the two phases.
  // Candidate wins only if it is >10% faster — the threshold filters network jitter.
  // Returns the state enriched with winner, baselineMbs, and candidateMbs.
  export function resolveProbe(state) {
    const baselineMbs   = state.baselineBytes  / state.baselineMs;
    const candidateMbs  = state.candidateBytes / state.candidateMs;
    const winner = candidateMbs > baselineMbs * 1.1 ? state.candidate : state.baseline;
    return {
      ...state,
      winner,
      baselineMbs:  Math.round(baselineMbs  * 1000) / 1000,
      candidateMbs: Math.round(candidateMbs * 1000) / 1000,
    };
  }
  ```

- [ ] **Step 4: Run tests to verify pass**

  ```bash
  node --test test/concurrency-strategy.test.js 2>&1 | tail -10
  ```

  Expected: all tests pass.

- [ ] **Step 5: Run full unit suite to check for regressions**

  ```bash
  npm test 2>&1 | tail -15
  ```

  Expected: no new failures.

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/concurrency-strategy.js test/concurrency-strategy.test.js
  git commit -m "feat: add concurrency-strategy module with calcAdaptiveConcurrency and probe helpers"
  ```

---

## Task 4: UploadQueue.jsx — sort, part-concurrency helper, and rebalancer

**Files:**
- Modify: `src/components/UploadQueue.jsx`

- [ ] **Step 1: Add imports**

  In `src/components/UploadQueue.jsx`, update the two import lines:

  ```js
  // Replace the existing storage import (line ~32):
  import { loadPartConcurrency, loadPartSizeMB, loadFileConcurrency, loadUploadExpandThreshold, loadAdaptiveMode } from '../lib/storage.js';

  // Replace the existing constants import (line ~33):
  import { MULTIPART_THRESHOLD, DEFAULT_FILE_CONCURRENCY, PART_CONCURRENCY, ADAPTIVE_CONNECTION_BUDGET, PROBE_THRESHOLD_PARTS } from '../lib/constants.js';
  ```

  Also add a new import line after the constants import:

  ```js
  import { calcAdaptiveConcurrency, createProbeState, resolveProbe } from '../lib/concurrency-strategy.js';
  ```

- [ ] **Step 2: Add the debug helper**

  In `UploadQueue.jsx`, add this function directly before the `export function UploadQueue(` declaration:

  ```js
  function debugConcurrency(...args) {
    try {
      if (localStorage.getItem('s3b_debug_concurrency') === '1') {
        console.log('[bucketer:concurrency]', ...args);
      }
    } catch { /* private browsing — skip */ }
  }
  ```

- [ ] **Step 3: Add the effectiveConcurrency helpers**

  Inside the `UploadQueue` component function, after the refs are declared (after the `batcherRef` block, around line 84), add:

  ```js
  // Returns the file concurrency to assign to the queue in the current mode.
  function effectiveFileConcurrency() {
    return loadAdaptiveMode()
      ? ADAPTIVE_CONNECTION_BUDGET
      : (loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY);
  }

  // Returns the part concurrency to use when starting or resuming a multipart upload.
  // In adaptive mode, scales up as fewer files are actively uploading.
  function getEffectivePartConcurrency() {
    if (loadAdaptiveMode()) {
      const activeCount = Object.keys(activeUploadsRef.current).length;
      const { partsPerFile } = calcAdaptiveConcurrency(activeCount);
      debugConcurrency('part-concurrency', { activeCount, partsPerFile });
      return partsPerFile;
    }
    return Math.max(1, loadPartConcurrency() ?? PART_CONCURRENCY);
  }
  ```

- [ ] **Step 4: Update the initial queue concurrency**

  On the `queueRef` line (currently `new Queue(loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY)`), change to:

  ```js
  const queueRef = useRef(new Queue(effectiveFileConcurrency()));
  ```

  Note: `effectiveFileConcurrency` is defined inside the component, so this initial value will be evaluated on first render.

  Actually, since `useRef` is initialized once and `effectiveFileConcurrency()` is defined after the refs... we need to use a lazy initializer. Change to:

  ```js
  const queueRef = useRef(null);
  if (queueRef.current === null) {
    queueRef.current = new Queue(
      loadAdaptiveMode() ? ADAPTIVE_CONNECTION_BUDGET : (loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY)
    );
  }
  ```

- [ ] **Step 5: Update the enqueueUpload concurrency line**

  Find the line in `enqueueUpload` (around line 150):
  ```js
  queueRef.current.concurrency = loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY;
  ```
  Change to:
  ```js
  queueRef.current.concurrency = effectiveFileConcurrency();
  ```

- [ ] **Step 6: Update the finally-block concurrency line**

  Find the line in the `finally` block of `runUpload` (around line 234):
  ```js
  queueRef.current.concurrency = loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY;
  ```
  Change to:
  ```js
  queueRef.current.concurrency = effectiveFileConcurrency();
  debugConcurrency('rebalance', {
    activeRemaining: Object.keys(activeUploadsRef.current).length,
    fileConcurrency: queueRef.current.concurrency,
  });
  ```

- [ ] **Step 7: Update the handleRequeue concurrency line**

  Find the line in `handleRequeue` (around line 423):
  ```js
  queueRef.current.concurrency = loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY;
  ```
  Change to:
  ```js
  queueRef.current.concurrency = effectiveFileConcurrency();
  ```

- [ ] **Step 8: Add sort-by-size in addFiles**

  In `addFiles`, on the line immediately before `setItems(prev => [...newItems, ...prev])` (line 114), insert:

  ```js
  // Smallest-first: minimises time-to-first-completion, reduces active file count
  // quickly so the part-concurrency rebalancer kicks in sooner for large files.
  fileEntries.sort((a, b) => a.file.size - b.file.size);
  ```

  The full `addFiles` start now reads:
  ```js
  function addFiles(fileEntries) {
    const batchId = String(Date.now() + Math.random());
    const newItems = fileEntries.map(({ file, relativePath }) => ({ ... }));
    fileEntries.sort((a, b) => a.file.size - b.file.size);
    setItems(prev => [...newItems, ...prev]);
    ...
    newItems.forEach(item => enqueueUpload(item));
  }
  ```

  Wait — `newItems` is built from `fileEntries` BEFORE the sort, so the queue order won't be sorted. The sort must come BEFORE the `map`. Move it:

  ```js
  function addFiles(fileEntries) {
    const batchId = String(Date.now() + Math.random());
    fileEntries.sort((a, b) => a.file.size - b.file.size);  // ← before map
    const newItems = fileEntries.map(({ file, relativePath }) => ({ ... }));
    setItems(prev => [...newItems, ...prev]);
    ...
    newItems.forEach(item => enqueueUpload(item));
  }
  ```

- [ ] **Step 9: Update handleResume to use getEffectivePartConcurrency**

  In `handleResume` (around line 367), find:
  ```js
  const concurrency = Math.max(1, loadPartConcurrency() ?? PART_CONCURRENCY);
  ```
  Change to:
  ```js
  const concurrency = getEffectivePartConcurrency();
  ```

- [ ] **Step 10: Run the test suite**

  ```bash
  npm test 2>&1 | tail -15
  ```

  Expected: all tests pass.

- [ ] **Step 11: Commit**

  ```bash
  git add src/components/UploadQueue.jsx
  git commit -m "feat: add adaptive sort-by-size, effectiveFileConcurrency, and getEffectivePartConcurrency to UploadQueue"
  ```

---

## Task 5: SettingsPanel — Adaptive/Manual toggle

**Files:**
- Modify: `src/components/SettingsPanel.jsx`
- Modify: `test/components/settings-panel.test.jsx`

- [ ] **Step 1: Write the failing tests**

  Add to `test/components/settings-panel.test.jsx`:

  ```js
  describe('SettingsPanel — adaptive/manual toggle', () => {
    test('renders an adaptive/manual mode toggle', () => {
      const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
      assert.ok(
        text().toLowerCase().includes('adaptive') || text().toLowerCase().includes('manual'),
        'settings panel must contain an adaptive/manual toggle'
      );
      cleanup();
    });

    test('hides concurrency sliders in adaptive mode (default)', () => {
      // localStorage is empty → adaptive mode is true by default
      const { query, cleanup } = mount(h(SettingsPanel, defaultProps()));
      // In adaptive mode the part/file concurrency inputs should not be present
      const concurrencyInput = query('#setting-concurrency');
      const fileConcurrencyInput = query('#setting-fileconcurrency');
      assert.equal(concurrencyInput, null, 'part concurrency input must be hidden in adaptive mode');
      assert.equal(fileConcurrencyInput, null, 'file concurrency input must be hidden in adaptive mode');
      cleanup();
    });
  });
  ```

- [ ] **Step 2: Run to verify failure**

  ```bash
  npm run test:ui -- --test-name-pattern="adaptive" 2>&1 | tail -20
  ```

  Expected: tests fail — there is no toggle or hiding logic yet.

- [ ] **Step 3: Add imports and state to SettingsPanel.jsx**

  In `src/components/SettingsPanel.jsx`:

  **a)** Update the storage import line to add `loadAdaptiveMode, saveAdaptiveMode`:
  ```js
  import { loadMaxKeys, saveMaxKeys, loadPartConcurrency, savePartConcurrency, loadPartSizeMB, savePartSizeMB, loadFileConcurrency, saveFileConcurrency, loadListingCacheTTL, saveListingCacheTTL, loadUpdateCheckEnabled, saveUpdateCheckEnabled, loadPrefetchSizeLimit, savePrefetchSizeLimit, loadUploadExpandThreshold, saveUploadExpandThreshold, loadAdaptiveMode, saveAdaptiveMode } from '../lib/storage.js';
  ```

  **b)** Inside the `SettingsPanel` component, add a new state after the existing state declarations:
  ```js
  const [adaptiveMode, setAdaptiveMode] = useState(() => loadAdaptiveMode());
  ```

- [ ] **Step 4: Add the toggle to the JSX and conditionally hide sliders**

  In the `return (...)` block of `SettingsPanel`, find the concurrency section. The two inputs currently rendered unconditionally are `#setting-concurrency` (part) and `#setting-file-concurrency` (file). Wrap each in `{!adaptiveMode && ( ... )}`.

  Also add the toggle row BEFORE those wrapped inputs. Place it at the top of the concurrency `<div class="form-group">` section (immediately after the `"Upload part size"` group closes):

  ```jsx
  <div class="form-group">
    <label>Upload concurrency mode</label>
    <div style={{ display: 'flex', gap: '1rem' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', cursor: 'pointer' }}>
        <input
          type="radio"
          name="concurrency-mode"
          value="adaptive"
          checked={adaptiveMode}
          onChange={() => { saveAdaptiveMode(true); setAdaptiveMode(true); }}
        />
        Adaptive
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', cursor: 'pointer' }}>
        <input
          type="radio"
          name="concurrency-mode"
          value="manual"
          checked={!adaptiveMode}
          onChange={() => { saveAdaptiveMode(false); setAdaptiveMode(false); }}
        />
        Manual
      </label>
    </div>
    <span class="hint">
      Adaptive automatically scales file and part concurrency based on how many uploads are active.
      Manual exposes the sliders below for direct control.
    </span>
  </div>

  {!adaptiveMode && (
    <>
      <div class="form-group">
        <label htmlFor="setting-concurrency">Upload part concurrency</label>
        <input
          id="setting-concurrency"
          type="number"
          value={concurrencyValue}
          onInput={e => setConcurrencyValue(e.target.value)}
          min="1"
          max="16"
        />
        <span class="hint">Simultaneous part uploads per file (1–16). Default: {DEFAULT_PART_CONCURRENCY}.</span>
        <span class="hint" style={{ color: 'var(--accent)' }}>
          Active: <strong>{activeConcurrency}</strong>
        </span>
      </div>
      <div class="form-group">
        <label htmlFor="setting-fileconcurrency">File concurrency</label>
        <input
          id="setting-fileconcurrency"
          type="number"
          value={fileConcurrencyValue}
          onInput={e => setFileConcurrencyValue(e.target.value)}
          min="1"
          max="16"
        />
        <span class="hint">Simultaneous file uploads (1–16). Default: {DEFAULT_FILE_CONCURRENCY}. Higher values improve throughput for many small files; lower values reduce load on constrained backends.</span>
        <span class="hint" style={{ color: 'var(--accent)' }}>
          Active: <strong>{activeFileConcurrency}</strong>
        </span>
      </div>
    </>
  )}
  ```

  Also update `handleReset` to reset adaptive mode to `true`:
  ```js
  saveAdaptiveMode(true);
  setAdaptiveMode(true);
  ```

- [ ] **Step 5: Run component tests**

  ```bash
  npm run test:ui 2>&1 | tail -20
  ```

  Expected: all component tests pass including the two new adaptive/manual toggle tests.

- [ ] **Step 6: Commit**

  ```bash
  git add src/components/SettingsPanel.jsx test/components/settings-panel.test.jsx
  git commit -m "feat: add Adaptive/Manual toggle to SettingsPanel; hide concurrency sliders in adaptive mode"
  ```

---

## Task 6: uploadMultipart — refactor to uploadPartsWithPool + probe

**Files:**
- Modify: `src/components/UploadQueue.jsx`

This task refactors the fresh-upload part of `uploadMultipart`. The resume path (`handleResume`) already uses `uploadPartsWithPool` and was updated in Task 4.

- [ ] **Step 1: Replace the worker/queue pattern with uploadPartsWithPool**

  In `uploadMultipart`, the section from `const parts = new Array(totalParts)` through `await Promise.all(...)` currently reads:

  ```js
  const parts = new Array(totalParts);
  const queue = Array.from({ length: totalParts }, (_, i) => i + 1);
  let bytesUploaded = 0;

  async function worker() {
    for (;;) {
      const partNumber = queue.shift();
      if (partNumber === undefined) break;
      if (abortController.signal.aborted) throw new Error('Upload aborted');
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, file.size);
      const chunk = await file.slice(start, end).arrayBuffer();
      const resp = await client.send(
        new UploadPartCommand({
          Bucket: bucket, Key: destinationKey, UploadId: uploadId,
          PartNumber: partNumber, Body: chunk,
        }),
        { abortSignal: abortController.signal },
      );
      parts[partNumber - 1] = { PartNumber: partNumber, ETag: resp.ETag };
      bytesUploaded += end - start;
      onProgress(bytesUploaded, file.size);
    }
  }

  const concurrency = Math.max(1, loadPartConcurrency() ?? PART_CONCURRENCY);
  await Promise.all(Array.from({ length: concurrency }, worker));
  ```

  Replace it entirely with:

  ```js
  const parts = new Array(totalParts);
  const allPartNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
  let bytesUploaded = 0;

  async function uploadPart(partNumber) {
    if (abortController.signal.aborted) throw new Error('Upload aborted');
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const chunk = await file.slice(start, end).arrayBuffer();
    const resp = await client.send(
      new UploadPartCommand({
        Bucket: bucket, Key: destinationKey, UploadId: uploadId,
        PartNumber: partNumber, Body: chunk,
      }),
      { abortSignal: abortController.signal },
    );
    parts[partNumber - 1] = { PartNumber: partNumber, ETag: resp.ETag };
    bytesUploaded += end - start;
    onProgress(bytesUploaded, file.size);
  }

  const baseline = getEffectivePartConcurrency();
  const candidate = Math.min(16, baseline + 4);
  const shouldProbe = loadAdaptiveMode()
    && totalParts >= PROBE_THRESHOLD_PARTS
    && candidate !== baseline;

  let probeResolved = null;
  let peakPartConcurrency = baseline;

  if (shouldProbe) {
    debugConcurrency('probe-start', { file: file.name, totalParts, baseline, candidate });

    const t1 = Date.now();
    await uploadPartsWithPool(allPartNumbers.slice(0, 3), uploadPart, baseline);
    const baselineMs = Date.now() - t1;

    const t2 = Date.now();
    await uploadPartsWithPool(allPartNumbers.slice(3, 6), uploadPart, candidate);
    const candidateMs = Date.now() - t2;

    const state = createProbeState(baseline, candidate);
    state.baselineBytes  = 3 * partSize;
    state.baselineMs     = baselineMs;
    state.candidateBytes = 3 * partSize;
    state.candidateMs    = candidateMs;
    probeResolved = resolveProbe(state);
    peakPartConcurrency = probeResolved.winner;

    debugConcurrency('probe-result', {
      baseline, candidate,
      baselineMbs: probeResolved.baselineMbs,
      candidateMbs: probeResolved.candidateMbs,
      winner: probeResolved.winner,
    });

    await uploadPartsWithPool(allPartNumbers.slice(6), uploadPart, probeResolved.winner);
  } else {
    await uploadPartsWithPool(allPartNumbers, uploadPart, baseline);
  }
  ```

- [ ] **Step 2: Return the annotation from uploadMultipart**

  At the very end of `uploadMultipart` (just before the closing `}`), change the existing code from:

  ```js
  await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
  delete activeUploadsRef.current[id];
  ```

  To:

  ```js
  await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
  delete activeUploadsRef.current[id];
  return {
    peakPartConcurrency,
    probeResult: probeResolved
      ? {
          baseline: probeResolved.baseline,
          candidate: probeResolved.candidate,
          baselineMbs: probeResolved.baselineMbs,
          candidateMbs: probeResolved.candidateMbs,
          winner: probeResolved.winner,
        }
      : null,
  };
  ```

- [ ] **Step 3: Capture the annotation in runUpload and pass to saveUploadLogEntry**

  In `runUpload`, add a variable before the try block:

  ```js
  let uploadAnnotation = null;
  ```

  Change the multipart call from:
  ```js
  await uploadMultipart(id, file, destinationKey, updateProgress);
  ```
  To:
  ```js
  uploadAnnotation = await uploadMultipart(id, file, destinationKey, updateProgress);
  ```

  Update the success `saveUploadLogEntry` call to add the three new fields:
  ```js
  saveUploadLogEntry({
    fileName: file.name, destinationKey, fileSize: file.size,
    status: 'done', startedAt: startTime, completedAt, durationSec,
    avgSpeedBps: durationSec > 0 ? file.size / durationSec : null,
    errorMessage: null,
    concurrencyMode:      loadAdaptiveMode() ? 'adaptive' : 'manual',
    peakPartConcurrency:  uploadAnnotation?.peakPartConcurrency ?? null,
    probeResult:          uploadAnnotation?.probeResult ?? null,
  }).then(() => onLogEntry?.()).catch(() => {});
  ```

  Update the error `saveUploadLogEntry` call similarly:
  ```js
  saveUploadLogEntry({
    fileName: file.name, destinationKey, fileSize: file.size,
    status: 'error', startedAt: startTime, completedAt,
    durationSec: (completedAt - startTime) / 1000,
    avgSpeedBps: null,
    errorMessage: err?.message || String(err),
    concurrencyMode:      loadAdaptiveMode() ? 'adaptive' : 'manual',
    peakPartConcurrency:  uploadAnnotation?.peakPartConcurrency ?? null,
    probeResult:          null,
  }).then(() => onLogEntry?.()).catch(() => {});
  ```

- [ ] **Step 4: Run full test suite**

  ```bash
  npm test 2>&1 | tail -15
  ```

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/UploadQueue.jsx
  git commit -m "feat: refactor uploadMultipart to uploadPartsWithPool; add one-shot probe for large files"
  ```

---

## Task 7: Upload log schema + UploadLog annotation

**Files:**
- Modify: `src/lib/upload-log.js`
- Modify: `src/components/UploadLog.jsx`
- Modify: `test/components/upload-log.test.jsx`

- [ ] **Step 1: Write the failing tests for formatProbeAnnotation**

  Add to `test/components/upload-log.test.jsx` (note: this test calls a function directly, not via mount, so no IndexedDB needed):

  ```js
  import { formatProbeAnnotation } from '../../src/components/UploadLog.jsx';

  describe('formatProbeAnnotation', () => {
    test('returns null for null probeResult', () => {
      assert.equal(formatProbeAnnotation(null), null);
    });

    test('formats a winner=candidate result with positive delta', () => {
      const result = formatProbeAnnotation({
        baseline: 4, candidate: 8, winner: 8,
        baselineMbs: 10, candidateMbs: 14,
      });
      assert.ok(result.includes('4→8'), 'must show part concurrency range');
      assert.ok(result.includes('+40%') || result.includes('40'), 'must show improvement percentage');
    });

    test('formats a winner=baseline result (no improvement)', () => {
      const result = formatProbeAnnotation({
        baseline: 4, candidate: 8, winner: 4,
        baselineMbs: 10, candidateMbs: 9,
      });
      assert.ok(result.includes('4→8'), 'must show part concurrency range');
      assert.ok(result.includes('held') || result.includes('baseline') || result.includes('4'), 'must indicate baseline was kept');
    });
  });
  ```

- [ ] **Step 2: Run to verify failure**

  ```bash
  npm run test:ui -- --test-name-pattern="formatProbeAnnotation" 2>&1 | tail -15
  ```

  Expected: import error — `formatProbeAnnotation` is not yet exported.

- [ ] **Step 3: Update upload-log.js schema comment**

  In `src/lib/upload-log.js`, update the schema comment at the top:

  ```js
  // Each entry: { fileName, destinationKey, fileSize, status, startedAt,
  //               completedAt, durationSec, avgSpeedBps, errorMessage,
  //               concurrencyMode, peakPartConcurrency, probeResult }
  ```

  No code changes needed — IndexedDB's object store is schemaless; new fields are stored automatically on new entries. Old entries simply lack those keys and render as null/undefined.

- [ ] **Step 4: Add formatProbeAnnotation and the annotation column to UploadLog.jsx**

  In `src/components/UploadLog.jsx`:

  **a)** Add the exported helper before the `UploadLog` function:

  ```js
  // Returns a short human-readable string for the probe result, or null if none.
  export function formatProbeAnnotation(probeResult) {
    if (!probeResult) return null;
    const range = `${probeResult.baseline}→${probeResult.candidate} parts`;
    if (probeResult.winner === probeResult.candidate) {
      const pct = Math.round((probeResult.candidateMbs / probeResult.baselineMbs - 1) * 100);
      return `adaptive · probe: ${range} (+${pct}%)`;
    }
    return `adaptive · probe: ${range} (held baseline)`;
  }
  ```

  **b)** In the `<thead>` row, add a new `<th>` at the end:
  ```jsx
  <th>Strategy</th>
  ```

  **c)** In the `displayEntries.map(...)` table row, add a new `<td>` at the end:
  ```jsx
  <td class="log-strategy">
    {formatProbeAnnotation(e.probeResult) ?? (e.concurrencyMode === 'manual' ? 'manual' : null) ?? '—'}
  </td>
  ```

- [ ] **Step 5: Run component tests**

  ```bash
  npm run test:ui 2>&1 | tail -20
  ```

  Expected: all tests pass including the two new `formatProbeAnnotation` tests.

- [ ] **Step 6: Run full suite**

  ```bash
  npm test 2>&1 | tail -10
  ```

  Expected: no failures.

- [ ] **Step 7: Commit**

  ```bash
  git add src/lib/upload-log.js src/components/UploadLog.jsx test/components/upload-log.test.jsx
  git commit -m "feat: extend upload log with concurrencyMode/peakPartConcurrency/probeResult; add Strategy column to UploadLog"
  ```

---

## Task 8: Final verification

- [ ] **Step 1: Run the full unit and build test suite**

  ```bash
  npm test 2>&1 | tail -20
  ```

  Expected: all unit + structural + build tests pass, 0 failures.

- [ ] **Step 2: Run the full component test suite**

  ```bash
  npm run test:ui 2>&1 | tail -20
  ```

  Expected: all component tests pass, 0 failures.

- [ ] **Step 3: Build and check output**

  ```bash
  npm run build 2>&1 | tail -15
  ```

  Expected: build succeeds, all invariants pass, `dist/index.html` updated.

- [ ] **Step 4: Manual smoke test — adaptive mode**

  Start the dev server and open in browser:
  ```bash
  npm run serve
  ```

  In DevTools Console: `localStorage.setItem('s3b_debug_concurrency', '1')`

  Then reload and upload a mixed batch (several small files + at least one file ≥ 100 MB). Verify:
  - Small files appear in the queue in size-ascending order
  - `[bucketer:concurrency]` log lines appear for `rebalance` and `part-concurrency` events
  - For the large file: `probe-start` and `probe-result` lines appear
  - After all uploads: UploadLog shows a `Strategy` column with annotation for the large file

- [ ] **Step 5: Manual smoke test — manual mode**

  In Settings, switch to Manual mode. Verify:
  - Concurrency sliders reappear
  - Upload a file — no probe runs (no probe log output)
  - UploadLog shows `manual` in the Strategy column

---

## Future work (documented, not implemented)

- **Phase C — continuous hill-climbing:** Periodically bump part concurrency mid-upload, measure over a window, hold or revert. See `docs/superpowers/specs/2026-06-11-adaptive-upload-concurrency-design.md`.
- **Phase C+ — dynamic part-size scaling:** For very large files (multi-GB), increase part size beyond the minimum to reduce per-request overhead.
- **Dynamic file concurrency:** Reduce `fileConcurrency` based on total remaining files (not just active), preventing idle queue slots when fewer files remain. Requires tracking a `remainingRef` and handling `clear()` correctly.
- **Priority queue for mid-batch adds:** Re-interleave newly added files into the pending queue by size.
