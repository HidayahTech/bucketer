# Roadmap, UX & Future Features — Bucketer v1.14.0

## Summary

Bucketer v1.14.0 is a functionally complete S3 browser with production-quality upload mechanics and a solid provider-abstraction layer. The biggest UX gap is the first-run experience: CORS setup is a multi-step CLI prerequisite that blocks the app entirely for new users, and the 401-line `SetupGuide.jsx` doubles as both a first-run wizard and a recurring reference—a purpose conflict that makes neither job ideal. The most significant 2.0 readiness blocker is not the data model (profiles already have a `version` envelope and survive unknown-field round-trips) but the tight coupling of `bucket` as a first-class credential field throughout every layer; decoupling it while keeping backwards-compat with existing stored profiles requires coordinated changes across storage, URL scheme, capability state, and at least three major components.

---

## Roadmap 2.0 Readiness

### Feature 1: Multi-bucket browsing

**Bucket coupling heat map (reference counts, excluding comments/imports):**

| File | Bucket refs | Notes |
|---|---|---|
| `SetupGuide.jsx` | 53 | Renders bucket in every CLI command snippet |
| `Browser.jsx` | 26 | `Bucket` param on every SDK command |
| `UploadQueue.jsx` | 24 | Same pattern |
| `App.jsx` | 17 | credential state, status label, share URL |
| `StorageModal.jsx` | 9 | Displays bucket in profiles table |
| `CredentialForm.jsx` | 9 | Bucket field in the form |
| `ProfilePicker.jsx` | 5 | Displayed in profile rows |
| `HiddenVersions.jsx` | 5 | SDK commands |
| `src/lib/*.js` | 41 | storage keys, URL params, CORS config |

`bucket` is structural—not cosmetic—in `Browser.jsx` and `UploadQueue.jsx` because it is passed directly as `Bucket:` on every SDK command call. A multi-bucket model requires that `bucket` be lifted from the credential/profile model into a runtime selection that is passed down through both components.

**Concrete blockers, in order of effort:**

1. **Credential/profile model: `bucket` is mandatory today.** `CredentialForm` validates it as required; the profile schema always stores it; `credentials.bucket` feeds the connected status label, share URL, and Browser/UploadQueue props. For multi-bucket, `bucket` must become optional at the credential level and runtime-selected after `ListBuckets`. This requires `CredentialForm`, `ProfilePicker`, `storage.js`, and `App.jsx` to accept a null/absent bucket field—and `migrateProfilesFromLegacy` to be idempotent across that shape change.

2. **Capability state is keyed globally per profile.** `s3b_capabilities` is a single JSON blob per session. With multiple buckets, capabilities (list/download/upload/delete) differ per bucket. The storage key and the in-memory capability shape in `App.jsx` must be keyed by bucket name before multi-bucket browsing is trustworthy.

3. **URL fragment scheme carries a single `bucket` parameter.** `buildShareUrl` / `readUrlParams` in `src/lib/url-params.js` encode one bucket. Multi-bucket deep links require a `bucket=` parameter distinct from the credential. This is additive but must be versioned (the existing `#v2:` encrypted link design already anticipates a versioned fragment scheme).

4. **`SetupGuide.jsx` pre-fills all CLI commands with `credentials.bucket`.** With multiple buckets, CORS setup is per-bucket. Either the guide must be opened per-bucket (bucket passed as a prop), or it must render a bucket picker. This is the highest UI surface-area change.

5. **`Browser.jsx` / `UploadQueue.jsx` accept `bucket` as a prop.** This is already the right interface pattern—but the upstream prop origin (App.jsx) will need to derive bucket from a runtime selection, not directly from credentials.

**Suggested migration path for stored profiles:**

The existing `version: 1` envelope and the `loadProfiles` tolerant-loading invariant (unknown fields preserved on round-trip) mean no migration is needed for old profiles. The v1.14.0 profile schema stores `bucket` as a string. In 2.0, treat a non-empty `bucket` field on a profile as "single-bucket mode" that bypasses `ListBuckets` and connects directly—backward-compatible without a version bump. Profiles with no bucket field (created in 2.0) trigger bucket discovery on connect. The `version` field can remain `1`; the distinction is handled by `bucket` presence alone.

---

### Feature 2: UI refresh

**Design system today:**

