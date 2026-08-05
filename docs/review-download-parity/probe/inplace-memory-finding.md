# In-place vs serial — Firefox memory + throughput (measured 2026-08-04)

Probe: `run-inplace-memory.mjs`, host Firefox (playwright pinned), 8 MiB medium files,
N ∈ {2,4,8,16}, 2 reps. Engine confirmed per run: in-place workerCount=1, serial
workerCount=0 (window.Worker deleted forces the serial+OPFS-temp fallback). Full data:
`results-inplace-memory.json`.

## Headline: in-place does NOT fix #59.

Both engines grow Firefox process RSS per medium file and largely retain it:
- Retained-after-settle slope: in-place ~15 MiB/file, serial ~14 MiB/file — **equal**.
- Peak slope: in-place ~25 MiB/file, serial ~18 MiB/file — in-place **higher**.

Root cause: the Gecko OPFS process-memory quirk behind #59 is triggered by OPFS write
activity broadly — `FileSystemSyncAccessHandle.write` (in-place) as much as the
`createWritable` temp read-back cycle (serial). It is NOT specific to the temp tier we
blamed. Removing temp files therefore does not remove the growth.

In-place's *higher peak* is likely the unbounded worker message-queue (fetch readers post
chunks fire-and-forget; the near-zero-latency local mock lets them outrun the worker's
synchronous writes). Backpressure (a credit/ack window) would lower the PEAK toward serial's,
but NOT the retained per-file growth — that is the Gecko quirk and is engine-independent.

## In-place IS a throughput win.

Wall time (ms), median of 2 reps:
| N | in-place | serial | speedup |
|---|---------|--------|---------|
| 2 | ~763 | ~990 | 1.3× |
| 4 | ~865 | ~1490 | 1.7× |
| 8 | ~1248 | ~2120 | 1.7× |
| 16 | ~1910 | ~3750 | **2.0×** |

OPFS disk: in-place ≤ serial at every N (no separate temp files). Both bounded (= ZIP size).

## Implication

The feature is a real **throughput / architecture** improvement (eliminates the serial
writer + temp read-back; ~2× faster on medium-file ZIPs; lower OPFS disk). It is NOT a
#59 memory fix. On Firefox its transient peak is currently *higher* than serial's (worker
queue), so a very large many-medium-file Firefox job could OOM sooner unless backpressure is
added. #59 (Gecko OPFS process-memory growth) remains open and affects all OPFS-staging paths.

## Update: after adding worker-queue backpressure (16 MiB window)

Backpressure is correct (reviewed, no hang/credit-leak paths) but did NOT close the Firefox
peak gap — because the peak is not queue-dominated. Clean 2-rep numbers (8 MiB files):

| N | in-place peak | serial peak | in-place wallMs | serial wallMs |
|---|--------------|-------------|-----------------|---------------|
| 2 | 98 | 105 | 736 | 1091 |
| 4 | 169 | 164 | 1013 | 1415 |
| 8 | 284 | 260 | 1414 | 2321 |
| 16| 489 | 377 | 2121 | 4326 |

