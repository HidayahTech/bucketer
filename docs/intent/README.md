# Bucketer — Design Intent & Codebase Overview

**Version:** 1.0  
**Date:** 2026-06-01  
**Spec baseline:** `docs/s3-browser-spec-v0.15.md`  
**Code baseline:** v1.11.3

This directory documents the *why* behind Bucketer's code — not what each function does (identifiers already communicate that), but why it was written, what user need it serves, and which spec requirement it implements. The goal is to provide a foundation for writing tests grounded in intent and behavior rather than implementation detail.

---

## Documents in This Directory

| File | Covers |
|------|--------|
| `README.md` | This file — architecture, design principles, spec mapping, divergences, test strategy |
| `lib.md` | All nine `src/lib/` modules |
| `browser.md` | `Browser.jsx` — the listing, navigation, preview, and file-operations component |
| `components.md` | All other components: `App`, `CredentialForm`, `SetupGuide`, `CapabilityPanel`, `UploadQueue`, `HiddenVersions`, `UpdateBanner`, `SettingsPanel`, and auxiliary components |

---

## Architecture Overview

Bucketer is a **single-file, no-backend web application** compiled to `dist/index.html` by `build.mjs`. All JS and CSS are inlined; the file can be opened as `file://` or deployed to any static host.

```
User ←→ Browser (Preact SPA)
           │
           └──→ S3-compatible endpoint (AWS SDK v3, SigV4)
                 (requests go directly from browser to provider)
```

There is no server-side component. No credentials leave the browser except as HMAC-signed request headers sent over TLS to the user's own S3 endpoint.

### Data Flow

```
URL hash / localStorage
        │
        ▼
     App.jsx (session state machine)
        │
        ├── CredentialForm  ──→ connectCredentials()
        ├── Browser.jsx     ──→ S3 API calls (list, get, put, delete, copy, head)
        └── UploadQueue.jsx ──→ S3 multipart upload pipeline
```

### Storage Model

| Data | Storage | Cleared |
|------|---------|---------|
| Secret key | `sessionStorage` | On tab close |
| Endpoint, bucket, keyId | `localStorage` | On disconnect |
| Provider override, region | `localStorage` | On disconnect |
| Capability state | `localStorage` | On credential change |
| Upload resume records | IndexedDB | On completion or explicit restart |
| Upload history log | IndexedDB | On explicit clear |
| Listing cache | In-memory (`Map`) | On page reload or credential change |
| Settings (TTL, concurrency, part size) | `localStorage` | Never (user-controlled) |

---

## Design Principles

These principles are embedded throughout the codebase. Tests should validate them as behaviors, not just as code patterns.

1. **Sensible defaults, optional overrides.** Every tunable parameter (page size, part size, concurrency, cache TTL) has a provider-appropriate default and can be overridden in Settings. Code never forces a configuration; it guides.

2. **Explicit state, no implicit flags.** Session state is a single enum (`disconnected | connecting | connected | failed`), not a combination of booleans. Capability state is `permitted | denied | unknown` per operation, not a boolean. Invalid combinations are structurally impossible.

3. **Graceful degradation.** Storage failures (private browsing), SubtleCrypto unavailability (some Safari contexts), file:// protocol restrictions, and AbortError from cancelled fetches are all caught and result in safe fallback behavior, not crashes.

4. **Provider abstraction.** `src/lib/provider.js` is the single place where per-provider differences (path-style, region extraction, CORS requirements) are encoded. Everything else is provider-agnostic.

5. **Credentials never leave the browser.** Secret keys are never sent to any server other than the user's S3 endpoint as part of an HMAC-signed SigV4 request over TLS.

6. **User guidance at the point of need.** CORS instructions appear in the credential form (where the user is about to configure their bucket), not in a separate docs page. Permission denial is surfaced in the capability panel alongside the operation it affects.

---

## Spec Requirements → Code Mapping

| Req | Description | Primary Implementation |
|-----|-------------|----------------------|
| REQ-1 | Credential entry: endpoint, bucket, key ID, secret key | `CredentialForm.jsx` + `src/lib/storage.js` |
| REQ-2 | List objects in bucket with prefix navigation | `Browser.jsx` `fetchPage()`, `navigateTo()` |
| REQ-3 | Download objects via presigned URL | `Browser.jsx` `handleDownload()` |
| REQ-4 | Upload files with progress reporting | `UploadQueue.jsx` `runUpload()`, `uploadMultipart()` |
| REQ-5 | Browser-only architecture; no backend | Build system (`build.mjs`) + no server imports anywhere |
| REQ-6 | Credentials stored locally; never sent to server | `src/lib/storage.js` + SigV4 in AWS SDK |
| REQ-7 | Disable operations not permitted by credentials | `CapabilityPanel.jsx` + `onCapabilityChange` in `App.jsx` + per-button gates in `Browser.jsx` |
| REQ-8 | Resumable multipart uploads across sessions | `UploadQueue.jsx` `uploadMultipart()` + `src/lib/indexeddb.js` |

### Beyond-Spec Features (see `docs/SPEC-DRIFT.md`)

