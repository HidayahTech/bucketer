# ZIP export at >2 GiB — memory profile

Spec-mandated measurement for the ZIP-download design (`docs/superpowers/specs/2026-08-03-zip-download-design.md`):
does OPFS ZIP export stay flat in memory beyond 2 GiB, or does peak memory grow with file size? The
quota-driven gate design only holds if it stays flat.

## Method

Same method as the rest of `docs/review-download-parity/probe/` — see the README's "Method, in one
paragraph" and "Re-running the measurements". One fresh persistent-context browser per measurement (no
operation inherits another's uncollected memory), 3 repetitions per cell reported as median with range, a
`control` that allocates nothing to establish the noise floor, profiles on real disk
(`PROFILE_ROOT` under the repo, never tmpfs), memory sampled every 40 ms from outside the browser across
the whole process tree (`ps` on the process tree rooted at the browser PID, not a single process).

Image: `mcr.microsoft.com/playwright:v1.60.0-noble` — the tag locked in `package-lock.json` and pinned in
`.gitlab-ci.yml` (the two are kept in lockstep by `test/e2e-matrix-helpers.test.js`).

### The `zip-dl` mechanism (new)

The existing `opfs-dl` mechanism measures raw OPFS write + export — not the ZIP path. `zip-dl` (added to
`probe.html` and `run.mjs` in this change) drives the **real** `src/lib/zip-writer.js` — the same module
the app ships — into a **real** OPFS file, then exports it through the same real-download path as
`opfs-dl` (`getFile()` → `URL.createObjectURL()` → a real `<a download>` clicked by the runner, with the
browser's own `download` event measured — not a `fetch()` proxy reading the bytes back into JS, which the
parity report's errata (fault #5) found to be off by ~360x from the real download path).

`run.mjs` serves `src/lib/zip-writer.js` unmodified at `/zip-writer.js` (read relative to `run.mjs`, same
pattern already used for `PROFILE_ROOT`) so `probe.html` can `import()` the actual module under test —
not a reimplementation of it. `probe.html`'s `zip-dl` branch opens `probe.zip` in OPFS, calls
`createZipWriter(sink)` where `sink.write` delegates to the `FileSystemWritableFileStream`, streams one
entry whose `declaredSize` equals `SIZE * MiB` in 8 MiB chunks (the writer throws if streamed bytes ≠
declared size, so a mismatch would have failed loudly), calls `endEntry()` / `finish()`, closes the
writable, then exports exactly like `opfs-dl`. At `SIZE=4096` the single entry is exactly 4 GiB, which
crosses `zip64Limit` (`0xFFFFFFFF` bytes) — so the 4096 MiB cell also exercises the writer's ZIP64 local
header, descriptor, and central-directory-extra code paths, not just the store-only fast path.

**Harness fidelity:** this drives the real `zip-writer.js` into real OPFS via `createWritable()`/`getFile()`
and measures the real browser `download` event — the same primitives Task 4's export path uses. It is not
a proxy for the ZIP export path; it *is* the ZIP export path, minus the app UI around it.

### Smoke test

Before the sweep, one small containerized run confirmed the mechanism produces a valid, downloadable ZIP:

```
ENGINES=chromium MECHS=zip-dl SIZES='[64]' REPS=1 OUT_JSON=./results-zip-smoke.json
```

Result: `ok:true`, `savedBytes: 67108996`. Expected: 64 MiB payload (67,108,864 bytes) + exactly 132 bytes
of store-only ZIP framing for a single non-ZIP64 entry named `probe.bin` — 39-byte local header (30 fixed
+ 9-byte name) + 16-byte data descriptor (no ZIP64 widening below the 4 GiB boundary) + 55-byte central
directory record (46 fixed + 9-byte name) + 22-byte EOCD = 132 bytes. `67108864 + 132 = 67108996`, an
exact match — confirming the writer's framing math, not just "a file downloaded". The smoke JSON was
deleted after (not committed, per the task brief).

## The sweep

`zip-dl` at `[2048, 3072, 4096]` MiB on Chromium and Firefox, REPS=3, plus one `control` per engine.
WebKit is out of scope — no OPFS ZIP export path there (see the parity report's errata #7: the automated
WebKit build has no storage interface at all, a property of that build, not a finding about Safari).

Run in 4 batches (each a separate container invocation, each well under the ~9-minute budget) so no
single invocation risked a timeout on 9 runs of multi-GiB work:

| Batch | Command | Wall time |
|---|---|---|
| chromium, 2048+3072 MiB, +control | `SIZES='[2048,3072]' MECHS=control,zip-dl ENGINES=chromium REPS=3` | 3m43s |
| chromium, 4096 MiB | `SIZES='[4096]' MECHS=zip-dl ENGINES=chromium REPS=3` | 2m15s |
| firefox, 2048+3072 MiB, +control | `SIZES='[2048,3072]' MECHS=control,zip-dl ENGINES=firefox REPS=3` | 5m40s |
| firefox, 4096 MiB | `SIZES='[4096]' MECHS=zip-dl ENGINES=firefox REPS=3` | 3m34s |

Each batch's `runs` array was merged into `results-zip-export.json` (24 runs: 2 engines × (3 control + 3
sizes × 3 reps)). No launch failures, no OOMs, no errors — every run reported `ok:true`.

