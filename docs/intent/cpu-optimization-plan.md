# CPU Optimization Plan — Large Upload Queues

## Status
Design only. Not yet scheduled for implementation.

## Problem

Uploading large numbers of small files (e.g. ~7000 files) causes sustained high
CPU usage and fan activity, even when the browser window is minimized. The uploads
complete correctly — this is purely an efficiency problem, not a correctness one.

The root causes are algorithmic and architectural, not inherent to the upload work
itself. Several compound each other.

---

## Hotspot Inventory

### Hotspot 1 — O(n²) array scanning in `updateItem` ★ Biggest algorithmic problem

**Location:** `UploadQueue.jsx`, `updateItem` callback (line ~79)

```js
setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
```

Every status or progress update scans the entire `items` array to find one item
by ID. With 7000 items and 3 concurrent uploads each making multiple calls
(start, progress ticks, completion), the total number of array iterations is in
the millions. Memory allocation is also high — every call creates a new 7000-item
array with spread copies of all unchanged items.

**Impact:** Severe for large queues. Gets worse quadratically as item count grows.

**Fix:** Replace the `items` array with a `Map<id, item>`. Updates become O(1):
```js
setItems(prev => new Map(prev).set(id, { ...prev.get(id), ...patch }));
```
Everything that iterates items (filter/reduce in `BatchSummary`) needs updating,
but the algorithmic improvement is significant.

**Effort:** Larger refactor — touches all array-iteration sites.

**Note:** This naturally fits as part of the persistent queue redesign, where
`items` state is being rearchitected anyway.

---

### Hotspot 2 — 8 full array passes per render in `BatchSummary` ★ High impact

**Location:** `UploadQueue.jsx`, `BatchSummary` function (lines ~620–630)

```js
const doneItems     = items.filter(i => i.status === 'done');
const abortedItems  = items.filter(i => i.status === 'aborted');
const errorItems    = items.filter(i => i.status === 'error');
const pausedItems   = items.filter(i => i.status === 'paused');
const inFlightItems = items.filter(i => i.status === 'uploading' || i.status === 'resuming');
const queuedCount   = items.filter(i => i.status === 'queued').length;
const totalBytes    = items.reduce((s, i) => s + i.size, 0);
const confirmedBytes = items.reduce((s, i) => s + (i.status === 'done' ? i.size : i.bytesUploaded), 0);
```

Because `updateItem` triggers a re-render on every call, and there are thousands
of calls during a large batch, these 8 passes execute continuously throughout the
upload. For 7000 items this is 56,000 iterations per render cycle.

**Impact:** High — constant CPU work proportional to queue size for the entire
duration of the upload.

**Fix:** Maintain running counters as separate state updated atomically alongside
item status changes — `doneCount`, `errorCount`, `activeCount`, `queuedCount`,
`confirmedBytes`, `totalBytes`. `BatchSummary` reads integers rather than
refiltering thousands of items on every render. The only array that still needs
to be tracked is `inFlightItems` (typically 3–4 items at concurrency=3) for
rendering the in-progress file rows.

**Effort:** Medium — requires updating `updateItem` and all call sites that
change item status to also update the relevant counters.

---

### Hotspot 3 — `setLogKey` fires once per completed file ★ Quick win

**Location:** `UploadQueue.jsx` line ~183; `App.jsx` `onLogEntry` handler

```js
.then(() => onLogEntry?.()).catch(() => {});   // fires on every completion
// App.jsx:
onLogEntry={() => setLogKey(k => k + 1)}      // triggers full App re-render
```

Every file completion triggers a full App-level re-render via `setLogKey`. For
7000 files that is 7000 App re-renders, each of which re-renders the entire
component tree — UploadQueue, UploadLog, Browser, header, footer, everything.

The upload log does not need to update 7000 times. Nobody is reading it in
real time during a large batch.

**Impact:** High — 7000 unnecessary full-tree re-renders.

**Fix:** Debounce `setLogKey` in App so it fires at most every 500ms–1s,
regardless of how many completions arrive in that window. The log refreshes
regularly but not per-file. Two lines of code.

**Effort:** Trivial.

---