- Peak slope: in-place ~28 MiB/file vs serial ~19 — in-place structurally higher (two-process
  design: the worker's OPFS activity adds to tree RSS). Backpressure (16 MiB) didn't change it.
- Throughput: in-place **~2.0×** faster at every N — solid, reproducible.
- Retained (the true #59 leak): too noisy at 2 reps to slope (serial non-monotonic). Neither
  engine is flat; in-place is NOT proven to fix #59, and the retained difference is not
  cleanly measurable here.

Conclusion: in-place is a reliable ~2× throughput win with a modest, reproducible Firefox
peak-memory regression that only bites pathological many-medium-file Firefox jobs (which
already hit #59 on serial). Not a #59 fix.

## Root-cause update — web research (2026-08-05)

The "Gecko OPFS quirk" framing above is superseded by a better-sourced explanation. Bugzilla
has NO bug describing OPFS positioned-writes leaking process memory per file — but two open/
known **ArrayBuffer-to-worker** GC issues map cleanly onto what we measured:

- **[Bug 1407691 — "Run away memory use sending ArrayBuffers to workers"](https://bugzilla.mozilla.org/show_bug.cgi?id=1407691) — STILL OPEN.**
  Repeatedly `postMessage`-ing ArrayBuffers into a worker makes memory climb until the worker
  is *terminated* (or memory is manually minimized), because **workers only GC when idle** and
  a continuous transfer flood never lets the worker idle. This is exactly the in-place engine
  (N concurrent fetches transferring chunk buffers into the always-busy assembler worker) and
  is the most likely cause of in-place's **~10 MiB/file higher peak vs serial** — NOT anything
  intrinsic to OPFS positioned writes. (The earlier "structural two-process design" note was
  too vague.)
- **[Bug 1651612](https://bugzilla.mozilla.org/show_bug.cgi?id=1651612) — RESOLVED FIXED (Firefox 80)**: the single-buffer version (needed 2 GC cycles).
  The flood case (1407691) was split off and stays open.
- The **shared** per-file retained growth (both engines) is better explained by Firefox's
  general deferred ArrayBuffer GC during busy work (fetched response buffers not reclaimed
  until idle/blur/CPU-drop) — [Bug 1540101](https://bugzilla.mozilla.org/show_bug.cgi?id=1540101), [Bug 1037358](https://bugzilla.mozilla.org/show_bug.cgi?id=1037358). Not OPFS-specific.

So this is an **ArrayBuffer/worker GC story, not an OPFS story.** #59 stays open, but the
mechanism is now understood. Documented mitigations (from 1407691): terminate the worker at
job end (we already do — hence retained < peak); **transfer buffers back out of the worker**
to trigger cleanup; or fetch inside the worker (no cross-thread transfer). The byte-window
backpressure did NOT help because it doesn't reduce how many buffers pass *through* the worker.

**Prototype (this branch `inplace-worker-buffer-return`):** the worker transfers each drained
chunk buffer back to the main thread in its `ack`, per 1407691's "transfer back out" mitigation.
See `results-inplace-memory-return.json` for the matched-pair re-measurement.

## Prototype result — worker transfers drained buffers back out (2026-08-05)

Firefox peak-RSS growth per medium file (8 MiB files, N∈{2,4,8,16}, 2 reps),
`results-inplace-memory-return.json`:

| engine | n=2 | n=4 | n=8 | n=16 | peak slope |
|--------|-----|-----|-----|------|-----------|
| in-place, backpressure only (shipped v1.49.0) | 98 | 169 | 284 | 489 | ~28 MiB/file |
| **in-place + buffer-return (this branch)** | 98 | 157 | 270 | **414** | **~22.7 MiB/file** |
| serial (same run) | 72 | 142 | 218 | 313 | ~17.6 MiB/file |

**Verdict: the mitigation helps, partially.** Transferring each drained chunk buffer back out
of the worker (Bug 1407691's documented workaround) cut in-place's per-file peak growth ~19%
(489→414 MiB at N=16; slope ~28→~22.7). This confirms Bug 1407691 is a real contributor. It
narrows but does not close the gap to serial (~17.6) — residual is the worker process itself +
in-worker OPFS write buffering, and main now transiently holding the returned buffers.
Throughput unchanged (in-place stayed faster within-run). Low-risk (one worker line + the
client already tolerates the extra ack field; 1451 unit tests pass). Not a full fix; a buffer
POOL (reuse returned buffers) or fetch-in-worker (no transfer at all) could push further.

## Experiment — "fetch inside the worker" (Approach B), 2026-08-05

Standalone A/B harness (`worker-fetch/`, real `fetch()` against a streamed /blob endpoint,
Firefox, N∈{2,4,8,16}, 2 reps): `transfer` = the shipped path (main fetches → transfers
buffers → worker writes); `workerfetch` = a worker fetches + writes with NO cross-thread
transfer. Isolates the transfer variable.

| N | transfer peak | workerfetch peak |
|---|--------------|------------------|
| 2 | ~91 | ~74 |
| 4 | ~167 | ~153 |
| 8 | ~306 | ~251 |
| 16 | ~517 | ~370 |
| **peak slope** | **30.4 MiB/file** | **20.7 MiB/file** |

**Result: Approach B cuts per-file peak growth ~32%** (real fetch). A *synthetic*-bytes
variant of the same A/B showed ~83% (transfer=14.6 vs workerfetch=2.5, workerfetch nearly
FLAT) — the gap between 83% and 32% is the crucial finding: **real `fetch()` adds a ~20
MiB/file network-buffer floor to BOTH mechanisms** (response bodies not promptly GC'd during
busy work — the engine-independent deferred-ArrayBuffer-GC effect). Moving fetch into the
worker removes the cross-thread transfer contribution (~10 MiB/file) but NOT that floor.

**Interpretation:**
- Approach B would bring in-place's Firefox per-file peak from ~30 down to ~21 MiB/file
  (this harness) — landing ≈ the real-app **serial** engine (~17.6). I.e. it would **erase
  in-place's Firefox memory regression (down to ~serial) while keeping the ~2× throughput**,
  but not go below serial.
- Incremental over the SHIPPED v1.49.1 buffer-return (~19% already recovered): ~another 13%.
  Buffer-return is a partial version of the same idea (get buffers out of the busy worker);
  workerfetch never puts them in.
- The ~20 MiB/file fetch-buffer floor is the true residual of #59 and is NOT addressed by any
  worker/transfer change — it would need a different lever (e.g. smaller in-flight windows,
  or Firefox fixing deferred ArrayBuffer GC).

**Cost of productionizing Approach B:** substantial — move fetch + CORS/offline probe +
per-entry records reporting into the worker; presign-in-worker (credentials/SDK on main →
either presign-all-up-front with refresh, or an on-demand presign message channel);
rework cancel/quota/progress across the boundary; new e2e. A full feature cycle, and a bigger
worker. Experiment harness: `docs/review-download-parity/probe/worker-fetch/`.
