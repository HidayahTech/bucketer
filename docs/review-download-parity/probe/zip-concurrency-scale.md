# Concurrent vs sequential ZIP download — throughput probe (D6)

Spec-mandated measurement for the download-concurrency design
(`docs/superpowers/specs/2026-08-04-download-concurrency-design.md`, D6): does bounded
prefetch (concurrency 4) actually beat sequential (concurrency 1) on a many-small-files
job, and do peak process memory and peak OPFS usage stay bounded — by concurrency, not by
file count — while it does?

**Verdict: DONE_WITH_CONCERNS.** The concurrency win is real and large in both engines. The
"bounded by N" half of the premise holds in Chromium but does **not** hold in Firefox: peak
process memory during the OPFS temp-tier path grows linearly with the *cumulative bytes
processed*, not with concurrency — reaching ~1.9 GiB of un-reclaimed RSS for a 40-medium-file
job that only ever has ~32 MiB actually resident on OPFS at once. This is not introduced by
the concurrency feature's fan-out (it reproduces identically at concurrency=1); it is a
property of the new OPFS temp-tier (`createTempStore` in `src/lib/zip-prefetch.js`, D1/D2)
itself, which this branch's `zip-job.js` now uses unconditionally (the old sequential loop is
gone — see `1894889 feat: runZipJob downloads concurrently via the prefetch pool`). See
"Verdict" below for the full reasoning and what it means for D2's stated bound.

## Method

Same method as the rest of `docs/review-download-parity/probe/` — see the README's "Method,
in one paragraph". One fresh persistent-context browser per measurement, 3 repetitions per
cell reported as median with range, a `control` that allocates nothing to establish the noise
floor, profiles on real disk (`PROFILE_ROOT` under the repo, never tmpfs). Memory sampled
every 40 ms from outside the browser across the whole process tree (`ps` on the process tree
rooted at the browser PID). OPFS usage is sampled differently from the rest of the parity
work, because it has to be: OPFS bytes live on disk under the profile directory, not in the
browser process's resident memory, so external `ps` cannot see them. Instead the page polls
`navigator.storage.estimate()` every 50 ms — the standard Storage API, in-page, at the same
cadence the external harness samples RSS — and reports the peak delta over baseline.

