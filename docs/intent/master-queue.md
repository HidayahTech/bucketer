# Master Queue — Unification Analysis and Plan

**Date:** 2026-07-06 · **Baseline:** v1.34.0 · **Status:** Analysis / proposal (no code changes yet)

## 1. Motivation

Bucketer has grown several independent mechanisms for "things that happen over time":
uploads, deletes, moves/copies, version purges, duplicate scans, verifications, downloads,
and ambient background checks. Each has its own display surface, its own controls (or lack
of them), and its own tracking story. The goals of unification:

- **Reduce user anxiety** — one place to look; nothing runs invisibly; nothing disappears
  silently while still running; destructive operations are always visible.
- **Increase visibility** — an average user sees one line per operation with clear status;
  a technically astute user can expand any operation for per-item detail and diagnostics.
- **Reduce code duplication** — DeleteQueue and MoveQueue are near-identical twins
  (~20+ duplicated CSS selector pairs in `main.css:381-487`, parallel JSX in
  `DeleteQueue.jsx:86-141` vs `MoveQueue.jsx:21-86`).

Design stance for the two audiences: **collapsed = calm** (one row per task: icon, label,
progress, count), **expanded = complete** (per-item status, errors, diagnostics). Nothing
important should require expansion to notice; nothing noisy should be visible without it.

## 2. Catalog of queueable-action candidates

Twelve candidates found. Grouped by how queue-shaped they already are.

### Tier A — already queue-shaped (background ops with progress panels)

| # | Action | Engine | UI | State owner | Persistence |
|---|--------|--------|----|-------------|-------------|
| 1 | **Upload** | `upload-queue.js` + `UploadQueue.jsx` orchestration | `UploadQueue.jsx` / `BatchSummary.jsx` / `UploadItem.jsx` | UploadQueue component (`useState` + RAF update-batcher) | IndexedDB resume records + upload log; localStorage tab-conflict map |
| 2 | **Delete** | `delete-queue.js` | `DeleteQueue.jsx` | App (`deleteOps` state) | None |
| 3 | **Move / Copy** | `move-queue.js` (+ `move-multipart.js`) | `MoveQueue.jsx` | App (`moveOps` state) | None |

### Tier B — destructive ops that bypass every queue

| # | Action | Engine | UI | Notes |
|---|--------|--------|----|-------|
| 4 | **Purge hidden versions** | `purge-versions.js` | `HiddenVersions.jsx` modal | Serial batch deletes, **no progress display at all** (just a disabled button), modal-bound, errors shown inline. The most destructive op in the app with the least visibility. |
| 5 | **Duplicate deletion** (iteration 2, not yet wired) | planned | `DuplicatesModal.jsx:88-90` (disabled buttons) | Design intent is to route through the delete queue via `onDeleteRequest`. |

### Tier C — scan/verify jobs (modal-bound, long-running)

| # | Action | Engine | UI | Notes |
|---|--------|--------|----|-------|
| 6 | **Duplicate scan** | `dedup-scan.js` | `DuplicatesModal.jsx` | Long-running (list + up to 10-concurrent HeadObject over collision groups). Closing the modal kills the scan. Results ARE durable (IndexedDB `bucketer_dedup_scans`). |
| 7 | **Byte-for-byte verify** | `verify-bytes.js` | `DuplicatesModal.jsx` per group | Streams objects; binary outcome, no incremental progress; egress `window.confirm` gate. |
| 8 | **Integrity check** | `integrity.js` | `IntegrityCheck.jsx` (in ChangelogModal) | Two fetches + one SHA-256; seconds at most. Deliberately lives in pre-auth trust surfaces. |

### Tier D — ambient / fire-and-forget

