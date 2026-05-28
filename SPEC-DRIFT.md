# Spec Drift Log
**Spec baseline:** s3-browser-spec-v0.15.md (2026-05-19)
**Implementation baseline:** v1.10.0 (2026-05-28)

This document records where the implementation intentionally or incidentally diverged from the spec, and why. The spec is not modified — this log is the authoritative record of drift so the spec can be understood as a historical design document while the code remains the source of truth.

---

## Drift Items

---

### D-1 — §3 Scope Note + §6: Delete, rename, copy are fully implemented

**Spec says (§3 scope note):**
> Delete, rename, copy, and bucket management operations are explicitly out of scope for this version.

**Spec says (§6 Out of Scope):**
> Object delete — Not a stated requirement

**What's implemented:**
- Single-file delete with confirmation modal (including versioning caveat language per provider)
- Batch delete (multi-select, `DeleteObjectsCommand` in 1000-object chunks)
- Folder delete (full recursive listing + batch delete with live progress)
- Rename (copy-then-delete via `CopyObjectCommand` + `DeleteObjectCommand`, metadata preserved)
- New folder creation (`PutObjectCommand` with `application/x-directory`)
- Hidden versions panel: lists old versions and delete markers, per-item delete, purge-all (`ListObjectVersionsCommand` + `DeleteObjectsCommand`)

**Context:**
These were implemented incrementally after the spec was frozen at v0.15. The spec's "out of scope" framing reflected the v0.1 minimum viable scope, not a permanent exclusion. All additions are consistent with the spec's design principles and architecture.

**Action needed:** None to the code. §3 scope note and §6 should be updated in a future spec revision to reflect actual scope.

---

### D-2 — §4.6: `lib-storage` never used; raw SDK commands used throughout

**Spec says (§4.6):**
> Use `lib-storage`'s `Upload` class with `leavePartsOnError: true` for files ≥ 5 MB. The `uploadId` property is populated on the first `httpUploadProgress` event.

**Spec says (§4.15):**
> `lib-storage` cannot resume a partially completed multipart upload within the same instance. On resume, raw SDK commands are used.

**What's implemented:**
`@aws-sdk/lib-storage` is not in `package.json` and is never imported. Both the initial multipart path and the resume path use raw SDK commands:
- `CreateMultipartUploadCommand` → get UploadId
- Worker pool of `UploadPartCommand` calls (configurable concurrency, default 4)
- `CompleteMultipartUploadCommand`

**Why this is better:**
`lib-storage` would have required `leavePartsOnError: true` to access the UploadId, but extracting the ID from an `httpUploadProgress` event is fragile (event-dependent timing). Using raw commands gives direct, synchronous access to the UploadId immediately after `CreateMultipartUpload` resolves, before any parts are uploaded. It also gives full control over part concurrency without proxying through lib-storage's `queueSize`. The result is a cleaner resume implementation with no lib-storage abstraction in the way.

**Action needed:** §4.6 and §4.15 should be updated in a future spec revision to describe the raw SDK approach.

---

### D-3 — §4.6: Default file concurrency is N=3, not N=2

**Spec says (§4.6):**
> Default N = 2, chosen as a conservative default.

**What's implemented (`UploadQueue.jsx`):**
```js
const DEFAULT_FILE_CONCURRENCY = 3;
```

**Context:**
N=3 was chosen as a slightly less conservative default given HTTP/2 multiplexing. The spec's rationale for N=2 ("avoid saturating browser resources") is still valid as a framing, but N=3 is a pragmatic increase. The value is configurable via Settings, so the default is not a hard constraint.

**Action needed:** Minor. Align spec or code. If N=3 is the settled default, update the spec's §4.6 example value.

---

### D-4 — QUESTIONS.md D1: Connection Failed state is resolved

**QUESTIONS.md says:**
> D1 — "Connection Failed" session state [...] Left as a known minor deviation for v0.1.

**What's implemented:**
`Browser.jsx` calls `onInitialListFailed(err)` when the first `ListObjectsV2` probe fails. `App.jsx` receives this via the `onInitialListFailed` prop and transitions to `session = 'failed'`, showing the error block in the splash view. The spec's §4.14 Connection Failed state is fully implemented and behaves as specified.

**Action needed:** Remove or strike through D1 in QUESTIONS.md.

---

### D-5 — §4.15: Resume sequence describes lib-storage initial path

