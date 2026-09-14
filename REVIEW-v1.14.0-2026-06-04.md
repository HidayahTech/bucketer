# Bucketer v1.14.0 — Consolidated Engineering Review

**Date:** 2026-06-04
**Scope:** Full codebase + production build artifact at commit `1db477d` (v1.14.0)
**Method:** Five specialised review lanes (Security, Correctness, Code Standards, Build/Perf, Roadmap/UX) run in parallel, then synthesised. Raw per-lane outputs preserved at `docs/review-v1.14.0/01..05-*.md`.
**Prior review of record:** `eng-review-v1.0-2026-05-28.md` (at v1.10.0). Every finding from that review is verified below as Fixed / Still present / Partially fixed.

---

## Executive Summary

Bucketer continues to be a disciplined, well-instrumented codebase that delivers a non-trivial product in a remarkably small surface area. Between v1.10 and v1.14, real progress was made: 18 test files exist (up from zero); `@anthropic-ai/claude-code` is gone from `package.json`; the Connection-Failed deviation is resolved in code; delete was extracted out of `Browser.jsx` into a clean `delete-queue.js` + `DeleteQueue.jsx` lane with proper error accumulation; six measured perf hotspots (rAF coalescing, timestamp cache, single-loop aggregation, visibility throttling, parallel delete, render cap) shipped between v1.13.14 and v1.14.0 with 17–93 % CPU reductions. The build pipeline enforces both documented invariants, ships a clean 521 KB self-contained artifact with no source-map / secret / dev-path leakage, and the pre-push + CI test gates are correctly wired.

The single most urgent finding is **new and not in the prior review**: `Browser.jsx` uses `DeleteObjectCommand` at line 564 inside `commitRename`, but the SDK import at line 9 does not include it. Every rename therefore throws `ReferenceError` after the copy step has already succeeded — leaving a duplicate file in the bucket with the new name while the original survives. This is a Critical, ship-blocking runtime regression, almost certainly introduced when the unified-delete refactor in v1.14.0 moved delete imports out of `Browser.jsx`.

Three concrete defects flagged in the v1.0 review remain unresolved seven minor versions later: `clearCredentials()` still wipes all user settings on every disconnect; `HiddenVersions.handlePurgeAllConfirm` still throws on the first batch error and leaves partial deletes invisible; and the multipart resume path is still a serial `for` loop while the fresh-upload path uses a 4-way worker pool. `_sessionFirstMount` is still a module-level mutable. Documentation drift has *grown*: `docs/QUESTIONS.md` contains three factually incorrect claims (D1 deviation, "delete is out of scope", N=2 file concurrency) that contradict both the live code and `docs/SPEC-DRIFT.md`.