### Hotspot 4 — `requestAnimationFrame` at 60fps throughout the upload

**Location:** `UploadQueue.jsx`, `BatchSummary` animation loop (lines ~641–663)
and `UploadItem` animation loop (lines ~793–803)

```js
function tick(now) {
  // updates displayed bytes counter
  animRef.current = requestAnimationFrame(tick);  // 60fps
}
animRef.current = requestAnimationFrame(tick);
```

The rAF loop runs continuously at 60fps while any upload is active, updating the
animated bytes counter. For a 7000-file upload running several minutes, this is
thousands of JS executions purely for a smooth counter animation — most of which
no one is watching, especially when the window is minimized.

**Impact:** Medium-high — constant 60fps CPU work for the entire upload duration.
Particularly wasteful when the tab is backgrounded.

**Fix (A):** Check `document.visibilityState` inside the rAF loop and skip the
tick (reschedule without updating) when the page is hidden. Zero visual difference
to the user; counter catches up instantly when they return to the tab.

**Fix (B):** Throttle to a lower frame rate (10–15fps) when `items.length` exceeds
a threshold (e.g. 100). The smoothness of a bytes counter is imperceptible above
~10fps.

**Fix (C):** Both — visibility-aware skip plus size-based throttle.

**Effort:** Small — a few lines inside the existing rAF callbacks.

---

### Hotspot 5 — `items.some()` in drain-detection effect runs on every update

**Location:** `UploadQueue.jsx`, `onUploadsComplete` useEffect (lines ~62–68)

```js
useEffect(() => {
  const hasActive = items.some(i => i.status === 'uploading' || i.status === 'resuming' || i.status === 'queued');
  if (hadActiveRef.current && !hasActive && items.length > 0) {
    onUploadsComplete?.();
  }
  hadActiveRef.current = hasActive;
}, [items, onUploadsComplete]);
```

This effect runs on every `items` state change — which happens on every
`updateItem` call. The O(n) `some()` scan executes thousands of times.

**Impact:** Medium — adds up alongside the other scans.

**Fix:** Maintain a running `activeCount` integer in state. The drain check
becomes `if (hadActiveRef.current && activeCount === 0 && items.length > 0)` —
O(1) with no array scan. This is a natural consequence of fixing Hotspot 2
(running counters).

**Effort:** Subsumed by Hotspot 2 fix.

---

### Hotspot 6 — SigV4 signing cost (outside our control)

Each upload requires HMAC-SHA256 request signing by the AWS SDK. For 7000 files
that is 7000 cryptographic signing operations. This is a non-zero baseline CPU
cost inherent to S3-compatible APIs and cannot be eliminated. Reducing file
concurrency reduces the number of simultaneous signing operations and can lower
the peak CPU spike.

**Impact:** Baseline — present regardless of other fixes.

**Fix:** None possible without changing the protocol. Lowering file concurrency
from the default (3) to 1–2 reduces peak load at the cost of throughput.

---

## Prioritisation

| Hotspot | Impact | Effort | Recommended order |
|---------|--------|--------|-------------------|
| 3 — `setLogKey` debounce | High | Trivial | 1st — do immediately |
| 4 — rAF visibility + throttle | Medium-high | Small | 2nd — do immediately |
| 2 — Running counters (8× filter passes) | High | Medium | 3rd |
| 5 — Drain detection O(1) | Medium | Trivial (falls out of #2) | With #2 |
| 1 — Map-based items store | High | Larger refactor | With persistent queue redesign |

Hotspots 1 and 2 are best addressed together as part of the persistent queue
redesign (see `persistent-queue-design.md`), since that work already restructures
how items are stored and tracked. Doing the Map refactor independently risks
duplicating the effort.

Hotspots 3 and 4 are independent quick wins that can ship any time.

---

## Out of Scope

- Virtual scrolling for the items list: the current UI already only renders
  in-flight items (typically 3–4) in the active view. Done items are counted
  but not individually rendered. Not a current bottleneck.
- Web Worker offloading for upload logic: significant complexity for uncertain
  gain, given the SDK must run in the main thread for fetch/XHR.
- Reducing part size to lower per-part signing overhead: already configurable
  in Settings; user can tune this themselves.
