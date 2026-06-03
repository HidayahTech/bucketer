# Bucketer Storage Catalog

Complete catalog of every piece of data the app stores in the browser, including
historical provenance, schema, lifecycle, and security classification.

Last updated: v1.13.2 (2026-06-03)

---

## Overview

Bucketer uses three browser storage mechanisms:

| Mechanism | Survives Tab Close | Survives Browser Restart | Cleared By |
|---|---|---|---|
| **localStorage** | Yes | Yes | Explicit removal or browser data wipe |
| **sessionStorage** | No | No | Tab close or page reload |
| **IndexedDB** | Yes | Yes | Explicit deletion or browser data wipe |

All storage is **origin-scoped**: data is isolated per domain+port. A Bucketer
instance at `https://bucketer.example.com` and one at `https://other.example.com`
have completely separate storage — they cannot see each other's data.

**Security posture:** The secret key (`s3b_secret_key`) is the only credential
that grants access to the bucket. It is intentionally stored in `sessionStorage`
so it is never written to disk. All other credential fields go to `localStorage`
so the user is not burdened with re-entering endpoint and bucket on every session.
No credentials of any kind are ever stored in IndexedDB.

---

## localStorage Keys

All keys use the `s3b_` prefix. There are currently **15 active keys** — none
have ever been removed or renamed since the initial commit.

### Credential Fields

These four keys hold the non-sensitive portion of the last-used connection.
They are written by `saveCredentials()` and cleared by `clearCredentials()`.
They are also the source data for `migrateProfilesFromLegacy()`, which reads
them to create the first profile for users upgrading from pre-v1.13.0.

---

#### `s3b_endpoint`

| Property | Value |
|---|---|
| **Type** | string |
| **Example** | `https://s3.us-west-004.backblazeb2.com` |
| **Introduced** | Initial commit (2026-05-21) |
| **Cleared by** | `clearCredentials()` on disconnect |
| **Owner** | `src/lib/storage.js` via `loadCredentials()` / `saveCredentials()` |

The full S3 API endpoint URL for the last-used provider. Trimmed and
trailing-slash-stripped before saving so `https://x.com/` and `https://x.com`
produce identical S3Clients.

---

#### `s3b_bucket`

| Property | Value |
|---|---|
| **Type** | string (1–63 chars, no whitespace; validated at write boundary) |
| **Example** | `my-photos` |
| **Introduced** | Initial commit (2026-05-21) |
| **Cleared by** | `clearCredentials()` on disconnect |
| **Owner** | `src/lib/storage.js` |

The S3 bucket name for the last-used connection.

---

#### `s3b_key_id`

| Property | Value |
|---|---|
| **Type** | string (no whitespace; validated at form level) |
| **Example** | `000a8794834eb7c000000001c` |
| **Introduced** | Initial commit (2026-05-21) |
| **Cleared by** | `clearCredentials()` on disconnect |
| **Owner** | `src/lib/storage.js` |
| **Sensitivity** | Low — key ID alone cannot access the bucket |

The access key ID (not the secret key). This is the public half of the
credential pair and is safe to persist across sessions.

---

#### `s3b_provider`

| Property | Value |
|---|---|
| **Type** | string, max 20 chars, no whitespace; one of `b2`, `r2`, `aws`, `wasabi`, `do_spaces`, `minio`, `generic`, or empty |
| **Example** | `b2` |
| **Introduced** | Initial commit (2026-05-21) |
| **Cleared by** | `clearCredentials()` on disconnect |
| **Owner** | `src/lib/storage.js` |

Internal provider enum used to apply provider-specific behaviour (path-style
requests, region extraction, CORS advice). Validated at both the read boundary
(`loadCredentials()`) and the write boundary (`saveCredentials()`). A corrupted
value (longer than 20 chars or containing whitespace) is silently replaced with
empty string on write and returned as `null` on read. `repairStorageInvariants()`
clears a corrupted value on app mount. See BUG-016.

---

#### `s3b_region_override`

| Property | Value |
|---|---|
| **Type** | string (no whitespace; validated at form level) |
| **Example** | `us-east-1` |
| **Introduced** | Initial commit (2026-05-21) |
| **Cleared by** | `clearCredentials()` on disconnect |
| **Owner** | `src/lib/storage.js` |

Optional region override. Empty string means "auto-detect from endpoint or use
provider default." Shown only when the endpoint does not embed the region.

---

### Settings

Settings survive disconnect — they are stored outside `LS_KEYS` (wait: they ARE
inside `LS_KEYS` and ARE cleared by `clearCredentials()`). See the note in the
`clearCredentials()` section below.

> **Note on settings and disconnect:** `clearCredentials()` calls
> `Object.values(LS_KEYS).forEach(k => remove(k))`, which removes ALL of LS_KEYS
> including settings. This means user settings (max keys, part size, etc.) are
> wiped on disconnect. This is likely unintentional and worth revisiting.

