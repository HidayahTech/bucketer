# Library Modules — Design Intent

**Version:** 1.0  
**Date:** 2026-06-01  
**Covers:** `src/lib/` (9 modules)

This document explains the design intent for every function in the library layer. Proposed comment text is shown as code blocks with file paths. These comments should be added to the source files; they explain WHY code was written, not what it does (which identifiers already communicate).

---

## `src/lib/storage.js`

### Purpose

Implements the dual-storage model for credentials required by REQ-6: non-sensitive fields (`endpoint`, `bucket`, `keyId`, `provider`, `regionOverride`) persist across sessions in `localStorage`; the secret key is held only in `sessionStorage` and is cleared on tab close. Also persists capability state (§4.12), upload settings, and cache TTL.

### Design intent

The split between `localStorage` and `sessionStorage` is the central security decision. It means:
- A user who reopens the browser after a day sees their endpoint and bucket pre-filled, but must re-enter their secret key
- The secret key is never written to disk, even indirectly through the browser's session restore feature
- Multiple tabs share endpoint/bucket settings but each has its own secret key

Private browsing mode throws on storage writes. `safeGet`/`safeSet`/`safeRemove` swallow these errors so the app degrades gracefully (credentials are not persisted, but the current session continues).

### Proposed comments

```javascript
// src/lib/storage.js

// Dual-storage credential model (REQ-6, §4.5).
// Non-sensitive fields (endpoint, bucket, keyId) → localStorage: survives tab close,
// shared across tabs, safe to persist because these are not cryptographic secrets.
// Secret key → sessionStorage only: cleared on tab close, not shared across tabs.
// This split is the core credential security posture: users must re-enter their secret
// key each session, but are not burdened with re-entering their endpoint and bucket.

function safeGet(storage, key) {
  // Wrap getItem() — private browsing and restrictive browser contexts may throw.
  // Return empty string rather than null so falsy checks work consistently downstream.

function safeSet(storage, key, value) {
  // Wrap setItem() — silently fail in private browsing. Caller cannot detect failure,
  // but the app continues with in-memory state. Degraded persistence is better than crash.

function loadCredentials() {
  // Restore persisted credentials at app startup. Returns a merged object with all fields.
  // provider may be null (never explicitly saved) vs. empty string (saved as empty override).
  // No validation occurs here — parsing and defaulting happen at the call site.

function saveCredentials({ endpoint, bucket, keyId, secretKey, provider, regionOverride }) {
  // Persist credentials to appropriate storage (§4.5 dual-storage model).
  // Falsy provider converts to empty string to prevent "null" string being stored.
  // No validation — caller must validate before saving.

function clearCredentials() {
  // Remove all credential fields from both storage layers.
  // Called on disconnect AND on credential change. Does not clear capability state —
  // caller must call clearCapabilities() separately to reset permission indicators.

function loadCapabilities() / saveCapabilities() / clearCapabilities()
  // Per-operation permission state (§4.12). Each of { list, download, upload, delete }
  // starts as 'unknown', transitions to 'permitted' or 'denied' based on actual operation
  // outcomes. 'unknown' means "not yet tested" — operations are enabled in this state.
  // Stored as JSON in a single localStorage key; parse failure returns safe defaults.
  // Clearing credentials must also clear capabilities (App.jsx handles this).

function loadListingCacheTTL() / saveListingCacheTTL(seconds)
  // Persist cache TTL choice (D-7). Check uses !== '' to distinguish missing key (null)
  // from explicitly set-to-zero (cache disabled). Zero is a valid and meaningful value.

function loadPartConcurrency() / loadPartSizeMB() / loadFileConcurrency()
  // Upload tuning parameters (§4.6, Principle 1). All return null if not set,
  // signalling "use application default." Callers must validate ranges (part size ≥ 5 MB,
  // concurrency ≥ 1) — this layer does no validation.
```

---

## `src/lib/provider.js`

### Purpose

Single source of truth for per-provider behavioral differences (§4.8, §5). Every place in the app that needs to behave differently for B2 vs. R2 vs. AWS etc. calls into this module. Isolating provider logic here means all other code is provider-agnostic.

### Design intent

Provider detection parses the endpoint URL and tests the **hostname only** against regex patterns. This prevents false matches on path components (`/r2/` in a reverse proxy path) or query strings. Patterns are anchored with `$` to prevent suffix-based misdetection (e.g., `mybackblazeb2.com` should not match the B2 pattern).

`detectProvider` returns `GENERIC` on any error (unparseable URL, no match). `GENERIC` has safe defaults (no path-style, no region extraction), so the app functions for any compliant S3 endpoint even if unrecognized.

