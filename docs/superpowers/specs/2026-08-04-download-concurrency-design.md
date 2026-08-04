# Download concurrency: bounded prefetch for ZIP downloads

**Date:** 2026-08-04 · **Status:** approved (design), pending implementation
**Motivation:** ZIP downloads stream one file at a time into the OPFS staging archive
(`download-queue.js:91` is a strictly-sequential `for … await issue` loop). For a folder
of many small files that is latency-bound — a round-trip paid per file, serially. This
adds **bounded prefetch**: up to N files fetch concurrently while the single ZIP writer
still appends them serially, overlapping network round-trips with the OPFS append. Builds
on the ZIP download feature (v1.46.0) and the in-progress ZIP download progress feature
(byte/speed/ETA + active-file detail).

Decisions below were taken by an expert-consensus panel (network, storage, reliability,
UX, architecture) at the operator's instruction to decide remaining questions and
chronicle them, rather than ask further.

## Operator decisions (2026-08-03/04)

1. **Bounded prefetch, first pass** (not in-place offset composition — that is Phase 2,
   documented below).
2. **Hybrid buffering by file size** (tiny → memory, medium → OPFS temp, huge → stream
   solo).
3. **The progress detail shows the N concurrent downloads** (the just-built `active`
   single-file row becomes an active-list).
4. **ZIP path only.** The handoff (per-file browser download) tier hands files to the
   browser's own download manager, which already parallelizes; it is unchanged.

## Panel decisions (chronicled)

- **D1 — Concurrency degree.** Default `N = 4`; configurable up to ~8. `N` bounds the total
  number of concurrent GET fetches (a huge file streaming solo counts as one of the N).
  Rationale: browsers cap ~6 connections/host on HTTP/1.1 (B2's S3 endpoint is HTTP/1.1 —
  see the upload-perf ceiling notes); diminishing returns past the cap; more in-flight
  fetches complicate the breaker.
- **D2 — Tier thresholds.** `tiny ≤ 4 MiB` → memory buffer; `4 MiB < medium ≤ 64 MiB` →
  its own OPFS temp file; `huge > 64 MiB` → streamed solo (no prefetch). Constants are
  tunable; the probe (D6) validates them. Peak memory ≤ N × 4 MiB; peak OPFS temp ≤
  N × 64 MiB (on top of the growing ZIP).
- **D3 — Ordering.** Completion-order append: the serial writer takes whichever prefetched
  file is *ready* next (the writer already accepts records out of physical order — the
  central directory carries per-entry offsets). No head-of-line blocking on a slow file. A
  huge file streams solo through the writer while tiny/medium keep prefetching behind it
  and drain after.
- **D4 — Failure / resume / breaker / quota.**
  - Per-file failure (any tier) → mark the item FAILED, discard its buffer/temp, do NOT
    write it. On resume it is re-fetched (file-granularity resume is unchanged — only
    *committed* writes are in the ZIP).
  - The 3-consecutive-DENIED breaker becomes a **rolling DENIED count** (order-independent
    under concurrency): trip the job-wide block when DENIED reaches the threshold within
    the active window; reset on any success. Preserves the breaker's intent under
    concurrency.
  - Quota gate reserves headroom for temps: fit check becomes
    `sendableBytes + N×64 MiB ≤ QUOTA_SAFETY × free`. A `QuotaExceededError` mid-run pauses
    (existing behavior) and frees in-flight temps to reclaim space; resumable.
  - Cancel aborts all in-flight fetches (`AbortController` per fetch) and deletes all temps
    and buffers.
- **D5 — Progress hookup.** The progress feature's task field `active` (a single
  `{key,size,bytes}`) migrates to `active` = an **array** of the currently-downloading
  files (length 1..N). `bytesDone` sums downloaded bytes across all in-flight files plus
  committed bytes (keeps the bar/speed/ETA smooth). The rate tracker (`useRate`) is
  unchanged (still fed by `bytesDone`). `MasterQueue`'s detail renders each active row.
- **D6 — Probe (measurement discipline).** A throughput probe comparing sequential vs
  bounded-prefetch on (a) a many-small-files job and (b) a mixed job, in the container
  (chromium + firefox), measuring wall-clock, peak process memory, and peak OPFS usage.
  Proves the win and confirms memory/OPFS stay bounded. Mandated as a plan step (like the
  ZIP export-scale probe).