---

#### `s3b_max_keys`

| Property | Value |
|---|---|
| **Type** | string (integer) |
| **Example** | `200` |
| **Introduced** | Initial commit (2026-05-21) |
| **Default** | `null` → provider default (usually 1000) |
| **Cleared by** | `clearCredentials()` |
| **Owner** | `src/lib/storage.js` via `loadMaxKeys()` / `saveMaxKeys()` |

Maximum number of items returned per `ListObjectsV2` page. Setting this lower
reduces memory usage in large buckets.

---

#### `s3b_part_concurrency`

| Property | Value |
|---|---|
| **Type** | string (integer) |
| **Example** | `4` |
| **Introduced** | ~2026-05-27 (around v1.0 rename) |
| **Default** | `null` → component default |
| **Cleared by** | `clearCredentials()` |
| **Owner** | `src/lib/storage.js` via `loadPartConcurrency()` / `savePartConcurrency()` |

Number of parts uploaded in parallel for a single multipart file upload.

---

#### `s3b_part_size_mb`

| Property | Value |
|---|---|
| **Type** | string (integer, megabytes) |
| **Example** | `16` |
| **Introduced** | ~2026-05-27 (around v1.0 rename) |
| **Default** | `null` → `calcPartSize()` default |
| **Cleared by** | `clearCredentials()` |
| **Owner** | `src/lib/storage.js` via `loadPartSizeMB()` / `savePartSizeMB()` |

Preferred multipart chunk size in megabytes. Overridden by `calcPartSize()` if
the requested size would produce more than 10,000 parts for a large file.

---

#### `s3b_file_concurrency`

| Property | Value |
|---|---|
| **Type** | string (integer) |
| **Example** | `3` |
| **Introduced** | ~2026-05-27 (before v1.8.0) |
| **Default** | `null` → component default |
| **Cleared by** | `clearCredentials()` |
| **Owner** | `src/lib/storage.js` via `loadFileConcurrency()` / `saveFileConcurrency()` |

Number of files uploaded in parallel when multiple files are enqueued.

---

#### `s3b_listing_cache_ttl`

| Property | Value |
|---|---|
| **Type** | string (integer, seconds; `0` = disabled) |
| **Example** | `120` |
| **Introduced** | v1.8.0 (2026-05-28) |
| **Default** | `null` → 120 seconds |
| **Cleared by** | `clearCredentials()` |
| **Owner** | `src/lib/storage.js` via `loadListingCacheTTL()` / `saveListingCacheTTL()` |

TTL for the in-memory folder listing cache in `Browser.jsx`. The cache itself
is in-memory only — it does not survive tab close. This key stores only the
user's TTL preference.

---

#### `s3b_update_check_enabled`

| Property | Value |
|---|---|
| **Type** | string (`'true'` or `'false'`) |
| **Example** | `'true'` |
| **Introduced** | v1.12.24 (2026-06-02) |
| **Default** | `true` (empty string reads as true — preserves pre-setting behaviour) |
| **Cleared by** | `clearCredentials()` |
| **Owner** | `src/lib/storage.js` via `loadUpdateCheckEnabled()` / `saveUpdateCheckEnabled()` |

Whether the app should poll the host for a newer version in the background. The
check uses a `Range: bytes=0-511` request to read only the version metadata from
the remote `index.html` without downloading the full page.

---

### Capability State

#### `s3b_capabilities`

| Property | Value |
|---|---|
| **Type** | JSON string |
| **Introduced** | Initial commit (2026-05-21); `delete` field added ~2026-05-26 |
| **Cleared by** | `clearCapabilities()`, called inside `clearCredentials()` and `handleConnect()` |
| **Owner** | `src/lib/storage.js` via `loadCapabilities()` / `saveCapabilities()` / `clearCapabilities()` |

JSON schema:
```json
{
  "list":     "unknown | denied | permitted",
  "download": "unknown | denied | permitted",
  "upload":   "unknown | denied | permitted",
  "delete":   "unknown | denied | permitted"
}
```

Tracks which operations the current key is allowed to perform. Updated
reactively when an operation fails with AccessDenied/403. `'unknown'` means
the operation has not yet been attempted; the UI treats it as permitted.
Parse failure falls back to `defaultCapabilities()` (all `'unknown'`).

---

### Profile Management

These two keys are intentionally **outside `LS_KEYS`** so `clearCredentials()`
does not remove them on disconnect. Profiles should survive across sessions and
disconnections.

---

#### `s3b_profiles`

| Property | Value |
|---|---|
| **Type** | JSON string |
| **Introduced** | v1.13.0 (2026-06-02) |
| **Cleared by** | Only explicit profile deletion or "wipe all app data" |
| **Owner** | `src/lib/storage.js` via `loadProfiles()` / `saveProfile()` / `deleteProfile()` |

