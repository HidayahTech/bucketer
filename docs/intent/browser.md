# Browser.jsx — Design Intent

**Version:** 1.0  
**Date:** 2026-06-01  
**File:** `src/components/Browser.jsx` (~1351 lines)

`Browser.jsx` is the largest component in the codebase. It implements the core file browser UI: listing, navigation, sorting, filtering, preview, download, delete, rename, batch operations, drag-and-drop, and browser history integration. This document explains the design intent behind its major sections.

---

## Architecture Summary

Browser is stateful root of the browsing experience. It:
- Manages the current `prefix` (virtual directory path) and its listing contents
- Implements a session-scoped listing cache to reduce S3 API calls (D-7)
- Produces a single `S3Client` instance per credential set (passed in as prop)
- Reports capability discoveries (permitted/denied) back to App via `onCapabilityChange`
- Coordinates with UploadQueue via `onUploadTargetChange` (tells queue where to upload)
- Calls `onInitialListFailed` if the first probe fails (triggers App's "Connection Failed" state, D-4)

---

## Section 1: Module-Level Constants (Lines ~1–25)

### Intent

Three foundational constants define immutable operating boundaries:

```javascript
// Read the URL-specified prefix exactly once per page session. Subsequent mounts
// (e.g., after credential change triggers Browser remount) always start at root.
// Prevents accumulating phantom root entries in browser history from rapid reconnects.
let _sessionFirstMount = true;

// Presigned URLs expire after 1 hour (§4.4). Long enough for interactive use
// (preview, download, copy-link) but short enough that a leaked URL expires overnight.
const PRESIGN_EXPIRES = 3600;

// Text preview is limited to 100 KB via HTTP Range header to prevent loading
// multi-GB log files into browser memory. Response status 206 (Partial Content)
// means the file was truncated — the UI shows a warning and offers full download.
const TEXT_PREVIEW_LIMIT = 100 * 1024;

// Preset copy-link durations. Custom durations are entered via a number+unit input
// and validated to a 7-day maximum before generating the presigned URL.
const COPY_LINK_PRESETS = [
  { label: '1 hour',  seconds: 3600    },
  { label: '24 hours',seconds: 86400   },
  { label: '7 days',  seconds: 604800  },
];
```

**Why module-level (not component state)?** `_sessionFirstMount` must persist across component remounts (credential change → Browser remounts) but reset on page reload. Component state resets on every remount; module-level state persists across remounts within the same page session.

### Behaviors important to test

- Loading `#prefix=a/b/c` starts at `a/b/c` and does not add a duplicate history entry
- Reconnecting with new credentials does NOT restore the old prefix from the URL — it starts at root
- Text file ≥ 100 KB shows a truncation warning and a "Download instead" link
- Text file < 100 KB shows no warning

---

## Section 2: Copy-Link Popovers (Lines ~27–160)

### Intent

```javascript
// CopyLinkPopover — generates a presigned GET URL for a single file with configurable expiry.
// BatchCopyLinkPopover — same, but for multi-selected files; formats as one URL per line.
//
// Both are self-contained state machines: preset buttons, custom duration input, async URL
// generation, clipboard copy, and error display.
//
// Design: custom duration is entered as a number+unit pair (hours/minutes/days) because users
// think in human time, not seconds. Validated to 1–604800 s before submission.
// Promise.all() for batch generation: all URLs generated in parallel; one failure fails all.
// Popovers close after successful copy (onClose()) — the action is complete.
```

**Why two separate components instead of one parameterized one?** Batch link formatting (one URL per line for pasting into documents) and popover positioning differ enough that a single component would need significant conditional logic. Separate components are clearer.

---

## Section 3: Breadcrumb Navigation (Lines ~162–182)

### Intent

```javascript
// Breadcrumb shows the current prefix path and enables jumping to any parent directory.
// Root is always clickable; the current segment is styled non-clickable.
//
// Prefix splitting: split('/').filter(Boolean) removes empty segments, handling both
// trailing slashes ('a/b/c/' → ['a','b','c']) and clean paths.
// Parent prefixes are reconstructed as parts.slice(0, i+1).join('/') + '/' to ensure
// they always end with '/' — required by S3 ListObjectsV2 Prefix parameter.
function Breadcrumb({ prefix, onNavigate })
```

---

## Section 4: Browser Component State (Lines ~206–275)

### Intent

Browser has 40+ state variables organized by concern. This is not state explosion — each interaction has an independent slice to prevent state sharing bugs.

```javascript
// Browser component manages the entire S3 listing, navigation, and file operations UI.
//
// State is organized by concern — each interactive feature has its own slice:
//   Listing:        prefix, items, commonPrefixes, continuationToken, isTruncated, listing, listError
//   Sort/filter:    sortCol, sortDir, filterQuery
//   File ops:       pendingDelete/deleting/deleteError, renamingKey/renameValue/renameError/renameSaving
//   Folder delete:  folderDelete { prefix, phase, total, deleted, errors } — explicit state machine
//   Preview:        previewItem, previewUrl, previewText, resolvedKind, previewTruncated, etc.
//   Batch:          selectedKeys (Set), batchDeletePending, batchDeleting, batchDeleteError
//   Metadata:       metaItem, metaData, metaLoading, metaError
//   Config:         maxKeys, cacheTTL (loaded from localStorage on mount, do not change per-session)
//
// Refs (not state) for:
//   abortRef:       AbortController for in-flight listing fetches — cancelled on navigation
//   cacheRef:       session-scoped Map<prefix, {...}> — avoids triggering re-renders on cache writes
//   dragCounterRef: debounces drag-enter/leave events from child elements
//   navigateRef / navigatePreviewRef: always-current closures for event handlers registered in effects
//   initialPrefixRef: URL-specified prefix captured once at mount (module-level _sessionFirstMount)
//
// §4.5, §4.7: maxKeys and cacheTTL are loaded from localStorage at mount time and are
// intentionally not reactive — changes in Settings take effect on next mount.
```

**Why `selectedKeys` is a `Set`:** The file table may contain thousands of rows. The checkbox render for each row calls `selectedKeys.has(o.Key)` — O(1) with a Set vs. O(n) with an Array.

**Why `folderDelete` is a single object not multiple variables:** The folder delete operation has phases (`confirm → listing → deleting → done`). A single state object makes the valid transitions explicit and prevents the render from showing e.g. both the listing spinner and the progress meter simultaneously.

---

## Section 5: Sort Toggle (Lines ~277–284)

### Intent

```javascript
// Column sort toggle (§4 beyond spec). Matches standard file manager behavior:
// clicking an active column flips asc ↔ desc; clicking an inactive column
// switches to that column and resets to ascending.
function toggleSort(col)
```

**Why sort state is explicit (not derived):** Explicit `sortCol`/`sortDir` state is stable across listings — when the user loads more pages, the new items are sorted into the existing list using the same state without needing to re-derive the sort direction.

---

## Section 6: Upload Target & Navigation Side Effects (Lines ~286–393)

### Intent

```javascript
// §4.6, §4.14: Notify upload queue of current prefix. Called on every prefix change
// so that files dropped onto the browser land in the correct destination folder.
useEffect(() => { onUploadTargetChange?.(prefix); }, [prefix]);

// §4.7, §4.14: navigateTo() — the central navigation function. On every navigation:
//   1. Abort any in-flight listing fetch (prevents stale state updates)
//   2. If cacheTTL > 0, save current listing to cache before leaving
//   3. Flush listing state: items, prefixes, continuationToken, isTruncated
//   4. Push or replace browser history entry (based on historyMode parameter)
//   5. Fetch the new prefix
//
// historyMode: 'push' for deliberate nav, 'replace' for initial load, 'none' for back button.
//
// Cache save before leaving: captures the listing before flushing it, so navigating
// back restores the full page of results without a network call.
function navigateTo(newPrefix, { historyMode = 'push' } = {})

// §4.14: Initial load — navigate to URL-specified prefix on first mount using replaceState
// so no history entry is added for the initial position. On cleanup, abort any in-flight fetch.
useEffect(() => { navigateTo(initialPrefixRef.current, { historyMode: 'replace' }); ... }, [client, bucket]);

// §4.14: Back/forward button support via popstate. Uses navigateRef.current (always-current
// reference to navigateTo) so the handler remains valid across re-renders.
useEffect(() => { window.addEventListener('popstate', onPopState); ... }, []);
```

### Behaviors important to test

- Navigating to folder A while a fetch for folder B is in progress: B's fetch is aborted, A's starts clean
- Navigate A → B → back: A's listing is restored from cache (no network call if within TTL)
- Navigate A → mutate file in A → B → back: A's listing is refetched (cache was invalidated by mutation)

---

## Section 7: Listing Cache and Pagination (Lines ~315–375)

### Intent

The listing cache (D-7) is a session-scoped optimization. B2 charges per `ListObjectsV2` call; without caching, navigating back to a recent folder adds a charge. The cache is transparent to the user — it only affects latency and cost.

```javascript
// §4.7, D-7: Listing cache — in-memory Map<prefix, {items, commonPrefixes, continuationToken,
// isTruncated, timestamp}>. On fresh navigation (replace=true, no token), check cache first.
// Cache hit: restore all pagination state atomically and skip the network call.
// Cache miss: fetch from S3 and populate cache on success.
//
// Cache is keyed by prefix only (not sort/filter — those are client-side).
// Sort state resets on navigation; filter persists across Load More but resets on navigation.
// Mutations (delete, rename, upload completion, folder create) call invalidateCache(prefix)
// to ensure the user never sees stale results after a write operation.
//
// The cache is never consulted for pagination (Load More) — only for initial navigation.
async function fetchPage(targetPrefix, token, replace = false)
```

```javascript
// §4.2, D-4: isInitialProbeRef tracks whether the initial listing has been attempted.
// If the probe fails, onInitialListFailed(err) is called exactly once to tell App to
// transition to 'session = failed'. Subsequent failures (e.g., after a manual retry)
// do not call onInitialListFailed again.
const isInitial = isInitialProbeRef.current;
// ...
if (isInitial && onInitialListFailed) onInitialListFailed(err);
```

### Invariants

1. Cache is only populated on successful fetches — errors never update the cache
2. `invalidateCache(prefix)` must be called after every mutation that changes the listing
3. Cache stores all pagination state atomically — partial restores (only items, not the token) would break Load More

---

## Section 8: Click-Away Handlers (Lines ~395–420)

### Intent

```javascript
// Popovers (copy-link menus) close when the user clicks outside them.
// Uses 'mousedown' (not 'click') for immediate response — popover collapses on mouse press,
// not after the full click cycle. ref.contains(e.target) check prevents closing when clicking
// within the popover. Listener removed on cleanup to prevent accumulation across re-renders.
```

---

## Section 9: Multi-Select and Batch Operations (Lines ~422–455)

### Intent

```javascript
// Multi-select state uses a Set<Key> for O(1) membership checks per row (§4 beyond spec).
// Selection is cleared on navigation and on refresh — keys do not span prefixes.
//
// "Select all" selects visible items only (respects active filter). If 3 of 50 items are
// visible due to a filter, "select all" selects those 3. This matches spreadsheet behavior
// and prevents invisible items from being accidentally deleted.
//
// Indeterminate header checkbox: the DOM element's .indeterminate property is set directly
// via a ref callback — Preact cannot express indeterminate as a prop. This provides visual
// feedback for "some but not all selected."
function toggleSelectAll(visItems)

// Batch delete uses DeleteObjectsCommand with Quiet: true (returns only errors, not successes).
// Chunked into 1000-object batches to respect the S3 API limit.
// After success, cache is invalidated and deleted keys are removed from items state in-memory
// (no refetch required — the UI is authoritative about what was just deleted).
async function handleBatchDelete()
```

### Behaviors important to test

- Select 3 of 5 items → header checkbox shows indeterminate → click → 5 selected → click → 0 selected
- Filter active showing 2 of 10 items → select all → only those 2 are in `selectedKeys`
- Batch-delete 2500 items → exactly 3 API calls (1000 + 1000 + 500)

---

## Section 10: Drag-and-Drop (Lines ~457–489)

### Intent

```javascript
// Drag-and-drop upload from desktop or file manager (§4 beyond spec).
//
// dragCounterRef debounces nested dragenter/dragenter events. The HTML5 spec fires
// dragenter for every element the cursor crosses, including children. Without the counter,
// the drop overlay would flicker on every row in the table as the cursor moves.
// Counter increments on dragenter, decrements on dragleave, reaches 0 when user fully exits.
//
// FileEntry API (webkitGetAsEntry fallback) preserves folder hierarchy.
// Falls back to e.dataTransfer.files if FileEntry API is unavailable.
// Forwards { file, relativePath } pairs to onExternalDrop (the upload queue picks them up).
```

---

## Section 11: File Metadata Panel (Lines ~491–504)

### Intent

```javascript
// File properties panel: calls HeadObjectCommand to fetch full metadata on demand (§4 beyond spec).
// HeadObject returns fields not available in ListObjectsV2: custom x-amz-meta-* headers,
// storage class, version ID, server-side encryption.
// Lazy fetch: metadata is NOT loaded during listing. Only fetched when user clicks ℹ.
// This avoids N HeadObject calls for N items in a listing page.
async function handleShowMeta(obj)
```

---

## Section 12: Rename (Lines ~506–535)

### Intent

```javascript
// Rename as CopyObject + DeleteObject (§4 beyond spec, D-1).
// S3 has no native rename. Copy-then-delete is the standard approach, used by all S3 UIs.
//
// Copy BEFORE delete — safety guarantee: if CopyObject fails, the original is untouched.
// If DeleteObject fails (rare), the user has two copies but no data loss.
//
// MetadataDirective: 'COPY' preserves all original metadata (content-type, custom headers,
// storage class). The default would strip metadata, which would break files that rely on
// their stored Content-Type for correct browser handling.
//
// Inline rename UI (not a modal): input appears directly in the table row for low-friction edits.
// Validation before commit: empty name, names with '/', and duplicate names are rejected inline.
// Escape cancels; Enter or ✓ button commits.
async function commitRename(oldKey)
```

### Behaviors important to test

- Rename preserves content-type (custom metadata not dropped)
- Rename to existing name in same prefix → inline error, no copy/delete
- Rename to new name with '/' → rejected before any API call

---

## Section 13: Download (Lines ~542–568)

### Intent

```javascript
// Download via presigned URL + temporary DOM <a> element (§4.4, REQ-3).
// Presigned URL generation offloads transfer entirely to the browser's download manager —
// no JavaScript buffering. Works for files of any size without memory concerns.
//
// ResponseContentDisposition: 'attachment; filename="..."' forces a download with the
// correct leaf name, preventing the browser from attempting to open the file inline.
// leafName(key) is URI-encoded for safety with special characters in filenames.
//
// Temporary <a> element: standard pattern for triggering programmatic downloads in
// browsers. Element exists only for the click; removed immediately after.
async function handleDownload(key)
```

---

## Section 14: Single-File Delete (Lines ~570–684)

### Intent

```javascript
// Single-file delete with confirmation modal (§4 beyond spec, D-1).
// A confirmation step is required — accidental one-click deletion is unacceptable.
//
// Modal includes a provider-specific versioning caveat:
// - B2: delete marker created; prior versions retained; storage not immediately reclaimed
// - Others: permanent if versioning is off; delete marker if versioning is on
// This caveat is important because many users expect "delete" to be permanent; on B2 and
// versioned buckets it is not.
//
// onCapabilityChange('delete', 'permitted') is called on success to update the capability
// panel and keep delete buttons enabled. isPermissionError catches 403/AccessDenied to
// mark delete as denied and disable the button.
//
// After delete: cache is invalidated and the item is removed from items state in-memory
// (no refetch — the component is authoritative about what was just deleted).
async function handleDeleteConfirm()
```

---

## Section 15: Folder Delete (Lines ~686–743)

### Intent

Folder delete is a multi-phase state machine (`confirm → listing → deleting → done`) because it may touch thousands of objects and take meaningful time.

```javascript
// Folder delete — recursive listing + batch deletion (§4 beyond spec, D-1).
//
// The state machine has four phases:
//   confirm:  User presses "Delete folder" — fetches begin
//   listing:  All objects under prefix are enumerated via paginated ListObjectsV2
//             (loops until IsTruncated = false). Large folders may take several API calls.
//   deleting: Batch DeleteObjects in 1000-object chunks. Progress shown as N / total.
//   done:     Results shown (success count, error list). User presses Close.
//
// Why enumerate before deleting: we need the total count for the progress meter,
// and batching requires all keys to be available. Also ensures the user sees the
// true scope of the operation before deletion begins.
//
// Why persist errors across batches: if one batch fails on object X, deletion
// continues for other objects. Partial success is better than aborting everything.
// Errors are shown after completion.
//
// After done: cache is invalidated and listing is refetched (the folder is gone,
// so the prefix no longer appears in commonPrefixes).
```

### Behaviors important to test

- Folder with 0 objects: modal does not enter listing/deleting phase, prefix disappears immediately
- Folder with 2500 objects: listing phase exhausts pagination; deleting shows progress 1000/2500, 2000/2500, 2500/2500
- One object in batch fails: deletion continues; done phase shows the error alongside the success count

---

## Section 16: Preview System (Lines ~580–666)

### Intent

The preview system is hybrid: media files use presigned URLs embedded in native HTML elements (browser handles buffering and streaming); text files are fetched via the Range header and displayed as `<pre>`.

```javascript
// File preview (§4 beyond spec) — supports image, audio, video, PDF, and text.
//
// Detection strategy (in order):
//   1. HeadObject → ContentType → mimeKind() — most accurate; works regardless of extension
//   2. Extension → mediaKind() — fallback if HeadObject fails or ContentType is generic
// If neither resolves a kind, 'notPreviewable' is shown.
//
// Media (image/audio/video/PDF): generate presigned URL, set as src/href on the element.
// Browser streams and buffers natively. Works for files of any size without JS memory usage.
//
// Text: SECURITY — ResponseContentType is always forced to 'text/plain; charset=utf-8'
// regardless of stored ContentType or extension. This prevents an uploaded HTML or JS file
// from being rendered as a web page in the preview. The preview only ever shows raw text.
// Range: bytes=0-(TEXT_PREVIEW_LIMIT-1) limits the fetch to 100 KB. Response status 206
// indicates truncation; the UI shows a warning and a "Download instead" button.
async function handlePreview(obj)
```

### Security invariant

The `ResponseContentType: 'text/plain'` override is non-negotiable. It must not be removed or made conditional. A user could upload an HTML file containing a credential-harvesting form and share the preview URL. By forcing `text/plain`, the preview always shows the raw source code, never renders it.

### Behaviors important to test

- HTML file previewed → shows raw HTML source as text, not rendered page
- JS file previewed → shows raw source text
- File with `ContentType: application/octet-stream` and `.jpg` extension → previews as image (extension wins)
- File with `ContentType: image/jpeg` and no extension → previews as image (header wins)
- 200 KB JSON file → previews truncated with warning

---

## Section 17: Preview Keyboard Navigation (Lines ~657–666)

### Intent

```javascript
// Arrow keys navigate prev/next previewable items when a preview is open.
// Effect only runs when previewItem is set (no key capture when no preview is open).
// navigatePreviewRef is updated every render with the current navigation callback,
// which depends on the current sorted/filtered items list. Using a ref (not capturing
// the callback in the effect closure) ensures the handler always sees fresh data even
// if the listing changes while the preview is open.
useEffect(() => { ... if (previewItem) window.addEventListener('keydown', onKey) ... }, [previewItem]);
```

---

## Section 18: Render Guards, Sorting, and Filtering (Lines ~788–840)

### Intent

Before the render tree, derived data is computed from raw API responses:

```javascript
// §4.12: Capability gates from parent state. Operations are disabled only when capability
// is explicitly 'denied' — 'unknown' means "not yet tested, assume permitted."
const canDownload = capabilities.download !== 'denied';
const canDelete   = capabilities.delete   !== 'denied';

// Sorting (§4 beyond spec):
// - Folders: by name only (no size/date available from ListObjectsV2 CommonPrefixes)
// - Files: by sortCol (name/size/modified) with locale-aware string comparison
// Sort state does not reset on Load More — new pages sort into the existing list.
// Sort is computed at render time (no cache needed — fast for thousands of items).

// Filtering: case-insensitive substring match against the leaf name.
// Applied AFTER sorting — re-sorting does not re-apply the filter.
// Filter is cleared on navigation (navigateTo flushes filterQuery) but persists across Load More.

// Preview navigation list: visibleItems with known media extensions + extension-less files.
// Extension-less files are included because they might have a previewable ContentType
// from the server (only discoverable via HeadObject, which happens on preview click).
// navigatePreviewRef.current is updated every render with the current navigation closure.
```

### Invariants

1. Sort does not flush on Load More — new items are sorted into the existing sorted list
2. Filter is applied client-side against already-loaded results (no refetch on filter change)
3. `capabilities.*.denied` → button disabled; `'unknown'` → button enabled (fail-open)

---

## Section 19: Modals Reference

| Modal | Trigger | Key design note |
|-------|---------|-----------------|
| Delete confirmation | Click ✕ on file | Provider-specific versioning caveat text |
| Folder delete | Click ✕ on folder | Multi-phase state machine; not dismissible during listing/deleting |
| Batch delete | "Delete N" in batch bar | Shows total count; warns about versioning |
| New folder | "+ New folder" button | Validates name (no `/`, no duplicates, not empty) |
| Metadata | Click ℹ on file | Lazy HeadObject; displays x-amz-meta-* headers |
| Preview | Click on file name | Hybrid presigned URL/range fetch; keyboard navigation |

All modals close on click-outside except the folder delete modal during listing/deleting phases (closing mid-operation would abandon an in-progress batch and leave inconsistent state).

---

## Section 20: File Table Render (Lines ~1110–1346)

### Key design notes

```javascript
// Folder rows come before file rows — matches convention of all S3 UIs and file managers.
// Folders are clickable rows (navigateTo); files have action buttons.

// Indeterminate select-all: ref callback sets el.indeterminate directly on the DOM element.
// This cannot be expressed as a Preact/React prop.

// Load More button shown only when isTruncated=true and no fetch in progress.
// Clicking it calls fetchPage(prefix, continuationToken) — appends to existing items.

// HiddenVersions is rendered with key={prefix} so it remounts on every navigation.
// This forces it to reset its loaded state when the user navigates to a different folder
// (the hidden versions panel is always per-prefix, never shared across folders).
<HiddenVersions key={prefix} client={client} bucket={bucket} prefix={prefix} />
```

---

## Cross-Component Integration Points

| Interaction | Who initiates | Who receives |
|-------------|--------------|-------------|
| Current upload directory | `Browser` (prefix change) | `App` → `UploadQueue` via `onUploadTargetChange` |
| Initial list failure | `Browser` (first fetch error) | `App` via `onInitialListFailed` → `session='failed'` |
| Operation capability update | `Browser` (operation result) | `App` via `onCapabilityChange` → `capabilities` state → back to `Browser` |
| Drop files onto browser | User (drag event) | `Browser` → `App` → `UploadQueue` via `onExternalDrop` |

---

## Complete Invariant List

1. `prefix` always ends with `/` except root (`''`)
2. `invalidateCache(prefix)` is called after every mutation (delete, rename, upload, folder create)
3. `navigateTo` always aborts any in-flight fetch before starting a new one
4. Resume record is saved BEFORE the first part upload (if record save fails, the upload continues but cannot be resumed)
5. `ResponseContentType: 'text/plain'` is always applied to text previews (security invariant)
6. `selectedKeys` is cleared on navigation and on refresh
7. The first `ListObjectsV2` failure calls `onInitialListFailed` exactly once
8. Capability state is `'unknown'` (enabled) by default; only transitions to `'denied'` after an actual operation fails
9. Delete modal is always required before any destructive operation (no one-click delete anywhere)
10. `_sessionFirstMount` is read at mount time and set to `false` immediately — subsequent mounts start at root regardless of URL
