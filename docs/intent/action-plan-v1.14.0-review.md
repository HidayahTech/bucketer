# Action Plan — v1.14.0 Engineering Review

**Date:** 2026-06-04
**Source review:** `REVIEW-v1.14.0-2026-06-04.md` (project root) — consolidated synthesis
**Lane files:** `docs/review-v1.14.0/01-security.md`, `02-correctness.md`, `03-standards.md`, `04-build-perf.md`, `05-roadmap-ux.md`, `06-provider-verification.md`, `06-providers/*.md`
**Status:** Complete (as of 2026-06-09 — all T1–T5 items verified done; see `docs/project-status.md`)

This document translates the v1.14.0 consolidated review into concrete, ordered work. Items are grouped by urgency tier. Each item includes the source finding, the affected location, and what done looks like.

---

## Tier 1 — Ship-blocking (hotfix immediately)

### T1-1: Add `DeleteObjectCommand` to `Browser.jsx` import [CRIT-1]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 2 — CRIT-1

**Problem:** `Browser.jsx:564` calls `new DeleteObjectCommand(...)` inside `commitRename` but `DeleteObjectCommand` is absent from the SDK import at line 9. Every rename throws `ReferenceError` after the copy step has already succeeded, leaving a duplicate file in the bucket. The original survives; the renamed copy also exists; the user sees an error toast.

**Fix:** Add `DeleteObjectCommand` to the import on line 9. One-word change. Almost certainly lost when the v1.14.0 unified-delete refactor moved delete imports out of `Browser.jsx` into `delete-queue.js`.

**Done when:** Rename completes without error and leaves exactly one file with the new name.

---

### T1-2: Add "every `new XCommand()` has a matching import" source invariant [STD-7 / BLD-3]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 5 — STD-7 and Section 6 — BLD-3

**Problem:** No mechanical check would have caught T1-1. The entire class of "use an identifier from an import that isn't there" is statically detectable.

**Fix:** Add a case to `test/source-invariants.test.js` that:
1. Greps each source file for `client.send(new ([A-Z][A-Za-z]+Command)\b` to collect all Command identifiers actually used.
2. Greps the same file's `@aws-sdk/client-s3` import for which identifiers are listed.
3. Asserts the used set is a subset of the imported set.

**Done when:** The test fails on a file that uses `DeleteObjectCommand` without importing it, and passes after the import is present.

---

## Tier 2 — High priority (next minor release)

### T2-1: Split `LS_KEYS` into credential keys and settings keys [COR-1 / STD-01 / UX-02]

**Finding:** All four review lanes independently surface this. Consolidated at `REVIEW-v1.14.0-2026-06-04.md` Section 4 — COR-1.

**Problem:** `clearCredentials()` at `src/lib/storage.js:72–75` iterates `Object.values(LS_KEYS)` and removes every key. `LS_KEYS` includes nine settings keys (`maxKeys`, `partConcurrency`, `partSizeMB`, `fileConcurrency`, `listingCacheTTL`, `updateCheckEnabled`, `prefetchSizeLimit`, `uploadExpandThreshold`, `capabilities`) alongside the five credential fields. Any user who disconnects loses all their settings silently. Has been open since the v1.0 review.

The author already applied the correct pattern for profiles — `QUESTIONS.md` line 11 explains they are deliberately outside `LS_KEYS` so disconnect doesn't remove them. Settings need the same treatment.

**Fix:**
1. In `storage.js`, replace the single `LS_KEYS` object with two: `CREDENTIAL_KEYS` (endpoint, bucket, keyId, provider, regionOverride) and `SETTINGS_KEYS` (everything else).
2. Change `clearCredentials()` to iterate only `CREDENTIAL_KEYS`.
3. `resetSettings()` already exists for the settings half — it becomes the only caller of `SETTINGS_KEYS`.

**Test:** Add to `test/storage.test.js`: `saveSettings({ partSizeMB: 50 })` → `clearCredentials()` → `loadSettings()` → assert `partSizeMB` is still `50`.

**Done when:** Disconnecting from a bucket does not affect any settings key in localStorage.