| Feature | Component | Drift Item |
|---------|-----------|------------|
| Delete (file, folder, batch) | `Browser.jsx` | D-1 |
| Rename (copy+delete) | `Browser.jsx` | D-1 |
| New folder creation | `Browser.jsx` | D-1 |
| Hidden versions panel | `HiddenVersions.jsx` | D-6 |
| Listing cache with TTL | `Browser.jsx` | D-7 |
| File concurrency N=3 | `UploadQueue.jsx` | D-3 |
| Raw SDK instead of lib-storage | `UploadQueue.jsx` | D-2 |
| Connection Failed state | `App.jsx`, `Browser.jsx` | D-4 (resolved) |
| File preview | `Browser.jsx` | Beyond scope |
| Dark mode | `main.css` | Beyond scope |
| Drag-and-drop upload | `Browser.jsx` | Beyond scope |
| Update available banner | `UpdateBanner.jsx` | Beyond scope |
| Shareable URL | `url-params.js`, `App.jsx` | Beyond scope |

---

## Spec Divergences Summary

Full details in `docs/SPEC-DRIFT.md`. Summary for test authors:

| ID | What changed | Test impact |
|----|-------------|------------|
| D-1 | Delete, rename, copy all implemented (were out of scope) | These operations are present and testable |
| D-2 | Raw SDK commands, not lib-storage | UploadId available synchronously; resume record saved before first part |
| D-3 | File concurrency default 3, not 2 | Default value differs from spec; configurable |
| D-4 | Connection Failed state is implemented | Initial list failure → `session='failed'` in App |
| D-5 | Resume sequence UploadId description stale | No behavior change; purely doc drift |
| D-6 | Hidden versions panel not in spec | Feature works; no spec to validate against |
| D-7 | Listing cache not in spec | Cache invalidation on mutations is a testable invariant |

---

## Testing Strategy Notes

### What to test and why

**Credential lifecycle (REQ-1, REQ-6):** Test that secret key never lands in localStorage; test that clearing credentials clears all storage. This is a security invariant.

**Capability detection (REQ-7):** Test that denied operations disable their buttons. Test that "Refresh Permissions" resets the state. These are correctness invariants that protect users from silently failing operations.

**Upload resume (REQ-8):** This is the most complex feature and most likely to have subtle bugs. Test the full lifecycle: initial multipart, crash-simulate (reload without completing), re-add same file, resume offers ListParts, upload remaining parts, complete. Also test: file identity mismatch, session expiry (NoSuchUpload from provider), and tab conflict detection.

**Provider detection:** Test each known hostname pattern. Test that custom domains fall through to GENERIC. Test that patterns cannot false-match on path or query string (hostname-only matching).

**Listing cache (D-7):** Test cache hit/miss, TTL expiry, and mutation-triggered invalidation. These are behavioral invariants that affect data freshness.

**Delete marker semantics (D-6):** Test that removing a latest delete marker undeletes the file (modal says "Undelete"). Test that removing a non-latest delete marker has no visibility effect.

**Text preview security:** Test that an HTML file previewed as text is not rendered as HTML. The `ResponseContentType: 'text/plain'` override is a security invariant.

**Multipart cleanup on permission error:** Test that permission failures abort the multipart session and delete the resume record. Orphaned parts on B2 accrue charges.

### What NOT to test

- Provider-side behavior (expiry of presigned URLs, multipart session expiry) — test generation, not provider response
- Actual S3 responses in unit tests — mock the client; test the state machine
- localStorage/sessionStorage internals — test the behavior (credentials persist after reload, secret key cleared on close), not which storage key was written

---

## Source Map

```
src/
  main.jsx                  # App bootstrap (3 lines)
  index.html                # HTML shell with placeholder for bundle + metadata
  styles/main.css           # All styles (inlined at build time)
  assets/
    bucketer-logo.svg       # App logo, reused as SVG favicon data URL
  components/
    App.jsx                 # Session state machine + credential lifecycle
    Browser.jsx             # Listing, navigation, preview, file operations (1351 lines)
    UploadQueue.jsx         # Upload pipeline: small file + multipart + resume (916 lines)
    HiddenVersions.jsx      # Version/delete-marker panel (281 lines)
    UpdateBanner.jsx        # Update detection banner (129 lines)
    CredentialForm.jsx      # Credential entry form with provider auto-detection
    SetupGuide.jsx          # Provider-specific CORS setup instructions
    CapabilityPanel.jsx     # Permission status display
    SettingsPanel.jsx       # Upload/listing configuration panel
    ErrorBlock.jsx          # Structured error display with CORS guidance
    FileBanner.jsx          # file:// protocol warning banner
    UploadLog.jsx           # Persistent upload history
    ChangelogModal.jsx      # In-app changelog
  lib/
    storage.js              # localStorage/sessionStorage wrappers + capability state
    provider.js             # Provider detection, labels, region extraction, path-style
    s3-client.js            # S3Client factory with region resolution
    url-params.js           # Hash fragment serialization (share links, browser history)
    indexeddb.js            # IndexedDB: resume records + upload log
    upload-queue.js         # Bounded-concurrency task queue
    file-entries.js         # Recursive FileSystemEntry traversal (drag-drop)
    format.js               # Formatting: bytes, speed, ETA, S3 error normalization
    media.js                # File type detection: extension + Content-Type
    changelog.js            # GENERATED by build.mjs — do not edit
build.mjs                   # Build pipeline: esbuild + CHANGELOG parse + invariants
dist/index.html             # Build output (committed for auditability)
```
