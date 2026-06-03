# Persistent Upload Queue — Design Document

## Status
Design only. Not yet scheduled for implementation.

## Problem

The upload queue is entirely in-memory. A page reload, browser crash, or version
update mid-queue loses all pending state. Files already uploaded are safe on S3,
but there is no way to know which ones finished, and the pending work has to be
re-identified and re-queued manually.

The specific pain point that prompted this: uploading ~7000 small files, needing
to reload to pick up a bug fix, with no clean way to resume.

---

## Core Constraint

`File` objects from drag-and-drop or the file picker are ephemeral — they cannot
be serialized to IndexedDB. The File System Access API (`FileSystemFileHandle`)
can be persisted, but has incomplete cross-browser support (Firefox gaps) and
introduces permission re-prompts on reload. It is ruled out as the primary path.

The solution must work on Firefox, Chrome, and Safari without special permissions.

---

## Key Insight: Folder Drops Have Natural Identity

When files are dropped, `DataTransferItem.webkitGetAsEntry()` gives a
`FileSystemEntry` for each top-level item. This tells us:

- `entry.isDirectory` / `entry.name` — whether a folder was dropped and its name
- `entry.isFile` — whether loose files were dropped

**Folder drops** have a name, a known file count, and a clear reconnect story:
*"Drop the folder 'vacation-photos' again to resume 4,847 remaining files."*

**Loose file drops** have no natural identity anchor. Reconnect is weak
(*"re-select the same 47 files"*), and these batches are typically small enough
that persistence matters less.

This distinction drives the design:

| Drop type     | Persistence          | Reconnect UX            |
|---------------|----------------------|-------------------------|
| Folder(s)     | Full — manifest + done set | Prompt by folder name  |
| Loose files   | Done set only        | No reconnect attempt    |

---

## Batch Model

**One drop/selection event = one batch.**

A batch contains one or more top-level entries (folders or loose files) added in
a single action. Batches are independent units with their own manifest and status.
The processing queue is still linear (shared concurrency across batches), but
provenance is preserved per batch.

### Batch identity

Scoped to: `provider + endpoint + bucket + destinationPrefix`

Identified by:
- UUID generated at drop time (primary key in IDB)
- Top-level entry names + file counts (for display / reconnect matching)
- Timestamp of when the batch was created

### Batch statuses

`pending` | `active` | `paused` | `completed` | `discarded`

---

## What Gets Persisted (IndexedDB)

### New object store: `bucketer_queue_batches`

One record per batch:

```json
{
  "id": "uuid",
  "createdAt": 1748000000000,
  "provider": "wasabi",
  "endpoint": "https://s3.wasabisys.com",
  "bucket": "my-bucket",
  "destinationPrefix": "photos/",
  "status": "paused",
  "roots": [
    { "name": "vacation-2026", "isDirectory": true, "fileCount": 4847 }
  ],
  "totalFiles": 4847,
  "doneCount": 1203
}
```

### New object store: `bucketer_queue_files`

One record per file in a batch:

```json
{
  "batchId": "uuid",
  "destinationKey": "photos/vacation-2026/DSC_0001.jpg",
  "fileName": "DSC_0001.jpg",
  "fileSize": 4823041,
  "lastModified": 1747000000000,
  "status": "done" | "pending" | "error",
  "completedAt": 1748001234567
}
```

The `(batchId, destinationKey)` pair is the composite key.

---

## Done-Set Logic ("What's done is done, what's not is redone")

When a file completes successfully:
1. Write its record as `status: "done"` with `completedAt` timestamp
2. Increment `doneCount` on the batch record

On reconnect (re-drop of a folder):
1. Match dropped files against `bucketer_queue_files` by `(batchId, destinationKey)` 
   or by file identity `(fileName + fileSize + lastModified + destinationKey)`
2. Skip files with `status: "done"`
3. Re-queue files with `status: "pending"` or `status: "error"`

Files that were **in-flight at crash/reload**:
- Small files: no partial state exists → treated as `pending` (full re-upload)
- Large files: existing multipart resume records in `s3browser_uploads` handle this
  independently — the persistent queue defers to them

