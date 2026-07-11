# Folder rename (#18) — Design

**Date:** 2026-07-11
**Target version:** v1.37.0 (minor — new feature, backwards-compatible)
**GitLab:** closes #18 (Epic #5 — Privacy & Polish quick wins)
**Status:** Approved (brainstorming) — pending implementation plan

## Motivation

Bucketer can rename a single file inline (`Browser.jsx` `commitRename`) and can move whole
folders into another folder (the move pipeline), but it cannot **rename a folder** — change
a prefix's own leaf name in place. This is the last open child of Epic #5.

A folder rename is, structurally, a move where the destination is the **same parent with a
new leaf name**. S3 has no native rename, so — exactly like the existing file rename and
folder move — it is a per-object server-side copy to the remapped key followed by a delete
of the source. It therefore reuses the entire tested move pipeline rather than introducing
any new execution machinery.

## Decisions (resolved during brainstorming, 2026-07-11)

1. **Trigger:** inline rename on folder rows, mirroring the existing file-row rename
   affordance (input pre-filled with the leaf name, ✓/✕, Enter/Esc).
2. **Execution:** dispatch to the existing move pipeline / unified master-queue panel as a
   cancelable **"Rename"** task with progress — even for a 1-object folder (consistency +
   safety for large folders). Not an inline blocking operation.
3. **Collision:** **block** with an error if the target folder name already exists at the
   same parent. No merging, ever. Matches how file rename blocks on collision.

## Scope

- `src/lib/move-key.js` — new pure remap helpers.
- `src/lib/move-queue.js` — new `'rename'` mode + `runRenameOperation`.
- `src/components/Browser.jsx` — folder-row inline rename affordance + dispatch.
- `src/components/App.jsx` — route `mode: 'rename'` into the operation + task label.

**Out of scope:** file rename (unchanged), folder move (unchanged), any change to the
master-queue store/panel internals (rename is just another task that flows through them).

## Architecture

### Remap (pure, in `move-key.js`)

A folder rename `photos/2024/` → `photos/memories/` is a prefix swap on every key under the
old prefix (including the 0-byte folder marker `photos/2024/` itself):

```js
// New target prefix for a renamed folder: same parent, new leaf name.
//   renamedFolderPrefix('photos/2024/', 'memories') -> 'photos/memories/'
//   renamedFolderPrefix('docs/', 'archive')         -> 'archive/'   (top-level)
export function renamedFolderPrefix(oldPrefix, newName) {
  return parentPrefix(oldPrefix.slice(0, -1)) + newName + '/';
}

// Destination key for an object under a renamed folder: strip the old prefix,
// prepend the new one. The marker key flows through the same formula.
//   renameFolderKey('photos/2024/', 'photos/2024/jan/a.jpg', 'photos/memories/')
//     -> 'photos/memories/jan/a.jpg'
export function renameFolderKey(oldPrefix, objectKey, newPrefix) {
  return newPrefix + objectKey.slice(oldPrefix.length);
}
```

`parentPrefix`/`leafName` already exist in `format.js` and are used by the move remap.

### Operation (`move-queue.js`)

`runTransfer(client, bucket, op, onProgress, mode, shouldCancel)` gains a third `mode`,
`'rename'`, exposed via a thin wrapper beside `runMoveOperation`/`runCopyOperation`:

```js
export async function runRenameOperation(client, bucket, op, onProgress, shouldCancel = () => false) {
  return runTransfer(client, bucket, op, onProgress, 'rename', shouldCancel);
}
```

- **Op shape:** `{ prefixes: [oldPrefix], renameTo: newName, capturedPrefix }`. Exactly one
  prefix; no `files`, no `dest`.
- **Work list:** compute `newPrefix = renamedFolderPrefix(oldPrefix, renameTo)`; for each
  discovered key under `oldPrefix`, `destKey = renameFolderKey(oldPrefix, key, newPrefix)`.
- **Collision (authoritative):** before copying anything, crawl `newPrefix`
  (`listAllObjectsForPrefix`). If it contains **any** key, finish immediately with
  `moved: 0` and a single error `A folder named "<newName>" already exists.` — copy nothing.
  (Because the target is verified empty, the per-key collision-skip logic move uses is not
  exercised on the rename path.)
- **Copy-then-delete:** identical to move — copy each object (multipart for >5 GiB via
  `copyObjectMultipart`), delete the source only after the copy is confirmed, honor
  `shouldCancel` between objects, report progress.
