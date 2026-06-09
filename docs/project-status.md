# Bucketer — Project Status

**Last updated:** 2026-06-09  
**Current version:** v1.17.0  
**Branch:** main

This document is the single authoritative "where things stand" reference. Update it at the end of each working session.

---

## Current state

The core feature set is complete and stable. v1.13–v1.17 was a sustained engineering quality push:

| Version | Work |
|---------|------|
| v1.13.x | Performance hotspots (6 upload-queue CPU optimisations) |
| v1.14.0 | Delete-queue refactor; engineering review conducted |
| v1.15.0 | Shared lib extraction, hook extraction, code deduplication |
| v1.16.0 | Further simplification: 16 libs/hooks extracted, indexeddb split |
| v1.17.0 | Component decomposition: 6 sub-components extracted from UploadQueue/Browser |

**Test suite:** 585 unit + 233 component tests, 0 failures.  
**Largest remaining files:** `Browser.jsx` (1015L), `UploadQueue.jsx` (697L).

> **Note (2026-06-09):** The T1–T5 backlog below is largely complete as of this session. All items through T5-14 are implemented and passing. The only remaining open work is listed in "Suggested next priorities" at the bottom.

---

## Open backlog

Full detail for all items is in `docs/intent/action-plan-v1.14.0-review.md`.

### Tier 1 — Ship-blocking

These are bugs that break core features and should be fixed immediately.

| ID | File | Problem | Fix |
|----|------|---------|-----|
| T1-1 | `Browser.jsx` | `DeleteObjectCommand` missing from SDK import. Every rename throws after the copy succeeds, leaving a duplicate file. | Add `DeleteObjectCommand` to the import on line 9. One word. |
| T1-2 | `test/source-invariants.test.js` | No mechanical check for "SDK command used without being imported" — the whole class that produced T1-1 is undetected. | Add invariant: grep each file for `new XCommand(` usages and assert each is in the `@aws-sdk/client-s3` import. |

### Tier 2 — High priority (next minor release)

Real user-facing bugs and one security fix.

| ID | Problem | Location |
|----|---------|----------|
| T2-1 | `clearCredentials()` wipes all settings (part size, concurrency, cache TTL, etc.) on every disconnect. Silent data loss. Fix: split `LS_KEYS` into `CREDENTIAL_KEYS` and `SETTINGS_KEYS`. | `src/lib/storage.js` |
| T2-2 | Resume path uploads remaining parts sequentially. A 1 GB resume runs ~4× slower than a fresh upload. Fix: share the `uploadPartsWithPool` helper between `uploadMultipart` and `handleResume`. | `src/components/UploadQueue.jsx` |
| T2-3 | `HiddenVersions.handlePurgeAllConfirm` throws on first error, abandoning subsequent batches. Partial deletes with no summary. Fix: accumulate errors across all batches (match `delete-queue.js` pattern). | `src/components/HiddenVersions.jsx` |
| T2-4 | `readUrlParams()` applies no validation to the `endpoint` URL. A crafted share link can pre-fill the form with an attacker-controlled endpoint. Fix: validate `http:` or `https:` scheme only. | `src/lib/url-params.js` |
| T2-5 | README CSP examples are missing `media-src` and `frame-src`. Image/audio/video/PDF previews silently break for anyone who copies the nginx/Caddy config. | `README.md` |
| T2-6 | `handleDeleteConfirm` in `App.jsx` has no try/catch. An uncaught error leaves the delete panel permanently stuck with no dismiss path. | `src/components/App.jsx` |

### Tier 3 — Provider-specific

Individually small; batch into the same release as Tier 2.

| ID | Problem |
|----|---------|
| T3-1 | Wasabi: no 90-day billing warning on delete confirmation dialogs. |
| T3-2 | R2: `HiddenVersions` panel should show a "not supported" message instead of silently returning empty. |
| T3-3 | AWS: `extractRegion()` only matches service endpoint form; virtual-hosted bucket URL (`mybucket.s3.<region>.amazonaws.com`) returns null → wrong region → SignatureDoesNotMatch. |
| T3-4 | MinIO: SetupGuide has no HTTPS mixed-content warning. HTTP MinIO + HTTPS Bucketer = every request silently blocked. |
| T3-5 | B2: SetupGuide doesn't mention `listAllBucketNames` capability. Bucket-scoped keys without it cause SDK initialisation failure. |
| T3-6 | R2: SetupGuide missing Account ID location, payment method requirement, and bucket-scoped vs account-scoped token guidance. |

### Tier 4 — Structural (v2.0 prerequisites)

Not bugs, but required before 2.0 feature work can safely proceed.