---

### T2-2: Parallelise the multipart resume path [COR-4 / STD-02]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 4 — COR-4. Also v1.0 finding #3, still open.

**Problem:** `handleResume` at `src/components/UploadQueue.jsx:371–385` uses a sequential `for` loop over `remainingParts`. Fresh uploads use a worker pool (`Promise.all(Array.from({ length: concurrency }, worker))`) with the configurable `PART_CONCURRENCY` default of 4. For a 1 GB file with 200 remaining 5 MB parts, resume runs ~4× slower than a fresh upload — which defeats the feature's purpose.

**Fix:** Extract a shared helper `uploadPartsWithPool(remainingParts, partSize, uploadFn, concurrency)` from `uploadMultipart` and call it from both `uploadMultipart` and `handleResume`. `PART_CONCURRENCY` / `loadPartConcurrency()` should apply equally to both paths.

**Done when:** Resuming a large file uses multiple concurrent part uploads visible in the network panel, and the elapsed time is comparable to a fresh upload of the same remaining byte count.

---

### T2-3: Fix `HiddenVersions.handlePurgeAllConfirm` error accumulation [COR-2]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 4 — COR-2. Also v1.0 finding #7, still open.

**Problem:** `src/components/HiddenVersions.jsx:128–131` throws on the first `resp.Errors` entry, abandoning all subsequent batches. A 2500-version purge that fails on batch 2 permanently deletes the first 1000 versions with no indication of partial success. The correct pattern is already in `delete-queue.js`'s `runDeleteOperation`.

**Fix:** Replace the throw-on-first-error pattern with the accumulating-errors pattern from `runDeleteOperation`: collect all `resp.Errors` into an array across all batches, continue through every batch regardless of individual errors, display an aggregate count + expandable error list at the end.

**Done when:** A purge-all that partially fails still attempts all batches and reports a total of how many succeeded vs failed.

---

### T2-4: Guard `readUrlParams()` endpoint against non-HTTP(S) schemes [SEC-1]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 3 — SEC-1.

**Problem:** `src/lib/url-params.js:21` — `if (p.has('endpoint')) out.endpoint = p.get('endpoint');` — applies no validation. A crafted share link like `bucketer.hidayahtech.net/#endpoint=https%3A%2F%2Fattacker.example%2Fs3&bucket=plausible-name` pre-fills the credential form with an attacker-controlled endpoint. If the user types their keys and clicks Connect before noticing, those credentials are sent to the attacker's server. The `provider` field was hardened in BUG-016; `endpoint` never was.

**Fix:**
```js
if (p.has('endpoint')) {
  const v = p.get('endpoint');
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' || u.protocol === 'http:') out.endpoint = v;
  } catch { /* ignore */ }
}
```
Apply an analogous guard on `bucket` (reject values containing `..` or path separators).

**Done when:** `readUrlParams` ignores any endpoint that is not a valid `http:` or `https:` URL.

---

### T2-5: Fix the CSP example in `README.md` [SEC-2]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 3 — SEC-2.

**Problem:** The nginx and Caddy examples at `README.md:163, 178` use `img-src data:` only. Presigned S3 preview URLs are `https:` URLs to third-party provider hosts, not data URIs. Anyone deploying with this example verbatim gets silently broken image, audio, video, and PDF previews. `media-src` and `frame-src` are entirely absent.

**Fix:** Update the `Content-Security-Policy` directives in both examples to at minimum:
```
img-src data: https:;
media-src https:;
frame-src https:;
```
Add a note that `script-src 'unsafe-inline'` is structurally required by the inline-bundle architecture and that a future hash-based approach (`script-src 'sha256-<hash>'`, emitted by `build.mjs`) would strengthen this.

**Done when:** A user deploying with the example CSP can open image, audio, video, and PDF previews without CSP violations in the browser console.

---

### T2-6: Try/catch around `runDeleteOperation` in `App.jsx` [COR-5]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 4 — COR-5.

