# Correctness & Subtle Bugs — Bucketer v1.14.0

## Summary

The codebase is in genuinely good shape for its class and complexity. The upload pipeline, resume path, and storage model are all well-engineered. One critical defect was found: `DeleteObjectCommand` is used in `Browser.jsx`'s rename function but is missing from the import statement, which means every rename operation throws a `ReferenceError` at runtime. Two medium-severity issues from the v1.0 review remain unresolved: `clearCredentials()` still wipes all user settings on every disconnect, and `HiddenVersions.handlePurgeAllConfirm` still stops on the first per-batch error rather than accumulating. The `handlePreview` async function has a latent race where a slow HeadObject can resolve after the user has navigated to a different folder, setting preview state for a file no longer in view.

---

## Findings (severity-ordered)

### [BUG-01] `DeleteObjectCommand` missing from Browser.jsx import — Critical

- **Location**: `src/components/Browser.jsx:9` (import), `src/components/Browser.jsx:564` (usage)
- **Symptom**: Every rename operation throws `ReferenceError: DeleteObjectCommand is not defined` at the step where the original file is deleted after the copy. The copy step succeeds, leaving a duplicate — the original file is still present with its old key, and the renamed copy also exists. The user sees an unhandled exception; the rename appears to have failed even though the file was duplicated.
- **Root cause**: The import from `@aws-sdk/client-s3` at line 9 lists `ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand, CopyObjectCommand` but not `DeleteObjectCommand`. The identifier is used at line 564 inside `commitRename`: `await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey }));`. The build will succeed (esbuild bundles what it finds at import time from the SDK), but the runtime reference is undefined.
- **Reproduction**: Connect to any bucket. Select a file, click the rename (✎) button, enter a new name, confirm. The rename dialog will close with an error, but the file listing will show both the original and the new-named copy.
- **Recommendation**: Add `DeleteObjectCommand` to the import on line 9. This is a one-word change; it was almost certainly lost when the unified delete flow was added in v1.14.0 and delete-related imports were moved to `delete-queue.js`.

---

### [BUG-02] `clearCredentials()` still wipes all user settings on disconnect — High

- **Location**: `src/lib/storage.js:72–75`
- **Symptom**: Disconnecting from a bucket deletes the user's saved settings (max keys, part concurrency, part size, file concurrency, listing cache TTL, update check enabled, prefetch size limit, upload expand threshold, capabilities). A user who has configured a non-default part size or disabled the listing cache loses those settings silently on every disconnect.
- **Root cause**: `clearCredentials()` iterates `Object.values(LS_KEYS)` and removes every key. `LS_KEYS` includes all settings keys (`maxKeys`, `partConcurrency`, `partSizeMB`, `fileConcurrency`, `listingCacheTTL`, `updateCheckEnabled`, `prefetchSizeLimit`, `uploadExpandThreshold`, `capabilities`). A `resetSettings()` function was added that correctly enumerates just the settings keys — but `clearCredentials()` was never updated to use a narrowed key set. The `resetSettings()` function exists but is only exposed via the StorageModal "Reset Settings" button; it is never called from the disconnect flow.
- **Reproduction**: Change part size to 50 MB in Settings, save. Disconnect. Reconnect and open Settings — part size reverts to the default 5 MB.
- **Recommendation**: Change `clearCredentials()` to remove only credential keys (endpoint, bucket, keyId, provider, regionOverride). The six settings keys and capabilities should survive a disconnect. This is the exact fix flagged in the v1.0 review that has not been applied.

---

### [BUG-03] `HiddenVersions.handlePurgeAllConfirm` stops on first batch error — High

- **Location**: `src/components/HiddenVersions.jsx:122–131`
- **Symptom**: When purging all hidden versions, if one `DeleteObjectsCommand` batch returns errors (e.g., partial access denial), the entire purge operation stops at that batch. The first 1000 items may have been deleted, but the remainder are not, and the UI shows only the first key that failed. There is no indication of how many were successfully deleted before the stop.
- **Root cause**: The batch loop (`for (let i = 0; i < all.length; i += 1000)`) calls `throw` on the first batch that has any per-key error in `resp.Errors`:
  ```js
  if (resp.Errors && resp.Errors.length > 0) {
    const e = resp.Errors[0];
    throw new Error(`Failed to delete ${e.Key}: ${e.Message}`);
  }
  ```
  This is the "stops on first error" pattern. The comparable flow in `delete-queue.js` (`runDeleteOperation`) correctly accumulates errors across all batches. `HiddenVersions` never received the same treatment.