**Spec says (§4.15 resume sequence step 4):**
> Use the `ListParts` result as the completed parts list (ETags included)

**And references (§4.15 preamble):**
> `uploadId` [...] extracted from `upload.uploadId` on the first `httpUploadProgress` event

**What's implemented:**
Consistent with D-2. The initial upload never goes through lib-storage; UploadId comes directly from `CreateMultipartUploadCommand`'s response. The resume sequence itself (`ListParts` → upload remaining parts → `CompleteMultipartUpload`) matches the spec correctly. Only the preamble description of how UploadId is obtained is stale.

**Action needed:** Update §4.15 UploadId extraction description in a future spec revision.

---

### D-6 — Versioning / hidden versions panel: not mentioned in spec

**Spec says:** Nothing. `ListObjectVersions`, delete markers, and version management are not referenced anywhere in the spec.

**What's implemented:**
`HiddenVersions.jsx` provides a full versioning panel: lazy-loaded per prefix, lists old versions and delete markers with type-aware labels, per-item delete with correct undelete semantics for latest delete markers, and a purge-all that exhausts pagination before batching.

**Context:**
This is an addendum feature that fits naturally within the spec's design principles and the existing delete/S3 capability model. The versioning caveat language in the single-file delete modal (already present in the spec's design intent) motivated the companion panel.

**Action needed:** Document in §4 or an appendix in a future spec revision.

---

### D-7 — §4.7: Listing cache not mentioned in spec

**Spec says (§4.7):**
> Filtering operates against the in-memory cache of already-loaded results.

This is the only reference to caching — meaning the filter should not re-fetch. The spec does not describe a persistent in-memory listing cache with TTL.

**What's implemented:**
`Browser.jsx` maintains a `cacheRef` (`Map<prefix, {items, commonPrefixes, isTruncated, continuationToken, timestamp}>`) with a configurable TTL (default 120 s, settable in Settings: Off / 30s / 2min / 10min). Navigating to a previously-visited prefix within the TTL returns the cached result without a network call. Mutations (delete, rename, folder create, upload completion) call `invalidateCache(prefix)`.

**Context:**
Reduces Class C list operations on B2 (billed per call). Consistent with the spec's §4.7 cost concern. The cache is session-scoped (in-memory only) and resets on reconnect, so it never produces stale data across credential changes.

**Action needed:** Document in §4.7 or §4.8 in a future spec revision.

---

## Features Implemented Beyond Spec Scope

For completeness, a summary of all features implemented that have no spec counterpart (beyond the drift items above):

| Feature | Component | Notes |
|---------|-----------|-------|
| File preview (image, audio, video, PDF, text) | `Browser.jsx` | Presigned URL with forced `text/plain` for text to prevent execution |
| Preview navigation (arrow keys, tap zones) | `Browser.jsx` | Ordered by current sort; respects active filter |
| Presigned link copy with custom expiry | `Browser.jsx`, `CopyLinkPopover` | Single file and batch (multi-select); 1h / 24h / 7d / custom |
| Shareable URL (endpoint + bucket in hash) | `url-params.js`, `App.jsx` | No credentials; hash fragment never sent to server |
| Dark mode | `main.css` | `prefers-color-scheme: dark` |
| Drag-and-drop onto file browser | `Browser.jsx` | Forwards to UploadQueue; preserves folder structure |
| Upload log (persistent history) | `UploadLog.jsx`, `indexeddb.js` | IndexedDB, newest-first, clearable |
| Changelog modal | `ChangelogModal.jsx`, `changelog.js` | In-app, version-tagged |
| File properties panel | `Browser.jsx` | `HeadObject` metadata including custom x-amz-meta-* headers |
| Column sorting (name, size, modified) | `Browser.jsx` | Client-side against loaded results |
| Filter bar | `Browser.jsx` | In-memory against loaded results; resets on navigation |
| Multi-select + batch operations | `Browser.jsx` | Select-all, batch delete, batch copy links |
| Folder creation | `Browser.jsx` | `PutObjectCommand` with `application/x-directory` |
| Browser history integration | `Browser.jsx`, `url-params.js` | Back/forward support; prefix in hash fragment |
| Update available banner | `UpdateBanner.jsx` | HEAD/Range/full cascade; version number display |
| Build invariants | `build.mjs` | Enforces metadata within Range fetch boundary |