- **Completion:** report `movedPrefixes: [oldPrefix]` on full success so `App` can drop the
  old folder row (same field move uses).

### UI (`Browser.jsx`)

Folder rows gain the same inline-rename affordance files have:
- A "Rename" (✎) button on folder rows, gated on `canMove` (rename needs both write and
  delete, same as move). Reuse the `renamingKey`/`renameValue`/`renameError`/`renameSaving`
  machinery, keyed on the folder prefix.
- `startRename(prefix)` pre-fills `leafName(prefix.slice(0, -1))`.
- On commit (`commitFolderRename(oldPrefix)`):
  1. `validateObjectName(newName)` → show inline error if invalid.
  2. No-op guard: if `newName === leafName(oldPrefix.slice(0,-1))`, just close the editor.
  3. Instant collision: if `commonPrefixes` already contains
     `renamedFolderPrefix(oldPrefix, newName)`, show inline
     `A folder named "<newName>" already exists.` — do not dispatch.
  4. Otherwise dispatch `onMoveRequest({ prefixes: [oldPrefix], renameTo: newName,
     mode: 'rename', capturedPrefix: prefix })` and close the editor. The queued task shows
     progress; the row is removed on success via the existing `movedPrefixes` handling.

### App wiring (`App.jsx`)

The existing move-request handler routes `mode: 'rename'` into `runRenameOperation`, creating
a master-queue task labeled **`Rename <oldLeaf> → <newLeaf>`**. Cache invalidation: invalidate
the parent prefix (both old and new folder live under it). All other master-queue behavior
(progress batching, cancel, dismiss) is inherited unchanged.

## Data flow

Folder row ✎ → inline edit → commit → validate + instant-collision check → `onMoveRequest`
(`mode: 'rename'`) → `App` creates a "Rename" master-queue task → `runRenameOperation` →
pre-flight target crawl (block if occupied) → copy-then-delete per object with progress/cancel
→ on success, old folder row removed, parent prefix cache invalidated.

## Error / edge handling

- Invalid name (empty / contains `/`) → inline `validateObjectName` error, no dispatch.
- Rename to the same leaf name → no-op, editor closes.
- Target folder already exists → blocked inline (if visible) or by the pre-flight crawl
  (authoritative); copies nothing.
- Copy succeeds but source delete fails → same "exists in both places" per-object error the
  move path already produces (object left in both locations, surfaced in the task's errors).
- Cancel mid-run → cooperative cancel between objects (inherited from the queue); the row
  reports how many of N were renamed.
- Empty / marker-only folder → the marker is a key; it is remapped and moved like any object.
- Not applicable: self/descendant guard (a rename relabels the leaf at the same parent and
  cannot nest into itself).

## Testing

**`test/move-key.test.js` (unit — extend):**
- `renamedFolderPrefix`: nested folder (`photos/2024/` → `photos/memories/`), top-level
  folder (`docs/` → `archive/`).
- `renameFolderKey`: nested key, the folder marker itself, deeply nested keys.

**`test/move-queue.test.js` (unit — extend; uses the mock S3 client):**
- Rename mode remaps every key under the old prefix to the new prefix and deletes sources.
- **Block on occupied target:** target prefix non-empty → `moved: 0`, one "already exists"
  error, and **no** copies/deletes issued.
- Marker-only / empty folder renames correctly.
- `movedPrefixes` reports the old prefix on success.

**`test/components/` (jsdom):**
- Folder row shows the rename affordance; clicking it opens the inline editor pre-filled
  with the leaf name.
- Invalid name shows the validation error and does not dispatch.
- A name colliding with a visible sibling folder shows the collision error and does not
  dispatch.
- A valid, non-colliding rename dispatches `onMoveRequest` with
  `{ mode: 'rename', prefixes: [oldPrefix], renameTo }`.

**e2e (mock S3) — optional:** rename a folder end-to-end; assert the bucket's keys moved from
the old prefix to the new one and the old prefix is gone.

## Versioning

- Minor bump **v1.37.0** + `CHANGELOG.md` top entry `## [1.37.0] — <date> — Folder rename`.
- `package.json` + CHANGELOG updated together (build enforces the match); `src/lib/changelog.js`
  and `dist/index.html` regenerated by the release build.
- No `BUG-LOG.md` entry (feature). Closes GitLab #18.