`main.css` has a well-structured CSS-variables system in `:root` covering:
- **Colours:** `--bg`, `--surface`, `--surface-raised`, `--border`, `--border-focus`, `--text`, `--text-muted`, `--text-danger`, `--text-success`, `--text-warn`, `--accent`, `--accent-hover`, `--danger`, `--danger-hover`, four semantic background tokens (`--success-bg`, `--warn-bg`, `--danger-bg`, `--info-bg`)
- **Typography:** `--font` (system stack), `--mono` (code)
- **Spacing:** no spacing tokens — padding/gap values are hard-coded throughout (`.5rem`, `1rem`, `1.25rem`, etc.)
- **Shape:** `--radius: 6px`, `--shadow`, `--transition: 140ms ease`

**Theming readiness:** The dark theme is implemented today via a single `@media (prefers-color-scheme: dark)` block that overrides all colour tokens — this is the correct architecture. Adding a light-theme toggle requires only: (a) moving the dark-theme overrides from a media query into a `[data-theme="dark"]` selector so JS can toggle it, and (b) keeping the `:root` block as the light theme. The colour tokens are already a complete set. Estimated effort: half a day to rewire the media query and add a toggle button.

**Mobile readiness: none.** There is exactly one `@media` query in the entire CSS file, and it is `prefers-color-scheme: dark`. There are no width-based breakpoints, no collapsible sidebar behaviour on narrow viewports (the sidebar uses `transform: translateX(-100%)` which is a good mobile foundation, but no trigger exists on mobile), no touch-target sizing (`min-height: 44px` standard), and no responsive table behaviour (the file table has fixed-width columns that will overflow on narrow screens). The `max-width: calc(100vw - 2rem)` on the sidebar is the only defensive mobile rule. Mobile readiness is essentially zero and would require a full responsive pass as part of 2.0.

**Component-library consistency:**

- **Buttons:** `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-sm` — consistent system. Plus several one-off inline-styled buttons (hamburger, version badge, Copy snippet in SetupGuide, splash About link, header action buttons with inline `borderColor` overrides). The inline-styled buttons are the inconsistency.
- **Modals:** all use `.modal-overlay` / `.modal-dialog` pattern consistently — AboutModal, ChangelogModal, StorageModal follow the same structure.
- **Inputs:** `.form-group` + `<label>` + `<input>` is consistent in CredentialForm, SettingsPanel, and UploadQueue. However, **no labels use `htmlFor`/`for`**: every `<label>` floats without an explicit association to its input, which means clicking the label text does not focus the field and screen readers cannot announce the association.

---

### Out-of-scope-for-2.0 designs (state of)

**Encrypted share links (`docs/design-encrypted-share-links.md`):**
Design is complete and thorough. The URL format (`#v2:<base64-IV>.<base64-ciphertext>`), key derivation strategy (PBKDF2 via SubtleCrypto), AES-GCM encryption, backward-compat `v1`/`v2` detection, and implementation attachment points (`buildShareUrl` / `readUrlParams`) are all specified. Two open questions remain (origin-derived vs. fixed key; whether Key ID is always included). Implementation effort: approximately 1 day. Zero bundle-size impact (SubtleCrypto is browser-native). This could ship as a 1.x point release.

**Persistent upload queue (`docs/intent/persistent-queue-design.md`):**
Design is the most thorough of the three: batch model, IDB schema (two new object stores), done-set logic, reconnect UX, pause/stop/discard semantics, and a four-phase implementation plan. A genuine open question exists around IDB schema version bump coordination with existing resume records. Phase 1 (done-set only, no UI changes) is a safe 1–2 day 1.x release candidate. The full four-phase design is a significant feature (~1 week) and correctly deferred to post-2.0.

**Storage viewer (`docs/design-storage-viewer.md`):**
Design is implementation-ready: component structure, props, internal state, all six sections, the "Clear All App Data" flow, `wipeAllAppData()` implementation, and edge cases (private browsing, multi-tab, active session). The `StorageModal.jsx` component already exists (468 lines, the fourth largest component) — this design appears to be at least partially implemented. Verification against the actual component would confirm completion status. Remaining effort: likely small (polish and the `wipeAllAppData` function) if the component is already wired.

---

## Accessibility Audit (light-touch)

**Count of `aria-*` attributes across all components: 9** (across 9 distinct sites)

Breakdown:
- `aria-label`: 7 occurrences — hamburger button, preview close/prev/next buttons, tap zones, logo, dismiss buttons
- `role="alert"`: 2 occurrences — `ErrorBlock` and `FileBanner`
- `role="status"`: 1 occurrence — `UpdateBanner`
- `aria-live`, `aria-hidden`, `aria-modal`, `aria-describedby`: **zero occurrences**

**Modal focus management:**

