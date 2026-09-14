# Code Standards & Design Adherence — Bucketer v1.14.0

## Summary

Bucketer v1.14.0 is a disciplined, well-documented codebase that has made meaningful structural progress since the v1.0 review: 18 test files now exist (up from zero), the `@anthropic-ai/claude-code` dependency has been removed from `package.json`, the D1 Connection Failed deviation has been resolved, and new functionality (delete, preview prefetch, upload batches) has been extracted into dedicated `lib/` modules (`delete-queue.js`) and components (`DeleteQueue.jsx`). The most significant open risk is unchanged: `Browser.jsx` has grown to 1326 lines with 53 `useState` calls (up from 33 at 1352 lines in v1.0 — slightly shorter but substantially more state-dense), and the two bugs carried forward from the v1.0 review (`clearCredentials()` silently deleting settings, resume path being serial) remain unresolved. The QUESTIONS.md D1 note is also still marked as an open deviation despite the code having fully resolved it.

---

## Spec Drift (§ by §)

### §3 Scope Note + §6 "Out of Scope" — Outstanding

**Spec says:** "Delete, rename, copy, and bucket management operations are explicitly out of scope for this version." §6 lists Object delete, Multiple saved profiles, and others as deferred.

**Reality:** Single-file delete, batch delete, folder delete, rename, new folder creation, hidden versions/purge-all, and multiple saved credential profiles are all fully implemented. SPEC-DRIFT.md correctly documents this as D-1, with a note that the spec should be updated. The drift is intentional and fully acknowledged, but the spec itself remains stale at v0.15 (dated 2026-05-19). QUESTIONS.md "Known Limitations" section still lists "No delete, rename, copy — out of scope per §6" — a factually incorrect claim that would mislead anyone reading it.

**Status: Outstanding (acknowledged in SPEC-DRIFT.md; QUESTIONS.md still contains stale claims)**

---

### §4.6 lib-storage — Outstanding

**Spec says:** "Use `lib-storage`'s `Upload` class with `leavePartsOnError: true`."

**Reality:** `@aws-sdk/lib-storage` is not in `package.json`. All multipart operations use raw SDK commands (`CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`). This is correctly documented in SPEC-DRIFT.md as D-2 and is an intentional deviation with a clear technical justification (synchronous UploadId access, full part concurrency control).

**Status: Outstanding (intentional; SPEC-DRIFT.md is the authoritative record)**

---

### §4.6 Default file concurrency N=2 vs N=3 — Outstanding

**Spec says:** "Default N = 2."

**Reality:** `DEFAULT_FILE_CONCURRENCY = 3` in `UploadQueue.jsx`. Documented as D-3 in SPEC-DRIFT.md. The QUESTIONS.md "Decisions Made" table still says "N=2 upload concurrency default — Spec §4.6", directly contradicting the live code at line 39 of `UploadQueue.jsx`.

**Status: Outstanding (SPEC-DRIFT.md acknowledged; QUESTIONS.md table contradicts the code)**

---

### §4.14 D1 Connection Failed — Outstanding in QUESTIONS.md only

**Reality:** `App.jsx` fully implements the Connection Failed state. `Browser.jsx` calls `onInitialListFailed(err)` on first-probe failure; `App.jsx` receives it and transitions to `session = 'failed'`, rendering the error block with full diagnostic detail. This was the v1.0 review's finding #4, described as resolved in SPEC-DRIFT.md (D-4).

**Status: Fixed in code. QUESTIONS.md D1 deviation note is stale and has NOT been struck through or removed, contradicting SPEC-DRIFT.md D-4 which says "Action needed: Remove or strike through D1 in QUESTIONS.md."**

---

### §4.2 Required CORS Methods — Fixed (new)

**Spec says:** "Required methods: GET, PUT, HEAD, POST." (Does not mention DELETE.)

**Reality:** `corsJson()` in `src/lib/cors-config.js` includes DELETE in AllowedMethods. This is the correct implementation for the actual feature set (BUG-012), but the spec's §4.2 still does not mention DELETE. Not a critical gap since SPEC-DRIFT.md covers D-1 (delete is fully implemented), but the CORS section of the spec is quietly inconsistent.

**Status: New drift (minor); implementation is correct**

---

## Browser.jsx (the Central Debt)

**Line count:** 1326 | **`useState` calls (including sub-components in same file):** 53 total across the file; approximately 35 belong to the main `Browser` component itself (lines 223–285).

**Distinct UI flows managed in a single render scope:**

