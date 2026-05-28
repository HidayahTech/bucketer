# Bug Log

A living record of real bugs encountered and resolved during development. Each entry captures the symptom, root cause, fix, why it wasn't caught earlier, and the test case it suggests. This log feeds directly into the test suite — bugs that have bitten us once should be mechanically prevented from recurring.

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
This class of bug is best caught by a linter (ESLint with `no-undef` or TypeScript). As a test: a smoke test that mounts `<App />` in a jsdom environment and asserts it renders without throwing would catch this immediately.

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
