# Bucketer — Feature Backlog

Roughly ordered by impact-to-effort ratio.

---

## 1. Client-side filter / search

A text input above the file table that filters the currently-loaded listing by filename in real time. No API call needed — filter `sortedItems` and `sortedFolders` by whether the name includes the query string (case-insensitive).

**Implementation notes:**
- Add a `filterQuery` state string, reset it on folder navigation.
- Apply `.filter(obj => obj.Key.slice(prefix.length).toLowerCase().includes(q))` before sorting.
- Show a "X of Y" count when a filter is active.
- Keep it out of the URL — it's ephemeral UI state.

---

## 2. Create folder

A button (near the breadcrumb or table header) that prompts for a folder name and PUTs a zero-byte object at `<prefix><name>/` to establish the prefix.

**Implementation notes:**
- Use `PutObjectCommand` with `Key: prefix + name + '/'`, `Body: ''`, `ContentType: 'application/x-directory'`.
- Validate: disallow slashes in the input, empty names, names that already exist in `commonPrefixes`.
- On success, append the new prefix to `commonPrefixes` state without a full re-list.

---

## 3. Multi-select + batch operations

Checkboxes on file rows enabling bulk delete, bulk copy-link (all presigned URLs newline-separated to clipboard), and potentially bulk download.

**Implementation notes:**
- Add `selectedKeys: Set<string>` state; a header checkbox selects/deselects the entire current page.
- Bulk delete: reuse the existing `DeleteObjectsCommand` batch logic already in `handleFolderDeleteConfirm`. Show a confirmation modal listing the count.
- Bulk copy-link: generate all presigned URLs in parallel (`Promise.all`), join with newlines, write to clipboard. Use the same duration-picker popover as the single-file flow.
- Bulk download as zip: out of scope for now — browser memory limits make it risky for large files. Skip unless explicitly requested.
- Clear selection on navigation, sort change, or page load.

---

## 4. Rename / move

Inline rename for files (click a pencil icon or double-click the filename); a separate "Move to…" modal for relocating files or entire folders to a different prefix.

**Implementation notes:**
- S3 has no native rename — it's `CopyObjectCommand` followed by `DeleteObjectCommand`. Use `MetadataDirective: 'COPY'` to preserve all metadata.
- For folders: list all keys under the old prefix, copy each to the new prefix (can parallelise with `Promise.all` in batches), then delete the originals. Same pattern as the existing folder delete.
- Show a progress indicator for folder moves (same `phase` state machine approach used in folder delete).
- The rename input should live in the file row — show it on a pencil-icon click, confirm with Enter, cancel with Escape.

---

## 5. Object metadata / properties panel

A modal or side panel showing the full `HeadObject` response for a file: `ContentType`, `ContentLength`, `ETag`, `LastModified`, `StorageClass`, `VersionId`, and any `x-amz-meta-*` custom headers.

**Implementation notes:**
- Triggered from a new action button (or from the preview modal).
- `HeadObjectCommand` is already imported and used in the preview flow — reuse it.
- Display custom metadata keys stripped of the `x-amz-meta-` prefix.
- Read-only for now; editable metadata is a larger scope (requires copy-with-new-metadata).

---

## 6. Drag-and-drop upload

Drop files (or a folder) directly onto the file table to queue them for upload, rather than using the file picker.

**Implementation notes:**
- Add `dragover` / `drop` handlers to the table container; prevent default to enable drop.
- `e.dataTransfer.files` gives a `FileList` — feed it to the existing upload queue the same way the file picker does.
- For folder drops, `e.dataTransfer.items` + `webkitGetAsEntry()` traversal is needed to reconstruct the path hierarchy. This is the fiddly part; single-file drops are trivial.
- Show a visual drop target overlay (dashed border, "Drop files here" label) while dragging over the table.

---

## 7. Dark mode

Add a `prefers-color-scheme: dark` media query override block to `main.css` redefining the CSS custom properties on `:root`.

**Implementation notes:**
- The variable system in `:root` is already structured for this — only the colour tokens need new values.
- Key swaps: `--bg` → `#1a1b1e`, `--surface` → `#25262b`, `--surface-raised` → `#2c2e33`, `--border` → `#373a40`, `--text` → `#c1c2c5`, `--text-muted` → `#909296`.
- No JS needed unless a manual toggle is wanted (not proposed here — `prefers-color-scheme` alone is sufficient).
