# ZIP download progress: byte/speed/ETA parity with uploads

**Date:** 2026-08-03 · **Status:** approved (design), pending implementation
**Motivation:** A running ZIP download shows only "Zipping N of M…". Uploads show real
byte progress, speed, ETA, a progress bar, and per-file detail. This brings the ZIP
download tier to parity: an aggregate byte/speed/ETA line with a progress bar, expandable
to an active-focused per-file detail — useful for long downloads. Builds on v1.46.0
(the ZIP download feature).

## Operator decisions (2026-08-03)

1. **Active-focused detail** (not a full per-file list): the expanded view shows the file
   downloading right now with live bytes, the completed and failed files (each capped,
   most-recent first), and collapses the not-yet-started files into a "…and N queued"
   line. ZIP streams one file at a time, so at most one file is ever active — the single
   stream's rate *is* the aggregate rate; there are no per-file speed/ETA figures.
2. **Rate tracker: extract a shared helper, use it for ZIP only.** Uploads' 6-second
   sliding-window rate lives inside `BatchSummary.jsx`; extract a small reusable helper
   for the ZIP side and leave the upload path untouched (no regression risk). **Deferred
   follow-up:** unify `BatchSummary` onto the shared helper once this is proven working.
3. **Per-file names come from IndexedDB, only when expanded.** The completed/failed file
   names in the detail are read from the job's persisted items (source of truth, accurate
   across a resume), only while the detail is open. The live active file comes from the
   task. Aggregate counts + bytes are always driven reactively by the task.
4. **ZIP-only.** The per-file "handoff" tier hands bytes to the browser's own download
   manager, which exposes no progress; byte/speed/ETA parity is possible only where we
   stream the bytes ourselves (ZIP). The handoff path is unchanged.

## Scope

The byte plumbing already reaches the task: `zip-job.js`'s `onProgress` emits byte-accurate
`bytesDone` on every chunk (including the in-flight file's partial bytes), and
`handleZipStart` already writes `bytesDone` onto the task — it is simply never rendered.
This feature is mostly *rendering + a rate tracker + emitting the active file*, plus
threading `bytesTotal`.

## Section 1 — Data flow

**`src/lib/zip-job.js` — enrich the `onProgress` payload** from `{done, bytesDone}` to
`{done, bytesDone, bytesTotal, active}`:

- `bytesTotal` — the job's sendable bytes (`counters.bytesSendable`, already computed;
  thread it into `runZipJob` and emit it). Falsy/missing → the UI falls back to a
  count-only line.
- `active` — `{ key, size, bytes }` for the file currently streaming, from the existing
  ephemeral `inFlightBytes` local. Set while streaming, **cleared (`null`) after
  `endEntry`** and while no entry is in flight. Same high-frequency per-chunk cadence as
  today (no new frequency).

**`src/components/App.jsx` — `handleZipStart` `onProgress`** forwards `bytesTotal` and
`active` onto the task via `taskStore.update` (additive, exactly as `bytesDone` already is).
Task fields added (additive; legacy/handoff tasks unaffected): `bytesTotal`, `active`.

**No new persistence.** The per-file checklist reconstructs from item statuses (DONE/FAILED
already persisted in IndexedDB) plus the live `active` entry. On resume, completed files
show ✓ (read from items), `bytesDone` resumes from the staged bytes, `bytesTotal` from
counters, and the rate tracker restarts (speed rebuilds from new samples).

## Section 2 — The rate tracker

Extract a small, dependency-free helper (a pure sampler + a thin hook), modeled on the
6-second sliding-window in `BatchSummary.jsx:80,96-125`:

- **Pure core** (`src/lib/rate-tracker.js`): given a series of `{ t, bytes }` samples,
  keep a rolling window (default 6000 ms), evict older samples, and return the window rate
  (`gained / span` when `span ≥ 0.5s`, else null). Deterministic — timestamps are inputs,
  so it is unit-testable without a clock.
- **Thin hook** (e.g. `src/hooks/useRate.js`): a throttled rAF loop (≥66 ms, paused when
  the tab is hidden, matching `BatchSummary`) that samples the task's `bytesDone` into the
  pure core and exposes `speed`. Lives in the MasterQueue task row for a running ZIP task.

ETA = `(bytesTotal − bytesDone) / speed` (the same relation uploads use), rendered only
when `speed > 0`. Displayed bytes come straight from `bytesDone` (per-chunk emission is
smooth enough; no display interpolation).

The upload path (`BatchSummary` / `useInterpolatedProgress`) is **not touched** by this
change. Unifying `BatchSummary` onto `rate-tracker.js` is a deferred follow-up.

## Section 3 — Rendering (`src/components/MasterQueue.jsx`)