None of the modals implement focus trapping. There are no `.focus()` calls anywhere in any component. Modals handle `Escape` via `document.addEventListener('keydown', ...)` but do not: (1) move focus into the modal on open, (2) trap Tab within the modal, or (3) return focus to the trigger element on close. This means keyboard users who open a modal will have their focus remain behind the overlay, and Tab will navigate DOM elements that are visually obscured.

- `AboutModal`: Escape closes; no focus trap; no focus return.
- `ChangelogModal`: same pattern.
- `StorageModal`: same pattern.
- Preview modal in `Browser.jsx`: keyboard navigation for prev/next arrows is implemented via `onKeyDown` on the rename input (line 1224) but not generically across the modal. The `‹`/`›` nav buttons have `aria-label` but focus does not enter the modal automatically.

**Keyboard shortcuts:** There are no global keyboard shortcuts beyond Escape on modals and Enter/Escape on inline inputs (rename, new folder, profile save form). No keyboard shortcut for upload, preview navigation, or delete is discoverable.

**Form labels:** Every `<label>` in the codebase floats without `htmlFor`. `CredentialForm` has five labels; `SettingsPanel` has seven; `UploadQueue` has one. None are programmatically associated to their inputs.

**Colour contrast:** The dark theme palette (`--text: #c1c2c5` on `--bg: #1a1b1e`) approximates 10:1 for body text — good. `--text-muted: #909296` on `--surface: #25262b` is approximately 4.5:1 — passes AA for normal text, borderline for the small-print sizes used for hints and column headers. The header (`color: #fff` on `#1b2438`) is a hard-coded non-token value — this will not update with a theme toggle.

**Progress indicators:** Upload progress bars have no `aria-valuenow`/`aria-valuemin`/`aria-valuemax`. Delete progress phases ("Discovering…", "Deleting…") render as text but have no `aria-live` region to announce them to screen readers.

**Specific findings (severity-ordered):**

| # | Finding | Severity |
|---|---|---|
| A-01 | No focus trap in any modal | High |
| A-02 | No focus-on-open in any modal | High |
| A-03 | Labels not associated to inputs (missing `htmlFor`) | High |
| A-04 | Progress bars lack ARIA progress attributes | Medium |
| A-05 | Delete/upload progress not announced via `aria-live` | Medium |
| A-06 | `aria-live` absent on capability probe results | Low |
| A-07 | Header background is a hard-coded hex, not a token | Low |
| A-08 | Tap zones in preview modal have `aria-label` but are `<div>` not `<button>` | Low |

---

## UX Findings (severity-ordered)

### [UX-01] CORS setup is a CLI prerequisite that completely blocks first-time use — High

**Location:** `SetupGuide.jsx` (401 lines), triggered when `needsCorsConfig` returns true for a new connection.

**Evidence:** For all providers except Wasabi, the app cannot make any API call until the user runs AWS CLI commands to set CORS headers on their bucket. `SetupGuide.jsx` is rendered inside the connected sidebar (only visible post-connect) but is required before any operation succeeds. New users see connection failures with a CORS error, then must navigate to the setup guide, install the AWS CLI, configure a profile, and run provider-specific multi-step commands before the app becomes functional.

**User impact:** Highest friction point in the product. A user trying the app for the first time who does not already have AWS CLI installed and a key configured will abandon before completing setup.