- **D7 — Engine placement.** A new concurrent orchestration lives in `zip-job.js` (a
  prefetch pool + a serial writer-drain loop). It reuses the item-status helpers
  (`updateItem`/`eachItemByStatus`/`countItemsByStatus`/`ITEM_STATUS`), presign, the probe,
  the breaker logic, the quota-pause path, and the OPFS writer. It REPLACES `runDownloadJob`'s
  sequential loop *for the ZIP path only* — `runDownloadJob` and the handoff path are
  untouched (the handoff `issue` closure and the browser-download tier keep working exactly
  as today). Before writing a new concurrency-pool primitive, check the upload queue
  (`src/lib/upload-queue.js` / `UploadQueue.jsx`) for a reusable bounded-concurrency
  helper to adapt.

## Architecture

**Separate the download (concurrent) from the write (serial).** OPFS cannot cleanly take
N concurrent writers on one file, but the *fetches* overlap freely.

- **Prefetch pool** — up to N concurrent presigned GETs. Each downloaded file lands in a
  tier-sized buffer (memory / OPFS temp / streamed-solo) and computes its CRC during its
  own download, so it is ready to commit.
- **Serial writer** — the single ZIP writer drains ready buffers one at a time, appending
  each entry (local header → bytes → data descriptor) into the one staging ZIP. Memory
  buffers are written directly; OPFS-temp files are copied in store-only (no re-CRC) then
  deleted; a huge file streams straight through the writer solo.
- **Completion-order** — whichever prefetched file is ready next is appended when the
  writer is free. Prefetch continues (filling buffers/temps) even while a huge file
  occupies the writer.

Net: network round-trips overlap (the real win on many-small-files) while the OPFS
single-file-write constraint is fully respected — no positioned writes, no 2× for the
whole set (only the bounded in-flight tiny buffers + medium temps).

## Composition with existing behavior

- **Resume** — unchanged at file granularity: committed (DONE) entries are in the ZIP;
  PENDING/FAILED are re-scanned and prefetched on resume. In-flight-but-uncommitted files
  at interruption are simply re-fetched (no partial ZIP state).
- **The ZIP writer** — unchanged (store-only ZIP64, out-of-order records via the central
  directory). No writer rework in this phase.
- **The gate / quota** — the existing capability + fit gate, plus the temp reserve (D4).
- **The progress feature** — extended per D5 (active → active-list; bytesDone aggregate).
- **Cancel / discard / staging cleanup** — extended to abort fetches and delete temps.

## Testing

- **Unit (plain Node):** the bounded-concurrency pool (deterministic ordering with injected
  fake fetches); the tier router (size → memory/temp/solo); the rolling-DENIED breaker; the
  completion-order drain; temp-file lifecycle (create → drain → delete; deleted on
  failure/cancel). Fake OPFS + fake fetch, as in the existing `zip-job` tests.
- **Component (jsdom):** the MasterQueue detail renders an active-*list* (N rows) with live
  per-file bytes; `bytesDone` aggregate drives the bar/speed/ETA.
- **E2E (container matrix; evidence rules, baseline first):** a many-small-files ZIP
  download completes as one byte-valid ZIP with all files (the observable is unchanged from
  the ZIP feature — one download, exact bytes/CRCs); an interruption/resume arm still yields
  a byte-valid ZIP. Concurrency-specific timing is not asserted in e2e (timing-sensitive);
  the probe (below) measures the speedup.
- **Probe (D6):** the mandated throughput/memory/OPFS probe. If the win is not real or
  memory/OPFS is not bounded, STOP for the operator.

## Phase 2 — in-place offset composition (documented, not built)

Because the archive is store-only, every entry's size — and therefore its **offset** in the
archive — is known up front. A future phase could download files concurrently and write
each straight into its pre-computed slot in the one ZIP, eliminating even the serial-writer
bottleneck. Requirements: rework the writer from append to **positioned writes**; move ZIP
staging into a **Web Worker** using `createSyncAccessHandle` (the performant positioned-write
API, exclusive per file, worker-only); per-slot CRC/descriptor handling; and — critically —
a **cross-browser OPFS positioned-write fidelity probe** before relying on it. Higher effort
and risk; deferred to Phase 2.

## Out of scope (this phase)

- In-place offset composition (Phase 2, above).
- Any change to the handoff (per-file browser download) tier.
- Any change to the ZIP writer's format or append model.
- Concurrency for uploads (already N=2) or for non-ZIP downloads.