### Proposed comments

```javascript
// src/lib/provider.js

// Provider detection and per-provider configuration (§4.8, §5).
// This is the single place where provider-specific behavioral differences are encoded.
// All other modules are provider-agnostic; they call these helpers when they need
// to vary behavior (S3Client construction, default page size, CORS guidance).

const PROVIDERS = { ... }
// Canonical provider keys (§4.8). GENERIC is the catch-all for any S3-compatible
// endpoint that does not match a known pattern (custom domains, reverse proxies,
// anything not in the known catalog).

const PATTERNS = [...]
// Regex patterns tested against the endpoint hostname only (§4.8).
// Hostname-only matching prevents false positives on path or query string.
// Patterns are anchored with $ to prevent suffix-based misdetection.
// Detection order does not matter (patterns do not overlap).

export function detectProvider(endpoint)
  // Parse the endpoint URL, extract hostname, test against PATTERNS.
  // Any error (malformed URL, no match) safely returns GENERIC.
  // Result is usually saved to localStorage by the caller at credential-save time
  // so detection does not re-run on every S3Client instantiation.

export function extractRegion(endpoint, provider)
  // Extract region code from endpoint URL for providers that embed it (§5 Group B):
  // B2: s3.{region}.backblazeb2.com — R2: returns 'auto' (§5 Group C)
  // AWS: s3.{region}.amazonaws.com  — Wasabi: s3.{region}.wasabisys.com
  // DO Spaces: {region}.digitaloceanspaces.com
  // GENERIC and MINIO return null (user must supply region override).

export function requiresPathStyle(provider)
  // B2 and MinIO require path-style URLs (§5 Group A). All others use virtual-hosted style.
  // Wrong choice causes auth-like errors that are hard to diagnose (§4.3 snag section).

export function defaultMaxKeys(provider)
  // B2: 200 (Class C billing — each list call costs money; smaller pages make cost visible).
  // Others: 1000 (S3 API maximum; no per-call billing concern).

export function needsCorsConfig(provider)
  // Wasabi returns permissive CORS headers automatically (§5 Group D).
  // All others require manual PutBucketCors setup before the app can function.
  // Affects SetupGuide.jsx guidance text, not application logic.
```

---

## `src/lib/s3-client.js`

### Purpose

Factory function that produces a correctly configured `S3Client` instance for a given credential set and provider. Bridges `provider.js` (path-style, region extraction) with the AWS SDK.

### Proposed comments

```javascript
// src/lib/s3-client.js

export function createS3Client({ endpoint, bucket, keyId, secretKey, provider, regionOverride })
  // Instantiate S3Client with provider-specific configuration (§4.3, §5).
  //
  // Region resolution order (first non-null wins):
  //   1. regionOverride — user's explicit input from CredentialForm
  //   2. extractRegion(endpoint, provider) — auto-extracted from URL structure
  //   3. 'us-east-1' — safe fallback that works for most providers and
  //                    the AWS SDK's SigV4 signing defaults
  //
  // forcePathStyle is derived from provider via requiresPathStyle() (B2/MinIO: true).
  // Bucket is NOT included here — it is supplied per-command in individual API calls.
  // Called once per credential set; the resulting client is stateless and reused for all
  // operations until the user disconnects or credentials change.
```

---

## `src/lib/url-params.js`

### Purpose

Serialize and deserialize connection config in the URL **hash fragment** for shareable links and browser history integration (§4.14). The hash is used explicitly (not the query string) so parameters are never sent to the server.

### Design intent

Shareable URLs contain only `endpoint`, `bucket`, `provider`, and `regionOverride`. Key ID and secret key are never included. This enables sharing a pre-configured connection URL with a colleague who still needs to authenticate separately.

Browser history is maintained by writing the current prefix to `#prefix=a/b/c/` on every navigation. The back button restores the prefix by reading `history.state` or re-parsing the hash. This gives the app standard browser navigation behavior without a server-side router.

### Proposed comments