- **Reproduction**: With a versioned bucket, purge-all on a prefix where some objects are protected by a bucket policy. The first batch may succeed and delete up to 1000 objects; subsequent batches are never attempted.
- **Recommendation**: Accumulate `resp.Errors` into an error array across all batches (as `delete-queue.js` does) and report the total at the end. Do not throw on partial batch errors.

---

### [BUG-04] `handlePreview` async function has no cancellation guard — Medium

- **Location**: `src/components/Browser.jsx:615–701`
- **Symptom**: If the user opens a preview and then quickly navigates to a different folder while the HeadObject or getSignedUrl call is still in flight, those async operations resolve after navigation and set `previewUrl` / `previewText` / `previewError` state on the now-navigated component. The preview modal may appear or update for a file from the previous folder.
- **Root cause**: `handlePreview` is a plain `async function` with no cancellation token, no generation counter, and no "still current?" check before each `set*` call. It sets state unconditionally after each await:
  ```js
  setPreviewUrl(url);  // line 697 — no guard
  setPreviewText(await resp.text());  // line 684 — no guard
  ```
  Navigation calls `navigateTo`, which clears listing state but does not close the preview or cancel the in-flight preview request. `prefetchAdjacent` correctly uses a `prefetchGenRef` generation counter to abandon stale runs; `handlePreview` itself has no equivalent.
- **Reproduction**: Open a preview on a large text file (slow HeadObject), immediately click a sub-folder to navigate. The preview modal may appear for the old file after navigation completes.
- **Recommendation**: Add a ref counter (similar to `prefetchGenRef`) that is incremented by `handlePreview` and checked before each state update. Alternatively, `navigateTo` should call `closePreview()` to clear preview state when the user navigates — this is the simpler fix and has better UX (the modal should close on navigation anyway).

---

### [BUG-05] `handleDeleteConfirm` in App.jsx is unawaited by its caller — Medium

- **Location**: `src/components/DeleteQueue.jsx:76`, `src/components/App.jsx:198`
- **Symptom**: If `runDeleteOperation` throws an unhandled error (e.g., a bug in the discovery path or an unexpected rejection from the S3 client that bypasses the internal catch), the resulting unhandled Promise rejection is invisible to the UI. The delete panel may stay in "discovering" or "deleting" state forever with no way to dismiss it.
- **Root cause**: `handleDeleteConfirm` is an `async function` that does not wrap `runDeleteOperation` in a try/catch. `runDeleteOperation` itself catches listing errors and converts them to `onProgress` calls, so this is mostly mitigated — but the `await runDeleteOperation(...)` call at line 201 is fire-and-forget from the button's `onClick` perspective. Any uncaught throw propagates as an unhandled rejection.
- **Reproduction**: Trigger a case where `discoverPrefixKeys` throws without the internal catch catching it (e.g., a ListObjectsV2 call that throws a non-standard error). The UI may freeze in a non-dismissible state.
- **Recommendation**: Wrap the `await runDeleteOperation` in `handleDeleteConfirm` with a try/catch that calls `updateDeleteOp(id, { phase: 'done', errors: [{ key: '(unexpected)', message: err.message }], deletedPrefixes: [] })` to ensure the panel always reaches a dismissible state.

---

### [BUG-06] Resume path is still a serial `for` loop — Medium

- **Location**: `src/components/UploadQueue.jsx:371–385`
- **Symptom**: Resuming a large partially-uploaded file is dramatically slower than a fresh upload. A fresh upload uses a worker pool with configurable concurrency (default 4 concurrent parts); resume uploads one part at a time.
- **Root cause**: `handleResume` uses a sequential `for` loop over `remainingParts`:
  ```js
  for (const partNumber of remainingParts) {
    ...
    const chunk = await item.file.slice(start, end).arrayBuffer();
    const partResp = await client.send(new UploadPartCommand(...));
    ...
  }
  ```
  The `uploadMultipart` function for fresh uploads uses `Promise.all(Array.from({ length: concurrency }, worker))`. This discrepancy was flagged in the v1.0 review and has not been addressed.
- **Recommendation**: Refactor the resume part-upload loop to share the same worker pool pattern as `uploadMultipart`. The `PART_CONCURRENCY` / `loadPartConcurrency()` settings should apply equally to both paths.

---

### [BUG-07] `_sessionFirstMount` module-level mutable — Low

- **Location**: `src/components/Browser.jsx:23`
- **Symptom**: In development with HMR, this flag is never reset between module reloads. On the second HMR reload, the URL-specified prefix is not restored, because `_sessionFirstMount` is already `false`. In production this is benign. The HMR dev experience is slightly degraded.
- **Root cause**:
  ```js
  let _sessionFirstMount = true;
  ```
  Module-level mutable state outlives React/Preact component lifecycle. The flag is set to `false` on the first `Browser` mount and never reset, so any subsequent mount (reconnect, HMR reload) starts at root even if the URL has a `prefix` param.