**Problem:** `handleDeleteConfirm` in `src/components/App.jsx:198–201` does not wrap `await runDeleteOperation(...)` in a try/catch. An uncaught throw from the discovery path produces an unhandled rejection and leaves the delete panel permanently wedged in `'discovering'` or `'deleting'` phase with no dismiss path.

**Fix:** Wrap the await in try/catch and call `updateDeleteOp(id, { phase: 'done', errors: [{ key: '(unexpected)', message: err.message }], deletedPrefixes: [] })` so the panel always reaches a dismissible terminal state.

**Done when:** Any uncaught error in the delete pipeline results in the panel showing a dismissible error state rather than hanging indefinitely.

---

## Tier 3 — Provider-specific (batch into same release as Tier 2)

These are individually small but together make the app meaningfully more reliable across the provider matrix.

### T3-1: Wasabi 90-day retention warning [PV-01]

**Finding:** `docs/review-v1.14.0/06-provider-verification.md` — PV-01. Rated HIGH.

**Problem:** Wasabi Pay-as-You-Go bills for 90 days of storage on every object even if deleted on day 1. A user uploading test data and deleting it five minutes later is billed for 89 more days at full storage rates (~$20.97 per TB at 2026-06-04 rates). Bucketer's delete confirmation has no provider-specific warning.

**Fix:** When `provider === PROVIDERS.WASABI`, add a warning to:
- The delete confirmation dialog in `App.jsx`
- The HiddenVersions purge-all confirmation in `HiddenVersions.jsx`

Text: *"Wasabi billing note: Wasabi charges for a minimum of 90 days of storage per object (30 days for Reserved Capacity). Deleting today may still incur storage charges for up to 89 more days."*

**Done when:** Wasabi users see the billing note before confirming any delete operation.

---

### T3-2: Gate HiddenVersions panel on provider versioning support [PV-02]

**Finding:** `docs/review-v1.14.0/06-provider-verification.md` — PV-02.