```javascript
// src/lib/url-params.js

// Hash fragment (not query string) is used for all URL params so that they
// are never transmitted to the server in request URLs (§4.14, REQ-5).

function hashParams()
  // Parse window.location.hash as URLSearchParams after stripping the leading '#'.

export function readUrlParams()
  // Read connection config from URL hash. Returns a sparse object containing only
  // the params that are present; caller must merge over stored credentials.
  // No validation — raw strings from URLSearchParams; parsing happens at call site.
  // Secret key is never in the hash; this is enforced by omission (not a check).

export function hasUrlParams()
  // Returns true if the hash contains any connection config params. Used at startup
  // to decide whether to pre-fill the form and attempt an auto-connect.

export function buildShareUrl(credentials)
  // Build a shareable URL with connection config in the hash (no credentials).
  // Returns null for file:// contexts — no meaningful origin to share.
  // Only non-falsy fields are included to avoid polluting the URL with empty params.

export function pushPrefixHistory(prefix, replace = false)
  // Update browser history when navigating to a prefix (§4.14).
  // Preserves other hash params (endpoint, bucket, provider) while updating prefix.
  // Uses replace=false for deliberate navigation (pushState), replace=true for initial
  // load and back-button handling (replaceState). Silent on file:// — Chrome blocks
  // pushState for local files.
```

---

## `src/lib/indexeddb.js`

### Purpose

Persistent storage for multipart upload resume records (REQ-8) and upload history. IndexedDB survives tab close and browser restart, making true cross-session resume possible.

### Design intent

Resume records are saved **before** any parts are uploaded. This is the critical invariant: if the browser crashes on the first part upload, the resume record already exists and the user can recover. If the record were saved after uploading parts, a crash on part 1 would leave the user with an orphaned multipart session they cannot resume.

File identity validation prevents accidentally resuming a different file. Three fields (name, size, lastModified) are stored at record creation. An optional SHA-256 hash of the first and last 64 KB provides a fast content-based check for cases where metadata matches but content differs.

### Proposed comments

```javascript
// src/lib/indexeddb.js

// Two IndexedDB stores (§4.15, REQ-8):
//   s3browser_uploads: multipart upload resume records
//   bucketer_upload_log: upload history (auto-increment)
// Both survive tab close and browser restart.

export function uploadExpiryWarningMs(provider)
  // R2 auto-aborts incomplete multipart uploads after 7 days.
  // B2 does not auto-expire — returns null (no warning threshold).
  // Used to warn user when a resume record is aging toward provider's cleanup window.

export function saveResumeRecord(params) / loadResumeRecord(params) / deleteResumeRecord(params)
  // Resume record lifecycle (§4.15). Record is saved BEFORE any parts are uploaded —
  // this is the critical invariant. A crash mid-upload still allows recovery because
  // the record exists. Delete is called on success or permission error (unrecoverable).
  // Record key is composite: provider:endpoint:bucket:destinationKey.

export function computeFileHash(file)
  // SHA-256 of first and last 64 KB of file content (§4.15 file identity).
  // Partial hash: fast enough for interactive use without reading the full file.
  // Returns null if SubtleCrypto unavailable (some Safari / Private Browsing contexts).
  // Callers must handle null — resume still works using name/size/mtime without hash.

export function buildFileIdentity(file) / fileIdentityMatches(identity, file)
  // File identity verification for resume (§4.15). Name, size, and lastModified must
  // all match. Optional content hash provides extra safety against coincidental matches
  // (same metadata but different content — e.g., file was replaced since the pause).

export function markUploadActive(key) / isUploadActiveElsewhere(key) / markUploadInactive(key)
  // Concurrent tab conflict detection (§4.15). Each tab registers its in-flight
  // uploads in a shared location. If another tab has the same destination key active,
  // the user is warned before starting. Best-effort: private mode disables detection.

export function saveUploadLogEntry(entry) / loadUploadLog() / clearUploadLog()
  // Persistent upload history (beyond spec). Entries record status, speed, duration,
  // and error messages for completed/failed/aborted uploads. No TTL or pruning —
  // user clears explicitly.
```

---

## `src/lib/upload-queue.js`

### Purpose

A simple bounded-concurrency task queue used by `UploadQueue.jsx` to limit simultaneous file uploads. Reusable utility decoupled from upload-specific state.

### Proposed comments

```javascript
// src/lib/upload-queue.js

// Bounded concurrency task queue (§4.6). Limits how many tasks run simultaneously.
// Default N=2 in spec, implemented as N=3 (D-3 — HTTP/2 multiplexing justification).
// The concurrency value is checked at enqueue time so Settings changes take effect
// without restarting in-progress uploads.

class UploadQueue {
  enqueue(task)
    // Add a task function () => Promise. Returns a promise that resolves when the task
    // completes. Starts immediately if below the concurrency limit; queues otherwise.

  clear()
    // Drop all pending (not yet started) tasks. In-flight tasks are NOT cancelled —
    // those must be stopped via their own AbortController. Used on "Cancel all."

  _drain()
    // Pull pending tasks off the queue and start them until the concurrency limit is
    // reached. Called after every task completion (.finally) to process the queue.
}
```

---

## `src/lib/file-entries.js`

