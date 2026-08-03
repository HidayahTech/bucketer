# Download entry points: relocation + selection scope

**Date:** 2026-08-02 · **Status:** approved (design), pending implementation
**Supersedes:** the sidebar placement of "Download this folder…" and "Download with a
transfer tool…" introduced in `258a697`/`7310ca4` (2026-07-30). That placement was an
implementation-time choice never surfaced in the Stage 1 design
(`2026-07-30-large-download-manager-design.md` contains no placement decision) and was
explicitly rejected by the operator on 2026-08-02.

## Problem

Folder download is an action on bucket *content*, but its only entry points sit in the
sidebar — a panel about connection and settings — invisible without scrolling and
disconnected from the folder they operate on. Separately, there is no way to download an
arbitrary multi-selection at all: the batch bar offers Move/Copy/Delete but not Download.

## Decisions (operator-approved, 2026-08-02)

1. **Same machinery, always.** Every download scope — folder, subfolder, or ticked
   selection — goes through the same `DownloadJobPanel` flow and the same durable,
   resumable job pipeline. No lightweight "just send these files" side path.
2. **Approach A: multi-root jobs.** One job whose scope is a list of roots, not one job
   per root (rejected: fragments confirm numbers and job history) and not in-memory
   pre-expansion (rejected: O(n) memory, violates the bounded-memory principle the
   parity measurements established).
3. **Transfer-tool link hidden on selection scope.** The Stage 1 command generator is
   prefix-scoped; the "Use a transfer tool instead" link renders only when the panel's
   scope is exactly one prefix root. No `--include`-filter generation (YAGNI).

## Section 1 — Entry points

**Removed:** the entire `handoff-entry` block in `App.jsx`'s sidebar (both buttons, both
hint paragraphs). `TransferHandoff` itself remains; its only entry becomes the panel's
"Use a transfer tool instead" link.

**Added — three entry points, all opening the same `DownloadJobPanel`:**

| Entry | Where | Scope |
|---|---|---|
| "⤓ Download" toolbar button | `browser-toolbar-actions`, next to ↺ Refresh and New folder | the folder currently viewed |
| ⤓ per-row action on folder rows | alongside rename/move | that subfolder, without navigating into it |
| "Download N" batch-bar button | next to Move/Copy/Delete; disabled when `canDownload` is false (same gate as Copy link) | the ticked files and folders |

- The toolbar button inherits `data-testid="open-download-job"` so shipped e2e specs
  pass unmodified — that is the relocation's regression check.
- `Browser` gets a new `onDownloadRequest(payload)` prop mirroring `onDeleteRequest`;
  it never touches job machinery. App stores the payload as the pending scope and opens
  the panel.
- Mobile: no new work — the batch bar wraps, and the ≤640px `.row-actions` reflow
  already accommodates added buttons.

## Section 2 — Scope model: multi-root jobs

A job's scope becomes `roots`, an ordered array of:

```js
{ type: 'prefix', prefix }
{ type: 'file', key, size, etag, lastModified, storageClass }
```

File roots carry everything the listing row already knew — enumerating them costs zero
requests.

- Toolbar/folder-row → one prefix root. Batch bar → one file root per ticked file plus
  one prefix root per ticked folder.
- **Normalization at capture time** (pure function): a ticked file whose key falls under
  a ticked folder is dropped — the crawl will produce it; keeping it would duplicate a
  manifest row.
- **Legacy read-path shim, no migration write:** a persisted job with `prefix` and no
  `roots` reads as `[{ type: 'prefix', prefix }]`. Additive field; no DB version bump.
- Jobs record a scope label at capture time: folder jobs read as today
  (`bucket/prefix`); selection jobs read "N selected items in `bucket/prefix`".
- Everything downstream of the manifest — issuing, lifecycle classification, verify,
  retry, discard — never sees `roots`; it operates on manifest items exactly as today.

## Section 3 — Enumeration and checkpointing

`enumerateJob` walks `roots` in order. The job's `enumeration` state generalizes from
`{ continuationToken, done }` to `{ rootIndex, continuationToken, done }`.

- **File roots:** consecutive file roots batch into one `appendManifestPage` call with
  the same filtering as crawled pages (directory markers dropped; archived storage
  classes recorded `SKIPPED` with `skipReason: 'archived'`, judged from the captured
  storage class). The commit advances `rootIndex` past the batch atomically.
- **Prefix roots:** crawled via `crawlPrefix` exactly as today; each committed page
  advances `{ rootIndex, continuationToken }` together inside the transaction
  `appendManifestPage` already provides. Completing a prefix root increments
  `rootIndex` and resets `continuationToken`.
- **Resume semantics unchanged in kind:** a crash mid-enumeration resumes from the last
  committed page — now "last committed page of root *i*". The items+checkpoint
  single-transaction invariant is untouched; only the checkpoint payload grows a field.
- `done: true` commits with the final page of the final root.
- Counts (`objects/bytes/archived/archivedBytes`) accumulate across all roots — the
  confirm button quotes one honest number for the whole selection.

## Section 4 — Panel behavior and edge cases

- The panel receives a `scope` prop replacing bare `prefix`:
  `{ kind: 'folder', prefix }` or `{ kind: 'selection', roots, label }`. Phases
  (options → listing → ready), naming-mode choice, archived disclosure, and job-history
  rows are unchanged.
- Naming modes apply per manifest item as now. LEAF collisions across selection roots
  are possible but not new (they exist within folder trees today); the browser's
  download manager suffixes duplicates, and full-path mode remains the collision-free
  option. No new handling.
- An entirely-archived selection yields `sendable = 0` and the existing "nothing can be
  sent" presentation.
- Bucket re-check before start/verify: existing guards in `downloadApi` cover selection
  jobs with no scope-specific code.
- Cancel mid-listing discards the half-enumerated job, as today.

## Section 5 — Testing

**Unit (plain Node):** roots normalization (file-under-ticked-folder dropped, order
preserved); multi-root `enumerateJob` against the existing mock client — file-roots-only,
prefixes-only, mixed; resume from a checkpoint mid-prefix and between roots; legacy
`{prefix}` job read as one prefix root; archived file root recorded SKIPPED.

**Component (jsdom):** batch bar shows "Download N" with correct count and `canDownload`
gating; folder-row and toolbar buttons dispatch the right scopes; panel renders the
selection label; transfer-tool link present for one-prefix-root scope, absent otherwise.

**Source invariants:** the sidebar `handoff-entry` block is gone from `App.jsx`.

**E2E (container matrix, per the evidence rules in CLAUDE.md):** baseline run on the
untouched tree first. One observable per feature:

- Selection download: a browser `download` event fires for **exactly the ticked files
  and no others** (`collectDownloads` in `test/e2e/harness.mjs`).
- Folder-row entry: download events for the subfolder's files.
- Relocation: the existing folder-download spec passes against the toolbar button via
  the inherited testid.

## Out of scope

- The staged/managed download tiers, sink seam, and chunked Range transport (Stage 2
  proper — unchanged by this work).
- Transfer-tool command generation for selections.
- Any change to issuing, lifecycle, verify, or retry logic.