**Problem:** Cloudflare R2 does not implement versioning at all (`ListObjectVersions`, `PutBucketVersioning`, `GetBucketVersioning` are on R2's unimplemented list). `HiddenVersions.jsx` issues these calls regardless of provider. Against R2 the panel returns empty with no explanation — users assume their versions disappeared.

**Fix:** Option A: hide the panel when `provider === PROVIDERS.R2`. Option B (preferred — more future-proof): attempt `GetBucketVersioning` on first panel open and render a "Cloudflare R2 does not support S3 object versioning" empty state when the call returns `NotImplemented`.

**Done when:** R2 users who open HiddenVersions see a clear "not supported" message rather than a silently empty list.

---

### T3-3: Extend AWS `extractRegion()` to cover virtual-hosted endpoint format [PV-03]

**Finding:** `docs/review-v1.14.0/06-provider-verification.md` — PV-03.

**Problem:** `src/lib/provider.js:72` uses `^s3\.([^.]+)\.amazonaws\.com$`. This only matches the service endpoint form. The AWS Console displays the virtual-hosted bucket URL (`mybucket.s3.us-west-2.amazonaws.com`), which most users will paste. That form returns `null` from `extractRegion()`, falls back to `us-east-1`, and produces `SignatureDoesNotMatch` for any bucket outside `us-east-1`. Dualstack endpoints (`s3.dualstack.<region>.amazonaws.com`) also miss.

**Fix (option A — regex extension):** Add patterns before or alongside the existing one:
```js
/^[^.]+\.s3\.([^.]+)\.amazonaws\.com$/   // virtual-hosted bucket URL
/^s3\.dualstack\.([^.]+)\.amazonaws\.com$/ // dualstack
/^s3-fips\.([^.]+)\.amazonaws\.com$/      // FIPS
/^s3-([^.]+)\.amazonaws\.com$/            // legacy dash-style
```

**Fix (option B — documentation):** Keep the regex narrow and update the SetupGuide AWS step to explicitly tell users to enter the *service* endpoint (`https://s3.<region>.amazonaws.com`), not the bucket URL.

Either option resolves the user-facing breakage; option A is more forgiving.

**Done when:** Pasting a virtual-hosted bucket URL into the endpoint field correctly extracts and signs with the right region.

---

### T3-4: Add mixed-content warning to MinIO SetupGuide [PV-05]

**Finding:** `docs/review-v1.14.0/06-provider-verification.md` — PV-05. Rated HIGH in production deployments.

**Problem:** Default MinIO installs are HTTP on localhost:9000. The canonical production Bucketer deployment is HTTPS. The browser's mixed-content policy silently blocks every S3 request from an HTTPS page to an HTTP server. The error appears only in DevTools; the app surface shows "request failed" with no helpful explanation. The SetupGuide does not mention this.

**Fix:** Add a warning block to `GuideMinIO` in `SetupGuide.jsx`:
> **HTTPS Bucketer + HTTP MinIO:** If you're using a hosted Bucketer (https://…), your MinIO server must also be HTTPS. Browsers block HTTPS pages from talking to HTTP servers (mixed-content policy). Either run Bucketer locally over `file://` / HTTP, or enable TLS on MinIO.

**Done when:** The MinIO setup guide explicitly covers the HTTPS deployment case.

---

### T3-5: Add `listAllBucketNames` instruction to B2 SetupGuide [PV-11]

**Finding:** `docs/review-v1.14.0/06-provider-verification.md` — PV-11.

**Problem:** AWS SDK v3 calls `ListBuckets` during client initialisation. A B2 Application Key scoped to a single bucket and missing the `listAllBucketNames` capability causes initialisation to fail entirely. The SetupGuide doesn't mention this capability.

**Fix:** In the B2 step of `SetupGuide.jsx`, add:
> If you restrict this key to a single bucket, also enable **Allow List All Bucket Names** so the AWS SDK can initialise correctly.

**Done when:** The B2 guide mentions `listAllBucketNames` and when to add it.

---

### T3-6: Update R2 SetupGuide — Account ID, billing card, token scope [PV-06]

**Finding:** `docs/review-v1.14.0/06-provider-verification.md` — PV-06 and lane file `06-providers/cloudflare-r2.md`.

**Problem:** The R2 setup guide does not tell users where to find their Account ID (required in the endpoint URL), does not mention that a payment method is required even at free-tier usage, and does not explain the bucket-scoped vs account-scoped token distinction (bucket-scoped tokens cannot call `ListBuckets`, which will matter for the v2.0 multi-bucket flow).

**Fix:** In the R2 branch of `SetupGuide.jsx`, add:
- Where to find the Account ID (Cloudflare dashboard sidebar).
- A note that R2 requires a payment method on file even on the free tier.
- Token scope guidance: bucket-scoped is sufficient for single-bucket use; account-scoped "Workers R2 Storage Read" is needed for v2.0 multi-bucket.

---

## Tier 4 — Medium priority (v2.0 enabling work)

These are not bugs but are prerequisites for safe feature work in 2.0.

### T4-1: Extract `usePreview` hook from `Browser.jsx` [STD-1]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 5 — STD-1; `docs/review-v1.14.0/03-standards.md` extraction proposal.

**Problem:** `Browser.jsx` is 1326 lines with ~35 `useState` calls in the main component and 53 total. Any 2.0 feature that touches it carries real risk. The preview state cluster is the largest and most self-contained: `previewItem`, `previewUrl`, `previewError`, `resolvedKind`, `notPreviewable`, `detectedContentType`, `previewText`, `previewTruncated`, `previewPixelated`, `previewCopyOpen`, `previewCopied`, `previewUrlCacheRef`, `prefetchGenRef`, `prevNextRef`, `navigatePreviewRef` — plus the `useEffect` keyboard handler and the entire `prefetchAdjacent` async. It has zero entanglement with listing, rename, or delete logic.

**Fix:** Extract to `src/lib/use-preview.js` as `usePreview(client, bucket, prefetchSizeLimit)`. Exposes `{ previewItem, open, close, navigate, isLoading, ... }`. Estimated −150 lines from `Browser.jsx`. This is the first extraction; `useRename`, `useMetadata`, and `useListingCache` follow in the same order.

**Done when:** `Browser.jsx` imports `usePreview` from `src/lib/use-preview.js` and has no inline preview state variables.

---

### T4-2: Fix `handlePreview` cancellation guard [COR-3]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 4 — COR-3.

**Problem:** A slow HeadObject or `getSignedUrl` call from a previous preview can resolve after the user has navigated to a different folder and set `previewUrl` / `previewText` / `previewError` for a key no longer in view. The modal can appear or update for the wrong file. `prefetchAdjacent` correctly uses `prefetchGenRef` to abandon stale runs; `handlePreview` has no equivalent.

**Fix (simplest):** Have `navigateTo` call `closePreview()` — the modal closes on folder navigation, which is the correct UX anyway.

**Fix (better):** Add a `previewGenRef` that increments at the start of each `handlePreview` call and is checked before each `set*` call, matching the `prefetchGenRef` pattern.

**Fix (best, combined):** Also track a per-preview `AbortController` in a ref; abort it at the start of each new `handlePreview` call so in-flight HeadObject requests are actually cancelled rather than just ignored.

Natural to land alongside the T4-1 `usePreview` extraction since both live in the same state cluster.

---

### T4-3: Cap `discoverPrefixKeys` concurrency [COR-6]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 4 — COR-6.

**Problem:** `src/lib/delete-queue.js:37–51` uses `Promise.all(prefixes.map(...))` with no concurrency cap. Deleting 30+ folders simultaneously launches 30+ `ListObjectsV2` paginated crawls. This can saturate the HTTP/2 connection pool and trigger 503 throttling from S3 providers.

**Fix:** Cap discovery concurrency at 4–8 using the same worker-pool pattern already used for `DeleteObjectsCommand` batches in `runDeleteOperation`. The `CONCURRENCY = 8` constant is the right model.

---

### T4-4: Fix `formatBytes` for null/NaN/negative input [COR-7]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 4 — COR-7.

**Problem:** `src/lib/format.js:4–9` only guards for `bytes === 0`. For null, undefined, NaN, or negative input, `Math.log(bytes)` returns NaN, which propagates to a `units[undefined]` access, producing the string `"NaN undefined"` visible in the size column for S3 objects (delete markers, folder placeholders) that omit the `Size` field.

**Fix:** Add a guard at the top: `if (bytes == null || isNaN(bytes) || bytes < 0) return '—';`

Add cases to `test/format.test.js` covering null, undefined, NaN, negative, and Infinity inputs.

---

### T4-5: Correct three stale claims in `docs/QUESTIONS.md` [STD-3]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 5 — STD-3.

**Problem:** Three factual errors in 80 lines that mislead anyone onboarding to the codebase:
1. D1 deviation (lines 52–63) still describes Connection Failed as an unresolved deviation — it has been implemented. `SPEC-DRIFT.md` D-4 explicitly demanded this be struck through.
2. "Known Limitations" (lines 43–44) still says "No delete, rename, copy — out of scope per §6." All three ship.
3. "Decisions Made" table (line 79) says "N=2 upload concurrency default" — actual default is N=3 (`DEFAULT_FILE_CONCURRENCY = 3` at `UploadQueue.jsx:39`).

**Fix:** Strike through D1 with a "Resolved in v1.14.0" note; remove or correct the Known Limitations bullet; update the Decisions table.

---

### T4-6: Accessibility baseline [A-1, A-2, A-3]

**Finding:** `REVIEW-v1.14.0-2026-06-04.md` Section 7 — findings A-1, A-2, A-3.

**Problem:** Three High-severity accessibility gaps:
- No focus trap in any modal (`AboutModal`, `ChangelogModal`, `StorageModal`, preview). Keyboard users' focus stays behind the overlay.
- No focus-on-open or focus-return in any modal. Tab navigates visually-obscured DOM elements.
- Every `<label>` lacks `htmlFor`: 5 in `CredentialForm`, 7 in `SettingsPanel`, 1 in `UploadQueue`. Clicking the label text does not focus the input; screen readers cannot announce the association.

**Fix:** `htmlFor` is mechanical and can be done in under an hour. Focus trapping requires a trap utility (small, can be inline) attached in `useEffect` on modal open. Both can be done independently.

---

## Tier 5 — Low priority / quality-of-life

Small, bounded, do when passing by the relevant files.

| ID | Finding | Fix summary |
|----|---------|-------------|
| T5-1 | [BLD-1] No `sourceMappingURL`-absence build invariant | 3–5 lines in `build.mjs`, mirroring existing meta-tag checks |
| T5-2 | [BLD-2] No bundle-size ceiling | Add `const SIZE_LIMIT = 600 * 1024; if (size > SIZE_LIMIT) throw` in `build.mjs` |
| T5-3 | [SEC-3] CORS clipboard command interpolates raw bucket/endpoint | `q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"` in `corsCmd()` |
| T5-4 | [SEC-4] No `<meta>` CSP for S3 static-hosting deployments | Add meta CSP after the `build-id`/`app-version` tags; verify 512-byte boundary still passes |
| T5-5 | [COR-8] `_sessionFirstMount` module-level mutable | Lift to `useRef(true)` in `App.jsx`; pass as `isFirstMount` prop with consume callback |
| T5-6 | [UX-3] Empty state doesn't distinguish empty bucket from empty prefix | When `prefix === ''` and listing is empty, render onboarding copy with Upload CTA |
| T5-7 | [UX-4] Single-file row delete fires without confirmation | Add confirm step (modal or inline) matching the batch-delete flow |
| T5-8 | [UX-5] CapabilityPanel `?` state is opaque | Add inline hint: "Permissions are detected automatically as you use each feature" |
| T5-9 | [A-4] Progress bars have no ARIA progress attributes | Add `aria-valuenow`/`aria-valuemin`/`aria-valuemax` to upload progress bars |
| T5-10 | [STD-6] BUG-023 and BUG-024 have no automated test | Add `test/upload-queue-cancel.test.js` with mock `loadResumeRecord`/`deleteResumeRecord` |
| T5-11 | [PV-08] Wasabi virtual-hosted style causes SSL errors on dotted bucket names | Either switch `requiresPathStyle(WASABI) → true` or add a caveat in the Wasabi SetupGuide |
| T5-12 | [PV-09] B2 path-style comment overstates requirement | Update comment: "B2 supports both; we force path-style because users supply a plain regional endpoint" |
| T5-13 | [PV-10] B2 `defaultMaxKeys=200` comment cites wrong billing rationale | B2 Class A/B/C are all free; reframe as a UX choice |
| T5-14 | [PV-12] Wasabi legacy alias endpoints extract wrong region | Build a `WASABI_ALIASES` map (`nl-1 → eu-central-1`, etc.) and translate at extraction time |

---

## v2.0 prerequisites (must land before redesign begins)

These are not in the tier system above — they are structural, multi-session work tracked separately.

1. **Decouple `bucket` from the credential/profile model.** `bucket` is referenced 156 times across the codebase (SetupGuide: 53, Browser: 26, UploadQueue: 24, App: 17, lib: 41, others). It must become optional at the credential layer and runtime-selected post-`ListBuckets`. Migration: a non-empty `bucket` on an existing profile becomes "single-bucket mode" (bypasses discovery, connects directly). No version bump needed on the profile envelope. See `docs/review-v1.14.0/05-roadmap-ux.md` §1 for the full coupling heat map and blocker order.

2. **Key `s3b_capabilities` by bucket.** Currently a global-per-session JSON blob. With multiple buckets, capabilities differ per bucket. Change the shape to `{ [bucketName]: { list, download, upload, delete } }` before the bucket picker lands, or switching buckets will show stale permission indicators.

3. **Extract custom hooks from `Browser.jsx`.** T4-1 above is the first step. Full order: `usePreview` → `useRename` → unify `CopyLinkPopover` / `BatchCopyLinkPopover` → `useListingCache` → `useMetadata`. Cuts ~250 lines and ~12 state vars from the central debt. Any new 2.0 surface area in `Browser.jsx` is risky until this lands.

4. **Establish a responsive layout skeleton.** Two breakpoints minimum (≤640 px mobile, ≤960 px mid). Test sidebar, file table, and modals at each. Must precede the UI refresh so visual polish is not duplicated across breakpoints added later.

5. **Explicitly decide and document the `file://` stance.** `SPEC-DRIFT.md` is the right home. The decision appears implicit (continue support); making it explicit removes ongoing uncertainty from `file://`-specific branches.

---

## Appendix — Finding reference index

| Action | Review finding ID | Location |
|--------|-------------------|----------|
| T1-1 | CRIT-1 | `REVIEW-v1.14.0-2026-06-04.md` §2 |
| T1-2 | STD-7, BLD-3 | `REVIEW-v1.14.0-2026-06-04.md` §5, §6 |
| T2-1 | COR-1, STD-01, UX-02, SEV-01 | All four lanes; `REVIEW-v1.14.0-2026-06-04.md` §4 |
| T2-2 | COR-4, STD-02 | `REVIEW-v1.14.0-2026-06-04.md` §4; `docs/review-v1.14.0/02-correctness.md` BUG-06 |
| T2-3 | COR-2, STD-03 | `REVIEW-v1.14.0-2026-06-04.md` §4; `docs/review-v1.14.0/02-correctness.md` BUG-03 |
| T2-4 | SEC-1, SEV-02 | `REVIEW-v1.14.0-2026-06-04.md` §3; `docs/review-v1.14.0/01-security.md` SEV-02 |
| T2-5 | SEC-2, SEV-03 | `REVIEW-v1.14.0-2026-06-04.md` §3; `docs/review-v1.14.0/01-security.md` SEV-03 |
| T2-6 | COR-5, BUG-05 | `REVIEW-v1.14.0-2026-06-04.md` §4; `docs/review-v1.14.0/02-correctness.md` BUG-05 |
| T3-1 | PV-01 | `docs/review-v1.14.0/06-provider-verification.md` §3; `docs/review-v1.14.0/06-providers/wasabi.md` |
| T3-2 | PV-02 | `docs/review-v1.14.0/06-provider-verification.md` §3; `docs/review-v1.14.0/06-providers/cloudflare-r2.md` |
| T3-3 | PV-03 | `docs/review-v1.14.0/06-provider-verification.md` §3; `docs/review-v1.14.0/06-providers/aws.md` |
| T3-4 | PV-05 | `docs/review-v1.14.0/06-provider-verification.md` §3; `docs/review-v1.14.0/06-providers/minio.md` |
| T3-5 | PV-11 | `docs/review-v1.14.0/06-provider-verification.md` §3; `docs/review-v1.14.0/06-providers/backblaze-b2.md` |
| T3-6 | PV-06 | `docs/review-v1.14.0/06-provider-verification.md` §3; `docs/review-v1.14.0/06-providers/cloudflare-r2.md` |
| T4-1 | STD-1 extraction | `REVIEW-v1.14.0-2026-06-04.md` §5; `docs/review-v1.14.0/03-standards.md` STD-01 |
| T4-2 | COR-3, BUG-04, BUG-11 | `REVIEW-v1.14.0-2026-06-04.md` §4; `docs/review-v1.14.0/02-correctness.md` BUG-04 |
| T4-3 | COR-6, BUG-09 | `REVIEW-v1.14.0-2026-06-04.md` §4; `docs/review-v1.14.0/02-correctness.md` BUG-09 |
| T4-4 | COR-7, BUG-08 | `REVIEW-v1.14.0-2026-06-04.md` §4; `docs/review-v1.14.0/02-correctness.md` BUG-08 |
| T4-5 | STD-3, STD-04 | `REVIEW-v1.14.0-2026-06-04.md` §5; `docs/review-v1.14.0/03-standards.md` STD-04 |
| T4-6 | A-1, A-2, A-3 | `REVIEW-v1.14.0-2026-06-04.md` §7; `docs/review-v1.14.0/05-roadmap-ux.md` A-01–A-03 |
