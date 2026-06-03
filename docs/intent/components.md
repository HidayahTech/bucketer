# Components — Design Intent

**Version:** 1.0  
**Date:** 2026-06-01  
**Covers:** All components except `Browser.jsx` (see `browser.md`)

---

## `src/components/App.jsx` — Session State Machine

### Purpose

App is the **session orchestrator** (§4.14). It manages the four mutually exclusive session states that determine what the user sees and manages credential lifecycle: load from storage, merge URL params, save on connect, clear on disconnect.

### Why it exists

The app has fundamentally different UI requirements based on session state:
- **disconnected**: only credential entry is shown
- **connecting**: credential entry + loading indicator
- **connected**: full browser UI available
- **failed**: error display with option to reconfigure

Without an explicit state machine, the UI would need to combine `isConnecting`, `isConnected`, `hasFailed`, and `showSplash` booleans. The risk of invalid combinations (both `isConnecting` and `hasFailed` true) is high. A single enum makes valid transitions explicit.

### Proposed comments

```javascript
// App.jsx

// Root session state machine (§4.14).
//
// Session states: 'disconnected' | 'connecting' | 'connected' | 'failed'
//   disconnected: no valid credentials; splash screen with credential form shown
//   connecting:   initial ListObjectsV2 probe in flight; form is saved, probe pending
//   connected:    probe succeeded; full Browser UI rendered
//   failed:       probe failed (auth, network, CORS, not found); error displayed
//
// Credential lifecycle:
//   On mount: load from localStorage, merge URL hash params (endpoint/bucket override, no secret)
//   On connect: save to storage, create S3Client, probe with ListObjectsV2, transition to connected
//   On disconnect: clear all storage, reset capabilities, increment browserKey (remounts Browser)
//
// Capability state (list/download/upload/delete permitted|denied|unknown) is stored in localStorage
// and updated reactively when operations fail. Capabilities persist across reconnects but are
// cleared on credential change. The CapabilityPanel reads this state; Browser.jsx reports updates.
//
// Browser component is re-mounted via key={browserKey} increment on every reconnect.
// This is intentional: remounting flushes Browser's in-memory listing cache and triggers
// a fresh listing probe. Without remounting, cached results from a previous bucket could
// linger after a credential change.

// Session state transitions are managed here; illegal states (e.g. 'connected' + no client)
// cannot occur because state and client are always set together in handleConnect.
const [session, setSession] = useState('disconnected');

// reconnect: true suppresses the 'connecting' transition when the user reconnects while
// already browsing (avoids a flash back to the splash screen mid-session).
async function handleConnect(creds, { reconnect = false } = {})

// URL params (endpoint/bucket) override localStorage on load — enables share-link flow (§4.5).
// Secret key is never in the URL; it always comes from sessionStorage or the credential form.
const [credentials, setCredentials] = useState(() => ({ ...loadCredentials(), ...readUrlParams() }));
```

### Behaviors important to test

- Page load with no stored credentials → splash screen shown
- Page load with all credentials in storage → auto-connects without showing splash
- `?endpoint=X&bucket=Y` in hash → form pre-filled with X and Y, stored keyId used if present
- Connected user reconnects with different credentials → no flash to splash during reconnect
- Disconnect → all storage cleared, capabilities reset, splash shown
- Browser re-mounts on reconnect → no stale listing from previous bucket

---

## `src/components/CredentialForm.jsx` — Credential Entry

### Purpose

Collects the four required credentials (endpoint, bucket, key ID, secret key) and provides auto-detection of the provider from the endpoint URL (§4.8).

### Key design decisions

**Provider auto-detection as display hint, not forced choice:** The form shows "Detected: Backblaze B2" as non-interactive text. The user can override via an explicit dropdown. Detection guides without constraining.

**Region input appears only when needed:** For B2, Wasabi, and AWS, the region is embedded in the endpoint URL and extracted automatically. For R2 and MinIO, a Region input appears with a context-appropriate hint ("For R2, use 'auto'"). This implements Principle 1: sensible defaults with optional overrides.