**Recommendation:** (1) Surface the setup guide *before* the Connect button is clicked for new users—surface it on the splash screen as "Before you connect, your bucket needs CORS configured" with a collapsible guide. (2) Investigate whether a `fetch`-based CORS probe on Connect can detect the problem before the user is in a failed state and surface the guide inline with the exact error. (3) Long-term: explore whether `PutBucketCors` via the SDK itself (using the user's credentials) could automate the step entirely for providers that allow it, eliminating the CLI dependency.

---

### [UX-02] `clearCredentials()` deletes all user settings on Disconnect — High (known bug)

**Location:** `src/lib/storage.js`, `clearCredentials()`

**Evidence:** Noted in `eng-review-v1.0-2026-05-28.md` §2. `LS_KEYS` includes settings keys (`maxKeys`, `partConcurrency`, `partSizeMB`, `fileConcurrency`, `listingCacheTTL`, `capabilities`). Disconnect clears them all.

**User impact:** A user who configures 50 MB part size or 4-file concurrency loses these on every disconnect. High recurrence rate for multi-bucket users who disconnect to switch.

**Recommendation:** Separate `clearCredentialFields()` (endpoint, bucket, keyId, provider, regionOverride only) from `clearSettings()`. Only the credential fields should clear on disconnect. A separate "Reset settings" action (the Storage Viewer design already provides this) should govern the settings keys.

---

### [UX-03] Empty state does not distinguish "empty bucket" from "empty prefix" from "filtered to nothing" — Medium

**Location:** `Browser.jsx` line 1159-1160

**Evidence:** 
```
filterQ ? 'No files match the filter.' : 'This prefix is empty.'
```
Neither case distinguishes "this prefix has no objects" (normal empty folder) from "the entire bucket is empty" (new bucket, first-time use). The first-run case is the one where user guidance would matter most.

**User impact:** A new user who has just connected to an empty bucket sees "This prefix is empty." with no indication of what to do next. Upload zone is below, but there is no directional cue.

**Recommendation:** Add a third case: when `prefix === ''` (root) and the bucket appears empty, render an onboarding empty state: "This bucket is empty — upload files to get started" with a prominent Upload call to action.

---

### [UX-04] No undo for any destructive operation — Medium

**Location:** All delete paths in `App.jsx`, `DeleteQueue.jsx`, `HiddenVersions.jsx`

**Evidence:** Deleted objects are immediately removed. The only recovery path is provider-side versioning (where available). `HiddenVersions.jsx` has one "cannot be undone" warning. No toast-with-undo, no recycle bin, no soft-delete.

**User impact:** Accidental single-file deletion is a real risk. The confirmation modal mitigates bulk delete but not single-file row-action delete (which fires `onDeleteRequest` directly from a button click — no confirmation step for single files).

**Recommendation:** (1) Add a confirmation step for single-file deletes (currently confirmless). (2) Consider a brief "undo window" toast for single-file deletes: delay the actual API call by 5 seconds, show a toast with "Undo" button. This is feasible without backend state since the app already holds the key in memory.

---

### [UX-05] CapabilityPanel is opaque — Low

**Location:** Sidebar `CapabilityPanel`, `CapabilityPanel.jsx`

**Evidence:** The panel shows ✓/✕/? for Browse/Download/Upload/Delete. The `?` state means "not yet tested" but is labelled only "Not yet tested" in a `title` attribute (tooltip only). A new user seeing four `?` marks has no intuition that these will self-populate on first use, or why they might show ✕.

**User impact:** Confusion for non-technical users; power users understand it.

**Recommendation:** Add a one-line hint below the panel: "Permissions are detected automatically as you use each feature." Replace the `?` label text with "Untested" rendered inline (not just a tooltip) for the denied state description.

---

### [UX-06] SetupGuide is the same component for first-run and recurring reference — Low

**Location:** `SetupGuide.jsx` (401 lines)

**Evidence:** The guide lives in the sidebar and is only accessible once connected. It covers AWS CLI install, provider-specific profile setup, CORS rule commands, and verification—a one-time-only workflow mixed with reference material (CORS JSON, CLI commands the user may need to re-run).

**User impact:** First-run users need wizard-style guidance; returning users need reference. The current single-component approach serves neither optimally.

**Recommendation:** Split into a `CorsGuide` reference component (pure reference, no step framing) and a first-run onboarding flow that calls it at the right moment. The `Step` sub-component already in SetupGuide is a good primitive.

---

## Missing Features Worth Considering

### Discoverability / power-user quality of life
- **Client-side search/filter:** `docs/TODO.md` item #1, explicitly designed, ~1 day — filter `sortedItems` by filename substring with "X of Y" count
- **Keyboard shortcuts:** no global shortcuts exist; preview open/close, navigation, upload-focus are all mouse-only
- **Object metadata panel:** `TODO.md` item #5, `HeadObject` reuse from preview flow, read-only display of ContentType/ETag/StorageClass/custom headers
- **Storage class display:** `StorageClass` is returned in `ListObjectsV2` responses but never surfaced in the file table

### Bulk operations
- **Bulk download:** most-requested missing feature; requires client-side ZIP assembly (e.g. `fflate`) or the native File System Access API Save dialog; correctly out of scope for 1.x
- **Bulk rename (prefix → prefix):** move a whole "folder" to a new prefix without deleting it; copy-then-delete pattern already implemented for single files
- **Move vs. copy-then-delete:** the current rename is a destructive copy—if the copy succeeds but the delete fails, the object is duplicated. A true transactional move is not possible in S3, but a "copy succeeded, delete failed" error message should explicitly tell the user what happened.

### Upload experience
- **Direct paste-from-clipboard upload:** `paste` event + `DataTransfer.files` — image paste is a common power-user workflow; ~half a day
- **Persistent queue (Phase 1 — done-set only):** `docs/intent/persistent-queue-design.md` Phase 1 is self-contained and low-risk; skipping already-uploaded files on folder re-drop is independently valuable

### Sharing and collaboration
- **Encrypted share links:** design is complete; implementation is ~1 day; pre-fills keyId safely
- **Prefix-scoped read links:** already partially addressed by the existing share URL, but no UI for "share this folder as a read-only link" with an expiry time

### Provider / advanced S3
- **Storage class change:** `CopyObject` with updated `StorageClass` — natural extension of the existing rename
- **Object tagging:** `GetObjectTagging` / `PutObjectTagging` — no S3 tagging UI exists
- **Versioning enable/disable from UI:** currently versioning is probed but not controllable
- **Bucket lifecycle policies:** out of scope, but absence is a gap for Glacier/IA users
- **Multi-region awareness:** cross-region copy would require a second S3 client; noted as out of scope but asked for

### Platform / reach
- **Mobile / PWA:** zero responsive breakpoints today; adding a `manifest.json` and `meta viewport` would enable "Add to home screen"; usability requires responsive layout first
- **i18n:** single-language English; not a gap for the current user profile but a future scaling blocker
- **Accessibility as a marketed feature:** the security story is well-articulated; an "accessible by design" bullet would differentiate against AWS console and most third-party tools

---

## v1.x Quick Wins (≤1 day each)

1. **Fix `clearCredentials()` to not delete settings** — split credential keys from settings keys; affects every user who disconnects (`storage.js`, ~20 lines)
2. **Add `htmlFor` to all form labels** — mechanical change across `CredentialForm`, `SettingsPanel`, `UploadQueue`; fixes all A-03 findings in under an hour
3. **Light theme toggle** — refactor the one `@media (prefers-color-scheme: dark)` block to `[data-theme="dark"]`; add a toggle button; all colour tokens already exist
4. **Client-side filename filter** — `docs/TODO.md` item #1, fully designed, no API calls, adds "X of Y" count when filtering; ~4 hours
5. **Single-file delete confirmation** — single-file row delete currently fires without confirmation; add the same confirm step already used for batch delete; ~2 hours
6. **Empty-bucket onboarding state** — distinguish root-prefix empty from subfolder empty; add "upload to get started" CTA; ~2 hours
7. **Add `aria-valuenow`/`aria-valuemin`/`aria-valuemax` to progress bars** — mechanical addition to `UploadQueue` progress bar render; ~1 hour
8. **`sandbox` attribute on PDF preview iframe** — noted in SHOW-HN-ANALYSIS §1.4; defense-in-depth; one-line change in `Browser.jsx`
9. **Encrypted share links (Phase 1)** — design complete in `docs/design-encrypted-share-links.md`; SubtleCrypto + `url-params.js` extension; zero bundle impact; ~1 day
10. **CapabilityPanel inline hint** — add "Permissions are detected automatically" sub-text; ~30 minutes

---

## v2.0 Prerequisites (must do before the 2.0 redesign starts)

1. **Decouple `bucket` from the credential/profile model** — make `bucket` optional at the credential level; update `CredentialForm`, `App.jsx`, `storage.js`, and `url-params.js` to treat a missing bucket as "runtime-selected." This is the single largest structural change and must land before any multi-bucket UI work.

2. **Key capability state by bucket** — change `s3b_capabilities` storage and in-memory shape from a global-per-session object to a `{[bucketName]: { list, download, upload, delete }}` map. Without this, switching buckets will show stale or incorrect permission indicators.

3. **Extract custom hooks from `Browser.jsx`** — currently 1326 lines with 33+ `useState` calls. The preview, delete, and rename flows are the cleanest extraction candidates. This is the prerequisite for safe feature work in 2.0: any new 2.0 capability (bucket picker, split pane, etc.) that touches `Browser.jsx` will be dangerous to land until the component is more modular.

4. **Establish responsive layout skeleton** — add at minimum two breakpoints (narrow/mobile ≤640px, mid ≤960px) and test the sidebar, file table, and modal layouts at each. This must be done as foundational work before the UI refresh adds new visual polish that would be duplicated at each breakpoint.

5. **Decide and document the `file://` stance** — as noted in `eng-review-v1.0-2026-05-28.md`, `file://`-specific branches carry ongoing maintenance cost. This decision should be explicit and recorded before 2.0 adds more surface area that would each require `file://` handling.