## Results — peak memory (MiB), median (min..max) over 3 reps

| Engine | Cell | 2048 MiB | 3072 MiB | 4096 MiB |
|---|---|---|---|---|
| Chromium | `write` span (OPFS write + zip-writer streaming + finish) | 59 (52..59) | 60 (59..63) | 61 (60..62) |
| Chromium | `download` span (real browser download event) | 7 (7..7) | 7 (7..7) | 7 (6..7) |
| Firefox | `write` span | 17 (12..18) | 11 (11..19) | 19 (18..19) |
| Firefox | `download` span | 6 (6..7) | 6 (6..7) | 9 (9..10) |

**Control noise floor** (allocates nothing, same method as the rest of `probe/`):

| Engine | `idle` peakDeltaMiB, median (min..max) |
|---|---|
| Chromium | 1 (1..2) |
| Firefox | 8 (7..9) |

These match the README's documented noise floors (Chromium ~1 MiB, Firefox ~8 MiB) exactly — the harness
is behaving consistently with the rest of the parity work, not producing a fluke.

## Verdict: FLAT

Peak memory does **not** scale with file size. Across a 2x size range (2048 → 4096 MiB) that also crosses
the ZIP64 4 GiB boundary at the top end, every span stays within a tens-of-MiB band indistinguishable from
noise:

- Chromium `write`: 59 → 60 → 61 MiB (essentially constant; well above its 1 MiB noise floor but flat
  across sizes).
- Chromium `download`: 7 → 7 → 7 MiB (flat, barely above noise floor).
- Firefox `write`: 17 → 11 → 19 MiB (noisy but flat — no trend with size; Firefox's write-span noise is
  comparable to its 8 MiB idle floor).
- Firefox `download`: 6 → 6 → 9 MiB (flat, close to noise floor).

If the file were being materialized in memory (a `Blob`-assembly path, or the writer buffering the whole
entry before flushing), the delta would approach a large fraction of the file size — hundreds to
thousands of MiB at 4096 MiB, the same shape the parity report found for the *in-memory* `blob` mechanism
at smaller sizes. Nothing in this sweep does that. Both the streaming write into OPFS (`zip-writer.js`
writes each chunk through `sink.write()` as it arrives — nothing buffers the entry) and the real-download
export (`getFile()` → `<a download>`, the same path `opfs-dl` already proved flat at ≤2 GiB in
`results-download.json`) hold their memory profile at scale.

**Gate implication: the quota-driven gate stands as implemented.** The design assumption underlying it —
that OPFS ZIP export cost is bounded independent of archive size — is measured, not assumed, up to 4 GiB
and across the ZIP64 boundary, in both Chromium and Firefox.

## Files

- `docs/review-download-parity/probe/probe.html` — added the `zip-dl` mechanism.
- `docs/review-download-parity/probe/run.mjs` — added the `/zip-writer.js` static route.
- `docs/review-download-parity/probe/results-zip-export.json` — merged raw results (24 runs).
- `docs/review-download-parity/probe/zip-export-scale.md` — this document.
