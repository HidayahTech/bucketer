# ZIP download: one dialog instead of N

**Date:** 2026-08-03 · **Status:** approved (design), pending implementation
**Motivation:** On Firefox with "always ask where to save" enabled, a multi-file download
job produces one save dialog per file. No web API can suppress that per-download prompt;
the only structural fix is to deliver one file. This also gives non-Chromium users the
first delivery mechanism with real byte progress and preserved folder structure.

## Operator decisions (2026-08-03)

1. **Approach A**: streaming store-only ZIP written incrementally into one OPFS staging
   file, delivered through the existing `runDownloadJob` engine via an alternate injected
   `issue`. (B — stage-then-zip — rejected: 2× quota, two passes. C — in-memory —
   rejected by the 2026-07 parity measurements: 1.62× file size on Firefox.)
2. **File-granularity resume**: completed ZIP entries persist their offsets; resume
   truncates and continues. Interruption never restarts a job from zero unless staging
   itself is gone.
3. **`persist()` included, lazily**: requested only when a job does not fit the current
   best-effort allowance — never as a blanket prompt.

## Bounds (verified 2026-08-03)

Firefox best-effort storage: min(10% of disk, 10 GiB) per site group; with a granted
`navigator.storage.persist()`: 50% of disk, capped 8 TiB, no group limit; best-effort
origins are LRU-evicted under disk pressure. Chromium: ~60% of disk in both modes.
Source: MDN, Storage quotas and eviction criteria —
https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
(fetched 2026-08-03). Effective default ZIP ceiling on Firefox: 0.9 × 10 GiB (the
existing `QUOTA_SAFETY` headroom in `browser-capability.js`).

The parity work measured OPFS export flat-memory (15–25 MiB on Firefox) up to 2 GiB.
Larger exports extrapolate the same mechanism; before the size gate advertises the full
10 GiB ceiling, one larger probe run should confirm it (measurement-discipline rule —
tracked as an implementation-plan step, not assumed).

ZIP format: entries >4 GiB, totals >4 GiB, or >65 535 entries require ZIP64 records; the
writer emits them when any threshold is crossed. Store-only (method 0), no compression —
deliberate: S3-hosted media is mostly incompressible and CPU time is the enemy of
10 GiB jobs.

## Section 1 — Engine, persistence, resume

**`src/lib/zip-writer.js`** — pure store-only ZIP64 writer over an injected byte sink
(`{ write(bytes), offset }`):

- `beginEntry(path, mtime)` — local header, streaming bit (3) set, UTF-8 names (bit 11).
- `update(chunk)` — incremental table-based CRC-32 (in-repo, ~20 lines, no dependency)
  plus length accounting, write-through.
- `endEntry()` — data descriptor; returns the entry record
  `{ path, zipOffset, zipEnd, size, crc }`.
- `finish(entries)` — central directory (+ ZIP64 end records when needed). Takes the
  entry list as data so a resumed session can finish from persisted records.

The sink injection is the first concrete instance of the Stage-2 sink seam: unit tests
run against an in-memory sink in plain Node.

**`src/lib/zip-job.js`** — orchestration:

- One OPFS staging file per job: `bucketer-zip-<jobId>.zip`.
- Drives the existing `runDownloadJob` with `issue` = presign → `fetch` → pipe the
  response body through the writer. Preflight probes, the 3-consecutive-DENIED breaker,
  failure retention, and cooperative cancel are inherited unchanged.
- Entry completion → item status **DONE** (observed completion, stronger than handoff's
  ISSUED) with the entry record persisted on the item — resume state and central-directory
  input in one.
- Entry paths: the key relative to the scope's captured prefix, each segment through the
  existing `sanitizeSegment`. Folder structure is preserved; naming modes do not apply to
  ZIP delivery.

**Resume, in order of increasing misfortune:**

1. Clean resume: reload DONE items' records, truncate staging to the last `zipEnd`,
   continue with PENDING/FAILED items. Post-retry entries appended out of manifest order
   are valid — the central directory carries offsets.
2. Mid-entry interruption or fetch failure: truncate to that entry's `zipOffset`, mark
   the item FAILED (message retained), continue. The existing retry path re-PENDINGs
   failures.