**Secret key uses `type="password"`:** Masked on screen, excluded from browser autofill history. `autocomplete="current-password"` enables browser Credential Manager integration opportunistically.

### Proposed comments

```javascript
// CredentialForm.jsx

// Credential entry form (REQ-1, §4.5, §4.8).
//
// Provider auto-detection: calls detectProvider(endpoint) as the user types. The detected
// provider and extracted region are shown as display hints — the user can override via
// the explicit provider dropdown if auto-detection is wrong (reverse proxies, custom domains).
//
// Region input: shown only when the endpoint URL does not embed the region. For B2/Wasabi/AWS,
// region is extracted from the URL. For R2, 'auto' is recommended and shown as hint. For MinIO
// and GENERIC, the field appears with a placeholder.
//
// Secret key: type="password" prevents display on screen and excludes from autofill history.
// autocomplete="current-password" allows browser Credential Manager integration if available.
// Storage policy: session only (cleared on tab close, never written to localStorage).
//
// Endpoint URL is trimmed and trailing slashes are removed before saving (normalization).
// This ensures 'https://example.com/' and 'https://example.com' create identical S3Clients.
//
// SetupGuide is rendered as a collapsible <details> child. It receives the current form
// values so that generated AWS CLI commands are pre-filled with the user's endpoint,
// bucket, and key ID — minimizing transcription errors.
```

### Behaviors important to test

- B2 endpoint → "Detected: Backblaze B2" shown, region extracted, no region input field
- R2 endpoint → "Detected: Cloudflare R2" shown, region input with "use 'auto'" hint
- Manual override to MinIO → MinIO-specific path-style warning shown
- Submit `https://example.com/` → saved as `https://example.com` (trailing slash normalized)
- SetupGuide updates: type bucket name → bucket appears pre-filled in guide commands

---

## `src/components/SetupGuide.jsx` — CORS Setup Instructions

### Purpose

CORS is a **blocking prerequisite** (§4.2). Without CORS headers configured on the bucket, every S3 API response is blocked by the browser, making the app completely non-functional. SetupGuide provides provider-specific, copy-pasteable AWS CLI instructions to configure CORS.

### Key design decisions

**Provider-specific guides:** Each provider has unique characteristics. B2 may have conflicting native CORS rules that must be cleared first. R2 auto-aborts incomplete multipart uploads after 7 days. Wasabi needs no CORS setup at all. Generic guides would force users to dig through provider documentation for these details.

**File:// protocol detection:** When the app runs from `file://`, browsers send `Origin: null`, which most providers reject as invalid CORS origin. The guide detects this and switches the CORS JSON to use `"*"` wildcard origin, with a warning explaining the implication.

**Pre-filled commands:** The user's endpoint, bucket, and key ID are interpolated into the `aws s3api put-bucket-cors` command shown in the guide. This reduces transcription errors significantly.

### Proposed comments

```javascript
// SetupGuide.jsx

// Provider-specific CORS setup guide (§4.2, §4.8).
// CORS is a blocking prerequisite: without it, the browser rejects all S3 API responses.
// This guide generates the correct AWS CLI commands for each provider and pre-fills
// them with the user's current form values to minimize transcription errors.
//
// Provider differences encoded here:
//   B2:     ClearNativeCors step required first (native B2 rules conflict with S3 API rules)
//   R2:     Region 'auto'; notes 7-day auto-abort of incomplete multipart uploads
//   Wasabi: No CORS setup needed — returns permissive headers automatically
//   AWS:    Standard put-bucket-cors without --endpoint-url
//   MinIO:  Standard put-bucket-cors with custom endpoint
//   Others: Generic guide with placeholders
//
// File:// origin detection: window.location.protocol === 'file:' → use "*" wildcard origin
// and show a warning. Browsers send Origin: null for local files; most providers reject "null".
// Users who later deploy to a domain must re-run the CORS setup with the specific origin.
//
// Rendered as a <details> element (progressive disclosure) inside CredentialForm.
// Warning styling applied when running from file:// protocol (action required before use).
```

