# Adaptive Upload Concurrency — Design Spec

**Date:** 2026-06-11  
**Status:** Approved, ready for implementation planning

---

## Context

Bucketer currently uses two fixed concurrency values loaded from settings: file-level (default 3) and part-level (default 4). Both are user-tunable via sliders in SettingsPanel (range 1–16 each). This works but is sub-optimal for mixed batches: when many small files are queued, part concurrency is wasted (small files don't use multipart); when only one large file remains, file concurrency is wasted and part concurrency is underutilised.

The goal is an **Adaptive mode** that automatically rebalances a fixed connection budget between file and part concurrency as a batch progresses, with an optional one-shot probe on large files to verify the rebalanced concurrency actually helps. Manual mode remains unchanged.

A future Phase C (not in scope here) will add continuous hill-climbing: probing concurrency every N seconds mid-upload and reverting if throughput drops. A companion Phase C+ will explore dynamic part-size scaling for very large files (multi-GB), where fewer larger parts reduce per-request overhead more than adding concurrency does.

---

## Design

### 1. Adaptive/Manual toggle

**New storage key:** `s3b_adaptive_mode` (boolean, default `true`).  
**Accessors:** `loadAdaptiveMode()` / `saveAdaptiveMode(v)` in `src/lib/storage.js`, using the existing `makeSettingAccessors` pattern.

**SettingsPanel:** A new toggle row at the top of the concurrency section labelled "Adaptive" / "Manual". In Adaptive mode the Part Concurrency and File Concurrency sliders are hidden. In Manual mode they appear exactly as today. Switching modes takes effect on the next file enqueued; in-flight uploads are unaffected.

**New constants in `src/lib/constants.js`:**
```
ADAPTIVE_CONNECTION_BUDGET = 16   // total target in-flight HTTP streams
PROBE_THRESHOLD_PARTS      = 20   // minimum parts required to trigger the probe
```

`ADAPTIVE_CONNECTION_BUDGET` is not user-configurable in this phase.

---

### 2. Sort-by-size at enqueue

In `addFiles()` in `src/components/UploadQueue.jsx`, sort the file entries array **ascending by `file.size`** before the loop that calls `enqueueUpload()` for each. Since `UploadQueue` processes tasks FIFO, this guarantees smallest files start first within a dropped batch. The sort runs before the single existing `setItems` call — no extra renders. For very large batches (100k+ files) the O(n log n) sort could add ~100ms of JS work; if that ever matters, defer it via `setTimeout`, but it is out of scope for this phase.

Files added mid-batch (a second drop while the first is uploading) are sorted relative to each other but not re-interleaved with existing pending files. Re-interleaving via a priority queue is a future improvement.

---

### 3. Budget rebalancer — `src/lib/concurrency-strategy.js` (new file)

Pure functions, no side effects, no DOM/S3 dependencies.

```js
// Returns the concurrency allocation for the current active-file count.
export function calcAdaptiveConcurrency(activeFiles, budget) {
  const files = Math.max(1, activeFiles);
  const partsPerFile = Math.max(DEFAULT_PART_CONCURRENCY, Math.floor(budget / files));
  const fileConcurrency = Math.min(files, budget);
  return { fileConcurrency, partsPerFile };
}
```

**Example allocations at `ADAPTIVE_CONNECTION_BUDGET = 16`:**

| Active files | fileConcurrency | partsPerFile | Total streams |
|---|---|---|---|
| ≥ 16 | 16 | 4 (default floor) | 16–64 |
| 8 | 8 | 4 | 32 |
| 4 | 4 | 4 | 16 |
| 2 | 2 | 8 | 16 |
| 1 | 1 | 16 | 16 |

Note: the 16-total-stream target is precisely achieved for ≤4 active files. Above 4 files, `partsPerFile` is floored at `DEFAULT_PART_CONCURRENCY` (4) — preventing part concurrency from dropping to unhelpfully low values — so total streams exceed the budget (e.g. 8 files × 4 parts = 32). This is intentional: at high file counts, files finish quickly at the default part concurrency; the budget rebalancing pays off most at the low-file tail.

**Rebalancer trigger:** Each time a file transitions to `done`, `error`, or `aborted` in `UploadQueue.jsx`, call `calcAdaptiveConcurrency` with the new active count and update `queueRef.current.concurrency` immediately. `queueRef` is a plain `useRef` — mutating it never triggers a Preact re-render; it piggybacks on the existing urgent `updateItem` call at file completion and adds zero new renders. Part concurrency is computed fresh at the moment each `uploadMultipart` call starts, via a new `getEffectivePartConcurrency(activeFiles)` helper that returns the adaptive value in adaptive mode or `loadPartConcurrency()` in manual mode.

**Memory note:** Peak RAM = `partsPerFile × partSize`. At the single-file tail (16 parts × 5 MB default) = 80 MB — the same ceiling as today's manual maximum.

---

### 4. Per-file probe (phase B)

Applies only when **adaptive mode is on** and the file has **≥ `PROBE_THRESHOLD_PARTS` (20) parts** — at default 5 MB parts that is a 100 MB minimum file size.

**Sequence inside `uploadMultipart()`:**

1. Compute `baseline = partsPerFile` from the budget formula.
2. Upload first 3 parts at `baseline` concurrency; record `baselineBytes` and `baselineMs`.
3. Compute `candidate = min(16, baseline + 4)`. If `candidate === baseline`, skip probe entirely.
4. Upload next 3 parts at `candidate` concurrency; record `candidateBytes` and `candidateMs`.
5. Compare throughput: if `(candidateBytes / candidateMs) > (baselineBytes / baselineMs) * 1.1`, use `candidate` for the rest of the file; otherwise revert to `baseline`.
6. Upload all remaining parts at the winner concurrency via a single `uploadPartsWithPool` call.

The probe is a one-time decision per file. No continuous adjustment after step 5. The existing `uploadPartsWithPool` helper is called three times sequentially for a probe-eligible file (3 baseline parts → 3 candidate parts → remaining parts); the helper itself is unchanged.

**Probe state object** (ephemeral, lives only for the duration of one file's upload):
```js
{
  phase,          // 'baseline' | 'candidate' | 'done'
  baseline,       // part concurrency for phase 1
  candidate,      // part concurrency for phase 2
  baselineBytes,
  baselineMs,
  candidateBytes,
  candidateMs,
  winner,         // set on resolution
}
```

If the file is aborted during the probe phases, the probe is treated as inconclusive and `probeResult` is recorded as `null`.

---

### 5. Observability

#### Console debug layer

Enabled by `localStorage.setItem('s3b_debug_concurrency', '1')` in DevTools (or URL param `?debug-concurrency`). When active, `console.group` blocks fire at:

- **Batch start:** files sorted, initial budget allocation
- **File start:** whether probe is eligible, baseline concurrency
- **Probe phase 1 complete:** `baseline N parts → X MB/s over Y ms`
- **Probe phase 2 complete:** `candidate N+4 parts → X MB/s over Y ms → winner: N or N+4`
- **Budget rebalance:** `activeFiles N→N-1, partsPerFile M→M+4`
- **File complete:** full summary object

No production noise. Zero UI surface.

#### Upload log annotations

Three new fields added to the IndexedDB upload log record (same store as `avgSpeedBps`, `durationSec`):

| Field | Type | Example |
|---|---|---|
| `concurrencyMode` | `"adaptive"` \| `"manual"` | `"adaptive"` |
| `peakPartConcurrency` | number | `8` |
| `probeResult` | object \| null | `{ baseline: 4, candidate: 8, baselineMbs: 6.2, candidateMbs: 9.1, winner: 8 }` |

`probeResult` is `null` for manual mode, small files (below probe threshold), or inconclusive probes (file aborted mid-probe).

**UploadLog UI:** When `probeResult` is non-null, show a small annotation line under the entry:  
`adaptive · probe: 4→8 parts (+47%)`  
No annotation shown for manual mode or null probe results.

---

## Files to create / modify

| File | Change |
|---|---|
| `src/lib/concurrency-strategy.js` | **New.** `calcAdaptiveConcurrency`, `createProbeState`, `resolveProbe` |
| `src/lib/constants.js` | Add `ADAPTIVE_CONNECTION_BUDGET`, `PROBE_THRESHOLD_PARTS` |
| `src/lib/storage.js` | Add `loadAdaptiveMode` / `saveAdaptiveMode` |
| `src/components/UploadQueue.jsx` | Sort in `addFiles`; rebalancer trigger on file complete; probe logic in `uploadMultipart`; `getEffectivePartConcurrency`; pass strategy data to upload log |
| `src/components/SettingsPanel.jsx` | Adaptive/Manual toggle; conditional slider visibility |
| `src/lib/indexeddb.js` | Extend upload log record schema with three new fields |
| `src/components/UploadLog.jsx` | Render probe annotation line |

---

## Tests to write / update

| Test file | Coverage |
|---|---|
| `test/concurrency-strategy.test.js` | **New.** `calcAdaptiveConcurrency` budget formula; `createProbeState` / `resolveProbe` winner logic; edge cases (1 file, budget=1, probe inconclusive) |
| `test/upload-queue.test.js` | Sort-by-size ordering; rebalancer fires on file complete |
| `test/components/settings-panel.test.jsx` | Toggle shows/hides sliders; default is adaptive |
| `test/components/upload-log.test.jsx` | Probe annotation renders when `probeResult` non-null; no annotation when null |

---

## Future work (out of scope)

- **Phase C — continuous hill-climbing:** Every N seconds mid-upload, bump part concurrency by 1, measure over a window, hold or revert. Justified once phases A+B are validated in real sessions.
- **Phase C+ — dynamic part-size scaling:** For very large files (multi-GB), increase part size beyond the minimum to reduce per-request overhead and S3 coordination cost. Complements rather than replaces concurrency tuning.
- **Priority queue for mid-batch file adds:** Re-interleave newly added files into the pending queue by size, rather than appending after existing pending items.
- **Configurable connection budget:** Expose `ADAPTIVE_CONNECTION_BUDGET` as an advanced setting for power users.

---

## Verification

1. `npm test` — all unit + structural + build tests pass
2. `npm run test:ui` — all component tests pass, including new settings-panel and upload-log cases
3. Manual: upload a mixed batch (5 small + 2 large files) in adaptive mode; open DevTools Console with `s3b_debug_concurrency=1` set; verify rebalance log fires as files complete and probe fires for the large files
4. Manual: switch to Manual mode; verify sliders reappear and concurrency behaviour is unchanged from today
5. Manual: open UploadLog after a batch; verify `adaptive · probe: N→M parts (+X%)` annotation appears on large-file entries
