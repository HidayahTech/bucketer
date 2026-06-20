# Bug Log

A living record of real bugs encountered and resolved during development. Each entry captures the symptom, root cause, fix, why it wasn't caught earlier, and the test case it suggests. This log feeds directly into the test suite — bugs that have bitten us once should be mechanically prevented from recurring.

---

## BUG-030 — Clicking a file's checkbox did not select the file (double-toggle no-op)

**Date:** 2026-06-20

**Symptom:**
In the file browser, clicking the checkbox on a **file** row did nothing — the row did not become selected and the batch action bar did not appear. Selecting a file only worked by clicking the surrounding cell padding, not the checkbox itself. Folder-row checkboxes worked correctly. Discovered while writing the e2e batch-selection tests: Playwright reported "clicking the checkbox did not change its state."

**Root cause:**
The file-row checkbox cell wires the toggle on **both** the `<td>` and the `<input>`:

```jsx
<td class="col-check" onClick={e => toggleSelect(obj.Key, e)}>
  <input type="checkbox" checked={isSelected} onChange={e => toggleSelect(obj.Key, e)} />
</td>
```

Clicking the checkbox fires the input's `onChange` (toggle #1) **and** the click bubbles to the `<td>`'s `onClick` (toggle #2). The two `setSelectedKeys` functional updates cancel out — net no change. `toggleSelect` calls `e.stopPropagation()`, but that does not prevent the already-dispatched `change` handler from also running. The **folder** row was correct because its input carried `onClick={e => e.stopPropagation()}`, which prevents the click from reaching the `<td>` — so only one toggle fires. The file row was missing that guard.

**Fix:**
Add `onClick={e => e.stopPropagation()}` to the file-row checkbox input, matching the folder row:

```jsx
<input type="checkbox" checked={isSelected} onChange={e => toggleSelect(obj.Key, e)} onClick={e => e.stopPropagation()} />
```

Clicking the checkbox now fires `onChange` once and the click no longer bubbles to the cell — a single toggle. Clicking the cell padding (which does not hit the input) still toggles via the `<td>` handler.

**Why it wasn't caught earlier:**
No test exercised checkbox selection — component tests asserted on rendered structure, and the earlier e2e flows selected rows via action buttons, not checkboxes. The bug is also partially masked in manual use: clicking the cell area around the checkbox works, so a user who clicks slightly off-target sees selection succeed and may not notice that the checkbox glyph itself is dead.

**Test case:**
e2e (`test/e2e/browser/batch.test.mjs`): after upload, check a file row's checkbox and assert the row gains `file-row-selected` and the batch bar appears; batch-delete/move of multiple selected files reflects in real bucket state.

## BUG-029 — Upload completion teleports user to bucket root

**Date:** 2026-06-16

**Symptom:**
After uploading any file or batch of files into a subfolder, the file browser would jump back to the bucket root once the queue drained. The URL hash `?prefix=...` was wiped (via `replaceState`, so the back button did not restore the previous view), and any in-progress selection or filter was cleared. The behaviour was the same regardless of where the user had navigated *to* during the upload — uploading into `a/` then navigating to `b/` mid-upload still ended at root, not at `b/` and not at `a/`.

**Root cause:**
`App.jsx` wired `onUploadsComplete={() => setBrowserKey(k => k + 1)}` on `<UploadQueue/>`. Incrementing `browserKey` changed the `key` prop on `<Browser/>`, which forced Preact to unmount and remount the component. The remounted Browser initialised `prefix` from this branch:

```js
const [prefix, setPrefix] = useState(() => {
  if (isFirstMount) return URL_HASH_PREFIX_OR_EMPTY;
  return '';
});
```

`isFirstMount` is `browserKey === 0` — false on any remount. So the new instance always started at root, then `navigateTo('', { historyMode: 'replace' })` ran in the initial-load effect, which wiped the URL hash prefix and fetched the root listing. The remount-on-key-change mechanism was intended for genuine reset events (reconnect, disconnect, refresh-permissions); reusing it for "the upload queue drained" was overkill and surprising.

The mechanism was probably picked because it conveniently invalidates the in-memory listing cache as a side effect of unmounting. A targeted invalidate-and-refetch was already available — `handleRefresh()` and the post-rename path both use `invalidateCache(prefix); fetchPage(prefix, null, true);` — but `onUploadsComplete` did not use it.

**Fix:**
Three coordinated changes:

- `UploadQueue.jsx` accumulates the parent prefix of every successful upload in a `drainedPrefixesRef = useRef(new Set())`. When the queue drains, the ref's `Set` is passed to `onUploadsComplete(drainedSet)` and reset.
- `Browser.jsx` exposes a new action `onUploadsDrained(prefixSet)` via the `onMount` payload. It invalidates the cache entry for each affected prefix (so a later navigation back picks up the new files), and refetches the current listing only if `prefixRef.current` (a live mirror of `prefix`) is in the set.
- `App.jsx` rewires `onUploadsComplete={(prefixSet) => browserActionsRef.current?.onUploadsDrained?.(prefixSet)}`. The `setBrowserKey(k => k + 1)` call is gone.

Net effect: the user stays exactly where they are. If they were in the upload target, the listing refreshes in place. If they navigated away, only the cache for the affected prefix is invalidated — no network traffic, no visible change, and the cached stale listing is rebuilt on next visit.

**Why it wasn't caught earlier:**
- The reset-to-root behaviour worked "correctly enough" for the common case where the user uploads into a folder, watches it finish, and was about to refresh anyway. The bug only surfaces when the user navigates away mid-upload, or cares about retaining selection / filter / URL state across an upload.
- No test covered the upload → navigation interaction. Component tests stop at single-component boundaries; the App-level integration was implicit.
- The reset was buried two levels of indirection deep (`setBrowserKey` → `key={browserKey}` → `isFirstMount={browserKey === 0}` → initial-state branch in Browser) and looked like normal reconnect handling at each layer.

**Test case:**
A source-invariant assertion that `App.jsx`'s `onUploadsComplete` handler does NOT call `setBrowserKey` and DOES delegate to `browserActionsRef.current.onUploadsDrained`. Plus structural checks that `UploadQueue.jsx` accumulates parent prefixes per success and passes them to the drain callback, and that `Browser.jsx` exposes `onUploadsDrained` via `onMount`. These prevent re-introducing the remount lever for this code path without forcing the test author to also think about the prefix/selection/URL reset side effects. See `test/source-invariants.test.js` describes under "BUG-029".

---

## BUG-028 — Custom object metadata invisible to browser despite being stored on S3

**Date:** 2026-06-12

**Symptom:**
After uploading a file to Wasabi, the "File Modified" column and properties modal showed no original modification time even though the upload succeeded. The DownloadPage also showed nothing. The metadata appeared never to have been stored, but checking via server-side tools confirmed `x-amz-meta-file-mtime` was present on the object.

**Root cause:**
The CORS `ExposeHeaders` list in `corsJson()` did not include `x-amz-meta-*`. Browsers silently strip response headers not listed in `ExposeHeaders` before JavaScript can read them — this is standard CORS behaviour. The AWS SDK v3 builds `head.Metadata` by reading `x-amz-meta-*` headers from the HeadObject response; with those headers stripped, `head.Metadata` was always `{}` from the browser's perspective, making all stored custom metadata invisible. The `fetch()` call in DownloadPage suffered the same block: `response.headers.get('x-amz-meta-file-mtime')` always returned `null`.

The upload side was unaffected: `AllowedHeaders` already contained `x-amz-*`, which covers `x-amz-meta-file-mtime` as a request header, so the preflight allowed the upload and the metadata was stored correctly.

**Fix:**
Add `'x-amz-meta-*'` to `ExposeHeaders` in `corsJson()` (`src/lib/cors-config.js`). Existing bucket owners must re-apply the CORS configuration (re-run the CORS command from the Setup guide) to pick up the change.

**Why it wasn't caught earlier:**
`ExposeHeaders` is easy to overlook because the upload path (controlled by `AllowedHeaders`) and the read path (controlled by `ExposeHeaders`) are separate concerns. The feature was tested by verifying the metadata was set on upload (correct) and displayed by HeadObject in Node.js (correct), but never tested in a real browser against a cross-origin bucket, where the CORS filter applies. The `cors-config.test.js` suite tested `ExposeHeaders` for `ETag`, `Content-Length`, and `Content-Type` but had no assertion about custom metadata headers.

**Test case:**
`test/cors-config.test.js` — "exposes x-amz-meta-* so custom object metadata is readable from the browser": asserts `x-amz-meta-*` is present in `ExposeHeaders`.

---

## BUG-001 — `$` special patterns in minified bundle corrupted build output

**Date:** 2026-05-21
**Commit:** `3497da5`

**Symptom:**
Built `dist/index.html` was malformed. Fragments of the HTML template appeared in the middle of the JS bundle output, or the bundle was truncated.

**Root cause:**
`String.prototype.replace()` treats certain `$` sequences in the replacement string specially: `$&` (full match), `$'` (string after match), `` $` `` (string before match), `$1`–`$9` (capture groups). The minified JS bundle contains these sequences naturally. Passing the bundle as a string literal to `.replace()` caused the HTML template to be spliced into the JS content.

**Fix:**
Pass a function as the replacement argument instead of a string. Functions disable all `$` interpretation.

```js
// Before (broken):
html.replace('<!-- BUNDLE_PLACEHOLDER -->', `<style>${css}</style><script>${js}</script>`);

// After (correct):
html.replace('<!-- BUNDLE_PLACEHOLDER -->', () => `<style>${css}</style><script>${js}</script>`);
```

**Why it wasn't caught earlier:**
Only manifests with minified output. Development builds (`--dev`) skip minification and produce JS without `$`-heavy patterns, so the bug was invisible during development and only appeared in production builds.

**Test case:**
Build pipeline test: assert that `dist/index.html` contains a single `<script>` tag, that its content starts with the expected IIFE wrapper, and that the HTML surrounding it is intact. Can be run as a post-build assertion rather than a unit test.

**Coverage:** `test/build.test.js` — "Build output — BUG-001 (placeholder replacement)" suite.

---

## BUG-002 — esbuild defaulted to React JSX transform; app failed to render

**Date:** 2026-05-21
**Commit:** `3c49e7d`

**Symptom:**
App rendered a blank page. Console showed `ReferenceError: React is not defined`.

**Root cause:**
esbuild's default JSX transform compiles `<Component />` to `React.createElement(Component, ...)`. The project uses Preact, not React. `React` was not in scope, so every JSX expression threw immediately at runtime.

**Fix:**
Configure esbuild with `jsx: 'automatic'` and `jsxImportSource: 'preact'`, which imports from `preact/jsx-runtime` automatically.

**Why it wasn't caught earlier:**
First-time configuration error before any tests existed. Manifested immediately on first run.

**Test case:**
Build output should not contain the string `React.createElement`. The bundle should reference `preact` in its import map. Verifiable as a post-build string assertion.

**Coverage:** `test/build.test.js` — "Build output — BUG-002 (Preact JSX transform)" suite.

---

## BUG-003 — Small-file uploads failed with TypeError in AWS SDK browser handler

**Date:** 2026-05-22
**Commit:** `b231890`

**Symptom:**
All file uploads below 5 MB failed with a `TypeError`. Multipart uploads (≥ 5 MB) worked correctly.

**Root cause:**
The AWS SDK v3 browser fetch handler calls `.getReader()` on the `Body` parameter, expecting a `ReadableStream`. `File` and `Blob` objects do not have `.getReader()`. The small-file path passed the `File` object directly; the multipart path was already converting each part chunk via `.arrayBuffer()` to a raw buffer, which the SDK handles correctly.

**Fix:**
Convert the file to `Uint8Array` before passing it to `PutObjectCommand`:
```js
const body = new Uint8Array(await file.arrayBuffer());
```

**Why it wasn't caught earlier:**
The multipart path (≥ 5 MB) worked because it already did the conversion per part. The inconsistency between the two upload paths wasn't visible until small-file uploads were tested against a real bucket.

**Test case:**
Unit test for `uploadSmall`: mock the S3 client and assert that the `Body` passed to `PutObjectCommand` is a `Uint8Array`, not a `File` or `Blob`.

**Coverage:** `test/calc-part-size.test.js` — "preparePutBody" suite. The conversion is extracted to `preparePutBody()` in `src/lib/upload-queue.js`; tests assert the result is a `Uint8Array`, never a `Blob`, and that content and empty-file cases are correct.

---

## BUG-004 — Folder picker silently opened in plain file mode (Preact JSX + `webkitdirectory`)

**Date:** 2026-05-22
**Commit:** `ea57ecf`

**Symptom:**
Clicking "Choose folder" opened the OS file picker in single-file mode rather than folder selection mode.

**Root cause:**
Preact does not reliably forward non-standard boolean attributes like `webkitdirectory=""` through its JSX prop system to the underlying DOM element. The attribute was being silently dropped, so the `<input>` element never received it.

**Fix:**
Set the property directly on the DOM element via a ref callback:
```js
ref={(el) => { folderInputRef.current = el; if (el) el.webkitdirectory = true; }}
```

**Why it wasn't caught earlier:**
The JSX looked correct and raised no errors. The failure was silent — the picker just opened in the wrong mode. No console warning, no exception. Required manual testing of the folder pick flow to observe.

**Test case:**
Integration/smoke test: mount `UploadQueue`, query the folder input element, and assert `el.webkitdirectory === true`. Verifies that the property reaches the DOM regardless of JSX handling.

**Coverage:** None — requires DOM/jsdom environment to query real element properties. No automated test exists; the fix is verified by manual interaction with the folder picker.

---

## BUG-005 — Click conflicts between upload buttons and drop zone

**Date:** 2026-05-22
**Commit:** `09d6a5a`

**Symptom:**
Clicking "Choose files" or "Choose folder" also triggered the drop zone's click handler. `stopPropagation()` was not sufficient to prevent the conflict.

**Root cause:**
The buttons were nested inside the drop zone `<div>`. The event propagation path meant that even with `stopPropagation()` on the buttons, the DOM structure created implicit coupling between the button clicks and the zone's own handlers.

**Fix:**
Move the buttons outside the drop zone `<div>` entirely. The drop zone becomes a pure drag target with no click handler; each button owns its own interaction independently.

**Why it wasn't caught earlier:**
The initial structure seemed logical — upload controls grouped visually with the drop zone. The event conflict only became apparent during interactive testing.

**Test case:**
Verify DOM structure: assert that the "Choose files" and "Choose folder" buttons are not descendants of the drop zone element.

**Coverage:** None — requires DOM/jsdom to inspect element ancestry. No automated test exists; the fix is verified by code review of the component structure.

---

## BUG-006 — Copy button in SetupGuide submitted parent credential form

**Date:** 2026-05-21
**Commit:** `631d2c6`

**Symptom:**
Clicking the "Copy" button on a code block in the CORS setup guide triggered a connection attempt, as if the Connect button had been clicked.

**Root cause:**
The copy button was inside a `<form>` element (the credential form). HTML buttons default to `type="submit"` when no `type` attribute is set. Clicking the button submitted the form.

**Fix:**
Add `type="button"` to the copy button.

**Why it wasn't caught earlier:**
The default `type="submit"` behavior is easy to miss because buttons look and feel interactive regardless. Only manifested when the setup guide was rendered inside the credential form context.

**Test case:**
Assert that every `<button>` element inside `SetupGuide` has an explicit `type` attribute. No button inside a form should rely on the default.

**Coverage:** `test/source-invariants.test.js` — "SetupGuide — every `<button>` has explicit type (BUG-006)". Reads SetupGuide.jsx source directly and fails if any `<button>` is missing a `type=` attribute.

---

## BUG-007 — `ListParts` pagination incomplete in resume flow

**Date:** 2026-05-21
**Commit:** `c8d26d2`

**Symptom:**
For files larger than approximately 5 GB (> 1000 parts at 5 MB each), resuming an interrupted upload would re-upload already-completed parts and then fail at `CompleteMultipartUpload`.

**Root cause:**
`ListParts` paginates at 1000 parts per response. The resume flow fetched only the first page, missing all completed parts beyond part 1000. When uploading remaining parts, the "remaining" set included parts that were actually already done. `CompleteMultipartUpload` then received a malformed parts list (duplicate or inconsistent ETags) and failed.

**Fix:**
Loop `ListParts` until `IsTruncated` is false, accumulating all completed parts before computing what remains.

**Why it wasn't caught earlier:**
Requires a file > 5 GB with default 5 MB parts (> 1000 parts) to trigger. Not exercised in normal development testing. The failure mode was also non-obvious — the symptom looked like a `CompleteMultipartUpload` bug rather than a missing-pagination bug.

**Test case:**
Unit test for the resume flow: mock `ListParts` to return two pages (IsTruncated=true on first call, false on second), assert that `UploadPartCommand` is only called for part numbers not present across both pages.

**Coverage:** `test/collect-parts.test.js` — "collectParts — pagination" suite tests the extracted `collectParts()` function with mock clients for two-page and three-page responses.

---

## BUG-008 — Content hash not persisted in resume record (ordering bug)

**Date:** 2026-05-21
**Commit:** `7769395`

**Symptom:**
Resume hash verification was silently skipped on every resume attempt, even when a hash should have been present. File identity checks fell back to name/size/lastModified only.

**Root cause:**
The content hash was being computed *after* `saveResumeRecord()` was called. The record was saved without the hash, and the async hash computation result was never written back. The code read as if the hash was included, but the ordering meant it never was.

**Fix:**
Compute the hash before calling `saveResumeRecord()`, so the field is populated when the record is written.

**Why it wasn't caught earlier:**
The code path looked correct at a glance — `computeFileHash` was called nearby and its result assigned to `fileIdentity.contentHash`. The async ordering bug was subtle. No error was thrown; hash verification was just silently absent.

**Test case:**
After calling the upload initiation flow with a mock file, load the resume record from IndexedDB and assert that `fileIdentity.contentHash` is present and non-null.

**Coverage:** `test/indexeddb-storage.test.js` — "buildFileIdentityWithHash" suite verifies that `contentHash` is present, deterministic, and content-sensitive. The extracted `buildFileIdentityWithHash()` function in `src/lib/indexeddb.js` ensures the hash is always added before the record is saved.

---

## BUG-009 — Permission errors on multipart uploads left orphaned sessions

**Date:** 2026-05-21
**Commit:** `7769395`

**Symptom:**
When a multipart upload failed due to a permission error (`AccessDenied` / 403), the IndexedDB resume record was retained. On the next upload attempt to the same destination, the app offered to resume an upload that could never succeed with the current credentials.

**Root cause:**
The failure handling distinguished transient failures (network errors — keep resume record for retry) from non-resumable failures (UploadId expired — clear record), but permission errors were not treated as non-resumable. A permission error is permanent for the current credentials — there is nothing to resume.

**Fix:**
On `isPermissionError`, call `AbortMultipartUpload` and clear the IndexedDB resume record immediately, in addition to updating the capability state.

**Why it wasn't caught earlier:**
The happy path (successful upload) and the transient failure path (network error + resume) were both tested manually. The permission-error-during-multipart path was not explicitly exercised.

**Test case:**
Mock a multipart upload that fails with a 403 on `UploadPartCommand`. Assert that `AbortMultipartUploadCommand` is sent and that the IndexedDB resume record is deleted.

**Coverage:** None — requires a Preact component harness with a mock S3 client and fake-indexeddb wired through component props. The logic is embedded in the `UploadQueue` component's error handler. No automated test exists; verified by code review and the `isPermissionError` function is unit-tested indirectly via `test/format.test.js`.

---

## BUG-010 — Batch uploads triggered `NS_BINDING_ABORTED` cascade

**Date:** 2026-05-22
**Commit:** `7e68cd1`

**Symptom:**
Uploading many small files produced a flood of `NS_BINDING_ABORTED` errors in the browser console. The listing occasionally showed incorrect or incomplete results after a batch.

**Root cause:**
Each file completion called `onUploadsComplete`, which incremented `browserKey` and re-mounted the `Browser` component. Each re-mount issued a new `ListObjectsV2` request, aborting any in-flight listing or its `OPTIONS` preflight. With many files completing in rapid succession, this created a cascade of aborted requests.

**Fix:**
Debounce the `browserKey` increment by 1500ms so that rapid completions coalesce into a single Browser re-mount after the burst settles.

**Why it wasn't caught earlier:**
Single-file uploads worked correctly. The cascade only appeared with batches of many small files completing faster than the listing could complete.

**Test case:**
Simulate N rapid calls to `onUploadsComplete` within a short window. Assert that `browserKey` is incremented only once (or at most twice) rather than N times.

**Coverage:** None — the debounce timer is internal to `App.jsx` component state. Requires mounting Preact components in jsdom. No automated test exists; verified by manual batch upload testing.

---

## BUG-011 — Listing refreshed per-file during batch, causing flickering

**Date:** 2026-05-22
**Commit:** `3d5c70e`

**Symptom:**
The file listing visually flickered and re-fetched multiple times during a batch upload, once per completed file.

**Root cause:**
`onUploadsComplete` was wired to fire on every transition of the `items` array, not just when the queue fully drained. Any state change (including a single file completing mid-batch) triggered a full Browser re-mount.

**Fix:**
Track a `hadActiveRef` boolean. Fire `onUploadsComplete` only when transitioning from "had active uploads" to "no active uploads" — i.e., when the queue fully drains.

**Why it wasn't caught earlier:**
Single-file uploads behaved identically under both implementations. The difference was only observable with concurrent multi-file batches.

**Test case:**
Simulate a queue of three files completing sequentially. Assert `onUploadsComplete` is called exactly once — after the third file, not after each one.

**Coverage:** None — `hadActiveRef` drain detection is internal to the `UploadQueue` component. Requires mounting Preact components in jsdom. No automated test exists; verified by manual batch upload testing.

---

## BUG-012 — `DELETE` missing from CORS `AllowedMethods`; delete operations failed on B2

**Date:** 2026-05-21
**Commit:** `938c3d3`

**Symptom:**
Delete operations failed on Backblaze B2 with a CORS preflight `403`. The delete button appeared to do nothing, and the browser console showed a CORS error on the `OPTIONS` request.

**Root cause:**
The CORS configuration template in `SetupGuide.jsx` included `GET`, `PUT`, `HEAD`, and `POST` in `AllowedMethods` but not `DELETE`. B2's CORS enforcement rejected the `OPTIONS` preflight for delete requests because the method wasn't whitelisted.

**Fix:**
Add `DELETE` to the `AllowedMethods` array in the CORS template.

**Why it wasn't caught earlier:**
Delete was implemented after the initial CORS guide was written. The guide wasn't updated to reflect the new operation's requirements. The symptom looked like a general CORS misconfiguration rather than a missing method.

**Test case:**
Assert that the CORS JSON generated by `corsJson()` in `SetupGuide.jsx` includes `'DELETE'` in `AllowedMethods`.

**Coverage:** `test/cors-config.test.js` — "corsJson — AllowedMethods (BUG-012)" suite. `corsJson()` has been extracted to `src/lib/cors-config.js`.

---

## BUG-013 — Shared URL params leaked connection details to server via query string

**Date:** 2026-05-22
**Commit:** `cb95ae1`

**Symptom:**
Endpoint URL, bucket name, provider, and current prefix appeared in the server's HTTP access logs when a shareable link was opened. Anyone with access to the server logs could observe connection configuration.

**Root cause:**
Shareable link parameters and the prefix navigation state were encoded in the URL query string (`?endpoint=...&bucket=...`). Browsers include the query string in the HTTP request path, which is logged by web servers. The hash fragment (`#`) is never sent to the server.

**Fix:**
Move all URL params (endpoint, bucket, provider, region, prefix) to the hash fragment.

**Why it wasn't caught earlier:**
Privacy implication of query string vs hash fragment is easy to overlook when focused on functionality. The behavior worked correctly from the user's perspective; the leak was only visible in server logs.

**Test case:**
Assert that `buildShareUrl()` returns a URL where all parameters appear after `#`, not in the `?` query string. Assert that no parameter key appears before the `#`.

**Coverage:** `test/url-params.test.js` — "buildShareUrl" suite, first test: "all params appear in the hash fragment, never the query string (BUG-013)".

---

## BUG-014 — Missing `useRef` import caused blank screen after refactor

**Date:** 2026-05-28
**Commit:** `f82352b`

**Symptom:**
App rendered a completely blank page after a refactor to `App.jsx`. No visible error in the UI; browser console showed `ReferenceError: useRef is not defined`.

**Root cause:**
`useRef` was added to `App.jsx` during a refactor but not added to the import statement from `preact/hooks`. Named imports must be explicitly listed.

**Fix:**
Add `useRef` to the import: `import { useState, useEffect, useCallback, useRef } from 'preact/hooks';`

**Why it wasn't caught earlier:**
No static analysis or linting configured to catch missing imports. The blank screen is a total failure but gives no actionable UI feedback.

**Test case:**
This class of bug is best caught by a linter (ESLint with `no-undef` or TypeScript). As a test: a smoke test that mounts `<App />` in a jsdom environment and asserts it renders without throwing would catch this immediately. Alternatively, assert at the source level that all hooks used in App.jsx are present in the preact/hooks import statement.

**Coverage:** `test/source-invariants.test.js` — "App.jsx — required hooks imported from preact/hooks (BUG-014)". Reads App.jsx source and asserts that `useState`, `useEffect`, `useCallback`, and `useRef` are all present in the import.

---

## BUG-015 — B2 multipart session expiry incorrectly assumed to match R2

**Date:** 2026-05-21
**Commit:** `2791f8a`

**Symptom:**
B2 users saw an "upload session may be approaching expiry" warning banner for long-running uploads, even though B2 sessions don't expire automatically.

**Root cause:**
A single `UPLOAD_EXPIRY_WARNING_MS` constant (7 days) was applied to all providers. R2 auto-expires incomplete multipart sessions after 7 days (documented). B2 does not expire them automatically — they persist until explicitly aborted or a lifecycle rule triggers. The warning was factually incorrect for B2.

**Fix:**
Replace the constant with a provider-aware function `uploadExpiryWarningMs(provider)` that returns `null` for B2 (no warning) and 7 days for R2 and others.

**Why it wasn't caught earlier:**
Provider-specific behavior was not confirmed before implementation. The assumption that B2 matched R2 was wrong and only surfaced when researching Q1 explicitly.

**Test case:**
Assert `uploadExpiryWarningMs('b2') === null`. Assert `uploadExpiryWarningMs('r2') === 7 * 24 * 60 * 60 * 1000`. Assert `uploadExpiryWarningMs('generic')` returns the same 7-day value as R2.

**Coverage:** `test/indexeddb-pure.test.js` — "uploadExpiryWarningMs" suite.

---

## BUG-016 — Corrupted `s3b_provider` promoted into profile name; credential pipeline had no write-boundary enforcement

**Date:** 2026-06-03
**Commit:** (v1.13.1)

**Symptom:**
After upgrading to v1.13.0, the profile picker on the connect screen displayed a garbled profile name containing credential text (key ID, secret key value, and instructional prose including "Use the above credentials to login. Navigate to Week 7.") instead of a normal connection name like "B2 — anwar-al-tafsir-storage".

**Root cause:**
`s3b_provider` in localStorage contained the string `"b2Key ID: <key-id>Secret Key: [REDACTED]Use the above credentials to login. Navigate to Week 7."` — credentials text that had been concatenated onto the provider identifier at some prior point (most likely a paste accident from a B2 dashboard credentials page, or residue from an older version of the app).

This corruption had three compounding effects:

1. **Perpetuation.** Every app load read the corrupted value via `loadCredentials()` with no validation, passed it through `handleConnect()`, and wrote it straight back via `saveCredentials()`. The corruption was self-reinforcing — it could never be auto-corrected.

2. **URL propagation.** `buildShareUrl()` included `credentials.provider` in the hash fragment verbatim. Any share link generated while the corruption was present would have embedded the credentials text in the URL.

3. **Migration amplification.** The v1.13.0 `migrateProfilesFromLegacy()` read `s3b_provider`, called `.toUpperCase()` on it to produce the `providerLabel`, and concatenated it into the profile `name` field: `"B2KEY ID: <KEY-ID>SECRET KEY: [REDACTED]USE THE ABOVE CREDENTIALS TO LOGIN. NAVIGATE TO WEEK 7. — anwar-al-tafsir-storage"`. The profile `provider` field was also stored verbatim. What had been a hidden corruption became a prominently displayed one.

The `provider` field is purely an internal enum (`'b2'`, `'r2'`, `'aws'`, `'wasabi'`, `'do_spaces'`, `'minio'`, `'generic'`). It has only seven valid states. No code anywhere in the pipeline enforced this.

**Fix (five layers):**

1. `repairStorageInvariants()` — retroactive cleanup: clears `s3b_provider` if it contains whitespace or exceeds 20 chars; repairs stored profiles with a corrupted `provider` field by setting `provider: null` and regenerating the name from bucket. Runs on every mount; idempotent no-op once data is clean.

2. `loadCredentials()` — sanitize on read: validates `provider` against `isValidProvider()`; returns `null` for any value that fails so corrupted data is never placed into app state.

3. `saveCredentials()` — sanitize on write: validates `provider` before writing; writes `''` if the value is invalid so the corruption cannot be re-persisted.

4. `readUrlParams()` — validates `provider` from the URL hash before accepting it; ignores any value containing whitespace or exceeding 20 chars, closing the URL propagation vector.

5. `CredentialForm` — inline validation errors shown as the user types: blocks submit if key ID, secret key, or bucket contain whitespace; warns if bucket exceeds 63 characters. Machine-generated S3 credentials never contain spaces; a space in any of these fields is unambiguous evidence of a paste error.

**Why it wasn't caught earlier:**
The `provider` field is set by a `<select>` dropdown in the UI, so it was implicitly assumed to always be one of the known enum values. This assumption did not account for: URL hash params (which accept free text), older app versions (which may have stored things differently), or direct localStorage access. No invariant was enforced at any layer — not at the read boundary, not at the write boundary, and not in the migration. The app treated localStorage as a trusted store rather than as external, potentially-corrupted input.

The broader principle: any data read from localStorage, URL params, or user input must be validated at the boundary where it enters the system. Trusting stored values because the code that wrote them was "our code" is a form of confused deputy — the store outlives any individual code version.

**Test cases:**
- `repairStorageInvariants` clears a corrupted `s3b_provider` value
- `repairStorageInvariants` fixes a profile whose `provider` field contains spaces
- `loadCredentials` returns `null` for provider when stored value fails the identifier check
- `saveCredentials` writes `''` for provider when passed an invalid value; round-trip returns `null`
- `readUrlParams` ignores a `provider` hash param that contains spaces or exceeds 20 chars
- CredentialForm `credentialErrors` returns an error for key ID containing a space
- CredentialForm `credentialErrors` returns an error for bucket containing a space or exceeding 63 chars

**Coverage:** `test/storage.test.js` — "repairStorageInvariants", "saveCredentials — provider write-boundary validation", "loadCredentials — provider read-boundary validation", "migrateProfilesFromLegacy" suites. `test/url-params.test.js` — "readUrlParams" suite (provider with spaces ignored, provider > 20 chars ignored). `test/credential-form-validation.test.js` — full `credentialErrors` coverage for bucket, keyId, secretKey, regionOverride.

---

## BUG-017 — Saved profile did not pre-fill credential form after disconnect

**Date:** 2026-06-03
**Commit:** (v1.13.2)

**Symptom:**
After disconnecting and returning to the connect screen, the profile picker correctly highlighted the last-used profile (shown in blue), but clicking it did not populate any form fields — all inputs remained blank. The user had to type all credentials manually despite having saved them.

**Root cause:**
In `App.jsx`, `credentials` was declared as the second `useState` call and `selectedProfileId` as the sixteenth. JavaScript executes `useState` initializers in declaration order. The `credentials` initializer called `loadCredentials()`, which returns empty strings after `clearCredentials()` runs on disconnect. Because `selectedProfileId` hadn't been initialized yet at that point, the initializer had no way to look up and seed the form from the saved profile.

When the user clicked the already-selected profile, `handleSelectProfile` called `setCredentials({...profile})` and `setSelectedProfileId(id)` with the same ID. Since the key on `<CredentialForm>` is `selectedProfileId`, and the ID didn't change, Preact did not remount the form — so its internal `useState` (seeded from `initial` only on mount) remained empty.

**Fix:**
Move `selectedProfileId` declaration before `credentials`. Update the credentials initializer to call `loadLastProfileId()`, find the matching profile in `loadProfiles()`, and use it as the base if found. Update the mount `useEffect` to use the same lookup order for the auto-connect check.

**Why it wasn't caught earlier:**
The state initialization ordering issue only manifests after a disconnect (which calls `clearCredentials()`). In a fresh session where credentials are still in localStorage, `loadCredentials()` returns the full credential set and the form populates normally. The multi-profile feature was new in v1.13.0 and this specific post-disconnect path was not exercised during testing.

**Test case:**
A source-level assertion: `selectedProfileId` must appear before `credentials` in the `useState` declarations in App.jsx. If the order is ever reversed, the credentials initializer silently loses access to the saved profile and the form loads empty.

**Coverage:** `test/source-invariants.test.js` — "App.jsx — selectedProfileId declared before credentials (BUG-017)". Reads App.jsx source, finds the character offset of both state declarations, and asserts the profile ID declaration comes first.

---

## BUG-018 — "Save as profile…" button stayed disabled even with all fields filled

**Date:** 2026-06-03
**Commit:** v1.13.7

**Symptom:**
The "Save as profile…" button remained disabled no matter what values were typed into the credential form, preventing profile creation without first connecting.

**Root cause:**
`canSaveProfile` in `ProfilePicker` was called with `currentFormData={credentials}`, where `credentials` is App-level state that only updates when the user submits the form via Connect. While the user was typing, `CredentialForm` held all values in its own local `useState` and never propagated them to App. `ProfilePicker` always saw the stale pre-connection (often empty) credentials, so `canSaveProfile` always returned `false`.

**Fix:**
Add an `onFormChange` prop to `CredentialForm` that fires on every field input with the current form values. In `App.jsx`, introduce `liveFormData` state (initialized from `credentials`) updated by `onFormChange`. Pass `liveFormData` to `ProfilePicker` instead of `credentials`. Also sync `liveFormData` in `handleSelectProfile` so selecting a profile immediately enables the button.

**Why it wasn't caught earlier:**
The profile save button was added alongside `canSaveProfile` in the same commit (v1.13.4). The validation logic was correct but the data source was wrong — testing against a live browser would have revealed it immediately, but the issue was not caught in code review because `credentials` being stale before Connect was not an obvious invariant to check.

**Test case:**
A DOM-level integration test would be needed to fully cover this (render the form, type into fields, assert button enables). Not currently practical without a test renderer. The fix is covered by code inspection: `ProfilePicker` must receive `liveFormData`, not `credentials`.

**Coverage:** No automated test (DOM-dependent). Fix is structural — `currentFormData` prop on `ProfilePicker` is now always `liveFormData` in App.jsx.

---

## BUG-019 — Wasabi bare endpoint `s3.wasabisys.com` not auto-detected as us-east-1

**Date:** 2026-06-03
**Commit:** v1.13.6

**Symptom:**
Entering `https://s3.wasabisys.com` as the endpoint (Wasabi's legacy default endpoint) showed "Cannot be auto-detected for this endpoint" and displayed an empty region input, forcing the user to type the region manually.

**Root cause:**
`extractRegion` for Wasabi matched only the pattern `^s3\.([^.]+)\.wasabisys\.com$` (region embedded in subdomain, e.g. `s3.us-east-1.wasabisys.com`). The bare legacy hostname `s3.wasabisys.com` has no region segment, so the regex returned `null`. Wasabi's official documentation lists `s3.wasabisys.com` as the primary endpoint for US East 1 (Virginia), equivalent to `s3.us-east-1.wasabisys.com`.

**Fix:**
Add a special case before the regex: if the host is exactly `s3.wasabisys.com`, return `'us-east-1'`. Source: https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions

**Why it wasn't caught earlier:**
The existing Wasabi test only exercised the region-in-subdomain form (`s3.us-east-1.wasabisys.com`). The bare legacy endpoint was not in the test suite and was only discovered when a user tried it in practice.

**Test case:**
`extractRegion('https://s3.wasabisys.com', PROVIDERS.WASABI)` must return `'us-east-1'`.

**Coverage:** `test/provider.test.js` — "Wasabi: bare s3.wasabisys.com resolves to us-east-1 (legacy default endpoint)".

---

## BUG-020 — Saving a profile before connecting stored empty values and cleared the form

**Date:** 2026-06-03
**Commit:** v1.13.9

**Symptom:**
Filling in the credential form and clicking "Save as profile…" appeared to work (a profile was created with the chosen name), but the saved profile contained no data. Immediately after saving, all form fields cleared, as if the form had been reset.

**Root cause:**
`handleSaveProfile` in `App.jsx` built the profile object from `credentials` state, not `liveFormData`. Since `credentials` only updates when the user connects, it was empty for a user who hadn't connected yet. The profile was saved with blank endpoint, bucket, and key ID.

The form clearing was a second consequence of the same bug: saving the profile called `setSelectedProfileId(profile.id)`, changing the `key` prop on `<CredentialForm key={selectedProfileId}>`. Preact treated this as a new component instance and remounted it with `initial={credentials}` — which was still empty — wiping everything the user had typed.

**Fix:**
`handleSaveProfile` now reads from `liveFormData` to build the profile (mapping `providerOverride` → `provider` and applying the same trim/trailing-slash cleanup as `handleSubmit`). After saving, `credentials` and `liveFormData` are both synced to the saved profile data (plus secretKey from `liveFormData`) so the remount that follows the key change initializes with the correct values.

**Why it wasn't caught earlier:**
The profile save flow was only tested in the connected state in earlier development (where `credentials` is already populated). The pre-connect save path — added in v1.13.4 when the save button was gated on `canSaveProfile` — was not exercised before shipping.

**Test case:**
A DOM-level integration test would be needed (fill form, save profile, assert profile contains correct values and form is not cleared). Not currently practical without a test renderer.

**Coverage:** No automated test (DOM-dependent). Fix verified by manual testing.

---

## BUG-021 — Page completely frozen: Firefox terminated Preact VDOM diff of 15 000+ UploadLog rows

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
After a large upload session (15 521 files in upload history), the entire page became unresponsive. Buttons did not respond. Dragging files caused the browser to try to open them instead of uploading. The tab appeared fully loaded (no spinner). Firefox DevTools console showed: `Script terminated by timeout` with a stack trace rooted in Preact's VDOM diff functions (`diffElementNodes`, `diffChildren`, `diff`) repeating dozens of frames deep, entered from the `UploadQueue` task runner (`_drain`).

**Root cause:**
`UploadQueue._drain()` dispatches upload tasks as microtasks. Each task completion called `updateItem` → `setItems` → Preact state flush. Preact flushes synchronously from within a microtask, running a full VDOM diff of the entire component tree before yielding. With 15 521 `<tr>` rows × 7 cells = 108 647 virtual nodes, each diff took several seconds of wall-clock time. Firefox's script timeout (not CPU-based, fires after ~10 s of wall-clock JS execution) fired during the diff and terminated the script. Because Preact's event delegation was in a crashed state, all subsequent clicks and drags were silently lost at the DOM level.

Compounding factor: `UploadLog` used `key={i}` (array index). When a new entry was prepended, all keys shifted by 1, forcing Preact to patch every row instead of inserting one node.

**Fix:**
- Cap `UploadLog` to render at most `MAX_DISPLAY = 200` rows (newest first). Summary stats (total bytes, error count) still computed from all loaded entries.
- Changed row key from `key={i}` (array index) to `key={e.completedAt != null ? \`${e.completedAt}_${i}\` : i}` so Preact can add/remove a single node per new entry instead of re-keying the entire list.
- Added truncation notice: "Showing most recent 200 of N uploads. Clear the log to reset."

**Why it wasn't caught earlier:**
The freeze only manifests at scale (thousands of entries). Normal testing involved small upload batches. The symptom (frozen page, browser opens files on drag) did not point to a Preact rendering issue — it looked like an event-handling or queue bug. The stack trace was the key diagnostic.

**Test case:**
Render performance regressions of this kind are not mechanically testable in the current unit suite. The cap itself is an implicit safeguard: the rendered node count is now bounded at `MAX_DISPLAY × 7` regardless of history size.

**Coverage:** No automated test. Mitigated by `MAX_DISPLAY` cap. Stable key fix is a correctness improvement that also helps.

---

## BUG-022 — UploadLog panel popped in and out during active uploads

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
While uploads were in progress, the Upload History section repeatedly disappeared and reappeared, causing the page to jump. Each time a new upload completed, the panel would flash out then back in.

**Root cause:**
`UploadLog` had a `loading` boolean state initialised to `true`. Every time `refreshKey` incremented (triggered by each upload completion via `onLogEntry`), the `useEffect` set `loading = true` before fetching from IndexedDB. The render guard `if (loading || entries.length === 0) return null` caused the component to unmount on every refresh cycle, even though entries already existed. The panel disappeared for the round-trip to IndexedDB and reappeared once data loaded.

**Fix:**
Replaced `loading` with `initialLoadDone` (starts `false`, set to `true` once on first load, never reset). The render guard became `if (!initialLoadDone || entries.length === 0) return null`. Subsequent refreshes update `entries` in place; the component stays mounted and its contents update without any unmount/remount.

**Why it wasn't caught earlier:**
Observed only when upload history was large enough to be visible while uploads were still in progress. In early testing, uploads finished before the log section rendered.

**Test case:**
A DOM-level integration test: render `UploadLog` with an initial `refreshKey`, simulate two increments in quick succession, assert the component never returns `null` between increments if entries are already present.

**Coverage:** No automated test (DOM-dependent). Fix verified by manual testing.

---

## BUG-023 — Re-dragging a cancelled folder showed all files as "Paused"

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
After cancelling an in-progress folder upload and dragging the same folder into the upload zone again, every file immediately appeared with status "Paused — resume record found" rather than starting fresh. The user had to manually click Restart on each file.

**Root cause:**
`handleCancelBatch` aborted in-flight multipart sessions via `AbortMultipartUploadCommand` but did not call `deleteResumeRecord`. The IndexedDB resume records from the original (now-cancelled) upload survived. On the re-drag, `enqueueUpload` found those stale records for each file and set status to `paused` to prompt the user for a Resume/Restart choice — the correct behaviour for a genuine interrupted session, but wrong when the session was intentionally cancelled.

**Fix:**
Added `deleteResumeRecord(...)` calls inside `handleCancelBatch` alongside the existing `AbortMultipartUploadCommand` calls — one per item that had an active or paused multipart session. Both calls are fire-and-forget (`.catch(() => {})`); failure to delete a record is non-fatal and the user can still Restart.

**Why it wasn't caught earlier:**
The cancel path was tested for single-file cancels (`handleCancel`) which always called `deleteResumeRecord`. The batch-cancel path (`handleCancelBatch`) was added later and the resume-record cleanup was not carried over.

**Test case:**
Unit test for `handleCancelBatch`: mock an item with a `resumeRecord`, call cancel, assert `deleteResumeRecord` was called. Not currently in the suite.

**Coverage:** No automated test. Fix verified by manual testing.

---

## BUG-024 — Cancel during `loadResumeRecord` async gap overwrote "aborted" status with "paused"

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
Cancelling a batch immediately after dropping files could leave some items stuck in "Paused" status even though the cancel appeared to have fired. Affected items were those where `enqueueUpload` was suspended awaiting `loadResumeRecord` at the moment `handleCancelBatch` ran.

**Root cause:**
`enqueueUpload` calls `await loadResumeRecord(...)` before checking `cancelledBatchesRef`. The function is suspended at this `await`. If `handleCancelBatch` fires during this gap — adding `batchId` to `cancelledBatchesRef` and setting in-queue items to `aborted` — the items are correctly marked. But when `loadResumeRecord` resolves, the continuation of `enqueueUpload` ran past the cancellation check (which only existed further down, inside `queueRef.current.enqueue`), reached `if (existingRecord) { updateItem(..., { status: 'paused' }) }`, and overwrote the `aborted` status set by the cancel.

**Fix:**
Added a guard immediately after the `await loadResumeRecord(...)` line:
```js
if (cancelledBatchesRef.current.has(item.batchId)) return;
```
This mirrors the guard already present inside the queued task and covers the async gap before it.

**Why it wasn't caught earlier:**
The race window is narrow (only items that happen to be suspended in the `await` at the exact moment of cancel). Reproducing it required cancelling very quickly after drop, before the IndexedDB lookup resolved.

**Test case:**
Unit test: call `enqueueUpload` with a mock `loadResumeRecord` that delays, fire `handleCancelBatch` during the delay, assert the item remains `aborted` after the delay resolves. Not currently in the suite.

**Coverage:** No automated test. Fix verified by manual testing.

---

## BUG-025 — Upload silently fails with cryptic network error when blocked by a browser extension

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
Uploading a file whose destination path matched an ad-block filter rule (e.g., `server/analytics/analytics.js`) failed immediately with status 0, time 0, and no response headers. The error displayed in Bucketer was a raw `TypeError` ("NetworkError when attempting to fetch resource.") with no indication of the cause. The user had uBlock Origin active in Firefox.

Note: this is not a bug in Bucketer's logic — the request was legitimate and correctly formed. The failure is external. It is recorded here because the UX consequence (opaque error, no recovery path surfaced) was indistinguishable from a genuine network failure.

**Root cause:**
Browser content-blocking extensions (uBlock Origin, AdBlock Plus, etc.) intercept `fetch()` calls at the browser `webRequest` API level, before the request reaches the network. The interception is silent: no CORS preflight fires, no HTTP response is returned, and the browser raises a `TypeError` with a browser-specific message. In Firefox this is "NetworkError when attempting to fetch resource."; Chrome produces "Failed to fetch"; Safari produces "Load failed". The AWS SDK receives this as an unclassified network error and rethrows it. Bucketer's error display showed the raw JSON-serialised error with no context.

The filter match that triggered this was the filename `analytics.js` in the upload path, which is a common target in EasyPrivacy and similar filter lists.

**Fix:**
Added `isBlockedByExtension(err)` to `src/lib/format.js`. It returns `true` when: the error is a `TypeError`, it has no `$metadata.httpStatusCode` (ruling out genuine HTTP responses), and its message matches one of the three browser-specific strings. When the check passes, `UploadItem` renders a yellow warning banner above the technical error detail explaining that a browser extension may have blocked the request and offering two concrete remedies: disable the extension for the page, or add the destination domain to its allowlist.

**Why it wasn't caught earlier:**
Requires both a content blocker and a file whose upload URL matches a filter rule — a combination unlikely to appear in normal development testing. The failure mode is also easy to misread as a network or CORS issue.

**Test case:**
`isBlockedByExtension` has unit tests in `format.test.js` covering the Firefox, Chrome, and Safari error strings, a TypeError with an HTTP metadata response (must not trigger), a non-TypeError with the same message (must not trigger), a real S3 error (must not trigger), and null/undefined inputs.

**Coverage:** `isBlockedByExtension` fully covered by unit tests. The banner render is DOM-dependent and verified by manual testing.

---

## BUG-026 — Profile load resets region inference: changing endpoint leaves region stale

**Date:** 2026-06-07
**Commit:** v1.15.6

**Symptom:**
After loading a saved profile (e.g. B2 `us-west-004`), changing the Endpoint URL to a different B2 region (e.g. `eu-central-003`) left the Region field stuck at the old value (`us-west-004`). The "Auto-filled from endpoint URL" hint also disappeared on load. The stale region would then be sent to the S3 client on connect, causing an authentication failure against the new endpoint.

**Root cause:**
`CredentialForm.jsx` computes `_initExtractedRegion` (what the endpoint would give for a region) only when `initial.regionOverride` is absent:

```js
const _initExtractedRegion = (() => {
  if (initial.regionOverride || !initial.endpoint) return null;  // ← bailed early
  ...
})();
```

Because `_initExtractedRegion` was always `null` when a profile stored a region, the `userEditedRef` comparison `initial.regionOverride !== _initExtractedRegion` was always `true`, marking the region as user-edited regardless of whether the stored value matched extraction. With `ue.region = true`, the `applyChange` endpoint→region inference branch was skipped on every subsequent keypress.

The comment above `userEditedRef` correctly described the *intent* ("a stored value that matches auto-extraction is treated as inferred") but the code never reached the comparison to check this.

**Fix:**
Remove `initial.regionOverride ||` from the `_initExtractedRegion` bail condition so extraction always runs when an endpoint is present. The existing comparison then correctly evaluates to `false` when the stored region matches extraction, setting `ue.region = false` and restoring inference. Also updated `_infRegion` to `true` in the matching case so the "Auto-filled from endpoint URL" hint is shown.

```js
// Before:
if (initial.regionOverride || !initial.endpoint) return null;
// After:
if (!initial.endpoint) return null;
```

```js
// Before:
_infRegion: !!(_initExtractedRegion && !initial.regionOverride),
// After:
_infRegion: !!(_initExtractedRegion &&
               (!initial.regionOverride || initial.regionOverride === _initExtractedRegion)),
```

**Why it wasn't caught earlier:**
The bug only manifests when a profile is loaded from storage (not when filling the form fresh). The inference tests in `provider.test.js` cover `extractRegion` in isolation. No test exercised the CredentialForm's `userEditedRef` initialization path with a pre-populated `regionOverride`.

**Test case:**
Structural: assert in `source-invariants.test.js` that `_initExtractedRegion` in `CredentialForm.jsx` does not include `initial.regionOverride` in its bail condition. Or integration: mount CredentialForm with `initial = { endpoint: B2_ENDPOINT, regionOverride: B2_REGION }`, simulate an endpoint change to a different B2 region, and assert the region field updates.

**Coverage:** No automated test. Fix verified by runtime observation: loading the "B2 Test" profile, changing endpoint from `us-west-004` to `eu-central-003`, confirmed region field updated to `eu-central-003` with "Auto-filled from endpoint URL" hint.

---

## BUG-027 — Post-disconnect: form is blank despite profile still highlighted

**Date:** 2026-06-07
**Commit:** v1.15.6

**Symptom:**
After disconnecting, the credential form went blank (all fields empty) even though the last-used profile remained highlighted in the profile list. Clicking the highlighted profile row had no effect — the form stayed empty. To recover, the user had to select a different profile and back, or reload the page.

**Root cause:**
`handleDisconnect` reset `credentials` state to all-empty but did not update `selectedProfileId` (intentional — the user's last profile stays selected across sessions) or `liveFormData`. The splash `CredentialForm` then mounted with `initial={empty credentials}`, showing blank fields.

The highlighted profile row was unclickable because `handleSelectProfile(id)` called `setSelectedProfileId(id)` with the same value already in state — React bails out on same-value state updates, the key (`selectedProfileId ?? 'manual'`) didn't change, and the CredentialForm wasn't remounted. `initial` prop changes don't re-initialize a component's `useState`.

**Fix:**
In `handleDisconnect`, repopulate `credentials` and `liveFormData` from the selected profile (minus secret key) instead of clearing to empty. The CredentialForm then mounts with the profile's endpoint/bucket/keyId visible; the user only needs to enter the secret key to reconnect. No behavior change for users with no saved profiles — those still see an empty form.

**Why it wasn't caught earlier:**
The bug is only observable in a live session after connecting and disconnecting. The unit and structural tests have no coverage of App-level state transitions. The pattern of "same-value setState is a no-op" is easy to miss when the component tree has just remounted (connected → disconnected transitions swap the entire layout).

**Test case:**
Integration: simulate `handleDisconnect` with a selected profile in state, assert `credentials` equals the profile data (minus secret key) and `liveFormData` matches. Or structural: assert `handleDisconnect` calls `setLiveFormData` and that `setCredentials` is not called with all-empty values when a profile is selected.

**Coverage:** No automated test. Fix verified by code review and runtime analysis.
