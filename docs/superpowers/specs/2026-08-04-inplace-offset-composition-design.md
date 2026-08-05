# Phase 2 — In-place offset composition (design)

Date: 2026-08-04
Author: Claude (Opus 4.8), autonomous session, expert-persona decision chronicle inline
Supersedes the "Phase 2" sketch in `2026-08-04-download-concurrency-design.md` §"Phase 2".
Branch: `inplace-composition`.

## OUTCOME (measured 2026-08-04 — read this first)

This design was motivated primarily by GitLab #59 (Firefox OPFS process-memory growth). **The
implementation shipped, but the #59 premise did NOT hold up under measurement.** A matched-pair
Firefox probe (`docs/review-download-parity/probe/inplace-memory-finding.md`) with the forcing
confirmed (in-place worker-count=1, serial=0) found:
- In-place is a **solid ~2× throughput win** on medium-file ZIPs (and lower OPFS disk).
- In-place is **NOT a #59 fix**: the Gecko OPFS memory growth affects `SyncAccessHandle`
  writes too, not just the temp read-back cycle. In-place's transient RSS **peak is actually
  higher** than serial (~28 vs ~19 MiB/file, structural — a two-process design); retained
  growth was too noisy to prove either engine flat. Worker-queue backpressure (added, correct)
  did not close the peak gap because the peak is not queue-dominated.

**Operator decision (2026-08-04): ship for all in-place-capable engines as a throughput
improvement, documented honestly as NOT a #59 fix.** #59 remains open for both engines. The
"Problem" section below is preserved as the original motivation; treat its #59 framing as
superseded by this outcome. The throughput/architecture benefits it describes are real.

## Problem

The shipped concurrent ZIP engine (`runPrefetch` → serial `onReady` writer, v1.48.0) has
two costs the store-only format makes unnecessary:

1. **Firefox OPFS process-memory growth (GitLab #59).** The medium (4–64 MiB) tier stages
   each file into an OPFS *temp* file, reads it back, then appends it into the staging ZIP.
   Firefox leaks ≈48 MiB of process RSS per medium file through that write→read-back→delete
   cycle — extrapolated, a ~200-medium-file job can OOM the tab. On-disk OPFS usage stays
   flat, so it is a Gecko OPFS quirk, not an algorithm defect — but the temp cycle is what
   triggers it. **Removing temp files removes the leak.** This is the primary motivation:
   Phase 2 is a bug fix for #59 as much as an optimization.

2. **A single serial writer + double I/O for medium files.** Every byte funnels through one
   async `createWritable` appender in manifest-completion order, and medium files pay 2× OPFS
   I/O (temp write + read-back). The store-only format makes every entry's *offset* known up
   front, so bytes can be written straight to their final slot with no buffering, no
   read-back, and no ordering constraint.

## Core insight

Store-only (method 0) + sizes-known-from-manifest ⇒ the full byte layout of the archive is
deterministic **before any byte is downloaded**, except the CRC-32 values (which live in the
data descriptor *after* each file's data and in the central directory — neither affects any
offset). So:

- Precompute, per entry: `headerOffset`, `dataOffset`, `dataEnd`, `descriptorOffset`,
  `entryEnd`. Also `centralDirOffset` = last `entryEnd`, and the total size.
- Download files concurrently; write each file's bytes **directly at its `dataOffset`** via a
  positioned write, in whatever order they arrive.
- The one thing that requires positioned writes is that arrival order ≠ archive order, so we
  need `write(buffer, { at })` — which OPFS exposes only through
  `FileSystemSyncAccessHandle`, worker-only and exclusive per file.

## Decision chronicle (expert personas)

The operator delegated decisions to expert personas and asked that they be chronicled.

### D1 — Architecture: where does fetch run, where do bytes get written?
**Persona: Browser-storage / OPFS specialist.**
`createSyncAccessHandle` is (a) worker-only in Firefox and WebKit (Chromium recently allows
main-thread, but we cannot special-case it) and (b) **exclusive**: one open handle per file.
So there is exactly ONE writer to the staging ZIP and it lives in a Web Worker. Two options
for fetch:
- **A. Fetch on main thread (reuse the shipped presign/probe/concurrency), stream each
  chunk to an "assembler" worker that owns the sync handle and does positioned writes.**
- B. Move the entire fetch loop into the worker; main thread only presigns via a message
  channel.

**Ruling: A.** It reuses every proven piece — presign (AWS SDK lives on main), the CORS/offline
`probe`, `runPool` concurrency, resume/cancel/quota bookkeeping — and confines the new,
risky surface to a thin worker that only does positioned writes + CRC + descriptors. Chunks
cross to the worker as **Transferable `ArrayBuffer`s** (zero-copy). B is a larger rewrite that
buys only marginal throughput (postMessage of a transferable is not a copy) at real risk.
*Chronicled trade-off:* A keeps a single-threaded write path, but `SyncAccessHandle.write` is
synchronous and direct (no `createWritable` stream machinery), so it is far faster than the
current appender and is not expected to be the bottleneck; the probe (D6) measures this.

### D2 — Do not rewrite `runPrefetch`; add a parallel engine.
**Persona: Release-risk engineer.**
`zip-prefetch.js` shipped in v1.48.0 with heavy hardening (abort leaks, orphan sweep, rolling
DENIED, quota pause). Rewriting it to stream-to-worker would put all of that at risk.
**Ruling:** leave `runPrefetch` untouched as the **fallback path**. Add a new orchestrator
(`zip-inplace.js`) + worker (`zip-assembler.worker.js`). `runZipJob` chooses at runtime:
in-place when the worker + sync handle are available, else the shipped serial path. Nothing
regresses for any browser; Phase 2 is strictly additive under a capability gate.

### D3 — ZIP format: keep data descriptors, or patch CRC into the local header?
**Persona: ZIP-format engineer.**
Positioned writes *could* let us drop bit-3 descriptors and patch the CRC back into the local
header once known. **Ruling: keep the descriptor-based format**, byte-identical to the shipped
writer's output. Reasons: (1) it is already proven to unzip in every tool the project tested;
(2) it keeps the central-directory builder in `zip-writer.js` reusable verbatim; (3) fewer
positioned writes to reason about (header and descriptor are written once each, not
read-modify-write on the header). The assembler writes, per entry: local header at
`headerOffset` (up front — sizes known), data streamed at `dataOffset`, data descriptor at
`descriptorOffset` once the file's CRC is complete.

### D4 — The layout is computed once, on the main thread, and shared.
**Persona: ZIP-format engineer.**
Offsets depend only on entry order + names + declared sizes + zip64-ness — all known from the
manifest. Compute the layout on main (`computeZipLayout(items, prefix)` — a pure function,
unit-testable without a browser), pass it to the worker. The worker never guesses offsets.
The central directory + EOCD are produced by the *existing* `zip-writer.finish()` logic,
driven from the per-entry records (offset, crc, size, time, date) exactly as today — but
written at the known `centralDirOffset` via the sync handle instead of appended.

### D5 — Resume, cancel, quota: reuse the shipped records model.
**Persona: Release-risk engineer.**
Item records already persist `{status, zipOffset, zipEnd, crc, size, time, date}`. In-place
resume is *cleaner* than append resume: each entry's slot is fixed by the layout, so a resumed
run re-fetches only PENDING items and writes them to their fixed `dataOffset`; DONE items'
bytes are already on disk. The central directory is written only when nothing remains PENDING
or FAILED — identical finish condition to today. Cancel aborts in-flight fetches and leaves
PENDING items for resume (same as `runPrefetch`). Quota: a positioned write past quota throws
`QuotaExceededError` → PAUSE the job (STORAGE block), same contract as today.
*Chronicled note:* the staging file is truncated/allocated to the total data-region size up
front so positioned writes never race the file's length; the probe (D6) confirms writes past
EOF extend correctly and that gaps left by out-of-order writes read back as written.

### D6 — De-risk with a fidelity probe BEFORE the full build. (Gate.)
**Persona: Browser-storage specialist + Operator.**
The entire design rests on one empirical question: are worker `SyncAccessHandle` positioned,
out-of-order writes byte-faithful on Chromium, Firefox, and WebKit? **Ruling: build and run a
standalone fidelity probe first**, in the container matrix, that: opens a sync handle in a
worker; writes regions out of order (region C, then A, then B) with gaps; interleaves partial
writes; closes; reopens; and asserts byte-exact content + correct final length. Also measures
peak process memory across a many-medium-file run to prove #59 is fixed (flat Firefox memory).
**Decision gate:** any engine that fails the probe (or lacks worker sync handle) is *gated out
of Phase 2 and keeps the shipped serial path* — exactly how ZIP itself gates Safari to
handoff. Phase 2 ships for the engines that pass; no engine regresses.

### D7 — Build: inline the worker as a Blob-URL string.
**Persona: Build / bundling engineer.**
The build guarantees a single self-contained `dist/index.html`. **Ruling:** esbuild bundles
`src/worker/zip-assembler.worker.js` as a separate IIFE, and the result is embedded as a
string constant; at runtime `new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'})))`.
No external file, single-file guarantee intact. A build invariant asserts the worker source is
present and non-empty in the bundle. Worker bundles `crc32` + the positioned-writer; it imports
nothing at runtime.

### D8 — Capability gate. (REVISED 2026-08-04 after the fidelity probe.)
**Persona: Browser-storage specialist.**
**Correction from the probe:** `createSyncAccessHandle` is exposed **only in worker global
scope**. `window.FileSystemFileHandle.prototype.createSyncAccessHandle` is `undefined` even on
Chromium/Firefox/WebKit that fully support it *in a worker*. So it **cannot** be
synchronously feature-detected from the main thread — the originally-planned
`isFn(fileHandleProto?.createSyncAccessHandle)` check would be `false` everywhere and in-place
would never activate.
**Ruling: optimistic selection + runtime worker fallback.** Main-thread detection gates only
on what IS detectable there: `inPlaceSupported(caps) = opfs && streamingFetch && webWorker`
(`webWorker = typeof Worker === 'function'`). When those hold, `runZipJob` optimistically
chooses in-place; `runInPlaceJob` spawns the worker, whose `init` self-checks
`createSyncAccessHandle` inside the worker. If it is absent (or `init` errors before any
fetch), the worker replies `{type:'unsupported'}` and `runInPlaceJob` returns a sentinel that
makes `runZipJob` fall back to the serial engine — no bytes fetched, no user-visible
difference. This is more robust than a startup probe (no async caps plumbing) and self-heals
if a browser removes the API. The existing `zipGate` (opfs/streamingFetch/writableFiles) is
unchanged — Phase 2 is a sub-choice *inside* the STAGED ZIP path, invisible to gate and UI.

### D9 — Version bump.
**Persona: Operator.** New capability, backwards-compatible, no format change, fallback
preserves all current behavior → **minor bump** (v1.49.0). Chronicled here per the delegation;
no interactive confirmation sought.

## Architecture

```
main thread                                   worker (1 sync handle on staging.zip)
───────────                                   ─────────────────────────────────────
computeZipLayout(items, prefix)  ──layout──►  open sync handle; truncate to dataRegionEnd
                                              write all local headers at headerOffset_i
runInPlaceJob:                                
  N concurrent fetches (runPool)              on {entryId, chunk@transferable}:
    presign → probe → fetch stream    ──────►   sync.write(chunk, {at: dataOffset_i + run_i})
    per chunk: postMessage(transfer)            run_i += chunk.len ; crc_i = crc32(chunk,crc_i)
    on stream end: postMessage(entryDone) ────► write data descriptor at descriptorOffset_i
                                                 postMessage(entryWritten {crc,size})
  on all done & nothing PENDING/FAILED  ──────► write central directory + EOCD at centralDirOffset
                                                 sync.flush(); sync.close()
  progress/records/cancel/quota as today
```

- **`src/lib/zip-layout.js`** (pure, unit-tested): `computeZipLayout(items, prefix, opts)` →
  `{ entries: [{key, path, headerOffset, headerBytes, dataOffset, descriptorOffset, entryEnd,
  zip64, declaredSize, time, date}], centralDirOffset, totalDataEnd }`. Reuses the header/
  descriptor byte-size math from `zip-writer.js` (extracted to shared helpers, not duplicated).
- **`src/worker/zip-assembler.worker.js`**: message protocol `{type:'init', layout}`,
  `{type:'chunk', entryId, buffer}` (buffer transferred), `{type:'entryEnd', entryId}`,
  `{type:'finish', records}`, `{type:'abort'}`; replies `{type:'ready'}`,
  `{type:'entryWritten', entryId, crc, size}`, `{type:'finished', totalBytes}`,
  `{type:'error', entryId?, name, message}`. Owns the sync handle; does positioned writes,
  CRC, descriptors, central directory (via shared zip-writer helpers).
- **`src/lib/zip-inplace.js`**: `runInPlaceJob(job, {presign, probe, fetchImpl, root,
  concurrency, worker, onProgress, shouldCancel})` — precompute layout, drive fetches, bridge
  to the worker, own resume/records/cancel/quota. Same return shape as `runZipJob`.
- **`runZipJob`** gains an engine selector: `inPlaceSupported(caps) ? runInPlaceJob : <current
  serial body>`. The current body is extracted so both paths share entry/records plumbing.
- **`build.mjs`**: bundle + inline the worker; invariant asserts presence.
- **`browser-capability.js`**: `syncAccessHandle`, `webWorker` detection.

## Testing

- **Unit (no browser):** `zip-layout.test.js` — offsets, zip64 thresholds, descriptor widths,
  central-dir offset, total size, byte-identical to what the serial writer would produce for
  the same inputs (cross-check against `createZipWriter`). Worker protocol logic factored into
  a pure `assembleInto(sink, ...)` core tested against an in-memory sink.
- **Component:** engine-selection branch in `runZipJob` (in-place vs fallback) via caps.
- **E2E (container matrix, the observable):** a many-file ZIP downloaded via the in-place
  engine unzips byte-exact; the fidelity probe spec; a resume arm (kill mid-job, resume,
  byte-valid ZIP); WebKit/unsupported lanes assert fallback path is used and still produce a
  valid ZIP. **Observable per D6/E2E rules:** the produced ZIP's bytes match a reference, and
  the mock's request log shows the expected GETs — not a counter.
- **Memory:** re-run the #59 many-medium-file probe on Firefox; assert flat process memory
  (the fix's whole point). Matched-pair: the leak reproduces on the serial path, is absent on
  in-place.

## Out of scope

- Compression (store-only stays).
- Any change to the handoff tier or the managed-folder tier.
- Changing the on-disk ZIP format (byte-identical output to the serial writer is a goal).
- Uploads.

## Known risks

- **WebKit sync-handle fidelity unknown** until the probe runs — mitigated by the fallback gate.
- **Positioned-write-past-EOF / sparse-gap behavior** — mitigated by up-front truncate to
  `totalDataEnd` and by the probe.
- **postMessage throughput** under N concurrent streams — mitigated by transferables; if the
  probe shows backpressure, add a credit/ack window (noted, not pre-built — YAGNI).