### Purpose

Recursively enumerate files from drag-and-drop `FileSystemEntry` objects, preserving folder structure for upload (D-1, beyond spec scope).

### Design intent

The HTML5 drag-and-drop API's Directory Reader returns at most 100 entries per `readEntries()` call. A naive implementation that calls `readEntries()` once would silently drop files after the 100th item in large folders. `collectFileEntries` loops until an empty array is returned, guaranteeing complete enumeration.

### Proposed comments

```javascript
// src/lib/file-entries.js

export async function collectFileEntries(entries)
  // Recursively enumerate files from FileSystemEntry objects (drag-and-drop, folder picker).
  // Returns flat array of { file: File, relativePath: string } pairs, preserving folder
  // hierarchy for upload.
  //
  // Critical: the Directory Reader API returns at most 100 entries per readEntries() call.
  // This function loops until readEntries() returns empty — omitting the loop would
  // silently drop files in large folders.
  //
  // Unreadable files and directories are skipped without throwing (permission errors,
  // broken symlinks). Some browsers follow symlinks; circular symlinks may loop infinitely
  // (no guard implemented — pathological case, not handled).
```

---

## `src/lib/format.js`

### Purpose

UI formatting utilities: byte sizes, upload speeds, ETAs, S3 object key leaf names, and S3 error normalization.

### Proposed comments

```javascript
// src/lib/format.js

export function formatBytes(bytes)
  // Format byte count as human-readable size using IEC binary units (KiB, MiB, GiB, TiB).
  // 1024-based, not 1000-based. 0 bytes special-cased to avoid log(0).

export function formatSpeed(bytesPerSec)
  // Format bytes-per-second as human-readable speed ("KiB/s" etc.). Delegates to formatBytes.

export function formatEta(seconds)
  // Format seconds as human-friendly ETA. Non-finite or negative → em dash.
  // < 1h: show seconds. 1h+: show hours and minutes only (no seconds).

export function leafName(key)
  // Extract the filename component from an S3 object key (everything after the last '/').
  // Used for download ResponseContentDisposition filenames and preview titles.
  // Keys ending in '/' return empty string (folder marker — callers should handle this case).

export function parseS3Error(err) / isPermissionError(err)
  // Normalize AWS SDK v3 error objects for display and capability detection (§4.10, §4.12).
  // SDK errors use varying field names (Code, name, $metadata.httpStatusCode, etc.) across
  // provider implementations. parseS3Error extracts canonical fields.
  // isPermissionError checks for AccessDenied code or 401/403 HTTP status — used to
  // transition capability state from 'unknown' or 'permitted' to 'denied'.
```

---

## `src/lib/media.js`

### Purpose

File type detection for preview and download headers. Uses file extension (from S3 object key) and Content-Type header (from `HeadObject` response) to determine whether a file can be previewed and how.

### Design intent

Two detection strategies are intentional: extension-based (`mediaKind`, `mimeType`) covers the common case where the stored Content-Type is generic (`application/octet-stream`). Header-based (`mimeKind`) covers files that have correct Content-Type but non-standard or missing extensions.

For text preview, `ResponseContentType` is always forced to `text/plain` regardless of what the extension or stored Content-Type say. This is a security invariant: a user could upload an HTML file and attempt to social-engineer someone into opening the "preview." Forcing `text/plain` renders it as text, never executed HTML.

### Proposed comments

```javascript
// src/lib/media.js

// File type detection for preview and Content-Type handling.
// Two complementary strategies:
//   mediaKind(key) / mimeType(key) — extension-based, fast, handles common case
//   mimeKind(contentType)         — header-based, handles correct Content-Type with
//                                   missing or non-standard extension
//
// SECURITY: Text preview always forces ResponseContentType='text/plain' regardless of
// detection result. This prevents an uploaded HTML file from being rendered as HTML in
// the preview iframe — it is shown as plain text only.

export function fileExt(key)
  // Extract file extension (lowercase, last dot-segment). Empty string if no dot.
  // Note: '.bashrc' → extension 'bashrc' (may be unexpected but is consistent).

export function mediaKind(key) / mimeType(key)
  // Look up previewable kind or MIME type by file extension. Returns null for unknown
  // extensions. Extension-based detection is fast but relies on convention (a renamed
  // .txt file is still treated as text).

export function mimeKind(contentType)
  // Determine previewable kind from Content-Type header. Handles broad patterns
  // (image/*, audio/*, video/*, text/*) and specific types (application/pdf,
  // application/json treated as text). Parses header for charset parameter.
  // Complements mediaKind() for files with missing or non-standard extensions.
```