- **Recommendation**: Move this into a `useRef` initialized once per App session and passed down as a prop, or use a module-level flag that is reset on `App` mount via an exported `resetSessionState()` call. The v1.0 review flagged this; it is cosmetic in production but shows unclean module design.

---

### [BUG-08] `formatBytes` produces `"NaN undefined"` for negative, `NaN`, `undefined`, or `null` input — Low

- **Location**: `src/lib/format.js:4–9`
- **Symptom**: Any call site that passes a negative number, `NaN`, `undefined`, or `null` to `formatBytes` renders the string `"NaN undefined"` in the UI. Examples: `formatBytes(obj.Size)` in the file table when S3 returns an object without a `Size` field; `formatBytes(displayedBytes)` in `BatchSummary` before any upload progress has been recorded.
- **Root cause**: `formatBytes` only guards for `bytes === 0`. For any other falsy or non-positive input:
  - `Math.log(bytes)` returns `NaN` for negative or `NaN` input, and `-Infinity` for zero (handled).
  - `Math.floor(NaN) = NaN`, which is used as an index into `units[]`, returning `undefined`.
  - The template `` `${NaN} undefined` `` produces the string `"NaN undefined"`.
- **Reproduction**: Inspect the file table for objects returned by some S3 providers (especially delete markers or folder placeholder objects) that omit the `Size` field. The size column shows `"NaN undefined"`.
- **Recommendation**: Add a guard at the top of `formatBytes`: `if (bytes == null || isNaN(bytes) || bytes < 0) return '—';`

---

### [BUG-09] `discoverPrefixKeys` in delete-queue.js fires all prefix discoveries concurrently without a concurrency limit — Low

- **Location**: `src/lib/delete-queue.js:37–51`
- **Symptom**: If a user selects a large number of folders (e.g., 50+) for deletion simultaneously, `discoverPrefixKeys` launches one `ListObjectsV2` paginated crawl per prefix, all concurrently, with no throttle. This can saturate the browser's HTTP/2 connection pool and may trigger throttling responses from the S3 provider.
- **Root cause**: `Promise.all(prefixes.map(async (pfx) => { ... }))` with no concurrency cap. `ListObjectsV2` for each prefix may itself paginate, multiplying the request count further.
- **Reproduction**: Select 30+ folders and click delete. Browser network tab will show 30+ simultaneous ListObjectsV2 requests.
- **Recommendation**: Limit discovery concurrency to a small cap (4–8) using the same worker-pool pattern used elsewhere. The `CONCURRENCY = 8` constant is only applied to `DeleteObjectsCommand` batches, not to the discovery phase.

---

### [BUG-10] Tab-conflict detection has a narrow TOCTOU window — Low

- **Location**: `src/lib/indexeddb.js:158–163`, `src/components/UploadQueue.jsx:165–172`
- **Symptom**: If two tabs start uploading the same file to the same key at very nearly the same time (both pass the `isUploadActiveElsewhere` check before either calls `markUploadActive`), both will proceed without a conflict warning and will corrupt each other's multipart sessions.
- **Root cause**: `isUploadActiveElsewhere` reads localStorage and `markUploadActive` writes it in two separate synchronous calls (lines 165 and 172 of `UploadQueue.jsx`). Between these two calls, a context switch to another JS event loop iteration (or another tab reading the same key simultaneously) could allow a second tab's `isUploadActiveElsewhere` to read before either tab has written. In practice, the window is extremely narrow (nanoseconds of microtask scheduling), but it is not zero. The comment in `indexeddb.js` correctly documents this as "best-effort."
- **Recommendation**: This is inherent to localStorage-based coordination without atomic compare-and-swap. Document explicitly that the detection is probabilistic, not guaranteed. Consider a `storage` event listener to notice when another tab writes to `ACTIVE_KEY` and re-check. For now, the best-effort note in the comment is sufficient for the threat model.

---

### [BUG-11] `handlePreview` does not call `closePreview` before starting a new preview — Nit

- **Location**: `src/components/Browser.jsx:615–626`
- **Symptom**: Clicking a preview link while a previous preview's HeadObject request is in flight does not cancel the in-flight request. Both the old and new preview's async bodies are executing concurrently, and whichever resolves last wins, possibly showing the wrong item.
- **Root cause**: `handlePreview` sets `setPreviewItem(obj)` and clears related state, but it does not abort the in-flight request from a previous `handlePreview` call. There is no AbortController associated with preview fetches.
- **Recommendation**: Track a preview AbortController in a ref; abort it at the start of each `handlePreview` call. This is separate from the generation-counter fix in BUG-04 but related.