3. Staging missing or shorter than the last recorded `zipEnd` (best-effort eviction):
   reset DONE items to PENDING, recreate staging, state the reason to the user plainly.

**Finish and export:** when no PENDING/FAILED items remain, `finish()` writes the
central directory; export issues **one download** via `getFile()` → object URL → a
transient same-origin anchor with the `download` attribute. (Not the iframe path: that
exists to contain cross-origin error responses; a same-origin blob needs no containment.)
The job records `exportedAt`. Discard — present on every ZIP job row, per the
reachability invariant — also deletes the OPFS staging file. On Chromium the existing
folder-check verify applies to the single ZIP file; on Firefox the row states "handed to
your browser", which is the truth.

**Progress:** streamed bytes give byte-accurate progress (`bytesDone / bytesSendable`) —
the first delivery mechanism that can show it.

## Section 2 — UI, gating, errors

**Placement:** the download panel's post-scan **ready** phase only (eligibility needs the
just-computed totals). Second start button next to "Send N files to my browser":
**"Download as one ZIP (N files, X GB)"**, with one hint line: "Arrives as a single file
with its folder structure intact. Your browser asks once, not N times." Naming-mode
buttons stay (they govern handoff); a note states ZIP keeps folder paths regardless.
Mobile and egress warnings unchanged.

**Gate, in order:**

1. Capability: `opfs && streamingFetch && writableFiles` — feature-detected, never
   browser-named. Where absent (WebKit), the button does not render; handoff remains.
2. Fit: `sendableBytes ≤ QUOTA_SAFETY × (quota − usage)` via the existing
   `readStorageQuota()`. Fits → enabled.
3. Doesn't fit, persist() plausible (`navigator.storage.persisted()` reports false —
   i.e., the larger allowance has not already been granted): button disabled with the reason ("needs about X GB
   of temporary browser storage; Y GB available") plus one action — "Allow more
   storage…" → `navigator.storage.persist()` → re-estimate → enable if it now fits.
   Denied or still too big → stays disabled with the honest reason.
4. Unknown quota: optimistic per the existing `selectTier` philosophy — offer ZIP, catch
   `QuotaExceededError` at runtime.

**Errors:** running ZIP jobs show byte progress with Stop (pause, resumable); job-wide
blocks reuse the existing blocked messaging; per-file failures accumulate with the same
retry action as handoff. `QuotaExceededError` mid-job **pauses** (not fails) with the
storage explanation and the persist action on the row. Export failure (user cancels the
save dialog) leaves the job finished-but-unexported with a "Save ZIP again" action —
staging is intact, re-export is free.

**Job model deltas (all additive; legacy jobs unaffected):** job gains
`delivery: 'zip' | undefined` (undefined = handoff), `zipName`
(`<bucket or folder>-<date>.zip`), `exportedAt`; items gain the entry record fields at
DONE.

## Testing

- **Unit (plain Node):** `zip-writer` against an in-memory sink, with a test-side
  minimal ZIP reader parsing back the central directory and data descriptors and
  cross-checking sizes/CRCs computed independently; ZIP64 exercised by injecting tiny
  thresholds. `zip-job` resume matrix on a fake sink: clean truncate-resume, mid-entry
  rewind, vanished-staging reset. Gate arithmetic as pure functions.
- **Component (jsdom):** the ready-phase button in all four gate states (offered /
  disabled-with-persist-action / absent capability / unknown-quota-optimistic).
- **E2E (container matrix; evidence rules apply, baseline first):** the observable —
  ONE browser download event fires, and the spec parses the downloaded ZIP's bytes,
  verifying it contains exactly the selected keys with matching sizes and CRCs. An
  interruption arm uses the mock's `killAtByte` fault and proves resume yields a
  byte-valid ZIP. WebKit lanes assert the button is absent — valid as an absence
  assertion because the Chromium/Firefox lanes assert its presence.

## Out of scope

- Compression (store-only is deliberate, see Bounds).
- The managed-folder and per-file staged tiers (Stage 2 proper, unchanged).
- Any change to the handoff delivery path.
- Proactive persist() prompting beyond the lazy gate path.
