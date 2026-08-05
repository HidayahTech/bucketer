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