**Verification policy**: trust the manifest by default. No `HeadObject` calls on
reconnect. A future "verify before resuming" toggle can be added if needed.

---

## Pause Semantics (Deliberate Decisions)

Four distinct operations with explicit names and behaviors:

### Pause
- Aborts in-flight uploads immediately
- Large files: multipart resume records are preserved (confirmed parts not lost)
- Small files in-flight: go back to `pending` in the manifest
- Pending queue: untouched
- Batch status → `paused`
- **Rationale**: users expect pause to be instant. Waiting for a large in-flight
  part to finish (potentially minutes) while a button says "Pausing…" is
  unintuitive. The cost (re-uploading one in-flight part for large files) is
  acceptable given the UX benefit.

### Resume
- Re-processes all `pending` files in the batch
- For folder batches: may require re-dropping the folder to supply File objects
- For large files: multipart resume flow runs as normal

### Stop (rename current "Cancel all")
- Same as Pause, but also stops processing new files from the queue
- Batch status → `paused`
- Queue manifest is **preserved** — nothing is discarded
- Non-destructive; resumable

### Discard queue
- Explicitly destructive
- Clears the batch manifest and all file records for the batch
- Abandons any active multipart sessions (sends AbortMultipartUpload)
- Irreversible — requires confirmation
- This is the current "Cancel all" behavior, made explicit

**Current "Cancel all" maps to Discard queue.** It should be renamed and the
confirmation step should make clear that pending files will be lost.

---

## Reconnect UX (Folder Batches)

On page load, if `bucketer_queue_files` contains records with `status: "pending"`
for the current bucket, show a reconnect banner:

> **Resume upload batch?**
> *"vacation-2026"* — 3,644 of 4,847 files remaining
> Drop the folder again to continue, or discard this batch.

When the user drops the folder:
1. Traverse it to get all File objects
2. Match against pending records by file identity
3. Skip done files
4. Re-queue matched pending files
5. Warn about any unmatched files (folder contents changed)

For loose file batches: no reconnect prompt is shown. Done-set records still
exist and will be used to skip already-uploaded files if the same files are
dropped again, but no proactive banner is shown.

---

## What This Does NOT Solve

- True transparent resume without re-dropping (requires FileSystemHandle — deferred)
- Resume of small files that were mid-upload at crash (atomic — unavoidable)
- Cross-device queue sync (out of scope)

---

## Open Questions Before Implementation

1. **IDB schema version**: adding two new object stores requires a DB version bump
   (v2 → v3). Needs a migration path that doesn't break existing resume records.

2. **Batch scoping**: if the user uploads to different prefixes in the same session,
   each gets its own batch. Should the reconnect banner scope to the current prefix
   or show all pending batches for the bucket?

3. **Retention policy**: how long do completed batch records live in IDB before
   being pruned? Indefinitely (user clears manually), or auto-expire after N days?

4. **UI hierarchy**: the current flat item list in BatchSummary would need to become
   batch-aware. How much UI change is acceptable? Consider whether batches are
   collapsed by default with a summary row each.

5. **Part concurrency and file concurrency**: do pause semantics apply per-batch
   or globally? If two batches are active and the user pauses one, does the other
   keep running?

---

## Implementation Phases (when ready)

**Phase 1**: Done-set only
- Write completed file records to IDB on every upload success
- On re-drop of same folder, skip files found in done set
- No reconnect banner, no pause changes
- Lowest risk, immediate value

**Phase 2**: Batch manifest + reconnect
- Persist batch manifests and file records on enqueue
- Reconnect banner on page load for folder batches with pending files
- Match re-dropped files against manifest

**Phase 3**: Pause/Stop/Discard semantics
- Rename "Cancel all" → "Discard"
- Add "Pause" and "Stop" with the semantics defined above
- Persist pause state to IDB

**Phase 4**: UI hierarchy
- Batch-aware BatchSummary with per-batch controls
- Per-batch pause/resume/discard