1. Prefix navigation and browser history (pushState/popState)
2. Object listing + pagination (Load More)
3. In-memory listing cache (TTL-based)
4. File download (presigned URL)
5. File preview (image, video, audio, PDF, text) — 9 state variables
6. Preview prefetch (adjacent items, Level 1+2)
7. Column sorting (name, size, modified)
8. Filter bar (in-memory)
9. Multi-select (files + folders)
10. Batch copy link — `BatchCopyLinkPopover` sub-component embedded in file
11. Single-file copy link — `CopyLinkPopover` sub-component embedded in file
12. Table row drag-and-drop (enter/leave counter debounce)
13. File properties / metadata panel
14. Rename (copy-then-delete)
15. New folder creation
16. Delete request (delegated to App, but triggering logic lives here)
17. HiddenVersions sub-tree integration

**Concrete extraction proposal (order of attack):**

The cleanest seams are where state, async logic, and cleanup are all self-contained:

1. **`usePreview(client, bucket, prefetchSizeLimit)`** — Owns: `previewItem`, `previewUrl`, `previewError`, `resolvedKind`, `notPreviewable`, `detectedContentType`, `previewText`, `previewTruncated`, `previewPixelated`, `previewCopyOpen`, `previewCopied`, `previewUrlCacheRef`, `prefetchGenRef`, `prevNextRef`, `navigatePreviewRef`. Exposes: `{ previewItem, open, close, navigate, isLoading, ... }`. Keyboard handler (`useEffect` on `previewItem`) moves with it. This is the single largest state cluster (10+ variables) and has zero entanglement with listing or rename logic. Extract to `src/lib/use-preview.js`.

2. **`useRename(client, bucket, invalidateCache)`** — Owns: `renamingKey`, `renameValue`, `renameError`, `renameSaving`. Exposes: `{ start, cancel, commit, renamingKey, ... }`. The rename implementation (copy-then-delete) is pure async logic that belongs in lib. Extract to `src/lib/use-rename.js`.

3. **`CopyLinkPopover` + `BatchCopyLinkPopover` deduplication** — These two components (lines 39–106 and 108–175) share nearly identical structure: same 5 `useState` variables, identical `handleCustomCopy` logic, identical custom input JSX. Unify into a single `CopyLinkPopover({ client, bucket, keys, onClose, onCopied, direction })` that accepts `keys` as an array (single-file passes `[key]`). Eliminates ~70 lines.

4. **`useListingCache(cacheTTL)`** — Owns: `cacheRef`, `fetchPage` cache-check logic, `invalidateCache`. A thin wrapper that is already clearly bounded. Extract to `src/lib/use-listing-cache.js`.

5. **`useMetadata(client, bucket)`** — Owns: `metaItem`, `metaData`, `metaLoading`, `metaError`. Extract to `src/lib/use-metadata.js`.

None of these extractions require splitting Browser.jsx into multiple files — moving hooks to `src/lib/` achieves separation of concerns while keeping the JSX rendering in one place.

---

## UploadQueue.jsx

**Line count:** 1165 | **`useState` calls:** 11 in the main component, plus ~8 in inline sub-components (`BatchRow`, `UploadItem`, `AnimatedBytes`)

**Distinct UI flows:**

1. File queue management (add, enqueue, cancel, abort)
2. Upload execution (small PutObject + multipart worker pool)
3. Resume flow (IndexedDB lookup, identity check, ListParts, serial part upload)
4. Per-batch collapse/expand state
5. Global action bar (dismiss all done, retry all failed, cancel all, collapse/expand all)
6. Per-batch animated speed/bytes display (`BatchRow` sub-component, ~100 lines inline)
7. Per-item animated speed display (`UploadItem` sub-component, ~100 lines inline)
8. Destination prefix override
9. Desktop notification gate
10. Beforeunload warning