| ID | Problem |
|----|---------|
| T4-1 | Extract `usePreview` hook from `Browser.jsx` (~150L, 15 state vars, zero entanglement with listing/rename/delete). First of: `usePreview` → `useRename` → `useMetadata` → `useListingCache`. |
| T4-2 | `handlePreview` stale-closure race: slow HeadObject can resolve after folder navigation and show a modal for the wrong file. Natural to fix alongside T4-1. |
| T4-3 | `discoverPrefixKeys` uses uncapped `Promise.all` — 30+ folder delete can launch 30+ concurrent ListObjectsV2 crawls, triggering 503 throttling. Cap at 4–8. |
| T4-4 | `formatBytes(null/NaN/negative)` renders "NaN undefined" in the size column for delete markers and folder placeholders. Add a null/NaN guard. |
| T4-5 | Three stale factual errors in `docs/QUESTIONS.md` (delete/rename described as out of scope; wrong concurrency default). |
| T4-6 | Accessibility baseline: no focus traps in any modal; no `htmlFor` on labels in CredentialForm/SettingsPanel/UploadQueue. |

### Tier 5 — Small quality-of-life

Do when passing by the relevant file. Full list in `docs/intent/action-plan-v1.14.0-review.md` §Tier 5.

Selected highlights:

| ID | Fix |
|----|-----|
| T5-1 | Build invariant: assert no `sourceMappingURL` leaks into `dist/index.html` |
| T5-2 | Build invariant: bundle size ceiling (600 KB) |
| T5-7 | Single-file row delete fires without confirmation (inconsistent with batch delete flow) |
| T5-9 | Progress bars missing `aria-valuenow`/`aria-valuemin`/`aria-valuemax` |
| T5-11 | Wasabi virtual-hosted style causes SSL errors on dotted bucket names |

---

## Remaining refactoring

### Component decomposition

Three-step plan to reduce the size of the two largest files. Steps 1 and 2 are done.

| Step | Status | Work |
|------|--------|------|
| 1 | ✅ v1.17.0 | `BatchSummary`, `UploadItem`, `ErrorDetailsPanel` extracted from `UploadQueue.jsx` |
| 2 | ✅ v1.17.0 | `CopyLinkPopover`, `Breadcrumb`, `SortTh` extracted from `Browser.jsx` |
| 3 | Open | `StorageModal.jsx` (468L): `Empty`, `KeyName`, `StoreLoc`, `SectionHead`, `Actions` are extractable. `ConfirmDialog` is a closure component (captures `act`/`setConfirm`/`cleared`) — needs prop-threading or left in place. Lowest priority of the three. |

### Hook extraction from Browser.jsx

Tracked as T4-1 above. Planned extraction order:

1. `usePreview` — largest cluster (~150L, 15 state vars), fully self-contained
2. `useRename` — copy+delete state machine
3. `useMetadata` — HeadObject lazy fetch
4. `useListingCache` — in-memory Map + TTL + invalidation

This is a v2.0 prerequisite. Any new 2.0 surface area in `Browser.jsx` is risky until it lands.

---

## Deferred features

### Demo mode (`docs/intent/demo-mode.md`)

Fully designed. A `MockS3Client` that implements the same `client.send()` interface as the real AWS SDK, allowing full UI exploration without credentials. Blocked on implementing the `getObjectUrl(client, command, options)` wrapper in `src/lib/object-url.js` to handle presigned URLs (which bypass `client.send()` and can't be intercepted by the mock). Design is settled; implementation is ready to start.

### Easter egg

Logo triple-tap triggers a 5-phase leak/mop/bandage/refill animation. **Implemented** in `src/components/BucketerLogo.jsx`.

---

## v2.0 roadmap (`docs/roadmap-2.0.md`)

Two major features:

1. **Multi-bucket browsing** — connect once, list all buckets, switch without re-entering credentials. Requires decoupling `bucket` from the credential model (156 usages across the codebase), per-bucket capability state, and `ListBuckets` discovery with graceful fallback.

2. **UI refresh** — responsive layout (mobile breakpoints), visual polish, light/auto theme, accessibility overhaul.

**Five structural prerequisites before 2.0 work begins:**

1. Decouple `bucket` from credential/profile model
2. Key `s3b_capabilities` per bucket (currently global-per-session)
3. Extract custom hooks from `Browser.jsx` (T4-1 above — the first step)
4. Establish a responsive layout skeleton (two breakpoints minimum)
5. Explicitly document the `file://` support stance in `SPEC-DRIFT.md`

---

## Suggested next priorities

All T1–T5 backlog items are done. Remaining work:

1. **T5-1** — ✅ Done (2026-06-09): `sourceMappingURL` absence check added to `build.mjs`.
2. **StorageModal decomposition** — Step 3 of 3 (deferred). `ConfirmDialog` is a closure component; extract the stateless sub-components first.
3. **Demo mode** — Design complete (`docs/intent/demo-mode.md`). Blocked on `src/lib/object-url.js` wrapper for presigned URLs.
4. **v2.0 prerequisites** — All five structural prereqs remain (bucket decoupling, per-bucket capabilities, hook extraction from `Browser.jsx`, responsive skeleton, `SPEC-DRIFT.md`).