Versioned envelope containing the array of saved connection profiles.

JSON schema (version 1):
```json
{
  "version": 1,
  "profiles": [
    {
      "id": 1717345612345,
      "name": "B2 — my-photos",
      "endpoint": "https://s3.us-west-004.backblazeb2.com",
      "bucket": "my-photos",
      "keyId": "000a8794834eb7c000000001c",
      "provider": "b2",
      "regionOverride": ""
    }
  ]
}
```

`id` is `Date.now()` at creation time. `secretKey` is **never stored** — it must
be re-entered each session. Parse failure returns an empty profiles array; the
app never crashes on corrupt profile data.

---

#### `s3b_last_profile_id`

| Property | Value |
|---|---|
| **Type** | string (integer, stringified `Date.now()` value) |
| **Example** | `'1717345612345'` |
| **Introduced** | v1.13.0 (2026-06-02) |
| **Cleared by** | `saveLastProfileId(null)` when the selected profile is deleted |
| **Owner** | `src/lib/storage.js` via `loadLastProfileId()` / `saveLastProfileId()` |

The `id` of the last-selected profile. On next load, the app uses this to
pre-fill the credential form with that profile's data (endpoint, bucket, keyId,
provider, regionOverride). The key is removed entirely when set to null —
absence and null are equivalent.

---

### Transient Cross-Tab State

#### `s3b_active_uploads`

| Property | Value |
|---|---|
| **Type** | JSON string |
| **Example** | `{"photos/trip.jpg": "k3j2l1m4n5"}` |
| **Introduced** | ~2026-05-23 (tab conflict detection) |
| **Cleared by** | `markUploadInactive()` when each upload completes or fails |
| **Owner** | `src/lib/indexeddb.js` via `markUploadActive()` / `markUploadInactive()` / `isUploadActiveElsewhere()` |

JSON object mapping destination S3 key → tab-unique ID (random string generated
at module load time). Used to detect when two tabs are uploading to the same
destination, which would corrupt each other's multipart sessions. Each tab only
clears entries it owns. Orphan entries (from crashed tabs) are ignored — they
prevent re-uploads but do not corrupt any data.

Semantics: if `active[destinationKey]` exists and does not match this tab's ID,
a concurrent-upload warning is shown.

---

## sessionStorage Keys

sessionStorage is cleared when the tab closes. No sessionStorage value
survives across sessions.

---

#### `s3b_secret_key`

| Property | Value |
|---|---|
| **Type** | string |
| **Introduced** | Initial commit (2026-05-21) |
| **Cleared by** | Tab close (automatic); `clearCredentials()` (explicit) |
| **Owner** | `src/lib/storage.js` via `loadCredentials()` / `saveCredentials()` / `clearCredentials()` |
| **Sensitivity** | **High** — this is the S3 secret access key |

The S3 secret access key. Stored in sessionStorage as the core security
posture of the app: the secret key is never written to disk, never survives
tab close, and is never included in profiles or share URLs. The user must
re-enter it each session.

In private browsing mode, sessionStorage throws on write; the app continues
with in-memory state only (the credential still works for the session but is
not persisted at all).

---

#### `s3b_file_banner_dismissed`

| Property | Value |
|---|---|
| **Type** | string (`'1'`) |
| **Introduced** | ~2026-05-26 |
| **Cleared by** | Tab close (automatic) |
| **Owner** | `src/components/FileBanner.jsx` (direct sessionStorage access — not via storage.js) |

Set to `'1'` when the user dismisses the `file://` protocol warning banner.
The banner warns that `file://` origins have unusual storage behaviour (Chrome
shares localStorage across all local HTML files under the null origin). Using
sessionStorage instead of localStorage means the warning reappears on each page
load, which is intentional — a user running Bucketer from a local file regularly
should see the warning until they deploy to a real domain.

---

## IndexedDB

Database name: **`s3browser`**
Current version: **2**

Version history:
- **Version 1** (initial commit, 2026-05-21): single store `s3browser_uploads`
- **Version 2** (~2026-05-27, before v1.8.0): added `bucketer_upload_log`

The `onupgradeneeded` handler creates each store conditionally
(`if (!db.objectStoreNames.contains(STORE))`) so upgrades are non-destructive.

---

### Object Store: `s3browser_uploads`

| Property | Value |
|---|---|
| **Key type** | Explicit string key |
| **Key format** | `provider:endpoint:bucket:destinationKey` |
| **Example key** | `b2:https://s3.us-west-004.backblazeb2.com:my-bucket:uploads/photo.jpg` |
| **Introduced** | Version 1 (initial commit) |
| **Owner** | `src/lib/indexeddb.js` via `saveResumeRecord()` / `loadResumeRecord()` / `deleteResumeRecord()` |