| # | Action | Engine | UI | Notes |
|---|--------|--------|----|-------|
| 9 | **Download** | presigned URL + anchor click (`Browser.jsx:514-540`) | none (browser's native download manager) | App-side work is only the sub-second presign; transfer progress/cancel belongs to the browser. |
| 10 | **Mtime lazy loading** | HeadObject pool (3-concurrent) in `Browser.jsx` | spinner in column header | Ambient, IntersectionObserver-driven, silent by design. |
| 11 | **Update check polling** | `UpdateBanner.jsx` | banner on detection | Silent until it has something to say. |
| 12 | **Changelog upstream check** | `ChangelogModal.jsx` | button + result banner | One-shot, sub-second. |

## 3. Behavior comparison (Tier A + B — the merge candidates)

| Dimension | Upload | Delete | Move/Copy | Purge versions |
|---|---|---|---|---|
| Lifecycle states | 7: queued/uploading/resuming/paused/done/error/aborted (`upload-status.js:15`) | confirm→discovering→deleting→done | discovering→checking→moving→done | boolean `deleting` flag |
| Granularity | batch → item (file) → parts | op → keys (implicit) | op → work items (implicit) | none |
| Cancel mid-run | ✔ per item + per batch + all (AbortController) | ✘ | ✘ | ✘ |
| Pause / resume | ✔ (multipart resume records, cross-session) | n/a | ✘ | ✘ |
| Retry failed | ✔ per item + "Retry all failed" | ✘ | ✘ | ✘ |
| Progress display | per-item bars, bytes, speed, ETA; batch summary w/ rolling speed | count `X / Y` + phase text | count `X / Y` + phase text | none |
| Error display | per-item `ErrorDetailsPanel` + diagnostics | first 10 + "…and N more", collapse toggle | same as delete (+ `skipped` class) | first error only, in modal |
| Survives navigation | ✔ (component stays mounted) | ✔ (App-owned) | ✔ (App-owned) | ✘ (modal-bound) |
| Survives reload | ✔ paused-resumable via IndexedDB | ✘ | ✘ | ✘ |
| Durable history | ✔ upload log (IndexedDB, rich diagnostics) | ✘ | ✘ | ✘ |
| Completion signal | desktop Notification API + auto-collapse | toast + auto-dismiss 3s | toast + auto-dismiss 3s | rows cleared in modal |
| Update mechanism | RAF-coalesced update-batcher (`update-batcher.js`) | direct `setState` per batch group | direct `setState` per work item | `setState` at end |
| Concurrency | 3 files × 4 parts, adaptive budget 16, memory clamp, sharding | 8 × 1000-key batch groups (`delete-queue.js:106-121`, verified) | 8 workers; multipart copy ≥ 5 GiB | serial batches |

Three structural asymmetries matter most for unification:

1. **State ownership** — upload items live *inside* the UploadQueue component; delete/move
   ops live in App. Neither is a subscribable store; the toast system (`toast.js`) is the
   only module-singleton pub-sub in the app.
2. **Controls gap** — delete, move, and purge have **no cancel, no retry**. A unified panel
   makes this instantly visible as an inconsistency ("why does this row have Cancel and
   that one doesn't?").
3. **Tracking gap** — uploads have a durable history; destructive operations (delete,
   purge) leave **no record at all** of what was destroyed. This is inverted relative to
   user anxiety: the scariest operations are the least auditable.

## 4. Merge verdicts, per candidate

### Merge — core of the master queue

**Delete + Move/Copy** — *merge first.*
- **Pros:** already near-identical (`{id, phase, files, prefixes, total, count, errors,
  collapsed}`); kills the duplicated CSS/JSX; App already owns both; zero behavior change
  needed to start; establishes the generic task shape cheaply.
- **Cons:** none of substance. Delete's provider-specific versioning caveats and move's
  `skipped` error class are per-kind rendering details, not structural blockers.
- **Judgment:** the confirm dialog must be **pulled out of the queue lifecycle** — delete's
  `phase: 'confirm'` is a pre-queue interaction (Modal) living inside queue data. In the
  unified model, confirmation happens *before* a task is created; a task in the queue is
  always already authorized. This simplifies every downstream consumer.

**Upload** — *merge, via adapter, after the generic layer is proven.*
- **Pros:** it's the flagship queue; a master queue without uploads isn't a master queue.
  Its batch→item hierarchy is exactly the two-level (task→items) model the unified panel
  needs anyway. Its update-batcher is the right progress mechanism for *all* kinds.
- **Cons / risks:** by far the most battle-tested and complex code path (pause/resume,
  resume records, sharding probes, adaptive concurrency, tab-conflict detection,
  BUG-033/034/035 history). Rewriting its state management is the highest-regression-risk
  step in the whole effort.
- **Judgment:** do **not** rewrite the upload engine. Keep `UploadQueue.jsx` orchestration
  logic intact and make it *publish* into the shared task store (batch = task, file =
  item) instead of holding private `useState`. Upload-specific UI (progress bars, speed,
  ETA, resume buttons, large-file warnings, `ErrorDetailsPanel`) becomes the upload
  kind's **detail renderer** inside the generic shell. The generic layer owns only:
  lifecycle summary, counts, expand/collapse, dismiss, and control *capability flags*.

**Purge hidden versions** — *merge; this is the biggest single UX win.*
- **Pros:** most destructive op, currently zero progress/no cancel/modal-bound. Routing it
  through the master queue as a delete-family task gives it progress ("Purging versions ·
  3,200 / 18,400"), navigation-survival, error accumulation display, and history — all for
  free once the delete kind exists.
- **Cons:** works on `{Key, VersionId}` pairs, not keys — `delete-queue.js` batching needs
  a versioned variant (DeleteObjectsCommand already accepts VersionId, so this is a small
  generalization). Listing exhaustion (ListObjectVersions) becomes the task's discovery
  phase. Modal can close once the task is queued.
- **Judgment:** merge in phase 2. Keep the confirmation modal exactly where it is (it
  carries important versioning caveats); only the execution moves into the queue.

**Duplicate deletion (iteration 2)** — *merge by construction.* It was already designed to
route through `onDeleteRequest` → delete queue. Building it against the master queue
instead costs nothing extra and avoids wiring it twice.

### Merge later — worth it, but genuinely optional

**Duplicate scan** — *phase 4, behind its own decision gate.*
- **Pros:** it is the clearest "anxiety" case outside Tier A: minutes-long, and closing
  the modal silently kills it. As a background task, the user could scan a large bucket
  while continuing to browse, with a "Scan complete — view results" affordance.
- **Cons:** it doesn't mutate anything, and its result is a *dataset*, not a count — the
  task row needs a "completed → open results" action, a new interaction the queue doesn't
  otherwise have. The modal-bound design is also self-limiting in a good way (scan scope
  is visible while it runs). Moderate effort: the scan engine already emits phase progress
  (`dedup-scan.js:17-31`) and results are already durable, so the plumbing is real but
  bounded.
- **Judgment:** include in the task model design (so the shape accommodates
  "produces-results" tasks), but implement only after the core proves out. If it never
  merges, the loss is small.

### Do not merge — with reasons

**Byte-for-byte verify** — group-scoped, interactive (egress confirm), binary outcome,
and only meaningful inside the duplicates report where its result badge lives. Putting a
row in a global queue for something whose entire meaning is local to one modal adds a
surface without adding visibility. *If* verify ever grows incremental progress on large
groups, revisit.

**Integrity check** — sub-second, and deliberately anchored to pre-auth trust surfaces
(ChangelogModal/AboutModal). Moving any part of it into an operational queue would weaken
its trust-surface placement for zero visibility gain.

**Downloads** — the app's only involvement is a sub-second presign; the transfer belongs
to the browser's download manager, which Bucketer can neither observe nor cancel. A queue
row would be a *lie* — it would show "running" with no real progress and a cancel button
that can't work. The honest improvement here is smaller and separate: a toast on presign
failure. (Folder/zip download, if ever built, would stream through the app and *would*
belong in the master queue — note for roadmap-2.0.)

**Mtime lazy loading** — ambient and silent by design; a queue row per viewport-load
would be pure noise for the average user. The existing header spinner is the right
altitude.

**Update polling / changelog check** — ambient or one-shot, sub-second, with their own
correct surfaces (banner, button-result). Nothing to unify.

## 5. Proposed unified model

### 5.1 Task shape

```js
Task {
  id: string,
  kind: 'upload' | 'delete' | 'move' | 'copy' | 'purge-versions' | 'dedup-scan',
  label: string,              // "Uploading 14 files", "Deleting 3 files and 1 folder"
  status: 'running' | 'done' | 'error' | 'cancelled',
  subPhase: string | null,    // kind-specific: 'discovering', 'checking', 'resuming'…
  progress: {
    current: number, total: number | null,      // null → indeterminate
    bytes?: number, totalBytes?: number,        // upload-family only
  },
  errors: [{ key, message, skipped? }],
  capabilities: { cancel: bool, retry: bool, pause: bool },  // drives which buttons render
  items?: TaskItem[],         // per-file detail; upload populates richly, delete/move lazily
  detail?: any,               // kind-specific payload for the detail renderer
  createdAt, completedAt,
}
```

Two-level display: **task rows** for everyone; **expand** for items/errors/diagnostics.
Confirmation is *not* a task state — tasks enter the store already confirmed.

### 5.2 Task store (the key refactor)

A module-level subscribable store (same pattern as `toast.js`, plus the existing
`update-batcher.js` for RAF-coalesced progress):

- `taskStore.add(task)`, `update(id, patch, urgent)`, `remove(id)`, `subscribe(fn)`
- All progress updates flow through the batcher — this *fixes* delete/move's
  setState-per-item render churn as a side effect (relevant given the v1.13.x CPU-hotspot
  history), and keeps upload's existing smoothness.
- Owned by no component → any surface can subscribe: the master panel, a header badge,
  a future history view. App no longer carries `deleteOps`/`moveOps`.

### 5.3 UI

- One `<MasterQueue>` panel where UploadQueue/DeleteQueue/MoveQueue stack today, rendering
  task rows newest-first; generic shell (icon, label, progress, counts, controls,
  expand/dismiss) + per-kind detail renderer.
- Retention: success rows auto-collapse after 3 s (keep upload's collapse-not-vanish
  behavior — safer than delete/move's current disappear-after-3s, which can erase evidence
  the user wanted to read); error rows sticky until dismissed.
- **Status chip** in the toolbar (decided 2026-07-06): "2 running · 1 failed", visible
  even when scrolled — the average user's single glanceable anxiety-reducer. Clicking it
  scrolls to / expands the queue panel. Ships in phase 3 with the merged panel.
- Completion signaling unified: toasts for everything; desktop Notification stays an
  upload-batch feature initially (policy can generalize later).

### 5.4 Controls normalization

Merging forces the cancel question. Recommendation: implement **cooperative cancellation**
for delete/move/purge as part of the merge — workers check an aborted flag between work
items / batch groups. Cheap for move (per-object work items); batch-boundary-only for
delete (a 1000-key `DeleteObjectsCommand` in flight can't be recalled — document that
"Cancel stops the next batch"). Retry-failed for delete/move is a natural follow-up
(errors already carry keys) but is not required for the merge.

### 5.5 History (activity log)

Generalize the upload log into an **activity log**: add a `kind` field to entries
(IndexedDB `.add()` is schema-flexible; old entries simply lack it — same pattern already
used in v1.32.0). Delete/move/purge write completion entries (counts, duration, error
count, and the **full key list** — decided 2026-07-06: a true audit trail outranks entry
size; a large purge may store a multi-megabyte entry, accepted trade-off. The audit answer
to "what did I just delete?" is always complete).
UploadLog UI grows a kind column/filter. This closes the destructive-ops audit gap at
minimal cost.

Deliberate non-feature: **do not persist or auto-resume pending destructive tasks across
reload.** An interrupted delete resuming itself on next visit violates least surprise;
only uploads (idempotent, resume-record-verified) earn cross-session resume.

## 6. Problems and risks

1. **Upload regression risk** (highest). Mitigation: adapter approach (§4), no engine
   rewrite, land behind the full e2e suite; uploads migrate *last* among Tier A.
2. **Generic-model gravity.** The upload kind will pressure the generic Task shape to grow
   until it's as complex as uploads. Guard: generic layer owns lifecycle/summary/controls
   *only*; everything else lives in `detail` + kind renderers. If a field is needed by
   exactly one kind, it does not go on Task.
3. **Progress-frequency mismatch.** Solved by routing all kinds through update-batcher
   (§5.2) — but this must be done at merge time, not deferred, or the unified panel
   re-renders per deleted batch × per moved object simultaneously.
4. **Confirm-phase extraction** touches delete's op lifecycle and its tests
   (`DeleteQueue` component tests assert the confirm modal). Contained but real churn.
5. **Cancellation semantics honesty.** Batch deletes can't cancel mid-batch; multipart
   copy can (abort + AbortMultipartUpload already exists in `move-multipart.js`). The UI
   must not promise instant cancellation where it's batch-boundary.
6. **Versioned delete generalization** (purge merge) touches the delete engine's batching;
   needs its own tests (BUG-log discipline: purge currently has no progress reporting to
   regress, but the delete path it joins does).
7. **Auto-dismiss asymmetry today is load-bearing:** delete/move rows vanish after 3 s;
   uploads collapse but remain dismissible. Unifying on collapse-not-vanish changes
   delete/move behavior users may have habituated to — small, but note it in the
   changelog.

## 7. Phased plan

| Phase | Scope | Effort | Risk | Payoff |
|---|---|---|---|---|
| **1** | Task store + generic `<MasterQueue>` shell; port **delete + move/copy**; extract confirm from delete lifecycle; cooperative cancel for both; unified retention | M (~2–3 sessions) | Low — porting twins onto a shape they already share | Kills duplication; proves the model; cancel for destructive ops |
| **2** | **Purge versions** through the queue (versioned delete batching, discovery phase, progress); **duplicate deletion** (iteration 2) lands on the master queue | M | Medium — destructive-path changes, needs UAT per dedup safety model | Biggest visibility win per line of code |
| **3** | **Upload adapter**: UploadQueue publishes batches/items into the store; merge panel; upload detail renderer; toolbar status chip | M–L | High-care (not high-probability) — adapter only, engine untouched, e2e gate | The actual "master queue" moment |
| **4** | **Activity log** (kind field + delete/move/purge entries + UI filter); optional **dedup scan as background task** behind its own go/no-go | S + M | Low / Medium | Audit trail; scan-while-browsing |

Each phase is independently shippable and independently valuable; stopping after phase 1
or 2 still leaves the codebase better than today.

**Explicit non-goals:** downloads, mtime loading, update polling, integrity check,
byte-verify, changelog check (reasons in §4).

## 8. Operator decisions (resolved 2026-07-06)

1. **Status chip: yes** — include the toolbar chip (§5.3); ships in phase 3.
2. **Activity log: full key list** — every deleted/moved/purged key recorded, not a
   capped sample. Entry size accepted as the cost of a complete audit trail (§5.5).
3. **Phase ordering confirmed** — destructive-op visibility (phase 2) before the upload
   adapter (phase 3), as proposed in §7.