---

## `src/components/CapabilityPanel.jsx` — Permission Display

### Purpose

Displays the permission state for four S3 operations (list, download, upload, delete) so users understand why certain operations are disabled (REQ-7, §4.12).

### Key design decisions

**Three-state capability enum:** `'permitted' | 'denied' | 'unknown'`. Operations start as `'unknown'` (assumed permitted) and are marked `'denied'` only after an actual operation fails. This fail-open approach avoids incorrectly disabling operations before they've been tested.

**Why not write-probe permissions?** The spec (§4.12) explicitly rejects probing upload permission with a test write because it would trigger bucket events, webhooks, replication, versioning, and charges. Permission is discovered through natural use only.

### Proposed comments

```javascript
// CapabilityPanel.jsx

// Permission state display (REQ-7, §4.12).
//
// Displays { list, download, upload, delete } capability states as ✓/✕/? indicators.
// State transitions:
//   unknown → permitted: operation succeeds naturally (e.g., first list succeeds)
//   unknown → denied:    operation fails with AccessDenied / 403 / 401
//   permitted → denied:  operation that previously worked now returns permission error
//   denied → unknown:    user clicks "Refresh Permissions" (clears stored state, re-probes)
//
// Operations start as 'unknown' (enabled in UI). The UI only disables operations when
// capability is explicitly 'denied'. This fail-open approach is correct because the first
// operation always reveals whether it's permitted — no advance probe needed.
//
// Upload permission is NEVER probed with a test PutObject — that would trigger bucket
// events, webhooks, replication, versioning lifecycle, and charges (§4.12).
//
// "Refresh Permissions" calls onRefresh() → App resets capability state and remounts
// Browser with a new probe. Useful if server-side key permissions have changed.
```

---

## `src/components/UploadQueue.jsx` — Upload Pipeline

### Purpose

The upload engine (REQ-4, REQ-8). Implements small-file upload (single `PutObjectCommand`), large-file multipart upload with configurable concurrency (raw SDK commands, D-2), and cross-session resume (IndexedDB, D-2).

### Why raw SDK instead of lib-storage (D-2)

`lib-storage` would require `leavePartsOnError: true` to access `UploadId`, and the ID must be extracted from a fragile `httpUploadProgress` event callback. Using `CreateMultipartUploadCommand` directly gives synchronous access to `UploadId` immediately, before any parts are uploaded. This enables saving the resume record before the first part — which is the critical invariant for cross-session resume.

### Proposed comments