Stores one record per in-progress multipart upload. A record is created
**before** any part is uploaded (critical invariant: if the browser crashes
before any part completes, the record exists and recovery is possible). Records
are deleted on upload completion or on permission error (a permission error is
permanent and cannot be resumed).

Record schema:
```json
{
  "provider": "b2",
  "endpoint": "https://s3.us-west-004.backblazeb2.com",
  "bucket": "my-bucket",
  "destinationKey": "uploads/photo.jpg",
  "uploadId": "abc123def456...",
  "partSize": 5000000,
  "fileIdentity": {
    "name": "photo.jpg",
    "size": 52428800,
    "lastModified": 1717345600000,
    "contentHash": "a1b2c3d4..."
  },
  "startedAt": 1717345612345
}
```

`contentHash` is the SHA-256 of the first and last 64 KB of the file, computed
via `crypto.subtle.digest`. It is `undefined` (absent) if SubtleCrypto is
unavailable (e.g. Safari + `file://`). On resume, `fileIdentityMatches()`
verifies the user re-selected the same file before continuing.

---

### Object Store: `bucketer_upload_log`

| Property | Value |
|---|---|
| **Key type** | Auto-increment integer |
| **Introduced** | Version 2 (~2026-05-27) |
| **Owner** | `src/lib/indexeddb.js` via `saveUploadLogEntry()` / `loadUploadLog()` / `clearUploadLog()` |

Persistent history of every completed or failed upload. Displayed in the
`UploadLog` component in the connected main view. The user can clear the log
via the "Clear" button in the UI.

Entry schema:
```json
{
  "fileName": "photo.jpg",
  "destinationKey": "uploads/2024/photo.jpg",
  "fileSize": 2097152,
  "status": "done",
  "startedAt": 1717345612000,
  "completedAt": 1717345620500,
  "durationSec": 8.5,
  "avgSpeedBps": 246676.47,
  "errorMessage": null
}
```

`status` is `'done'` or `'error'`. `avgSpeedBps` is `null` for errors.
`errorMessage` is `null` for successful uploads.

---

## What `clearCredentials()` Actually Clears

`clearCredentials()` removes every key in `LS_KEYS` from localStorage plus
`s3b_secret_key` from sessionStorage. It does **not** clear:

- `s3b_profiles` — intentional: profiles survive disconnect
- `s3b_last_profile_id` — intentional: the selected profile is remembered
- `s3b_active_uploads` — not in LS_KEYS; transient state managed separately
- IndexedDB stores — not touched by credentials clearing

Side effect worth noting: settings (`s3b_max_keys`, `s3b_part_concurrency`,
etc.) ARE inside `LS_KEYS` and ARE wiped on disconnect. This means user-
configured upload settings are lost each time the user disconnects. This
appears to be an unintentional consequence of the flat LS_KEYS structure
and is a candidate for a future fix.

---

## Complete Key Reference

| Key | Store | Survives Tab Close | Cleared By | Category |
|---|---|---|---|---|
| `s3b_endpoint` | localStorage | Yes | `clearCredentials()` | Credential |
| `s3b_bucket` | localStorage | Yes | `clearCredentials()` | Credential |
| `s3b_key_id` | localStorage | Yes | `clearCredentials()` | Credential |
| `s3b_provider` | localStorage | Yes | `clearCredentials()` | Credential |
| `s3b_region_override` | localStorage | Yes | `clearCredentials()` | Credential |
| `s3b_max_keys` | localStorage | Yes | `clearCredentials()` | Settings |
| `s3b_part_concurrency` | localStorage | Yes | `clearCredentials()` | Settings |
| `s3b_part_size_mb` | localStorage | Yes | `clearCredentials()` | Settings |
| `s3b_file_concurrency` | localStorage | Yes | `clearCredentials()` | Settings |
| `s3b_listing_cache_ttl` | localStorage | Yes | `clearCredentials()` | Settings |
| `s3b_update_check_enabled` | localStorage | Yes | `clearCredentials()` | Settings |
| `s3b_capabilities` | localStorage | Yes | `clearCapabilities()` | Runtime State |
| `s3b_profiles` | localStorage | Yes | Explicit deletion only | Profiles |
| `s3b_last_profile_id` | localStorage | Yes | Profile deletion | Profiles |
| `s3b_active_uploads` | localStorage | Yes | Upload complete/fail | Transient State |
| `s3b_secret_key` | sessionStorage | **No** | Tab close / `clearCredentials()` | Credential (sensitive) |
| `s3b_file_banner_dismissed` | sessionStorage | **No** | Tab close | UI State |
| `s3browser_uploads` (records) | IndexedDB | Yes | Upload complete/error/explicit | Resume Records |
| `bucketer_upload_log` (entries) | IndexedDB | Yes | `clearUploadLog()` | History |