The `BatchRow` and `UploadItem` sub-components are substantial enough (100+ lines each with their own hooks) to be extracted as named components in a separate file or at minimum top-level functions, which would reduce cognitive load when reading the main queue logic. The serial resume path (finding #3 from v1.0 review) remains a performance issue: `handleResume` still uses a sequential `for` loop (lines 371–385) rather than the same worker-pool pattern as `uploadMultipart`. For a file with 2000 remaining parts this is ~2× slower than a fresh upload.

---

## Architectural Findings (Severity-Ordered)

### [STD-01] `clearCredentials()` deletes all user settings on every disconnect — High

**Location:** `src/lib/storage.js:72–75`

**Evidence:** `LS_KEYS` contains `maxKeys`, `partConcurrency`, `partSizeMB`, `fileConcurrency`, `listingCacheTTL`, `updateCheckEnabled`, `prefetchSizeLimit`, `uploadExpandThreshold`, and `capabilities` alongside the five credential fields. `clearCredentials()` iterates `Object.values(LS_KEYS)` and removes every key. A user who disconnects (to switch buckets or re-enter credentials) loses all configured settings silently.

**Why it matters:** This is the v1.0 review's Bug #2, now 7 versions later and unresolved. Any user who disconnects loses part concurrency, part size, listing cache TTL, prefetch limit, etc. The storage module's own comment at line 11 says profiles are outside `LS_KEYS` "so clearCredentials() does not remove them on disconnect" — the author clearly understands the pattern, but settings are still caught in the sweep.

**Recommendation:** Split `LS_KEYS` into `CREDENTIAL_KEYS` (endpoint, bucket, keyId, provider, regionOverride) and `SETTINGS_KEYS` (everything else). `clearCredentials()` iterates only `CREDENTIAL_KEYS`. A separate `clearSettings()` or `resetSettings()` is already in the module for explicit resets; this separation just prevents the accidental clear.

---

### [STD-02] Resume path is serial; 10x slower than a fresh upload for large files — High

**Location:** `src/components/UploadQueue.jsx:371–385`

**Evidence:** `handleResume` uses `for (const partNumber of remainingParts) { await client.send(...) }`. This is sequential per-part upload. The `uploadMultipart` fresh path uses a worker pool (`Promise.all(Array.from({ length: concurrency }, worker))`) with the same configurable `PART_CONCURRENCY = 4` default. For a 1 GB file with 200 remaining 5 MB parts, the resume path runs them one-at-a-time; the fresh path runs 4 simultaneously.

**Why it matters:** Resume is specifically designed for interrupted large uploads. Forcing those uploads to be 4× slower on resume than on fresh start undermines the feature's value. This is the v1.0 review's Bug #3, still unresolved.

**Recommendation:** Replace the `for` loop with the same worker-pool pattern: extract a shared `uploadPartsWithPool(remainingParts, partSize, ...)` function used by both `uploadMultipart` and `handleResume`.

---

### [STD-03] `HiddenVersions.handlePurgeAllConfirm` stops on first batch error — Medium

**Location:** `src/components/HiddenVersions.jsx:128–131`

**Evidence:**
```js
if (resp.Errors && resp.Errors.length > 0) {
  const e = resp.Errors[0];
  throw new Error(`Failed to delete ${e.Key}: ${e.Message}`);
}
```
A 2500-item purge in three batches that fails on batch 2 leaves the first 1000 items deleted with no indication of partial success. The v1.0 review flagged this as Bug #7; `Browser.jsx`'s folder delete has been fully replaced by the accumulating-errors approach in `delete-queue.js`, but `HiddenVersions` was not updated to match.

**Why it matters:** Partial purge-all failure leaves the user with deleted items (permanent, unbillable) alongside surviving items, and the error message names only the first failure key. The user has no way to know what was deleted and what wasn't.

**Recommendation:** Replace the throw-on-first-error loop with the same accumulating-errors pattern as `runDeleteOperation`: collect all `resp.Errors`, continue through all batches, display a count + expandable error list at the end.

---

### [STD-04] QUESTIONS.md contains three stale/contradictory claims — Medium

**Location:** `/home/basilgohar/dev/bucketer/docs/QUESTIONS.md`

**Evidence:**
1. D1 deviation (lines 52–63) still describes Connection Failed as unresolved: "Left as a known minor deviation for v0.1." SPEC-DRIFT.md D-4 explicitly says "Action needed: Remove or strike through D1 in QUESTIONS.md." Neither has happened.
2. Known Limitations section (lines 43–44): "No delete, rename, copy — out of scope per §6." Delete, rename, and copy are all fully implemented.
3. Decisions Made table (line 79): "N=2 upload concurrency default — Spec §4.6." The actual default is N=3 (`DEFAULT_FILE_CONCURRENCY = 3`).

**Why it matters:** QUESTIONS.md is the primary onboarding document for understanding known deviations. Three factual errors in 80 lines make it unreliable as a reference.

**Recommendation:** Strike through D1 with a "Resolved in v1.14.0" note. Remove or cross out the stale Known Limitations. Update the Decisions table N=2 → N=3.

---

### [STD-05] `CopyLinkPopover` and `BatchCopyLinkPopover` are 95% identical — Medium

**Location:** `src/components/Browser.jsx:39–175`

**Evidence:** Both components have identical state declarations (`showCustom`, `customValue`, `customUnit`, `copying`, `error`), identical `handleCustomCopy` implementations (same validation, same `mult` object, same 7-day cap), and identical custom input JSX (~25 lines). The only difference is that `BatchCopyLinkPopover` takes `keys: string[]` and calls `Promise.all(keys.map(...))` while `CopyLinkPopover` takes a single `fileKey`. This is 135 lines of near-duplication in the codebase's most complex file.

**Why it matters:** Any change to expiry logic, validation, or custom input UX must be made in two places. This is exactly the kind of crystallised duplication worth extracting.

**Recommendation:** Unify into `CopyLinkPopover({ client, bucket, keys, onClose, onCopied, direction })` where `keys` is always an array. Callers pass `[fileKey]` for single-file cases. Reduces Browser.jsx by ~70 lines and puts the single copy/batch copy logic in one place.

---

### [STD-06] Three `useEffect` calls with identical "dismiss popover on outside click" pattern — Low

**Location:** `src/components/Browser.jsx:420–445`

**Evidence:** Three consecutive `useEffect` calls (tableCopyKey, previewCopyOpen, batchCopyOpen) each add a `mousedown` document listener that checks `containerRef.contains(e.target)` and closes the popover if the click was outside. The pattern is identical except for the ref and the setter. This is at the threshold of worthwhile abstraction but is only ~10 lines per block.

**Recommendation:** Extract a `useOutsideClick(ref, isOpen, onClose)` hook — standard React/Preact pattern. Reduces 30 lines to 3 call sites. Nit-level for now, but if a fourth popover is added it should push this over the threshold.

---

### [STD-07] Module-level `_sessionFirstMount` is an implicit global — Low

**Location:** `src/components/Browser.jsx:23`

**Evidence:** `let _sessionFirstMount = true;` at module scope. The comment explains the reasoning (persists across remounts). The v1.0 review flagged this as finding #6 — "hidden coupling between module load order and component behavior." The `_` prefix is a reasonable convention signal, but the coupling still exists.

**Why it matters:** In development with hot module reloading it won't reset between reloads. More importantly, it is invisible state that affects `Browser`'s initial behavior — a reader must notice this module-level variable to understand why the first mount behaves differently.

**Recommendation:** Pass as a prop from `App.jsx` using a ref: `const sessionFirstMountRef = useRef(true)` in App, passed as `isFirstMount={sessionFirstMountRef.current}` with a callback `onFirstMountConsumed={() => { sessionFirstMountRef.current = false; }}`. Makes the dependency explicit and testable.

---

### [STD-08] `useCallback` absent from `handleCapabilityChange` in App.jsx but used correctly — Nit

**Location:** `src/components/App.jsx:93–100`

**Evidence:** `handleCapabilityChange` is correctly wrapped in `useCallback([], [])`. However, `handleDisconnect`, `handleDeleteRequest`, `handleDeleteConfirm`, `handleDeleteDismiss`, `handleDeleteCollapse`, `handleCopyLink`, `handleSelectProfile`, `handleSaveProfile`, `handleDeleteProfile` are all plain functions re-created on every render and passed as props to `Browser`, `UploadQueue`, `DeleteQueue`, and `ProfilePicker`. None of these are passed to memoized components (Preact doesn't use `React.memo`), so the re-creation is harmless. The `useCallback` on `handleCapabilityChange` appears cargo-culted rather than performance-motivated.

**Recommendation:** Either wrap all of the above in `useCallback` for consistency, or remove the `useCallback` from `handleCapabilityChange` to make the inconsistency go away. Since Preact doesn't use memo by default, neither is performance-critical. Prefer consistency.

---

## Component-by-Component Verdict

**Browser.jsx (1326 lines)** — The most complex file in the codebase remains the highest-risk item. It has actually grown slightly denser in state (53 `useState` calls vs 33 in v1.0) despite dropping 26 lines, because delete was extracted to `App.jsx`/`delete-queue.js` (a correct extraction) while preview, prefetch, and rename logic was added inline. The preview state cluster (10 state variables, 2 refs, a useEffect, and an async prefetch function) is the clearest extraction candidate and should be the first custom hook created.

**UploadQueue.jsx (1165 lines)** — Well-structured for its complexity. The upload execution logic (`runUpload`, `uploadSmall`, `uploadMultipart`) is clean. The serial resume path is a concrete performance bug. `BatchRow` and `UploadItem` as inline sub-components work but make the file harder to scan — they would read better as top-level exported functions in the same file or a companion `UploadQueueParts.jsx`.

**App.jsx (541 lines)** — Growing steadily with profile management (BUG-016 through BUG-020 drove significant expansion). The delete operation state (`deleteOps` array + four handlers) is the newest addition and is clean: it mirrors the upload queue pattern correctly. The credentials initializer at lines 59–68 is the most complex state initialization in the app and deserves the large comment it has. The `liveFormData` / `credentials` split is a necessary complexity from BUG-018/020, but it means there are now effectively two credential state variables in flight simultaneously, which is worth documenting more explicitly.

**StorageModal.jsx (468 lines)** — A pure display component for the storage viewer. Well-decomposed into small helper components (`SectionHead`, `StoreLoc`, `KeyName`, `Actions`). No logic beyond loading and clearing; the 468 lines are almost entirely JSX. Clean.

**SetupGuide.jsx (401 lines)** — Provider-conditional rendering for CORS setup instructions. The `corsCmd` function's inline template at lines 74–80 is readable. The `Code` sub-component with its copy button correctly uses `type="button"` (BUG-006 fix). The main function body uses `needsCorsConfig` and provider identity correctly. Clean for its purpose, though the AWS/B2/R2/Wasabi/MinIO branching makes it verbose.

**BucketerLogo.jsx (371 lines)** — 90% of this file is inline SVG path data for the Easter egg animation phases. The component logic (triple-tap detection, phase cycling, CSS class gating) is 40 lines of clean code. The SVG paths cannot be meaningfully shortened. Acceptable as-is; the bulk is unavoidable for an inlined animated SVG.

---

## BUG-LOG ↔ Test Cross-Reference Table

| Bug | Test coverage claimed | Test exists | Test asserts the right thing |
|-----|----------------------|-------------|------------------------------|
| BUG-001 | `test/build.test.js` — placeholder replacement | yes | yes |
| BUG-002 | `test/build.test.js` — Preact JSX transform | yes | yes |
| BUG-003 | `test/calc-part-size.test.js` — preparePutBody | yes | yes |
| BUG-004 | None — DOM/jsdom required | N/A | N/A (acknowledged) |
| BUG-005 | None — DOM/jsdom required | N/A | N/A (acknowledged) |
| BUG-006 | `test/source-invariants.test.js` | yes | yes |
| BUG-007 | `test/collect-parts.test.js` — pagination | yes | yes |
| BUG-008 | `test/indexeddb-storage.test.js` — buildFileIdentityWithHash | yes | yes |
| BUG-009 | None — embedded in component | N/A | N/A (acknowledged) |
| BUG-010 | None — internal App.jsx state | N/A | N/A (acknowledged) |
| BUG-011 | None — internal UploadQueue state | N/A | N/A (acknowledged) |
| BUG-012 | `test/cors-config.test.js` + `test/build.test.js` | yes | yes |
| BUG-013 | `test/url-params.test.js` — hash fragment | yes | yes |
| BUG-014 | `test/source-invariants.test.js` — hook imports | yes | yes |
| BUG-015 | `test/indexeddb-pure.test.js` — uploadExpiryWarningMs | yes | yes |
| BUG-016 | `test/storage.test.js` + `test/url-params.test.js` + `test/credential-form-validation.test.js` | yes | yes |
| BUG-017 | `test/source-invariants.test.js` — declaration order | yes | yes |
| BUG-018 | None — DOM-dependent | N/A | N/A (acknowledged) |
| BUG-019 | `test/provider.test.js` — Wasabi bare endpoint | yes | yes |
| BUG-020 | None — DOM-dependent | N/A | N/A (acknowledged) |
| BUG-021 | `test/source-invariants.test.js` — MAX_DISPLAY cap | yes | yes (cap bounded) |
| BUG-022 | None — DOM-dependent | N/A | N/A (acknowledged) |
| BUG-023 | None — no test | no | N/A |
| BUG-024 | None — no test | no | N/A |
| BUG-025 | `test/format.test.js` — isBlockedByExtension | yes | yes |

**Notes:**
- BUG-023 and BUG-024 (both from v1.14.0) are listed as "No automated test — fix verified by manual testing" in BUG-LOG.md. Both are unit-testable in `upload-queue.test.js` or a new `upload-queue-cancel.test.js` without DOM: BUG-023 needs a mock `deleteResumeRecord` spy; BUG-024 needs a delayed mock `loadResumeRecord` and a cancel signal.
- 11 bugs have no automated test by acknowledged necessity (DOM/component-level). The new test file count (18) relative to 25 bugs is healthy — approximately 60% of bugs have mechanical regression prevention.

---

## Verification of v1.0 Review Items (Design Lens)

**Browser.jsx extraction — Not started.** The v1.0 review named `usePreview`, `useDelete`, `useRename` as the first candidates. `useDelete` has been addressed differently (delete moved to `App.jsx` + `delete-queue.js`, which is architecturally correct). But `usePreview` and `useRename` remain inline in Browser.jsx, and preview has grown significantly (prefetch, pixelated detection, URL cache). The extraction opportunity is now larger and clearer than in v1.0.

**`clearCredentials()` settings bug — Not fixed.** Still at the same lines in `storage.js`. The module comment added at line 11 ("profiles are outside LS_KEYS so clearCredentials() does not remove them on disconnect") demonstrates the author is aware of the pattern and applied it for profiles. Settings are still swept.

**file:// stance — Confirmed and documented.** SPEC-DRIFT.md and QUESTIONS.md both reference file:// behavior. `FileBanner.jsx` exists and handles the browser context warning. The v1.0 review raised this as a "decide" item, and the decision appears to be: continue supporting it. That is fine; the explicit documentation in SPEC-DRIFT.md makes it a conscious choice.

**Tests added — Substantially addressed.** 18 test files cover all pure lib modules. The v1.0 review's specific recommendations (`upload-queue.js`, `format.js`, `provider.js`) are all covered. The gap is in component-level integration tests; those are acknowledged in BUG-LOG.md as DOM-dependent. The coverage model (test lib boundaries, assert source invariants structurally, assert build output) is sound and consistent with the CLAUDE.md philosophy.

**Serial resume path — Not fixed.** `handleResume` in `UploadQueue.jsx` at line 371 is still a sequential `for` loop. This is the v1.0 review's Bug #3.

**HiddenVersions partial-failure handling — Not fixed.** `handlePurgeAllConfirm` still throws on first batch error (line 130). This is the v1.0 review's Bug #7.

**@anthropic-ai/claude-code in package.json — Fixed.** Not present anywhere in `package.json` or `package-lock.json`. Confirmed.

---

## CLAUDE.md Adherence

**"Don't add comments that explain WHAT":** Mostly compliant. Comments in Browser.jsx and UploadQueue.jsx explain architectural decisions, spec citations (§4.14, §4.15), and non-obvious invariants ("isInitialProbeRef gates a single call to onInitialListFailed"). The inline ref comments on lines 274–276 (`previewUrlCacheRef`, `prefetchGenRef`, `prevNextRef`) explain the shape of the data structure, which is borderline — they document the type that TypeScript would encode, not the reason. Acceptable given no TypeScript.

**"No backwards-compat shims":** Compliant. `repairStorageInvariants()` and `migrateProfilesFromLegacy()` are one-time migration and repair functions (not perpetual shims) that run on mount and are idempotent no-ops once data is clean. This is correct.

**"Tests must pass before every push" — pre-push hook:** Verified. `.githooks/pre-push` runs `npm run build` then `npm test`, aborts on failure, and the recursive tag-push detection via `grep -c 'refs/heads/'` correctly skips the build/test cycle for tag-only pushes. Hook is correct.

**"@anthropic-ai/claude-code must not appear in package.json":** Compliant. Confirmed absent from `package.json` and from `devDependencies`.

**"Build invariants enforced in build.mjs":** Compliant. Both invariants documented in CLAUDE.md (update-check range boundary, CHANGELOG version match) are implemented in `build.mjs` and only run in `prod` mode (when `mode.invariants === true`). The constants are synchronized between `build.mjs` (`UPDATE_CHECK_RANGE_BYTES = 512`) and should be in `UpdateBanner.jsx` as well — that cross-file sync requirement is documented in CLAUDE.md. The `parseChangelog` regex is reasonably robust; the `split(/^## /m)` approach handles the expected format without fragile lookaheads.

**QUESTIONS.md stale content:** Three factual errors as documented in STD-04. This is not a CLAUDE.md violation per se, but it undermines the documentation-as-contract principle the project otherwise follows carefully.
