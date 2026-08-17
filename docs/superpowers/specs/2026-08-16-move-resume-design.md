# Resumable moves — design

**Date:** 2026-08-16
**Status:** approved (part-level resume in; `ListMultipartUploads` orphan discovery deferred)

## Problem

A move runs entirely in-memory (`move-queue.js`). Reloading the tab kills it; there is no
persisted record and no resume. A large single-file move (multipart copy) that is interrupted
must be restarted from byte zero, and leaves an orphaned incomplete multipart upload behind.

## Goal

Reload mid-move → the operations queue shows the interrupted move with **Resume** and
**Discard**. Resume picks up where it left off — including *within* a large file (copy only
the parts not yet done), not from scratch. Discard aborts the incomplete upload and forgets
the job.

## Non-goals (deferred)

- `ListMultipartUploads` discovery of uploads that were never recorded (tab crashed before the
  first write). v1 relies on the persisted record. This is also the future "clean up any stray
  upload" slice.
- Resuming a `copy`/`rename` — v1 covers `move` (the case reported). The engine is shared, so
  extending later is small.

## Correctness pivot: the destination re-scan is the safety net

On resume we re-list the destination prefix (the same collision scan a fresh move already
does). **Any object already at its destination key is treated as already-moved** — its source
is deleted if still present, then it is counted done. This means per-item status persistence is
only a *performance* optimization (skip re-copying), never a *correctness* requirement: even if
the record undercounts completed items, the dest scan prevents duplicate work and the
idempotent source-delete prevents errors. The only state that must be persisted precisely is the
**in-flight multipart upload's `uploadId`** — without it the partial parts are unreachable.

## Persistence — `move-jobs.js`, store `bucketer_move_jobs` (DB v6)

Single object store, one record per job (keyPath `id`), work list held inline. Moves are far
smaller than million-object download jobs, so a per-item store is unnecessary.

```
{ id, provider, endpoint, bucket, mode:'move', dest, capturedPrefix, createdAt,
  items: [{ sourceKey, destKey, size }],          // the resolved work list
  inflight: { sourceKey, uploadId, partSize } | null }  // the multipart object in progress
```

CRUD mirrors `download-records.js`: `saveMoveJob`, `loadMoveJob`, `loadAllMoveJobs`,
`updateMoveJob` (read-merge-write one row), `deleteMoveJob`, `clearAllMoveJobs`.

**Invariant (from resume-records.js):** the job record — with `inflight.uploadId` — is written
BEFORE any `UploadPartCopy`, so a crash on part 1 is still recoverable.

Known limitation: rewriting the whole record on each item completion is O(items) per write. Fine
for a single large file (one item) and typical folder moves; noted for very large folder moves.

## Engine changes

**`move-multipart.js` — resume support on `copyObjectMultipart`:**
- New `onUploadIdCreated(uploadId, partSize)` callback, fired right after `CreateMultipartUpload`
  so the caller persists it before any part copy.
- New `resumeUploadId` param: when present, skip `CreateMultipartUpload`, call `collectParts`
  (`ListParts`) to find parts already copied, copy only the missing ranges, then `Complete`.
  (`onPartCopied` — added in v1.52.0 — already reports per-part bytes for both progress and the
  persisted `inflight` update.)

**`move-queue.js`:**
- `runMoveOperation` persists a job: `saveMoveJob` at start (with the resolved item list),
  `onUploadIdCreated` → `updateMoveJob({ inflight })`, and on the final `done` transition
  `deleteMoveJob`. (A completed move leaves no record.)
- New `resumeMoveOperation(client, bucket, record, onProgress, shouldCancel)`: re-scan dest →
  skip items already at their destKey (deleting a lingering source if present) → copy the rest,
  resuming `record.inflight.sourceKey` via `resumeUploadId`. On completion, `deleteMoveJob`.

## Surfacing — the operations queue (uniform with other actions)

On connect, `loadAllMoveJobs` filtered to the current bucket → each becomes a `taskStore` task
with `status: 'paused'`. `MasterQueue` renders a paused move with **Resume** and **Discard**
buttons (a new state beside running/settled). Resume runs `resumeMoveOperation` and flips the
task to running (byte bar from v1.52.0 applies). Discard aborts `inflight` (if any) via
`abortMultipartSession`, `deleteMoveJob`, and removes the task.

## Evidence

- Unit: `move-jobs` CRUD (fake-indexeddb); `copyObjectMultipart` resume (ListParts → copies only
  missing parts → Complete; fires `onUploadIdCreated`); `resumeMoveOperation` (skips
  dest-existing items, resumes the in-flight file, deletes the record on done).
- Component: `MasterQueue` renders Resume/Discard for a paused move.
- **E2E (the real observable):** start a move whose large file is interrupted mid-parts; load a
  fresh page against the same bucket (parts still server-side); Resume; assert the object lands
  complete and the source is gone — with a matched-pair showing pre-resume the object is absent.

## Delivery

Checkpointed stages, committed as they go: (1) `move-jobs` + DB v6, (2) multipart resume,
(3) engine persist + `resumeMoveOperation`, (4) surfacing, (5) e2e, then ship as a minor bump.