```javascript
// UploadQueue.jsx

// Upload engine (REQ-4, REQ-8, §4.6, §4.15).
//
// File size routing:
//   < 5 MiB: single PutObjectCommand (atomic, no resume needed)
//   ≥ 5 MiB: manual multipart via raw SDK commands (D-2):
//     CreateMultipartUploadCommand → synchronous UploadId access
//     Worker pool of UploadPartCommand calls (default 4 concurrent parts)
//     CompleteMultipartUploadCommand with sorted ETags
//
// Why raw SDK, not lib-storage (D-2): CreateMultipartUpload gives UploadId synchronously
// before any parts are uploaded. This is required because the resume record is saved to
// IndexedDB BEFORE the first part — if the browser crashes on part 1, the user can recover.
// lib-storage would require extracting UploadId from an httpUploadProgress event (fragile timing).
//
// Cross-session resume (REQ-8, §4.15):
//   1. Check IndexedDB for existing resume record at credential-save time
//   2. If found: pause item, offer Resume or Restart
//   3. Resume: validate file identity (name/size/mtime/hash), call ListParts (provider is
//      ground truth of what was ACK'd), upload remaining parts, complete
//   4. Resume record deleted on success or permission error (unrecoverable)
//
// Concurrency model:
//   File concurrency: N=3 files uploading simultaneously (D-3, configurable)
//   Part concurrency: 4 UploadPartCommand calls per file (configurable)
//   Peak RAM: fileConcurrency × partConcurrency × partSize (e.g., 3×4×5MiB = 60 MiB)

// MULTIPART_THRESHOLD = 5 MiB — S3 spec minimum part size for all but the last part.
// Below this, multipart setup overhead exceeds the benefit. Single PutObjectCommand is
// simpler and requires no resume state.
const MULTIPART_THRESHOLD = 5 * 1024 * 1024;

// calcPartSize(fileSize, preferredBytes)
// Respects two constraints:
//   Minimum: 5 MB decimal (S3 spec limit for non-final parts)
//   Maximum implied: partSize × 10,000 ≥ fileSize (S3 10,000-part limit)
// User's preferred size from Settings is used if it exceeds the calculated floor.

// uploadMultipart() — saves resume record BEFORE first part upload.
// If the browser crashes after CreateMultipartUpload but before saving the record,
// the session is orphaned (can only be cleaned up server-side or via AbortMultipartUpload).
// If the browser crashes after saving the record but before any parts, ListParts returns
// an empty list on resume — correct behavior.

// handleResume() — resume flow per §4.15:
//   1. Validate file identity: compare name/size/mtime, optionally content hash
//   2. ListParts (paginated) → provider is authoritative on what was ACK'd
//   3. Upload remaining parts
//   4. CompleteMultipartUpload with all parts (completed + newly uploaded), sorted by PartNumber
//   5. Delete resume record from IndexedDB
//   NoSuchUpload error: session expired on provider. Delete stale record, tell user to restart.

// Permission error on multipart: abort the multipart session and delete the resume record.
// Unrecoverable state — user must restart with new credentials. Aborting the session
// prevents orphaned parts from accruing storage charges on B2.

// beforeunload guard: prompts user before closing tab during active upload. Crucial because
// closing the tab kills in-flight requests immediately. The user can reopen and resume,
// but only if they understand the session was interrupted.

// 50 GiB guidance: non-blocking warning. Browser limitations (no bandwidth control, tab
// close kills requests, memory constraints) make native tools (rclone, b2, AWS CLI) more
// reliable for very large transfers. User can proceed in-browser if desired.
```

### Behaviors important to test

- Small file (< 5 MiB): single PutObjectCommand, no resume record created
- Large file (100 MiB): resume record saved before first part; reload mid-upload → resume offered
- File identity mismatch: edit file on disk, attempt resume → error (name/size/mtime or hash mismatch)
- Session expiry (NoSuchUpload): resume record cleaned, user told to restart
- Tab conflict: same destination key in two tabs → second tab shows error
- Permission error during multipart: session aborted, resume record deleted
- Part concurrency: 4 simultaneous UploadPartCommand calls visible in Network tab

---

## `src/components/HiddenVersions.jsx` — Version/Delete-Marker Panel

### Purpose

Exposes S3 versioning internals that are invisible in the normal listing (D-6). In versioned buckets, deleting a file creates a **delete marker** — the file appears deleted but the content still exists. Removing the latest delete marker **undeletes** the file.

### Key design decisions