---

## Verification of prior review (v1.0)

### clearCredentials clobbers settings
**Still present.** `src/lib/storage.js:72–75` still iterates `Object.values(LS_KEYS)` and removes all keys including `maxKeys`, `partConcurrency`, `partSizeMB`, `fileConcurrency`, `listingCacheTTL`, `updateCheckEnabled`, `prefetchSizeLimit`, `uploadExpandThreshold`, and `capabilities`. A `resetSettings()` function was added but is not called from `handleDisconnect`. See BUG-02.

### Resume path is serial
**Still present.** `src/components/UploadQueue.jsx:371–385` uses a sequential `for` loop over `remainingParts`. The fresh-upload path at line 310 uses `Promise.all(Array.from({ length: concurrency }, worker))`. See BUG-06.

### HiddenVersions purge-all stops on first error
**Still present.** `src/components/HiddenVersions.jsx:128–130` throws on the first batch with any `resp.Errors` entry. See BUG-03.

### `_sessionFirstMount` module-level mutable
**Still present.** `src/components/Browser.jsx:23` declares `let _sessionFirstMount = true;` at module scope. No change from v1.0. See BUG-07.

### Browser.jsx complexity (still 1326 lines)
**Still present.** `Browser.jsx` is 1326 lines with 34+ `useState` calls. The v1.0 review flagged it at 1352 lines and 33 useState calls; the v1.14.0 unified delete refactor actually moved delete operations to `App.jsx` (a genuine improvement — delete no longer lives inside Browser), but the file remains at the same line count because the preview and prefetch machinery grew to fill the removed delete code. The extraction of delete into `DeleteQueue.jsx` and `delete-queue.js` is the right direction; the preview, rename, and metadata flows are the next candidates.

---

## Non-findings worth noting

- **Delete operation parallelism and error accumulation (`delete-queue.js`)**: The new `runDeleteOperation` correctly accumulates errors per batch, uses a worker-pool pattern with `CONCURRENCY=8`, and includes retry with exponential backoff. This is significantly better than the old per-operation delete paths. The `handleDeleteConfirm` integration in `App.jsx` correctly uses the `onProgress` callback for incremental UI updates.
- **Prefetch generation counter**: `prefetchAdjacent` uses `prefetchGenRef` to abandon stale prefetch runs when the user navigates or opens a new preview. The implementation is correct and the gen-check is applied before every async operation in the loop.
- **IndexedDB schema migration**: `openDB`'s `onupgradeneeded` correctly creates both stores on first open and handles the v1→v2 upgrade by creating `LOG_STORE` if absent. Quota and private browsing errors are caught by the IDB `onerror` handler, which rejects the returned Promise; callers use `.catch(() => {})` consistently.
- **`Promise.all` in `BatchCopyLinkPopover`**: Batch presign uses `Promise.all`; on first rejection, unresolved signs are abandoned in-flight but the SDK calls are read-only (presign) — no data corruption possible.
- **Provider detection robustness**: `detectProvider` tests only the hostname (`new URL(endpoint).hostname`), avoiding false matches on path components. The patterns are anchored with `$` to prevent suffix-based misdetection. An unparseable endpoint correctly falls through to `GENERIC`.
- **Pagination token safety (`fetchPage`)**: The `ContinuationToken` is cleared when `navigateTo` is called, preventing stale tokens from a previous prefix from contaminating a new listing. `handleRefresh` also resets `continuationToken` to null before re-fetching.
- **`collectParts` pagination (BUG-007 regression check)**: `src/lib/upload-queue.js:23–35` correctly loops until `IsTruncated` is false, matching the BUG-007 fix.
- **Settings validation**: `SettingsPanel.handleSave` validates all numeric inputs (max keys, part concurrency, part size, file concurrency, upload expand threshold) with `isNaN` guards and range checks before saving. The listing cache TTL is a `<select>` so it cannot receive invalid input.
- **Storage security model**: Secret key goes to `sessionStorage` only; `clearCredentials()` calls `safeRemove(sessionStorage, SS_KEY_SECRET)`; `saveCredentials` writes secret key only to session storage. The provider field validates with `isValidProvider` on both read and write. These are correct.
- **`beforeunload` guard**: Correctly registered and cleaned up via `useEffect` with `hasActive` dep. The cleanup returns a function that removes the handler, preventing orphaned listeners.