On security: the XSS surface is clean (no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`), the secret key is correctly confined to `sessionStorage`, and `provider` validation added for BUG-016 is solid. Two gaps stand out: `readUrlParams()` accepts `endpoint` from the URL hash without protocol validation — a crafted share link is a credible phishing vector that could redirect typed credentials to an attacker endpoint; and the nginx/Caddy CSP examples in `README.md` use `img-src data:` alone, which silently breaks every image/audio/video/PDF preview in production deployments.

On the roadmap: the multi-bucket browsing feature (the centrepiece of 2.0) is structurally blocked by `bucket` being a mandatory first-class field threaded through 156 reference sites across components and lib code. The data layer is ready (the profile envelope is versioned and tolerant of unknown fields), but `CredentialForm`, `App.jsx`, `storage.js`, `url-params.js`, capability state, and `SetupGuide.jsx` all need coordinated changes before the feature can land. The UI refresh feature has good bones — colour tokens exist as CSS variables and the dark theme already overrides them through one media query — but spacing tokens, a `[data-theme]` selector for a light-theme toggle, mobile breakpoints, focus traps, ARIA labels, and `htmlFor` associations on form labels are all absent.

The headline action items, in order: (1) fix the rename `DeleteObjectCommand` import, (2) fix `clearCredentials()` settings wipe, (3) fix `HiddenVersions` purge-all error accumulation, (4) parallelise the resume path, (5) guard `readUrlParams()` endpoint against non-HTTP(S) schemes, (6) correct the CSP example in `README.md`, (7) update `docs/QUESTIONS.md` to match reality.

---

## Section 1 — Regressions & Verification of v1.0 Engineering Review

| # | v1.0 finding | Status in v1.14.0 | Cite |
|---|--------------|-------------------|------|
| 1 | `Browser.jsx` approaching unmanageable complexity (1352 lines, 33 useState) | **Worsened in density.** 1326 lines, ~35 useState in the main component (53 if you count inline sub-components). Delete was correctly extracted but preview / prefetch / rename grew to fill the space. | `src/components/Browser.jsx` |
| 2 | `clearCredentials()` silently deletes all user settings | **Still present.** `Object.values(LS_KEYS).forEach(...)` clobbers nine settings keys. A `resetSettings()` function was added but never wired into the disconnect path. | `src/lib/storage.js:72–75` |
| 3 | Resume path is serial, not concurrent | **Still present.** `handleResume` uses a sequential `for` over `remainingParts`; fresh path uses a worker pool. | `src/components/UploadQueue.jsx:371–385` |
| 4 | No tests | **Substantially fixed.** 18 test files cover all pure lib modules, plus structural source-invariant assertions and build-output assertions. Component-level integration tests are still absent (acknowledged as DOM-dependent in BUG-LOG). | `test/` |
| 5 | `@anthropic-ai/claude-code` in dependencies | **Fixed.** Absent from both `package.json` and `package-lock.json`. The only string match is a CHANGELOG historical note. | `package.json` |
| 6 | `_sessionFirstMount` module-level mutable | **Still present.** `let _sessionFirstMount = true;` at module scope. | `src/components/Browser.jsx:23` |
| 7 | `HiddenVersions.handlePurgeAllConfirm` stops on first batch error | **Still present.** Throws on first `resp.Errors[0]`; partial deletions are silent. | `src/components/HiddenVersions.jsx:122–131` |
| 8 | Spec §6 "Out of Scope" lists shipped features as deferred | **Acknowledged but not fixed in the spec.** `docs/SPEC-DRIFT.md` correctly records the drift (D-1) but `docs/s3-browser-spec-v0.15.md` still claims delete/rename/copy/multi-profile are out of scope, and `docs/QUESTIONS.md` "Known Limitations" still says "No delete, rename, copy — out of scope per §6". | `docs/s3-browser-spec-v0.15.md`, `docs/QUESTIONS.md:43–44` |
| 9 | Spec §4.6 mandates lib-storage; code uses raw SDK | **Acknowledged.** Drift D-2 in `SPEC-DRIFT.md`. Spec unchanged. | `docs/SPEC-DRIFT.md` |
| 10 | Spec N=2 file concurrency; code N=3 | **Acknowledged in SPEC-DRIFT.md (D-3) but QUESTIONS.md table still says N=2.** | `docs/QUESTIONS.md:79`, `src/components/UploadQueue.jsx:39` |
| 11 | QUESTIONS.md D1 deviation note is stale | **Still stale.** SPEC-DRIFT.md D-4 explicitly says "Action needed: Remove or strike through D1 in QUESTIONS.md." Neither has happened. | `docs/QUESTIONS.md:52–63` |
| 12 | `file://` stance unresolved | **Decided implicitly: continue support.** SPEC-DRIFT.md and FileBanner.jsx make the support visible. Not explicitly resolved as the v1.0 review asked, but no longer an open question in practice. | `src/components/FileBanner.jsx` |

**Summary:** Of 12 distinct items, 3 are fixed, 1 is substantially fixed, 1 has been decided implicitly, and 7 remain open. Two of the seven open items are doc-only (low effort to close); five are real code bugs.

---

## Section 2 — Critical Findings (new, not in v1.0 review)

### CRIT-1 — Rename throws and leaves a duplicate file behind

- **Location:** `src/components/Browser.jsx:9` (import), `src/components/Browser.jsx:564` (usage)
- **Symptom:** Every rename operation throws `ReferenceError: DeleteObjectCommand is not defined`. The preceding `CopyObjectCommand` has already succeeded — the renamed file exists alongside the original. The user sees an error and a duplicate.
- **Root cause:** The SDK import at line 9 lists `ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand, CopyObjectCommand` but not `DeleteObjectCommand`. Almost certainly lost when the v1.14.0 unified-delete refactor moved delete imports out of `Browser.jsx` into `delete-queue.js` and the rename-internal usage was missed.
- **Reproduction:** Connect to any bucket, rename any file, observe the error toast and the duplicate. A quick repro in a dev console without even loading the app: `grep -n "DeleteObjectCommand" src/components/Browser.jsx | head` — the import is missing.
- **Fix:** Add `DeleteObjectCommand` to the import on line 9. One-word change.
- **Why no test caught it:** Rename is a DOM-driven flow with no unit test (acknowledged as DOM-dependent in BUG-LOG). A `test/source-invariants.test.js` rule that grep'd for any identifier used in a `client.send(new ...)` site and required it to appear in the SDK import list would have caught this mechanically. Worth adding now to prevent recurrence.
- **Severity:** Critical. Ships duplicate data, breaks an advertised feature on every invocation.

---

## Section 3 — Security Findings

(Original lane output: `/tmp/bucketer-review/01-security.md`.)

### SEC-1 — `readUrlParams()` accepts arbitrary `endpoint` from URL hash (Medium)

- **Location:** `src/lib/url-params.js:21`
- **Evidence:** `if (p.has('endpoint')) out.endpoint = p.get('endpoint');` — no scheme, length, or shape validation. The `provider` field was hardened in BUG-016; the `endpoint` and `bucket` fields received no comparable guard.
- **Risk:** A crafted share link such as `bucketer.hidayahtech.net/#endpoint=https%3A%2F%2Fattacker.example%2Fs3&bucket=plausible-looking-bucket` can pre-fill the credential form with an attacker-controlled HTTPS endpoint. If the user types their access key + secret and clicks Connect before noticing, those credentials are sent to the attacker's server. A `javascript:` or `file:` scheme is sterilised by the browser's `fetch` semantics (no XSS), but the value is persisted to `localStorage` and re-distributed via `buildShareUrl`.
- **Fix:**
  ```js
  if (p.has('endpoint')) {
    const v = p.get('endpoint');
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' || u.protocol === 'http:') out.endpoint = v;
    } catch { /* ignore */ }
  }
  ```
  Apply an analogous guard on `bucket` (reject path separators / `..`). The form's `type="url"` covers manually-typed values; this closes the URL-params bypass.

### SEC-2 — Deployment CSP example in `README.md` is incomplete and broken (Medium)

- **Location:** `README.md:163` (nginx), `README.md:178` (Caddy)
- **Evidence:** `img-src data:` only. Presigned S3 previews are HTTPS URLs to third-party hosts, not data URIs. `media-src` and `frame-src` are absent. `script-src 'unsafe-inline'` is forced by the inline-bundle architecture, which structurally weakens any CSP at this layer.
- **Risk:** (a) Functional — every image/audio/video/PDF preview silently fails to load with a CSP violation in production deployments using the example verbatim. (b) Security — `unsafe-inline` neutralises CSP's primary XSS mitigation; any future XSS would execute. Spec §4.9 correctly states that `script-src 'self'` is achievable, but only with a hashed inline-bundle approach.
- **Fix:** Update the example to `img-src data: https:; media-src https:; frame-src https:;` at minimum. Long-term: emit `script-src 'sha256-<hash-of-inline-bundle>'` from `build.mjs` and bake the hash into the CSP example so the inline architecture can satisfy a `script-src` directive without `unsafe-inline`.

### SEC-3 — Shell-metacharacter injection into CORS clipboard command (Low)

- **Location:** `src/components/SetupGuide.jsx:74–79` (`corsCmd`)
- **Evidence:** `--endpoint-url ${endpoint || '...'} --bucket ${bucket || '...'}` — endpoint and bucket are interpolated into a shell-command string with no quoting. The command is copied to clipboard, not executed by the app, so the danger is the user pasting an adversarial-share-URL-pre-filled value into their terminal.
- **Fix:** Defense-in-depth single-quoting wrapper: `q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"`.

### SEC-4 — No `<meta http-equiv="Content-Security-Policy">` in the artifact (Nit, deployment gap)

- **Location:** `src/index.html` (absent), `dist/index.html` (absent)
- **Evidence:** No CSP meta tag. README correctly notes HTTP headers are the strong path, but S3 static-hosting deployments cannot set headers.
- **Fix:** Add a meta CSP after the `build-id`/`app-version` tags as a baseline for header-less deployments. Verify the byte boundary still passes the 512-byte invariant.

### SEC-5 — `x-amz-*` AllowedHeaders wildcard is broader than strictly required (Low, accept)

- **Location:** `src/lib/cors-config.js:12`
- **Assessment:** Correct fix for BUG-012. The wildcard scope is acceptable for request headers (no `ExposeHeaders` expansion). Document the rationale; do not narrow.

### Non-findings worth knowing the lane covered

- No `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` / `document.write` anywhere in `src/`.
- Secret key never leaves `sessionStorage`; `StorageModal` displays `'Present (session only)'`, never the value; `saveProfile` explicitly drops `secretKey` before persisting.
- Share URLs never contain credentials (`buildShareUrl` whitelists endpoint / bucket / provider / regionOverride).
- Presigned URLs default to 3600 s; copy-link cap 604800 s (7 days); cache evicts 5 minutes before expiry.
- PDF iframe uses `sandbox=""` (maximally restrictive — correct).
- Text preview forces `ResponseContentType: 'text/plain; charset=utf-8'`; HTML/JS stored in bucket renders as source.
- SVGs render through `<img>`, not inline — browser sandbox applies.
- `dist/index.html` has zero `sourceMappingURL`, zero `/home/`, no unreplaced placeholders, no `process.env` leftovers.
- No `storage` event listeners; no cross-tab leakage path through `localStorage` reads.

---

## Section 4 — Correctness Findings

(Original lane output: `/tmp/bucketer-review/02-correctness.md`. CRIT-1 above is also from this lane.)

### COR-1 — `clearCredentials()` wipes all user settings on disconnect (High)

- **Location:** `src/lib/storage.js:72–75`
- **Same finding cited as:** SEC-non-issue (data-loss but not a security risk), STD-01, UX-02 — single fix benefits all four lenses.
- **Fix:** Split `LS_KEYS` → `CREDENTIAL_KEYS` (endpoint, bucket, keyId, provider, regionOverride) and `SETTINGS_KEYS` (everything else). `clearCredentials()` iterates only `CREDENTIAL_KEYS`. The author already proved they understood this pattern: line 11 comments that profiles are deliberately outside `LS_KEYS` so they survive disconnect. The same logic just needs to be extended to settings.
- **Test:** Add `test/storage.test.js` case: `saveSettings({ partSizeMB: 50 })` → `clearCredentials()` → `loadSettings()` returns `{ partSizeMB: 50, ... }`.

### COR-2 — `HiddenVersions.handlePurgeAllConfirm` throws on first batch error (High)

- **Location:** `src/components/HiddenVersions.jsx:122–131`
- **Evidence:** A 2500-version purge that fails on batch 2 leaves the first 1000 versions permanently deleted with no UI indication of partial success. `delete-queue.js`'s `runDeleteOperation` already has the correct accumulating pattern.
- **Fix:** Mirror `runDeleteOperation`'s pattern — collect `resp.Errors` across all batches, continue through, report final aggregate.

### COR-3 — `handlePreview` has no cancellation guard against navigation (Medium)

- **Location:** `src/components/Browser.jsx:615–701`
- **Symptom:** A slow HeadObject from a previous preview can resolve after the user has navigated to a new folder, setting `previewUrl` / `previewText` / `previewError` for a key that is no longer in view. `prefetchAdjacent` correctly uses `prefetchGenRef` to abandon stale work; `handlePreview` itself doesn't.
- **Fix:** Simplest: have `navigateTo` call `closePreview()` so the modal closes on navigation. Better: a `previewGenRef` checked before each `set*` call (the prefetch pattern). Best, in combination: an `AbortController` per preview so the in-flight `getSignedUrl` / HeadObject is actually cancelled rather than abandoned.

### COR-4 — Resume path is still serial (Medium — performance correctness, was v1.0 finding #3)

- **Location:** `src/components/UploadQueue.jsx:371–385`
- **Symptom:** A 1 GB file with 200 remaining 5 MB parts resumes ~4× slower than it would have uploaded fresh. The whole point of resume is large interrupted uploads.
- **Fix:** Extract a shared `uploadPartsWithPool(remainingParts, ...)` from `uploadMultipart` and use it from both code paths. `PART_CONCURRENCY` should apply equally.

### COR-5 — `handleDeleteConfirm` does not wrap `runDeleteOperation` in try/catch (Medium)

- **Location:** `src/components/App.jsx:198–201`, `src/components/DeleteQueue.jsx:76`
- **Symptom:** Any uncaught throw from `runDeleteOperation` (e.g., from `discoverPrefixKeys` if `ListObjectsV2` returns a non-standard error shape) becomes an unhandled rejection. The delete panel can wedge in `'discovering'` / `'deleting'` with no dismiss path.
- **Fix:** Wrap the `await runDeleteOperation(...)` in try/catch and call `updateDeleteOp(id, { phase: 'done', errors: [{ key: '(unexpected)', message: err.message }], deletedPrefixes: [] })` so the panel always reaches a dismissible terminal state.

### COR-6 — `discoverPrefixKeys` fires all prefix listings concurrently with no throttle (Low)

- **Location:** `src/lib/delete-queue.js:37–51`
- **Symptom:** Deleting 30+ folders launches 30+ simultaneous `ListObjectsV2` paginated crawls. Saturates the HTTP/2 connection pool; may trigger 503 throttling.
- **Fix:** Cap discovery concurrency at 4–8 with the same worker-pool pattern already used for the delete batches.

### COR-7 — `formatBytes` returns `"NaN undefined"` for negative / NaN / null / undefined (Low)

- **Location:** `src/lib/format.js:4–9`
- **Symptom:** Some S3 providers omit the `Size` field on delete-marker / folder-placeholder objects; the size column then renders `"NaN undefined"`.
- **Fix:** Add a guard: `if (bytes == null || isNaN(bytes) || bytes < 0) return '—';`. Add cases to `test/format.test.js` covering null, undefined, NaN, negative, Infinity.

### COR-8 — `_sessionFirstMount` module-level mutable (Low — was v1.0 finding #6)

- **Location:** `src/components/Browser.jsx:23`
- **Fix:** Lift to a `useRef(true)` in `App.jsx`; pass as `isFirstMount` prop with a consume callback. Makes the dependency explicit and HMR-safe.

### COR-9 — `handlePreview` does not abort the previous preview's in-flight requests (Nit)

- **Location:** `src/components/Browser.jsx:615–626`
- **Symptom:** Rapid preview switching can race two async bodies; whichever resolves last wins.
- **Fix:** A per-preview `AbortController` (paired with COR-3).

### COR-10 — Tab-conflict detection has a narrow TOCTOU window (Low — acknowledged)

- **Location:** `src/lib/indexeddb.js:158–163`, `src/components/UploadQueue.jsx:165–172`
- **Assessment:** Inherent to localStorage-without-CAS coordination. The current `isUploadActiveElsewhere` → `markUploadActive` sequence has a sub-microsecond TOCTOU window between two tabs. The lane judged this acceptable but documented; the in-code comment already calls it best-effort. Consider a `storage` event listener that re-checks the active key on cross-tab write, as defense in depth.

### Lane-confirmed non-findings

- `delete-queue.js` correctly accumulates errors per batch with worker-pool concurrency = 8 and exponential-backoff retry — the new code is materially better than the old per-operation paths.
- `prefetchAdjacent` is correctly cancellation-safe (generation counter).
- `collectParts` pagination still matches the BUG-007 fix.
- Pagination `ContinuationToken` is cleared by `navigateTo` and by `handleRefresh` — no stale-token cross-prefix bleed.
- IndexedDB `onupgradeneeded` correctly creates both stores on first open and migrates v1→v2 if `LOG_STORE` is missing.
- `beforeunload` cleanup is correct (dependency-tracked, removeListener in `useEffect` return).

---

## Section 5 — Code Standards & Spec Adherence

(Original lane output: `/tmp/bucketer-review/03-standards.md`.)

### STD-1 — `Browser.jsx` continues to grow denser despite the delete extraction (High)

- **Numbers:** 1326 lines, ~35 `useState` in the main component (53 if you count the in-file `CopyLinkPopover` / `BatchCopyLinkPopover` sub-components).
- **17 distinct UI flows are managed in a single render scope:** navigation+history, listing+pagination, in-memory listing cache (TTL), download, preview (10 state vars), preview prefetch (with generation counter), sorting, filter, multi-select, batch copy link, single copy link, drag-and-drop counter, metadata panel, rename, new-folder, delete request triggering, HiddenVersions integration.
- **Cleanest extraction order — do these in v1.x as enabling work for 2.0:**
  1. **`usePreview(client, bucket, prefetchSizeLimit)`** — owns 10 state vars + 3 refs + 2 effects + the prefetch async. Zero entanglement with listing/rename/delete. Estimated −150 lines from `Browser.jsx`, +1 testable hook in `src/lib/use-preview.js`.
  2. **`useRename(client, bucket, invalidateCache)`** — 4 state vars + the copy-then-delete async. Pure logic, lib-grade.
  3. **Unify `CopyLinkPopover` + `BatchCopyLinkPopover`** — they share 5 state vars, identical `handleCustomCopy`, identical custom-input JSX. Pass `keys: string[]`; single-file callers pass `[key]`. Eliminates ~70 lines.
  4. **`useListingCache(cacheTTL)`** — already cleanly bounded.
  5. **`useMetadata(client, bucket)`** — owns `metaItem`, `metaData`, `metaLoading`, `metaError`.

### STD-2 — `UploadQueue.jsx` is well-structured but inline sub-components blur readability (Medium)

- **Numbers:** 1165 lines, 11 useState in the main component, ~8 more in inline `BatchRow` / `UploadItem` / `AnimatedBytes` sub-components, each ~100 lines.
- **Fix:** Promote `BatchRow`, `UploadItem`, `AnimatedBytes` to top-level functions in the same file or a companion `UploadQueueParts.jsx`. No public surface change.
- **Joint fix with COR-4:** Extract a shared `uploadPartsWithPool(...)` consumed by `uploadMultipart` and `handleResume`. Resolves the serial-resume bug structurally.

### STD-3 — Three factual errors in `docs/QUESTIONS.md` (Medium, doc-only)

- D1 deviation still describes Connection Failed as unresolved; code resolves it; SPEC-DRIFT.md D-4 explicitly demanded the strike-through.
- "Known Limitations" still claims "No delete, rename, copy — out of scope per §6"; all three ship.
- "Decisions Made" table still says "N=2 upload concurrency default"; actual default is N=3.
- **Fix:** Strike D1 with a "Resolved in v1.14.0" note; remove or correct the Known Limitations bullet; update the Decisions table.

### STD-4 — Three sibling `useEffect` outside-click handlers in `Browser.jsx` (Low)

- **Location:** `src/components/Browser.jsx:420–445`
- **Pattern:** Three consecutive effects (tableCopyKey, previewCopyOpen, batchCopyOpen) each add a `mousedown` document listener with the same `containerRef.contains` check.
- **Fix:** Extract `useOutsideClick(ref, isOpen, onClose)` — standard pattern, 3 call sites → 3 lines.

### STD-5 — `useCallback` inconsistency in `App.jsx` (Nit)

- `handleCapabilityChange` is wrapped; nine sibling handlers are not. Preact has no `React.memo` so the inconsistency is performance-neutral. Either wrap all or unwrap the one — prefer the unwrap, since none are passed to memoised consumers.

### STD-6 — Test coverage gap on BUG-023 and BUG-024 (Low)

- Both are listed as "no automated test — fix verified manually". Both are unit-testable in `test/upload-queue-cancel.test.js`-style without DOM (mock `loadResumeRecord` / `deleteResumeRecord` and assert call order).

### STD-7 — Add a source-invariant test for "every `new XCommand()` site has the matching import" (Low → mechanically prevents the rename CRIT-1 bug class)

- A grep-style assertion in `test/source-invariants.test.js`: extract identifiers used in `client.send(new ([A-Z][A-Za-z]+)Command\b` calls; assert each appears in the file's `@aws-sdk/client-s3` import list.

### Spec-drift summary

| § | Spec says | Code does | Status |
|---|-----------|-----------|--------|
| §6 + §3 | delete / rename / copy / multi-profile out of scope | All shipped | Documented (SPEC-DRIFT D-1); spec still stale |
| §4.6 | use lib-storage Upload class | raw SDK commands | Documented (D-2) |
| §4.6 | N=2 file concurrency default | N=3 | Documented (D-3); QUESTIONS.md contradicts |
| §4.14 D1 | Connection Failed deviation noted as unresolved | Implemented | Fixed in code; QUESTIONS.md still stale |
| §4.2 | CORS required methods: GET/PUT/HEAD/POST | CORS includes DELETE | New minor drift; implementation is correct |

### CLAUDE.md adherence

- **No backwards-compat shims:** Compliant. `repairStorageInvariants` and `migrateProfilesFromLegacy` are one-time idempotent fixers, not perpetual shims.
- **Comments explain WHY not WHAT:** Mostly compliant. A handful of inline ref-shape comments (lines 274–276 of `Browser.jsx`) document type information that TypeScript would encode — borderline acceptable given the no-TS posture.
- **Tests pass on every push:** Verified. `.githooks/pre-push` correctly distinguishes recursive tag-only pushes via stdin and gates everything else on build + test.
- **`@anthropic-ai/claude-code` absent from `package.json`:** Verified.
- **Build invariants enforced:** Both documented invariants run in prod mode and only in prod mode. `UPDATE_CHECK_RANGE_BYTES = 512` is in `build.mjs` and the doc tells you to keep it in sync with `UpdateBanner.jsx`.

### BUG-LOG ↔ test cross-reference (full table)

| Bug | Coverage claim | Exists | Asserts correctly |
|-----|----------------|--------|-------------------|
| BUG-001 | `test/build.test.js` placeholder | ✓ | ✓ |
| BUG-002 | `test/build.test.js` Preact transform | ✓ | ✓ |
| BUG-003 | `test/calc-part-size.test.js` | ✓ | ✓ |
| BUG-004 | (none — DOM) | N/A | N/A |
| BUG-005 | (none — DOM) | N/A | N/A |
| BUG-006 | `test/source-invariants.test.js` | ✓ | ✓ |
| BUG-007 | `test/collect-parts.test.js` | ✓ | ✓ |
| BUG-008 | `test/indexeddb-storage.test.js` | ✓ | ✓ |
| BUG-009 | (none — embedded) | N/A | N/A |
| BUG-010 | (none — App state) | N/A | N/A |
| BUG-011 | (none — UploadQueue state) | N/A | N/A |
| BUG-012 | `test/cors-config.test.js` + build | ✓ | ✓ |
| BUG-013 | `test/url-params.test.js` | ✓ | ✓ |
| BUG-014 | `test/source-invariants.test.js` | ✓ | ✓ |
| BUG-015 | `test/indexeddb-pure.test.js` | ✓ | ✓ |
| BUG-016 | storage + url-params + credential-form | ✓ | ✓ |
| BUG-017 | `test/source-invariants.test.js` | ✓ | ✓ |
| BUG-018 | (none — DOM) | N/A | N/A |
| BUG-019 | `test/provider.test.js` | ✓ | ✓ |
| BUG-020 | (none — DOM) | N/A | N/A |
| BUG-021 | `test/source-invariants.test.js` MAX_DISPLAY | ✓ | ✓ |
| BUG-022 | (none — DOM) | N/A | N/A |
| BUG-023 | (none — "manual") | ✗ | should add |
| BUG-024 | (none — "manual") | ✗ | should add |
| BUG-025 | `test/format.test.js` | ✓ | ✓ |

≈60 % of bugs have mechanical regression prevention; the other 40 % are DOM/component flows.

### File-by-file verdict (files > 200 lines)

- **`Browser.jsx` (1326)** — Highest-risk file. The growth pattern is concerning: even with the delete extraction, density rose. Preview is the cleanest extraction candidate and the first hook to land.
- **`UploadQueue.jsx` (1165)** — Well-structured for its complexity. Two concrete improvements: hoist inline sub-components; parallelise resume.
- **`App.jsx` (541)** — Growing steadily with profile management; clean overall. The `liveFormData` / `credentials` split (from BUG-018/020) is necessary but is now effectively two credential state variables — worth a clearer in-code comment about their lifecycle.
- **`StorageModal.jsx` (468)** — Pure display, well-decomposed. Clean.
- **`SetupGuide.jsx` (401)** — Provider-branching is verbose but correct. The first-run vs reference duality (UX-06 below) is the structural critique.
- **`BucketerLogo.jsx` (371)** — ~90 % SVG path data for the easter-egg animation. Unavoidable. Component logic is ~40 lines.

---

## Section 6 — Build, Deployment, Performance

(Original lane output: `/tmp/bucketer-review/04-build-perf.md`.)

### Production artifact at a glance

- **521 KB total** — 91 % AWS SDK JS, 6 % CSS, 3 % HTML + Preact + app code.
- **Self-contained:** single `<style>`, single `<script>`, no external `<script src>` / `<link href="http">`.
- **No source map** (`sourceMappingURL` count = 0).
- **No dev-path / username leakage** (`/home/`, `basilgohar`, `/Users/` count = 0).
- **No unreplaced template placeholders** (`<!-- BUILD_ID -->`, `<!-- APP_VERSION -->`).
- **7 `console.*` strings** in the bundle — all `@smithy/*` middleware advisories, not app code. Benign; app code uses one intentional `console.info` at `UploadQueue.jsx:570` for visibility-state debugging.
- **Update-check invariants pass:** `build-id` meta tag ends at byte 179, `app-version` at byte 224 (boundary is 512).
- **og-image.png** correctly emitted into `dist/` and referenced in head.

### BLD-1 — Add `sourceMappingURL` absence as a build invariant (Low)

- 3–5 lines in `build.mjs` mirroring the existing meta-tag checks. Catches the human error of accidentally setting `sourcemap: 'inline'` for prod.

### BLD-2 — Add a bundle-size ceiling (Low → useful trip-wire)

- `const SIZE_LIMIT_BYTES = 600 * 1024; if (Buffer.byteLength(out, 'utf8') > SIZE_LIMIT_BYTES) throw ...` in `build.mjs`. Catches accidental dependency bloat early.

### BLD-3 — Add the "every `new XCommand()` has a matching import" structural test (Low)

- Same as STD-7. Belongs in `test/source-invariants.test.js`. Would have prevented CRIT-1.

### Pre-push hook walkthrough — verified correct

- Reads stdin to distinguish branch pushes from recursive tag-only pushes.
- Branch push: `npm run build && npm test`; aborts on failure.
- Idempotent tag creation; immediate tag push afterward.
- `--no-verify` documented as human-operator emergency only.
- No code path lets a failed test through.

### CI walkthrough — verified correct

- `test` stage on every push: `npm ci` → `npm run build` → `npm test`. Artifacts: `dist/index.html` (1-day expiry).
- `release` stage gated on `needs: [test]` and the `v\d+\.\d+\.\d+` tag pattern only — runs `node scripts/release.mjs`.
- No deploy path bypasses the test gate.

### Performance work in v1.13.14–v1.14.0 (independently verified)

| Optimization | Source change | Measured impact at 1000 files |
|--------------|---------------|-------------------------------|
| rAF-aligned `updateItem` batching | `src/lib/update-batcher.js` | `BatchSummary` self-time 877 → 724 ms (−17 %) |
| Single-loop `BatchSummary` aggregation | `UploadQueue.jsx:757–770` | 1143 → 877 ms (−23 %) |
| Timestamp formatter cache | `UploadLog.jsx` module-level Map | ~1378 → ~90 ms (−93 %) |
| Visibility throttling + 15-fps rAF gate | `UploadQueue.jsx:848–850` | ~75 % animation overhead drop |
| Parallel delete batches (3 concurrent) | `delete-queue.js` | ~3× faster for 10k-object delete |
| `UploadLog` render cap (`MAX_DISPLAY = 200`) | `UploadLog.jsx:15` | Fixed Firefox "Script terminated by timeout" at 15k+ rows |

### Performance observations

- **No virtualisation in the upload queue.** Acceptable today (batches typically 5–500 files; collapsible by default; `UploadLog` capped at 200 rendered rows). A single batch of 10k+ items would jank; flag for 2.0 if upload patterns grow.
- **No N² loops, no `JSON.parse(JSON.stringify(...))` deep clones, no repeated `Array.from(map.values())` inside hot paths.**
- **Perf results not committed.** `perf/output/*.cpuprofile` is gitignored and run manually. Worth committing a small `perf-baseline.json` and running `npm run bench` in CI so regressions surface against a quantitative reference.

---

## Section 7 — Roadmap, UX & Future Features

(Original lane output: `/tmp/bucketer-review/05-roadmap-ux.md`.)

### 7.1 — 2.0 Feature 1: Multi-bucket browsing

**Bucket coupling heat map (reference count by file):**

| File | Bucket refs |
|------|------------:|
| `SetupGuide.jsx` | 53 |
| `Browser.jsx` | 26 |
| `UploadQueue.jsx` | 24 |
| `App.jsx` | 17 |
| `StorageModal.jsx` | 9 |
| `CredentialForm.jsx` | 9 |
| `ProfilePicker.jsx` | 5 |
| `HiddenVersions.jsx` | 5 |
| `src/lib/*.js` (total) | 41 |

`bucket` is structural in `Browser.jsx` / `UploadQueue.jsx` because it's a required `Bucket:` parameter on every SDK command. It must become a runtime selection threaded down through the same prop interface — the prop interface itself is fine.

**Blockers, in execution order:**

1. **Make `bucket` optional at the credential layer.** `CredentialForm` validates required; profile schema mandates the field; `credentials.bucket` feeds the status label, share URL, and Browser/UploadQueue props. Drop the required validator; allow null.
2. **Key `s3b_capabilities` by bucket.** Currently global per session. Change shape to `{ [bucketName]: { list, download, upload, delete } }`. Without this, switching buckets shows stale permission indicators.
3. **Extend the URL fragment scheme.** `buildShareUrl` / `readUrlParams` carry exactly one bucket. Add a `bucket=` slot distinct from the credential's optional default. Use the versioned `#v2:` scheme from the encrypted-share-links design for clean evolution.
4. **`SetupGuide` per-bucket model.** All 53 CLI command sites assume `credentials.bucket`. Either open the guide per selected bucket (bucket prop) or render a bucket picker inside the guide.
5. **`Browser.jsx` / `UploadQueue.jsx` already accept `bucket` as a prop** — just rewire `App.jsx` to derive it from a runtime selection.

**Migration path:** The existing `version: 1` profile envelope with tolerant-loading already handles unknown-field round-tripping. A non-empty `bucket` in a v1.14 profile becomes "single-bucket mode" in 2.0 (bypass `ListBuckets`, connect directly); a profile with no `bucket` triggers bucket discovery. No version bump needed.

### 7.2 — 2.0 Feature 2: UI refresh

**Design system today:**

- **Colour tokens — complete.** `:root` defines `--bg`, `--surface`, `--surface-raised`, `--border`, `--border-focus`, `--text`, `--text-muted`, `--text-danger`, `--text-success`, `--text-warn`, `--accent`, `--accent-hover`, `--danger`, `--danger-hover`, four semantic backgrounds.
- **Typography — minimal.** `--font` (system stack), `--mono`. No size scale; sizes are inline.
- **Spacing — absent.** No spacing tokens; padding/gap values are hard-coded `.5rem` / `1rem` / `1.25rem` throughout.
- **Shape — present.** `--radius: 6px`, `--shadow`, `--transition: 140ms ease`.
- **Theming readiness — high.** Dark theme is one `@media (prefers-color-scheme: dark)` block overriding every colour token. To add a light-theme toggle: move the dark overrides under `[data-theme="dark"]`, add a toggle button. ~½ day.
- **Mobile readiness — zero.** Exactly one `@media` rule in the entire CSS; it's the dark theme. No width breakpoints, no sidebar trigger on narrow viewports, no touch-target sizing, no responsive table.
- **Component consistency.** Buttons mostly use `.btn` / `.btn-primary` / `.btn-danger` / `.btn-ghost` / `.btn-sm`, with a handful of inline-styled exceptions (hamburger, version badge, copy button, splash About link). Modals are uniform. Inputs use `.form-group` consistently, but **no `<label>` has `htmlFor`** — every label-input pair is unassociated.

### 7.3 — Out-of-scope-for-2.0 designs (state of)

- **Encrypted share links** (`docs/design-encrypted-share-links.md`): design is implementation-ready. Versioned `#v2:` fragment, PBKDF2 via SubtleCrypto, AES-GCM. Two open questions (origin-derived vs fixed key; whether Key ID is always included). Estimated ~1 day. Zero bundle impact. **Could ship in a 1.x point release.**
- **Persistent upload queue** (`docs/intent/persistent-queue-design.md`): the most thorough of the three designs. Phase 1 (done-set only, no UI changes) is a 1–2 day 1.x candidate; the full four-phase design is post-2.0.
- **Storage viewer** (`docs/design-storage-viewer.md`): largely implemented — `StorageModal.jsx` (468 lines) is the wired component. Remaining work is small (polish + verifying `wipeAllAppData`).

### 7.4 — Accessibility (light-touch baseline)

- **Total `aria-*` attributes across all components: 9.**
- `aria-label`: 7 sites (hamburger, preview close/prev/next, tap zones, logo, dismiss).
- `role="alert"`: 2 (`ErrorBlock`, `FileBanner`).
- `role="status"`: 1 (`UpdateBanner`).
- `aria-live`, `aria-hidden`, `aria-modal`, `aria-describedby`: **zero**.

| # | A11y finding | Severity |
|---|--------------|---------:|
| A-1 | No focus trap in any modal (`AboutModal`, `ChangelogModal`, `StorageModal`, preview) | High |
| A-2 | No focus-on-open / focus-return in any modal | High |
| A-3 | Every `<label>` lacks `htmlFor` (5 in `CredentialForm`, 7 in `SettingsPanel`, 1 in `UploadQueue`) | High |
| A-4 | Progress bars have no `aria-valuenow` / `aria-valuemin` / `aria-valuemax` | Medium |
| A-5 | Delete / upload progress not announced (no `aria-live` region) | Medium |
| A-6 | Capability probe results not announced | Low |
| A-7 | Header background is hard-coded `#1b2438` (not a token); will not theme-toggle | Low |
| A-8 | Preview-modal tap zones are `<div>` with `aria-label` instead of `<button>` | Low |

### 7.5 — UX findings

- **UX-1 — CORS setup is a CLI prerequisite that completely blocks first-time use (High).** For every provider except Wasabi, no API call succeeds until the user has the AWS CLI installed, has a profile configured, and has run multi-step provider-specific commands. The setup guide lives inside the connected sidebar — visible only after a failed Connect. Surface it on the splash screen before Connect ("Before you connect, your bucket needs CORS configured"); investigate whether `PutBucketCors` via the SDK itself could automate the step.
- **UX-2 — `clearCredentials()` deletes user settings on Disconnect (High, dupe of COR-1).**
- **UX-3 — Empty state does not distinguish empty bucket vs empty prefix vs filtered (Medium).** `Browser.jsx:1159` shows `'This prefix is empty.'` for the root of a brand-new bucket. Add a third case: when `prefix === ''` and the listing is empty, render onboarding copy with a prominent Upload CTA.
- **UX-4 — No undo for any destructive operation (Medium).** Single-file row-action delete currently fires without confirmation (bulk delete has a confirm modal; single-file does not). Add a confirm step at minimum; consider a 5-second toast-with-undo since the key is in memory.
- **UX-5 — `CapabilityPanel` is opaque (Low).** Four `?` marks with only a tooltip explanation. Add one inline hint: "Permissions are detected automatically as you use each feature."
- **UX-6 — `SetupGuide.jsx` doubles as first-run wizard and recurring reference (Low).** Neither role is served optimally. Split into `CorsGuide` (reference) and a first-run onboarding host.

### 7.6 — Missing features worth considering

Grouped by theme.

- **Power-user / discoverability:** client-side filename filter (`docs/TODO.md` #1, ~½ day, fully designed); global keyboard shortcuts (none today); object-metadata side panel (HeadObject is already wired for preview); storage-class display (`StorageClass` is in `ListObjectsV2` responses but never shown).
- **Bulk operations:** bulk download (requires client-side ZIP — `fflate` or File System Access API); bulk rename (prefix → prefix); explicit "copy succeeded, delete failed" message in rename to surface duplicates (today the error is opaque — and CRIT-1 makes this guaranteed-to-happen on every rename).
- **Upload UX:** direct paste-from-clipboard upload (`paste` + `DataTransfer.files`, ½ day); persistent-queue Phase 1 (done-set only).
- **Sharing / collaboration:** encrypted share links (design complete, ~1 day); prefix-scoped read-only links with expiry.
- **Provider / advanced S3:** storage class change via `CopyObject`; object tagging; versioning toggle from UI; bucket lifecycle policies; multi-region awareness.
- **Platform / reach:** mobile / PWA (`manifest.json` + responsive layout first); i18n (single-language English today); A11y as a marketed differentiator.

### 7.7 — v1.x quick wins (each ≤ 1 day)

1. **Fix CRIT-1: add `DeleteObjectCommand` to the `Browser.jsx` import.** Minutes.
2. **Fix `clearCredentials()` settings wipe.** ~20 lines in `storage.js`.
3. **Guard `readUrlParams()` endpoint against non-HTTP(S) schemes** (SEC-1).
4. **Fix CSP example in `README.md`** (SEC-2): add `media-src` / `frame-src`, broaden `img-src`.
5. **Correct `docs/QUESTIONS.md`** (STD-3): three textual edits.
6. **Add `htmlFor` to every form label** (A-3): mechanical, < 1 hour.
7. **Light-theme toggle** (move dark overrides to `[data-theme="dark"]` + button): ~½ day; tokens already exist.
8. **Client-side filename filter** (`docs/TODO.md` #1): ~4 hours.
9. **Single-file delete confirmation** (UX-4 first half): ~2 hours.
10. **Empty-bucket onboarding state** (UX-3): ~2 hours.
11. **`aria-valuenow` / `aria-valuemin` / `aria-valuemax` on progress bars** (A-4): ~1 hour.
12. **Encrypted share links (Phase 1)** (`docs/design-encrypted-share-links.md`): ~1 day. Zero bundle impact.
13. **Add `sourceMappingURL`-absence and bundle-size build invariants** (BLD-1/2): ~½ hour.
14. **Add the "import-matches-Command" source invariant test** (STD-7 / BLD-3): mechanically prevents CRIT-1 recurrence; ~1 hour.

### 7.8 — v2.0 prerequisites (must land before redesign begins)

1. **Decouple `bucket` from the credential / profile model.** Optional at the credential layer; runtime-selected post-`ListBuckets`. Largest structural change.
2. **Key capability state by bucket.** `s3b_capabilities` becomes a map.
3. **Extract `usePreview`, `useRename`, `useMetadata`, `useListingCache` from `Browser.jsx`; unify the two `CopyLinkPopover`s.** Cuts ~250 lines and ~12 state vars from the central debt. Any new 2.0 surface area in `Browser.jsx` is risky until this lands.
4. **Establish a responsive layout skeleton.** Two breakpoints minimum (≤640 px, ≤960 px). Test sidebar, table, modals at each. Foundational — the UI refresh adds polish that would be duplicated if breakpoints land after.
5. **Decide and document the `file://` stance explicitly.** SPEC-DRIFT can become the authoritative location.

---

## Section 8 — Prioritised Action List

### Block any release until fixed

- **A1. CRIT-1 — Add `DeleteObjectCommand` to `Browser.jsx:9` import.** Every rename in v1.14.0 is broken; this is an immediate hotfix candidate for v1.14.1.
- **A2. Add the source-invariant test (STD-7 / BLD-3) that asserts every `client.send(new XCommand(...))` site has the matching identifier in the file's `@aws-sdk/client-s3` import.** Mechanically prevents recurrence of CRIT-1's class.

### High-priority — schedule for the next minor release

- **A3. COR-1 / STD-1 / UX-2 — Split `LS_KEYS` into `CREDENTIAL_KEYS` and `SETTINGS_KEYS`.** Single fix addresses three lanes; ~20 lines in `storage.js`; new `storage.test.js` case.
- **A4. COR-2 — `HiddenVersions.handlePurgeAllConfirm` accumulating-errors pattern.** Mirror `runDeleteOperation`.
- **A5. COR-4 / STD-2 — Extract `uploadPartsWithPool` and parallelise the resume path.**
- **A6. SEC-1 — URL-scheme guard in `readUrlParams()` for `endpoint`; path/`..` guard for `bucket`.**
- **A7. SEC-2 — Update CSP example in `README.md` (`media-src` / `frame-src` / broaden `img-src`).**
- **A8. COR-5 — Try/catch around `runDeleteOperation` in `App.jsx`'s delete handler.**

### Medium — bundle into the v2.0 enabling-work track

- **A9. STD-3 — Correct three stale claims in `docs/QUESTIONS.md`.** Doc-only.
- **A10. STD-1 extraction proposal — `usePreview` first, then `useRename`, then unify `CopyLinkPopover`.** Prereq for safe 2.0 work in `Browser.jsx`.
- **A11. COR-3 — `handlePreview` cancellation guard (closePreview on navigateTo, generation ref, AbortController).**
- **A12. COR-6 — Cap `discoverPrefixKeys` concurrency.**
- **A13. COR-7 — `formatBytes` guard against null/NaN/negative; expand `format.test.js`.**
- **A14. A-1 / A-2 / A-3 — Modal focus trap + focus return + form-label `htmlFor`.** Accessibility baseline.
- **A15. Multi-bucket prerequisites (7.8 items 1–2).**

### Low — quality-of-life, defense-in-depth, future-proofing

- A16. BLD-1 — `sourceMappingURL`-absence invariant.
- A17. BLD-2 — bundle-size ceiling invariant.
- A18. SEC-3 — shell-quote bucket/endpoint in CORS clipboard command.
- A19. SEC-4 — `<meta>` CSP fallback.
- A20. COR-8 — lift `_sessionFirstMount` into an `App.jsx` ref.
- A21. UX-3 / UX-4 / UX-5 — empty-state onboarding, single-file delete confirm, capability hint.
- A22. STD-6 — add tests for BUG-023 / BUG-024.
- A23. Encrypted share links (Phase 1).
- A24. Light-theme toggle.
- A25. Mobile breakpoints (foundation for the 2.0 UI refresh).
- A26. Commit a perf baseline and run `npm run bench` in CI.

---

## Appendix A — Raw Lane Outputs

Preserved at `docs/review-v1.14.0/` for traceability:

- `01-security.md` — full security lane (≈ 2,400 words)
- `02-correctness.md` — full correctness lane (≈ 2,700 words)
- `03-standards.md` — full standards / spec-drift lane (≈ 3,500 words)
- `04-build-perf.md` — full build / perf lane (≈ 2,000 words)
- `05-roadmap-ux.md` — full roadmap / UX / future-features lane (≈ 3,400 words)

Each was generated by an independent agent (4 × Sonnet 4.6, 1 × Haiku 4.5) reading from the same project tree but a deliberately distinct brief. The synthesis above de-duplicates findings that appeared in multiple lanes (notably `clearCredentials()`, which surfaced in security as a data-loss observation, in correctness as BUG-02, in standards as STD-01, and in UX as UX-02 — one fix resolves all four).

## Appendix B — Methodology Notes

- All five lanes were instructed to verify every finding from `eng-review-v1.0-2026-05-28.md` and label it Fixed / Still present / Partially fixed with current `file:line` evidence. Cross-lane corroboration confirmed the status of every prior-review item.
- CRIT-1 (the rename `DeleteObjectCommand` import miss) was raised by the correctness lane and verified manually before inclusion in this document. The exact two-line evidence — `grep -n "DeleteObjectCommand\|from '@aws-sdk" src/components/Browser.jsx` — shows the import at line 9 lacks the identifier and line 564 uses it.
- No code was modified during the review. No tests were run. No `npm install` / `npm run build` / `npm test` were executed. All evidence is from static reading of the repository at `1db477d` and the current `dist/index.html` artifact.
- This document is **not** committed. Per CLAUDE.md and the saved memory on commit/push confirmation, an explicit ask is required before any commit, tag, or push.