**Type-aware confirmation text:** The confirmation modal says "Undelete this file?" when removing a latest delete marker (because that's the effect), and "Permanently delete this version?" for old versions. Users must understand what they're confirming.

**Purge-all exhausts pagination first:** If the UI shows page 1 of 3, "Purge All" must fetch pages 2 and 3 before deleting. Deleting only the loaded page would leave orphaned versions and show a misleading "done" message.

### Proposed comments

```javascript
// HiddenVersions.jsx

// Hidden versions panel: lists old versions and delete markers (D-6).
//
// In S3 versioned buckets:
//   - Deleting an object creates a delete marker (IsLatest=true) that hides the file
//     in ListObjectsV2. The prior version still exists in storage.
//   - Removing the latest delete marker UNDELETES the file — the prior version becomes visible.
//   - Old versions are previous copies of overwritten objects (IsLatest=false).
//
// This panel uses ListObjectVersionsCommand to surface both types. They are invisible to
// the normal listing and must be managed here for versioning and cost control.
//
// Lazy-loaded: the panel only fetches when the user expands it. ListObjectVersions is
// expensive and many buckets have versioning disabled.
//
// collectHidden(resp): extracts old versions and delete markers from a ListObjectVersions
// response, labeling each with type ('old-version' or 'delete-marker') and isLatest flag.
// Sorted by key ascending, then date descending within each key.
//
// Purge-all: exhausts all pagination pages before deleting. Must delete ALL versions
// including unloaded pages — partial purge leaves orphaned versions and storage charges.
// Batched in 1000-object chunks (S3 DeleteObjects API limit).
// Side effect: deleting all delete markers for a prefix undeletes those files.
//   The confirmation modal warns about this.
```

### Behaviors important to test

- Latest delete marker removed → file reappears in main listing
- Superseded delete marker removed → no effect on main listing visibility
- Purge-all with 1500 rows → 2 DeleteObjects calls; all 1500 gone after
- Pagination: 1001 versions → "Load more" appears; after loading all, purge-all deletes all 1001

---

## `src/components/UpdateBanner.jsx` — Update Detection

### Purpose

Polls the app's own URL for a newer build and shows a banner (§4 beyond spec). Uses the cheapest possible strategy: HEAD first, then 512-byte Range fetch if needed, never a full fetch.

### Polling strategy

```
HEAD request
  │
  ├── ETag/Last-Modified matches baseline → same build, reschedule
  │
  └── changed or no baseline → Range fetch (bytes 0–511)
        │
        ├── build-id matches running page → same build, update baseline, reschedule
        │
        └── build-id different → show banner, STOP polling
```

This cascade is designed to minimize bandwidth. The `HEAD` fast-path skips the Range fetch on most checks (build doesn't change often). Once a new build is detected, polling stops — no further checks are needed.

### Build invariant dependency

Both `build-id` and `app-version` are guaranteed to appear within the first 512 bytes of the HTML output by a build invariant in `build.mjs`. `RANGE_BYTES` in `UpdateBanner.jsx` **must** be kept in sync with `UPDATE_CHECK_RANGE_BYTES` in `build.mjs`. If the invariant fails, the build fails loudly.

### Proposed comments

```javascript
// UpdateBanner.jsx

// Polls window.location for a newer build and prompts the user to refresh.
//
// Strategy (cheapest to most expensive):
//   1. HEAD request — compare ETag or Last-Modified against stored baseline.
//      Match: no change, reschedule. Change or no baseline: proceed to step 2.
//   2. Range fetch (bytes 0–RANGE_BYTES) — extract build-id and app-version from meta tags.
//      Both are guaranteed within the first RANGE_BYTES by the build invariant in build.mjs.
//      Match: same build, update HEAD baseline, reschedule. Mismatch: show banner, stop.
//
// RANGE_BYTES must match UPDATE_CHECK_RANGE_BYTES in build.mjs (512). Changing one
// without the other breaks the invariant check or causes missed metadata.
//
// Exponential backoff: 10 fast checks (1 min each), then doubling interval (2min, 4min...)
// capped at 30 min. ±25% jitter prevents thundering herd if many instances check simultaneously.
//
// Polling stops once a new build is detected. The user refreshes manually.
// No polling on file:// protocol — no server to check.

function nextDelay(attempt)
  // Fast checks (0–9): BASE_MS (1 min)
  // Slow checks (10+): BASE_MS × 2^(attempt-10), capped at MAX_MS (30 min)
  // ±JITTER (25%) random variation to spread concurrent instances

async function fetchRangeMetadata(url)
  // Fetch first RANGE_BYTES of the HTML. Extract build-id and app-version from <meta> tags.
  // Returns { buildId, appVersion } or null if fetch fails or build-id is absent.
  // Much cheaper than fetching the full HTML (which may be 10+ MB) just to compare two tags.
```

### Behaviors important to test

- HEAD ETag unchanged → no Range fetch, reschedule
- HEAD ETag changed → Range fetch performed
- Range fetch shows same build-id → no banner, update HEAD baseline, reschedule
- Range fetch shows different build-id → banner shown, polling stops
- Dismiss banner → banner hidden; polling does not restart
- File:// protocol → no polling occurs at all

---

## `src/components/SettingsPanel.jsx` — Configuration

### Purpose

Exposes upload and listing behavior controls to the user (§4.7). Settings persist to localStorage and apply to future operations.

### Proposed comments

```javascript
// SettingsPanel.jsx

// Application settings (§4.7, D-7). All settings persist to localStorage.
// Changes take effect on next operation — they do NOT affect in-progress uploads.
//
// Page size (MaxKeys): items per ListObjectsV2 page (1–100,000). Empty means use provider
// default (B2: 200, others: 1000). Smaller pages reduce per-page latency but increase
// total API calls for large buckets.
//
// Upload part size (MiB): per-part chunk for multipart uploads, 5–512 MiB. Conservative
// default (5 MiB) avoids timeouts on slow connections. Larger parts improve throughput on
// fast connections. Auto-raised if needed to respect S3's 10,000-part limit.
//
// Part concurrency: simultaneous UploadPartCommand calls per file (1–16, default 4).
// Peak RAM per file = part concurrency × part size.
//
// File concurrency: simultaneous files uploading (1–16, default 3, D-3).
// Higher values improve throughput for many small files; lower values reduce server load.
//
// Listing cache TTL (D-7): how long to cache folder listing results. 0 = disabled (always
// fetch fresh). Reduces Class C B2 list charges. Mutations always invalidate the cache
// for the affected prefix regardless of TTL.
//
// "Active" labels next to part size, part concurrency, and file concurrency show the
// currently persisted value, distinct from the input field (which may have unsaved edits).
// This clarifies that the setting applies to FUTURE operations, not current ones.
```

---

## `src/components/ErrorBlock.jsx` — Error Display

### Purpose

Structured S3 error display with CORS-specific guidance (§4.10). Surfaces provider error details while recognizing that CORS errors often mask the real underlying cause.

### Proposed comments

```javascript
// ErrorBlock.jsx

// Structured S3 error display (§4.10). Parses and normalizes S3 error fields across
// provider implementations (AWS SDK v3 errors use varying field names).
//
// CORS heuristic: if the error message mentions "fetch" or "network", or if HTTP status
// is null (network-level block), the browser likely rejected the response due to missing
// CORS headers. However, CORS preflight requests do not include Authorization headers —
// a 403 on the preflight looks identical to a genuine CORS error. The guidance directs
// the user to verify their setup with a non-browser tool (curl, AWS CLI) to see the
// actual provider error, not the browser's masked version.
//
// Expandable details: raw provider response (code, status, requestId) hidden by default
// in a <details> element to avoid cluttering the UI in the common case.
```

---

## `src/components/FileBanner.jsx` — file:// Protocol Warning

### Purpose

Warns users about browser-specific limitations when running the app from `file://` (§4.13). Session-dismissible so it doesn't nag on every reload during development.

### Proposed comments

```javascript
// FileBanner.jsx

// file:// protocol warning (§4.13). Browser-specific limitations when running locally:
//   Firefox:  most permissive; IndexedDB and localStorage work; recommended local browser
//   Chrome:   ES module CORS blocked (no issue here — all JS inlined); localStorage is
//             shared across ALL local HTML files (null origin — potential data collision)
//   Safari:   SubtleCrypto may behave inconsistently; Storage APIs unreliable in Private Browsing
//   Others:   behavior unknown
//
// Dismissed per-session (sessionStorage key). Cleared on tab close, so the warning
// reappears in future sessions — the user is reminded again if they open the file fresh.
// Dismissal does NOT persist to localStorage to avoid hiding the warning permanently.
```

---

## `src/components/UploadLog.jsx` — Upload History

### Purpose

Persistent upload history display. Loads from IndexedDB on mount, shows newest uploads first, supports clearing.

### Proposed comments

```javascript
// UploadLog.jsx

// Persistent upload history (§4.6 beyond spec). Each entry records:
//   status: 'completed' | 'failed' | 'aborted'
//   filename, destinationKey, fileSize, startedAt, completedAt, durationSec, avgSpeedBps, errorMessage
//
// Stored in IndexedDB (survives tab close and browser restart).
// Loaded from IndexedDB on mount and on refreshKey change (refreshKey incremented by parent
// after each upload completion to trigger re-load).
// Displayed newest-first (IndexedDB returns insertion order; array is reversed).
// clearUploadLog() wipes all history from IndexedDB.
//
// Rendered as a <details> element — collapsed by default to keep the upload panel compact.
// Summary shows aggregate counts (total files, bytes, errors).
```

---

## `src/components/ChangelogModal.jsx` — In-App Changelog

### Purpose

Shows the app's version history in a modal. The displayed data comes from `src/lib/changelog.js`, which is generated by `build.mjs` from `CHANGELOG.md`.

### Proposed comments

```javascript
// ChangelogModal.jsx

// In-app changelog modal. Data is imported from ../lib/changelog.js, which is generated
// by build.mjs from CHANGELOG.md at build time — do not import or edit changelog.js directly.
// CHANGELOG.md is the single source of truth for version history (§4 build invariant).
//
// The current version badge is shown next to the entry matching CURRENT_VERSION.
// Escape key closes the modal (keyboard accessibility; standard modal behavior).
// Click-outside (modal-overlay) also closes (via onClose prop from parent).
```

---

## `src/main.jsx` — App Bootstrap

### Purpose

Minimal entry point. Mounts the App component into the `#app` element. No setup, configuration, or initialization — everything lives in App.

### Proposed comment

```javascript
// main.jsx

// App bootstrap: mount Preact App component into the #app element defined in index.html.
// All application logic lives in App.jsx. This file exists only to satisfy the esbuild
// entry point requirement and must stay minimal.
render(<App />, document.getElementById('app'));
```

---

## Cross-Cutting Patterns

### Capability detection lifecycle

```
App.jsx            CapabilityPanel.jsx   Browser.jsx / UploadQueue.jsx
   │                     │                         │
   │  capabilities state │                         │
   │─────────────────────►                         │
   │                     │  (read-only display)    │
   │                                               │
   │◄────────────────────────────────────────────  │
   │  onCapabilityChange('upload', 'denied')        │
   │  (called after first PutObject failure)        │
   │                                               │
   │  setCapabilities({...prev, upload:'denied'})  │
   │─────────────────────────────────────────────► │
   │  (capabilities prop updated; button disabled)  │
```

### Error handling philosophy

Every async operation in Browser.jsx and UploadQueue.jsx:
1. Has its own `*Error` state variable
2. Shows an `ErrorBlock` when the error is set
3. Calls `onCapabilityChange(operation, 'denied')` if `isPermissionError(err)` is true
4. Does NOT crash or leave the UI in a broken state — errors are always recoverable

### Session security boundaries

| What | Where stored | Scope |
|------|-------------|-------|
| Secret key | sessionStorage | Current tab only; cleared on close |
| Presigned URLs | DOM only (never stored) | Expire after PRESIGN_EXPIRES (3600s) |
| API responses | In-memory React state | Cleared on page reload |
| Resume records | IndexedDB | Persistent; cleared after successful upload |
| Capability state | localStorage | Persistent; cleared on credential change |