Image: `mcr.microsoft.com/playwright:v1.60.0-noble` — the tag locked in `package-lock.json`
and pinned in `.gitlab-ci.yml`. WebKit is out of scope per the task brief ("chromium +
firefox").

### Driving the real code, not a reimplementation

`run-concurrency.mjs` serves `src/lib/zip-prefetch.js` unmodified at `/lib/zip-prefetch.js`,
alongside its real relative-import siblings `upload-queue.js`, `zip-writer.js`, and
`download-preflight.js` at the same `/lib/` path (so the browser's native ES module resolver
follows the real `./upload-queue.js`-style relative imports with no bundler involved) — the
same pattern `run.mjs` already uses for `zip-writer.js`. The one dependency that cannot be
served as-is is `upload-queue.js`'s `import { ListPartsCommand } from '@aws-sdk/client-s3'`
— a bare specifier a browser cannot resolve without an import map, and `@aws-sdk/client-s3`
is not something a probe page can reasonably vendor. `ListPartsCommand` is used only by
`collectParts()`, which this probe never calls (it only exercises `runPool`, `upload-queue.js`'s
other export, via `runPrefetch`); `probe-concurrency.html`'s `<script type="importmap">`
redirects the specifier to a trivial one-line stub (`export class ListPartsCommand {}`) the
server hands out at `/lib/aws-sdk-stub.js`, letting the real `upload-queue.js` source ship
completely unmodified.

**Harness fidelity — the fake network.** `runPrefetch` takes `fetchImpl`/`presign`/`probe` as
parameters specifically so a caller can substitute them; this probe supplies:

- `presign`: trivial, the item's key **is** the fake URL — no network round trip.
- `probe` (the per-file NETWORK/DENIED preflight): omitted entirely (`runPrefetch` treats it
  as optional), so the measured win is attributable to the fetch round trip alone, not doubled
  by an extra preflight round trip.
- `fetchImpl`: awaits an injected `LATENCY_MS` (50 ms) delay — modeling the per-file RTT the
  concurrency win exists to hide, **the one thing a zero-latency mock cannot show** — then
  streams the item's declared size back through a real `ReadableStream`, in 128 KiB chunks,
  each a **freshly allocated** `Uint8Array` (never a shared/reused buffer — reusing one buffer
  object across reads would make every "downloaded" byte alias the same memory and hide real
  memory pressure behind one object reference, which would silently invalidate the whole
  memory measurement).
- `onReady`: fully drains `entry.chunks` and discards the bytes — for memory-tier items this
  exercises the real in-memory buffering + CRC path; for temp-tier items this exercises the
  real OPFS `tempStore.put()` write and `tempStore.open().stream()` read-back, i.e. real disk
  I/O through the real `createTempStore` in `zip-prefetch.js`, not a proxy for it.
- `root`: a real `navigator.storage.getDirectory()` OPFS root (skipped only if OPFS is
  entirely unavailable, which does not happen for chromium/firefox).

This drives the real `runPrefetch` orchestration — the writer-lock backpressure, the tier
router (`classifyTier`), the temp-store lifecycle, the completion-order writer callback — end
to end. It is not a proxy for the download-concurrency design; it *is* the design's core
algorithm, minus the app UI and the real S3 network.

### Workloads

- **tiny** — 150 files, deterministic sizes spanning 256 KiB..1024 KiB (all classify as
  `memory` tier, `TINY_MAX` = 4 MiB). This is the "many-small-files" job D6 asks for — the one
  where RTT-hiding should show close to an N× win.
- **mixed** — the same 150 tiny files plus 20 files spanning 16..32 MiB (`temp` tier,
  `MEDIUM_MAX` = 64 MiB), to also exercise the OPFS temp-tier path and give the peak-OPFS
  measurement something real to measure.

## The primary sweep: wall-clock + memory/OPFS, concurrency 1 vs 4

`chromium,firefox` × `{tiny, mixed}` × `{concurrency 1, concurrency 4}` × REPS=3, plus 3
control reps per engine. 30 runs total, one podman invocation per engine (2m57s chromium,
3m41s firefox — both far under the ~9 min budget). Raw data: `results-zip-concurrency.json`.

```
podman run --rm --ipc=host -v "$PWD":/work:Z \
  -w /work/docs/review-download-parity/probe \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e MECHS=control,prefetch -e WORKLOADS=tiny,mixed -e CONCS=1,4 \
  -e ENGINES=<chromium|firefox> -e REPS=3 -e LATENCY_MS=50 \
  -e OUT_JSON=./results-zip-concurrency-<engine>.json \
  mcr.microsoft.com/playwright:v1.60.0-noble node run-concurrency.mjs
```

(Batches merged into `results-zip-concurrency.json` afterward.)

### Wall-clock, median (min..max) over 3 reps

| Engine | Workload | Sequential (c=1) | Concurrent (c=4) | Speedup |
|---|---|---|---|---|
| Chromium | tiny (150 files, memory tier) | 7847 ms (7839..7849) | 1979 ms (1978..1984) | **3.97x** |
| Firefox | tiny (150 files, memory tier) | 8638 ms (8609..8661) | 2173 ms (2170..2180) | **3.98x** |
| Chromium | mixed (150 tiny + 20 medium) | 14446 ms (14361..35218) | 5389 ms (5096..9482) | **2.68x** |
| Firefox | mixed (150 tiny + 20 medium) | 20456 ms (20033..31169) | 10775 ms (10685..13005) | **1.90x** |

The tiny-workload speedup (~3.97-3.98x at concurrency 4) is close to the theoretical ceiling
of 4x — expected, since with a 50 ms RTT dominating a sub-millisecond local transfer, wall
time is essentially `fileCount / concurrency × LATENCY_MS`, and `150 / 4 ≈ 37.5` vs `150 / 1 =
150`. The mixed-workload speedup is lower (2.68x / 1.90x) because it also carries real OPFS
write/read I/O for the 20 medium files, which does not compress as cleanly under concurrency
as pure RTT-hiding does. **Every cell of this table confirms concurrency=4 beats
concurrency=1** — the wall-clock half of the premise holds cleanly in both engines.

Both tiny cells and the Chromium mixed cell show tight, low-variance ranges. The mixed
cell's wider ranges (Chromium c1: 14361..35218; Firefox c1: 20033..31169) foreshadow the
memory finding below — see "Verdict."

### Control noise floor (idle, allocates nothing)

| Engine | peakDeltaMiB, median (min..max) |
|---|---|
| Chromium | 1 (0..1) |
| Firefox | 10 (8..13) |

Matches the README's documented floors (Chromium ~1 MiB, Firefox ~8 MiB) closely enough to
trust the harness is behaving consistently with the rest of `probe/`.

### Peak process RSS delta and peak OPFS usage, median (min..max) over 3 reps

| Engine | Workload | Conc. | RSS ΔMiB | OPFS peak MiB |
|---|---|---|---|---|
| Chromium | tiny | 1 | 41 (40..54) | 0 |
| Chromium | tiny | 4 | 40 (38..41) | 0 |
| Chromium | mixed | 1 | 98 (88..103) | 32 (32..32) |
| Chromium | mixed | 4 | 127 (114..131) | 74 (73..79) |
| Firefox | tiny | 1 | 48 (48..53) | 0 |
| Firefox | tiny | 4 | 99 (99..99) | 0 |
| Firefox | mixed | 1 | 255 (188..1050) | 32 (32..32) |
| Firefox | mixed | 4 | 1052 (1052..1055) | 79 (79..82) |

Two things to read here:

- **OPFS peak usage (the standard-API measurement, both engines) is exactly what D2
  predicts.** At concurrency 1 it tops out at 32 MiB — precisely the largest single medium
  file in the workload (`16 + 4×4 MiB`), i.e. at most one temp file resident at a time. At
  concurrency 4 it rises to ~74-82 MiB — well under the `N×MEDIUM_MAX` = 4×64 = 256 MiB
  ceiling, and clearly scaling with *concurrency*, not with the 20-file workload's total ~480
  MiB of medium data. The OPFS-disk half of D2's invariant is confirmed in both engines.
- **Firefox's process RSS delta for the mixed workload does not fit that story.** 255 MiB
  median for concurrency 1 (with a 1050 MiB outlier — one of the 3 reps), jumping to a rock-
  solid 1052-1055 MiB for **all three** concurrency-4 reps. Chromium's mixed-workload RSS
  stays in the 88-131 MiB range throughout — consistent with engine overhead plus a small,
  bounded buffer footprint. This divergence is the reason for the second sweep below.

## A second sweep: does Firefox's RSS scale with concurrency, or with byte volume?

The first sweep held workload size fixed and varied concurrency; it cannot distinguish "RSS
scales with concurrency" (the thing D2 is actually about) from "RSS scales with total bytes
processed regardless of concurrency" (a different and worse problem). A dedicated sweep holds
concurrency fixed at **1** and varies only the medium-file count (`ntiny=0`, so nothing but
the OPFS temp-tier path runs — an isolation this probe supports via the `SCALE_NMEDIUMS`
env var / `nmedium`+`ntiny` query params added to `probe-concurrency.html` for this purpose).
3 reps × {4, 20, 40} medium files × 2 engines = 18 runs, one podman invocation, 4m45s wall.
Raw data: `results-zip-concurrency-scale.json`.

```
podman run --rm --ipc=host -v "$PWD":/work:Z \
  -w /work/docs/review-download-parity/probe \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e SCALE_NMEDIUMS=4,20,40 -e ENGINES=chromium,firefox -e REPS=3 \
  -e OUT_JSON=./results-zip-concurrency-scale.json \
  mcr.microsoft.com/playwright:v1.60.0-noble node run-concurrency.mjs
```

| Engine | Medium files | RSS ΔMiB, median (min..max) | OPFS peak MiB | RSS ΔMiB per file |
|---|---|---|---|---|
| Chromium | 4 | 62 (62..64) | 28 | 15.5 |
| Chromium | 20 | 95 (91..98) | 32 | 4.8 |
| Chromium | 40 | 104 (102..106) | 32 | 2.6 |
| Firefox | 4 | 188 (188..189) | 28 | 47.0 |
| Firefox | 20 | 963 (963..966) | 32 | 48.2 |
| Firefox | 40 | 1934 (1933..1936) | 32 | 48.4 |

At **fixed concurrency=1**, all three reps at each file count are tight (±3 MiB or less) —
this is not noise. Chromium's RSS-per-file *decreases* as file count grows (15.5 → 4.8 → 2.6),
the signature of a mostly-fixed overhead amortizing over more files while the actual live
footprint stays bounded near the concurrency-1 ceiling (~1×MEDIUM_MAX). Firefox's RSS-per-file
is **constant at ~48 MiB regardless of file count** (47.0, 48.2, 48.4) — the signature of a
per-file cost that never gets reclaimed: 10x more files (4→40) produces almost exactly 10x
more retained RSS (188→1934 MiB, ratio 10.3x), while OPFS's own on-disk usage stays flat at 32
MiB the entire time (confirming the temp files themselves genuinely are being deleted — the
bytes are not piling up on disk, they are piling up in the Firefox process's memory). Roughly
48 MiB retained per ~24 MiB-average medium file is about 2x the file's own size — consistent
with something in Firefox's `createWritable()`/`getFile()`/`Blob.slice().arrayBuffer()`
OPFS-temp-file lifecycle (write, read back in `TEMP_CHUNK` pieces, delete) not releasing
memory back promptly, compounding once per file across the job.

This happens at **concurrency=1** — the same value used by every ZIP download before this
branch. It is not a consequence of the prefetch pool's fan-out; it is a consequence of routing
medium-sized files through the new OPFS temp tier at all, which this branch's `zip-job.js` now
does unconditionally (`1894889 feat: runZipJob downloads concurrently via the prefetch pool`
replaced the old sequential loop — there is no code path left that avoids `zip-prefetch.js`'s
tier router for the ZIP-download feature). A job with, say, 200 medium-sized files (a plausible
real workload — think a folder of scanned documents or short video clips) would be predicted,
by this linear relationship, to retain roughly 200 × 48 MiB ≈ 9.4 GiB of Firefox process RSS —
enough to crash the tab on most consumer hardware — regardless of whether concurrency is 1 or
4.

## Verdict: DONE_WITH_CONCERNS

**The concurrency win (D6's primary question) is real, large, and confirmed in both engines**:
concurrency=4 beats concurrency=1 by 3.97-3.98x on the many-small-files (RTT-dominated)
workload and by 1.90-2.68x on the mixed workload, with tight, reproducible measurements. Do
not read anything below as walking that back.

**The "bounded, not scaling with file count" half of the premise (D2's stated invariant) holds
in Chromium and does not hold in Firefox, for the OPFS temp tier specifically.** OPFS's own
on-disk usage (the standard `navigator.storage.estimate()` measurement) is bounded by
concurrency in both engines, exactly as D2 predicts (~1×MEDIUM_MAX at concurrency 1, well
under N×MEDIUM_MAX at concurrency 4). But Firefox's actual process memory during that same
work grows **linearly with the total number of medium-tier files in the job** — about 48 MiB
of un-reclaimed RSS per file, independent of concurrency, confirmed by three tight reps at
each of three file counts (4/20/40) spanning a 10x range with a near-perfect 10x RSS-growth
match. This is not a proxy result or a one-off outlier: it reproduced identically across every
rep at every size, and the isolating sweep (concurrency fixed at 1, tiny files removed
entirely) rules out both "it's a concurrency artifact" and "it's the tiny-file path
contributing."

This needs the operator's judgment, not a unilateral fix, because the options trade off
against each other and touch the design's stated scope:

- The design's stated bound ("peak OPFS temp ≤ N × 64 MiB", D2) is written in terms of OPFS
  storage usage, which this probe confirms holds. If that is the intended meaning, D2's
  invariant is satisfied as measured and this is a *separate*, Firefox-specific finding about
  process memory rather than a violation of D2 itself — worth flagging regardless, but not
  necessarily blocking.
- If the intended meaning (or the practical concern — a browser tab that gets killed by the OS
  under memory pressure does not care whether the bytes were "supposed to" be on disk) includes
  process memory, then the mixed/medium-tier path as currently implemented does not meet it in
  Firefox, and a job with many medium-tier files could crash the tab regardless of the
  concurrency setting chosen.
- Lowering `MEDIUM_MAX` (routing more files to the `solo` streamed-no-buffering tier instead of
  the OPFS temp tier) would reduce exposure per file but does not address the underlying
  per-file retention in Firefox's OPFS write/read cycle, and changes the tier boundaries this
  probe was not asked to re-tune.
- This may be a Firefox/Gecko OPFS implementation characteristic worth a smaller, targeted
  follow-up probe (e.g. a bare `createWritable()`/`getFile()`/`removeEntry()` loop with no
  `zip-prefetch.js` involvement, to confirm the retention is in Firefox's OPFS primitives
  themselves and not in something specific to how `zip-prefetch.js` sequences the calls) before
  deciding whether it is fixable in application code at all.

Per the task brief: reporting the numbers and stopping here rather than committing a
"premise holds" conclusion the data does not support for the memory/OPFS half of D6.

## Files

- `docs/review-download-parity/probe/probe-concurrency.html` — the probe page (new).
- `docs/review-download-parity/probe/run-concurrency.mjs` — the matrix runner (new); also
  implements the `SCALE_NMEDIUMS` byte-volume sweep used for the second measurement.
- `docs/review-download-parity/probe/results-zip-concurrency.json` — primary sweep raw data
  (30 runs).
- `docs/review-download-parity/probe/results-zip-concurrency-scale.json` — byte-volume
  scaling sweep raw data (18 runs).
- `docs/review-download-parity/probe/zip-concurrency-scale.md` — this document.