The running ZIP task already renders in the MasterQueue task row (`downloadSummary` +
`TaskRow`); the download panel is a pre-flight/history modal that closes on start, so it is
not involved. Changes, all scoped to a `delivery === 'zip'` running task:

- Import `formatBytes`, `formatSpeed`, `formatEta` from `src/lib/format.js`.
- Replace the plain "Zipping N of M…" line with two info lines + a progress bar:
  - Line 1 (files): `Zipping · {current} of {total} files` (+ ` · {failed} failed` when
    `failed > 0`).
  - Line 2 (bytes): `{formatBytes(bytesDone)} of {formatBytes(bytesTotal)}` (+
    ` · {formatSpeed(speed)} · ETA {formatEta(eta)}` when `speed > 0`).
  - Progress bar: `bytesDone / bytesTotal`.
- Open the expand toggle **while running** for ZIP tasks (today the toggle is gated on
  `isSettled && hasErrors`; extend the gate so a running ZIP task can expand too).

**Expanded body (active-focused detail):**

```
▼ Zipping · 12 of 4,231 files · 1 failed
  1.2 GB of 3.4 GB · 18 MB/s · ETA 2m 4s        [====────]  36%
    ▶ photos/2024/trip-4k.mov      412 MB / 900 MB  (46%)
    ✓ photos/2024/b.jpg             6.1 MB
    ✓ photos/2024/a.jpg             8.2 MB
    ✗ photos/2024/corrupt.raw       failed
    …and 4,213 queued · 9 more done
```

- **Active row** (`active` non-null): `▶ {key}  {formatBytes(active.bytes)} / {formatBytes(active.size)}  ({pct}%)`.
- **Completed rows**: read DONE items from IndexedDB when the detail opens, and re-read
  whenever `current` increments while the detail stays open, most-recent first, capped at
  20. Each: `✓ {key}  {formatBytes(size)}`.
- **Failed rows**: read FAILED items, capped at 20. Each: `✗ {key}  failed`.
- **Footer**: `…and {queued} queued` (queued = `total − done − failed`) `· {overflow} more
  done` when the completed list is capped.

## Section 4 — Edge cases

- **Between files** — `active` is briefly null; the ▶ row is simply omitted for that
  instant.
- **Finishing / export** — once all bytes are staged, a brief "Finishing ZIP…"; then the
  existing terminal labels ("ZIP handed to your browser" / "ZIP ready — save it again").
  The byte line and bar render only during streaming.
- **Paused / quota-paused / cancelled** — keep the existing honest labels ("Paused — N of
  M zipped, K failed"; the "allow more storage" row; "Stopped while zipping — N of M").
  Expanding a paused job still shows the completed/failed detail (no active row); resume is
  unchanged.
- **Fallbacks** — `bytesTotal` missing/zero → count-only "Zipping N of M…" line (no byte
  line/bar). `speed === 0` (just started) → omit speed/ETA until the tracker has a sample.
- **Resume** — completed files from IndexedDB (accurate across sessions); `bytesDone` from
  the staged bytes; `bytesTotal` from counters; the rate tracker restarts.

## Testing

- **Unit (plain Node):** `rate-tracker.js` — window rate from injected `{t, bytes}` samples
  (eviction, the `span ≥ 0.5s` gate, monotonic bytes, an idle gap → rate decays). The
  enriched `zip-job` payload — `active` is set (with `{key, size, bytes}`) while an entry
  streams and cleared to `null` after `endEntry`; `bytesTotal` is emitted. Extend
  `test/zip-job-run.test.js`.
- **Component (jsdom):** the MasterQueue row for a running ZIP task — the two info lines +
  progress bar render from `bytesDone/bytesTotal/current/total`; speed/ETA appear only when
  a `speed` is present; the expand toggle opens while running; the expanded detail renders
  the active row, completed/failed rows (with a mocked item read), and the queued/overflow
  footer + caps. Extend `test/components/master-queue-download.test.jsx`.
- **E2E:** unchanged. Mid-download progress rendering is timing-sensitive; the component
  tests are the real coverage. Harness-fidelity note: the container e2e is not a reliable
  place to assert transient byte-progress strings, so this feature has **no new e2e
  observable** beyond the existing "one ZIP download" arm.

## Out of scope

- Any change to the handoff (per-file browser download) tier.
- Per-file speed/ETA (ZIP is sequential — the single stream's rate is the aggregate rate).
- A full/virtualized per-file list (the active-focused view is deliberate).
- Display interpolation (per-chunk emission is smooth enough).
- Unifying `BatchSummary` onto `rate-tracker.js` — **deferred follow-up** once this ships
  and is proven.
