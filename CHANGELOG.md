# Changelog

All notable changes to Bucketer are documented here.
Versioning follows [Semantic Versioning](https://semver.org/).

Heading format: `## [version] — date — Title`

---

## [1.15.0] — 2026-06-05 — Refactor + accessibility: usePreview hook, cancellation guard, htmlFor labels, progress ARIA

- **T4-1** Extract all preview state, `handlePreview`, and `closePreview` into `src/lib/usePreview.js`; Browser.jsx now consumes the hook
- **T4-2** Add gen-ref cancellation guard to `handlePreview` — every await is followed by `if (gen !== genRef.current) return` to drop stale async callbacks when the user opens a new preview
- **T4-6** Add `htmlFor` + `id` to all standalone `<label>` elements in CredentialForm.jsx (6) and SettingsPanel.jsx (7) — screen readers and click-to-focus now work correctly
- **T5-9** Add `role="progressbar"` + `aria-valuenow/min/max` + `aria-label` to progress bar elements in UploadQueue.jsx — upload progress is now exposed to the accessibility tree

## [1.14.4] — 2026-06-04 — Quality batch: concurrency cap, format guards, build invariants, provider accuracy, UI polish

- **T4-3** Cap `discoverPrefixKeys` concurrency at 8 with worker-pool; removes bare `Promise.all(prefixes.map)` that could throttle on large folder-delete operations
- **T4-4** Guard `formatBytes` against `null`/`undefined`/`NaN`/negative/`Infinity` — all return `'—'` instead of crashing
- **T4-5** Remove stale "No delete, rename, copy" and "N=2 concurrency" claims from `docs/QUESTIONS.md`
- **T5-1** Add build test: production bundle must have no source map comments (regression guard)
- **T5-2** Add build invariant: `dist/index.html` must not exceed 600 KB ceiling
- **T5-3** Export `shellQuote` from `cors-config.js`; use in `corsCmd()` to prevent shell injection from bucket/endpoint names
- **T5-4** Add `<meta http-equiv="Content-Security-Policy">` to `src/index.html` for S3/R2/B2 static-hosting deployments
- **T5-5** Replace module-level `let _sessionFirstMount` in `Browser.jsx` with `isFirstMount` prop derived from `browserKey === 0` in App.jsx
- **T5-6** Distinguish empty-bucket copy (`"This bucket is empty. Upload files to get started."`) from empty-prefix copy
- **T5-7** Show filename in delete confirmation modal for single-file deletes
- **T5-8** Add inline hint to CapabilityPanel explaining permissions are detected automatically
- **T5-11** Add dotted-bucket SSL caveat to Wasabi SetupGuide step
- **T5-12** Correct `requiresPathStyle` comment — B2 supports both styles; we use path-style because users supply a plain endpoint
- **T5-13** Correct `defaultMaxKeys` comment — B2 Class C is not billed per call; 200 is a UX latency choice
- **T5-14** Map Wasabi legacy alias region slugs (`nl-1→eu-central-1`, `de-1→eu-central-2`, `uk-1→eu-west-1`, `fr-1→eu-west-2`, `uk-2→eu-west-3`, `it-1→eu-south-1`) to canonical SigV4 names to prevent signing failures

## [1.14.3] — 2026-06-04 — Provider-specific fixes: Wasabi billing warnings, R2 versioning gate, AWS region patterns, SetupGuide improvements

- **T3-1:** Delete confirmation dialogs now show a Wasabi-specific 90-day minimum retention warning when `provider === 'wasabi'` — both `DeleteQueue` (file/folder delete) and `HiddenVersions` purge-all confirmation. Prevents silent billing surprises for deleted test data.
- **T3-2:** `HiddenVersions` now accepts a `provider` prop (threaded from `Browser`). Cloudflare R2 buckets render a "versioning not supported" message instead of a confusing empty panel, because R2 does not implement `ListObjectVersions`.
- **T3-3:** `extractRegion()` for AWS S3 now handles virtual-hosted bucket URLs (`bucket.s3.region.amazonaws.com`), dualstack endpoints (`s3.dualstack.region.amazonaws.com`), FIPS endpoints (`s3-fips.region.amazonaws.com`), and legacy dash-style endpoints (`s3-region.amazonaws.com`). Pasting a URL from the AWS Console no longer silently falls back to `us-east-1`.
- **T3-4:** `GuideMinIO` in `SetupGuide` now includes an explicit mixed-content warning: browsers block HTTP requests from an HTTPS-served Bucketer to an HTTP MinIO server, and the error only appears in DevTools.
- **T3-5:** `GuideB2` now mentions that application keys must have the `listAllBucketNames` capability — a single-bucket key without it causes AWS SDK v3 initialisation to fail entirely.
- **T3-6:** `GuideR2` now tells users where to find their Account ID (dashboard sidebar), that a payment method is required even on the free tier, and the difference between account-scoped and bucket-scoped token scope.

## [1.14.2] — 2026-06-04 — Correctness and security fixes: settings preservation, resume parallelism, purge-all error recovery, endpoint URL guard, CSP docs

- **T2-1:** `clearCredentials()` now only removes credential fields (endpoint, bucket, keyId, provider, regionOverride). Settings keys (partSize, concurrency, etc.) survive disconnect — split `LS_KEYS` into `CREDENTIAL_KEYS` and `SETTINGS_KEYS`; `resetSettings()` now uses the canonical `SETTINGS_KEYS` set.
- **T2-2:** Multipart resume path now uses the same `uploadPartsWithPool` worker pool as fresh uploads, matching the configured `PART_CONCURRENCY`. Extracted helper exported from `src/lib/upload-queue.js` with unit tests asserting concurrency.
- **T2-3:** `HiddenVersions.handlePurgeAllConfirm` now continues through all batches on S3 `Errors` entries instead of throwing on the first — reports aggregate failure count in the dialog rather than abandoning remaining batches silently.
- **T2-4:** `readUrlParams()` now validates the `endpoint` parameter (must be a parseable `http:` or `https:` URL) and the `bucket` parameter (no slashes or `..` traversal sequences). Prevents crafted share links from pre-filling the credential form with attacker-controlled values.
- **T2-5:** Fixed `README.md` nginx and Caddy CSP examples to include `img-src data: https:; media-src https:; frame-src https:;`. Previous `img-src data:` only directive silently blocked all presigned S3 preview URLs. Added note about `unsafe-inline` being structurally required and a future hash-based alternative.
- **T2-6:** `handleDeleteConfirm` in `App.jsx` now wraps `runDeleteOperation` in try/catch. An uncaught throw previously left the delete panel stuck in `discovering` or `deleting` phase indefinitely with no dismiss path.

## [1.14.1] — 2026-06-04 — Fix rename: add missing DeleteObjectCommand import; add Command import invariant

- **Bug fix (T1-1):** `Browser.jsx` was missing `DeleteObjectCommand` from its `@aws-sdk/client-s3` import. Every rename threw `ReferenceError` after the copy step succeeded, leaving a duplicate file. Lost during the v1.14.0 unified-delete refactor.
- **Test invariant (T1-2):** Added source-level assertion to `test/source-invariants.test.js` that scans every `src/` file importing from `@aws-sdk/client-s3` and asserts every `new XCommand()` usage has a matching named import. Prevents this class of bug from silently shipping again.

## [1.14.0] — 2026-06-03 — Unified delete, preview prefetch, collapsible upload queue, global queue actions

**Unified delete workflow**
- Replaced three separate delete code paths (single-file, multi-file, multi-folder) with a single unified flow
- All delete requests — one file, many files, one folder, many folders, or any mix — go through the same confirm → discover → delete → done pipeline
- Folder checkboxes added to the file listing; select-all now covers both files and folders
- Batch bar counts files and folders separately ("X files, Y folders selected")
- Non-blocking execution: the confirm modal starts the operation then dismisses; progress appears in a panel in App.jsx that survives folder navigation (same pattern as UploadQueue)
- Each delete operation shows spinner during discover/delete phases, ✓ on clean completion (auto-dismisses after 3 s), ✕ with expandable error detail on failure
- Delete batches run at CONCURRENCY=8 (up from 3) with exponential-backoff retry on 503/429/SlowDown throttling responses
- Fixed: selection bar ("X files, Y folders selected") now clears as items are removed from the listing after a successful delete
- `src/lib/delete-queue.js` — new execution module
- `src/components/DeleteQueue.jsx` — new UI component: confirm modal overlay + collapsible progress entries

**Preview signed-URL cache**
- Signed URLs for previewed items are cached for 55 minutes (5-minute buffer before the 1-hour expiry); re-opening the same file within that window skips the HeadObject and URL-signing round-trip entirely and lets the browser serve the image from its own HTTP cache
- Cache is cleared on folder navigation to prevent unbounded growth

**Preview prefetch**
- After the current preview item loads, the next and previous items are prefetched in the background so navigation feels instant
- Level 1 (all previewable types): HeadObject + signed URL generated and cached — eliminates the "thinking" delay on navigation
- Level 2 (images and text): image content downloaded via a hidden Image element if within the configured size limit; text fetched via the existing range request and stored in the cache so navigation requires zero network activity
- Audio, video, and PDF: Level 1 only — URL cached, no content download
- New setting "Preview prefetch" in Settings: Off / 1 MB / 5 MB (default) / 10 MB / 25 MB — takes effect immediately without a page reload

**Small image preview**
- Images smaller than 128×128 px now fill the preview container (`object-fit: contain` at 100% width/height) so they are no longer uselessly tiny
- Images detected as pixel art (natural size < 128×128) get `image-rendering: pixelated` so they scale up crisply without blurring

**Collapsible upload queue**
- Each batch of dropped/selected files is now a collapsible row in the upload panel, independent of other batches
- Batches with few files start expanded; larger batches start collapsed — configurable via new "Upload queue expand threshold" setting in Settings (default: 5)
- Collapsed view shows a one-liner summary (file count, progress, speed, ETA)
- Batches auto-collapse 3 seconds after all files complete
- A Dismiss button appears once a batch is fully settled (no active or queued items); removes it from the panel
- Cancel button is now per-batch rather than clearing the entire queue
- Desktop notifications changed from per-file to one summary notification per batch when it settles ("3 files uploaded", "2 uploaded · 1 failed", etc.)

**Global queue actions bar**
- A compact action bar appears above the batch list when multiple batches are present or when actions span batches
- "Dismiss all done" — removes all settled batches in one click (shown when 2+ batches are fully settled)
- "Retry all failed" — re-queues every failed item across all batches (shown when any item has error status)
- "Cancel all" — cancels all active and queued batches; uses the same two-click confirm pattern as per-batch cancel (shown when any upload is active or queued)
- "Collapse all" / "Expand all" — toggle visibility of all batch rows at once (shown when 2+ batches exist with at least 2 in the same state)

**Upload speed display improvements**
- Batch transfer rate now uses a rolling 6-second derivative of confirmed bytes rather than summing per-item speeds; small files (single `PutObject`, no progress events) contribute the same as large files (continuous multipart updates), so the rate is accurate and uniform regardless of file size
- Completed items in the per-file list now show their measured average upload speed ("✓ Complete · 2.1 MB/s"), giving a consistent display between in-progress large files and finished small files

**Browser extension upload blocking detection**
- Uploads blocked by ad/content blockers (uBlock Origin, etc.) now show an actionable warning rather than a cryptic network error: "Request may have been blocked by a browser extension" with guidance to disable the extension for the page or allowlist the destination domain
- Detection covers all three browsers: Firefox ("NetworkError when attempting to fetch resource"), Chrome ("Failed to fetch"), Safari ("Load failed"); correctly ignored when an HTTP response was received (genuine server errors are unaffected)

**Failed upload visibility**
- Batches containing failed items now show a red left accent border, making them immediately scannable across a long queue without expanding anything
- Failed items float to the top of their batch's expanded list so they are visible without scrolling
- Batches are force-expanded the first time an error appears, so failures are never hidden behind a collapsed "Show" button

**In-app changelog grouping**
- The changelog modal now renders a second level of hierarchy: `**Bold section headers**` in `CHANGELOG.md` become labelled groups with their items nested beneath them; entries without headers render as a flat list as before (no change to older releases)

**Upload queue bug fixes**
- Fixed page freeze (Firefox "Script terminated by timeout") caused by Preact diffing 15 000+ UploadLog rows on every queue update; upload history now renders at most 200 rows (all entries still counted for summary stats)
- Fixed upload history panel popping in and out during active uploads; the panel no longer hides after initial load
- Fixed re-dragging a previously cancelled folder showing files as "paused"; cancel now deletes the IndexedDB resume record
- Fixed race condition where cancelling a batch during the resume-record lookup could set cancelled items back to "paused"

## [1.13.22] — 2026-06-03 — Remove redundant preview button from file row actions

- The filename is already clickable (accent colour, underline on hover) and opens
  the preview modal; the separate ⊙ button in the actions column did the same thing
- Removing it reduces the actions column from 5 buttons to 4

## [1.13.21] — 2026-06-03 — Fix preview modal layout jank with fixed-height content stage

- Preview content area now has a fixed height (`clamp(300px, 70vh, 700px)`) so the
  modal opens at full size immediately — no reflow as media loads
- Added `--surface-raised` background on the stage so the loading spinner and
  "can't preview" state appear in a clearly defined area
- Audio previews use a compact 140px stage instead of the full height; for files
  with a recognised audio extension the compact height is applied immediately
  (no intermediate expansion)
- Image and video `max-height` changed from `72vh` to `100%` — container is now
  the constraint
- PDF `height` changed from `70vh` to `100%`; text preview fills and scrolls
  within the container rather than relying on its own viewport-relative max-height

## [1.13.20] — 2026-06-03 — Parallelize DeleteObjectsCommand batches (3 concurrent)

- Both batch-delete (selected files) and folder-delete now send up to 3
  `DeleteObjectsCommand` requests concurrently instead of sequentially;
  each request still deletes up to 1000 objects (S3 API limit)
- For a 10,000-object delete this reduces round-trips from 10 serial requests
  to 4 parallel groups — roughly 3× faster at typical provider latencies
- Folder-delete uses per-batch `.catch()` so a single failing request does
  not abort the remaining batches; errors are still collected and reported

## [1.13.19] — 2026-06-03 — Batch rAF-aligned updateItem calls; add slow-mock latency option

- Extracted `createUpdateBatcher` (`src/lib/update-batcher.js`) — coalesces
  non-urgent progress patches into one `setItems` call per animation frame;
  urgent status transitions (done, error, paused, etc.) flush immediately and
  preserve any accumulated bytes for the same item
- All 14 status-change `updateItem` call sites in `UploadQueue.jsx` now pass
  `urgent = true`; the two high-frequency `updateProgress` calls remain
  non-urgent and are coalesced per frame
- Added 14 unit tests covering merge semantics, urgent/non-urgent paths, and
  the pending-bytes-preserved invariant (`test/update-batcher.test.js`)
- Added `MOCK_S3_LATENCY_MS` env var to `perf/mock-s3.mjs` for realistic
  benchmark conditions (e.g. `MOCK_S3_LATENCY_MS=20 npm run perftest`)
- `BatchSummary` self-time: 877ms → 724ms (−17%) at 1000 files, 0ms latency

## [1.13.18] — 2026-06-03 — Replace 8 filter/reduce passes in BatchSummary with a single loop

- Replaced 8 separate `filter`/`reduce` calls in `BatchSummary` (run on every
  `updateItem` call over all queued items) with a single `for...of` loop that
  computes all counts and collects only the small renderable arrays (errorItems,
  pausedItems, inFlightItems); `BatchSummary` self-time: 1143ms → 877ms (−23%)
  at 1000 files; browser idle time increased from 390ms to 716ms

## [1.13.17] — 2026-06-03 — Cache formatted timestamps in UploadLog and raise bench default to 1000 files

- Added module-level `Map` cache to `formatCompletedAt` in `UploadLog.jsx` so
  each timestamp is passed through `toLocaleString()` exactly once; subsequent
  renders and IndexedDB reloads are O(1) map lookups — reduced self-time from
  ~1378ms to ~90ms (−93%) at 1000 files
- Changed default `BENCH_FILES` from 200 to 1000 in `perf/bench-browser.mjs`

## [1.13.16] — 2026-06-03 — Throttle rAF animation loops to 15fps and skip when tab hidden

- Both animation loops in `UploadQueue.jsx` (BatchSummary bytes counter and
  per-item progress) now skip state updates when `document.visibilityState`
  is `'hidden'` and throttle to ~15fps (66ms gate) when visible; reduces
  animation overhead by ~75% during long uploads and to zero when tab is hidden

## [1.13.15] — 2026-06-03 — Use version string as build-id for deterministic builds

- `build-id` meta tag now contains the version string (e.g. `1.13.15`) instead
  of a build timestamp; repeated builds from the same source produce identical
  output, eliminating the dirty `dist/index.html` left behind by the pre-push hook

## [1.13.14] — 2026-06-03 — Debounce setLogKey to eliminate dominant CPU hotspot

- Debounced `onLogEntry` callback in `App.jsx` (fires at most every 500ms) to
  eliminate O(N²) `toLocaleString()` calls in `UploadLog`; wall-clock time for
  a 200-file upload dropped 30% (3862ms → 2705ms), `formatCompletedAt` CPU
  self-time dropped from ~24% to ~5%

## [1.13.13] — 2026-06-03 — Add performance benchmarking harness and unify build modes

- Added `npm run perftest` — full browser benchmark using Playwright + CDP profiling
  against a local mock S3 server; saves `.cpuprofile` to `perf/output/`
- Added `npm run bench` — fast algorithmic microbenchmarks (no browser required)
- Unified build configuration in `build.mjs` with explicit `--mode=prod|dev|perf`;
  each mode determines destination directory, minification, source maps, and whether
  production invariants run
- Simplified `serve.mjs` to delegate build logic to `build.mjs --mode=dev`
- Perf builds write to `perf/index.html`; `dist/` is never touched by benchmarks
- Added `data-testid` attributes to upload queue file input and completion indicator

---

## [1.13.12] — 2026-06-03 — Add design-intent documentation for all components and libraries

- Added `docs/intent/` documentation set (baseline v1.11.3): architecture overview,
  data flow, storage model, design principles, and per-module intent for all
  `src/lib/` modules, `Browser.jsx`, and all other components

---

## [1.13.11] — 2026-06-03 — Fix file concurrency setting not taking effect mid-queue

- Changing the file concurrency setting while uploads are in progress had
  no effect because `queueRef.current.concurrency` was only updated in
  `enqueueUpload` (called when adding files). The Queue's `_drain()` kept
  reading the original value on every completion.
- Fix: re-read `loadFileConcurrency()` in `runUpload`'s `finally` block,
  which executes immediately before the Queue's own `.finally()` calls
  `_drain()` — so the new value is in place at exactly the right moment.

## [1.13.10] — 2026-06-03 — Add per-queue desktop notification mute toggle

- Add "Notifs on / Notifs off" toggle button to the batch summary header.
  Only shown when Notification permission has been granted. Takes effect
  immediately on the next completed upload — a ref is checked at fire time
  so toggling mid-queue requires no async coordination.
- State is queue-scoped (resets when the queue is cleared) and does not
  affect the notification permission grant itself.

## [1.13.9] — 2026-06-03 — Fix profile save capturing empty fields and clearing the form

- `handleSaveProfile` was reading from `credentials` state (only updated
  on Connect) instead of `liveFormData`. Result: saved profiles were empty
  and the form cleared immediately after saving because the key-prop change
  triggered a remount against the stale empty credentials.
- Fix: build the profile from `liveFormData`; sync `credentials` after
  saving so the remounted form retains the values the user entered.

## [1.13.8] — 2026-06-03 — Trim surrounding whitespace from pasted credential values

- Pasting a value with leading or trailing whitespace into any credential
  field (endpoint, bucket, key ID, secret key, region) now automatically
  strips the whitespace. Only intercepts pastes that actually contain
  surrounding whitespace — normal typing and clean pastes are unaffected.
  Handles partial-field paste (selection replaced) correctly via cursor
  position tracking.

## [1.13.7] — 2026-06-03 — Fix profile save button not enabling as form is filled

- "Save as profile…" was always disabled while typing because ProfilePicker
  checked App's `credentials` state, which only updates on Connect — not as
  the user types. Fix: CredentialForm fires `onFormChange` on every keystroke;
  App tracks `liveFormData` and passes it to ProfilePicker instead.

## [1.13.6] — 2026-06-03 — Fix Wasabi bare endpoint region auto-detection

- `s3.wasabisys.com` (no region segment) is Wasabi's documented legacy
  endpoint for us-east-1. `extractRegion` now returns `'us-east-1'` for
  this host instead of falling through to null and showing the manual
  region input.

## [1.13.5] — 2026-06-03 — Add serve link to file:// banner and fix banner link color

- Add a "Run `npm run serve` for a local server" link to the file://
  warning banner, pointing to the GitLab README setup section.
- Set `.banner a` color to `--accent` so links in banners are readable
  against both light and dark banner backgrounds.

## [1.13.4] — 2026-06-03 — Require valid fields before saving a profile

- Disable "Save as profile…" button unless endpoint is a valid URL,
  bucket is present (no spaces, ≤ 63 chars), and key ID is present
  (no spaces) — the minimum needed to make the profile useful.
- Add `canSaveProfile()` to credential-validation.js (pure, tested).
- Disabled button shows a tooltip explaining what is needed.
- Add 13 new tests for canSaveProfile covering presence, URL validity,
  bucket format, and key ID format.

## [1.13.3] — 2026-06-03 — Storage & Privacy viewer

- Add "Storage & Privacy" modal (footer link, always accessible regardless of
  session state) showing a live snapshot of every value the app stores.
- Six collapsible sections: Connection, Saved Profiles, Upload History,
  Incomplete Uploads, Settings, Runtime State — each with a scoped clear action.
- Secret key shown as presence indicator only ("Present (session only)" /
  "Not stored") — the value is never rendered.
- "Clear All App Data" removes every localStorage, sessionStorage, and IndexedDB
  entry the app has ever written, then reloads to a fresh state.
- New `wipeAllAppData()`, `resetSettings()`, `deleteAllProfiles()` in storage.js.
- New `loadAllResumeRecords()`, `clearAllResumeRecords()`, `deleteDatabase()`,
  `loadActiveUploads()`, `clearActiveUploads()` in indexeddb.js.
- Storage catalog documented in `docs/storage-catalog.md`; feature design in
  `docs/design-storage-viewer.md`.

## [1.13.2] — 2026-06-03 — Fix saved profile not populating form fields on load

- Fix: selecting a saved profile after disconnect left the credential form blank.
  Root cause: `credentials` state was initialized before `selectedProfileId`, so
  the initializer had no profile to draw from. Fix: declare `selectedProfileId`
  first, then seed `credentials` from the matched profile when one is restored.
- Mount `useEffect` now uses profile data as the base for auto-connect, matching
  the same lookup order as the initializer.

## [1.13.1] — 2026-06-03 — Credential field validation and storage write-boundary enforcement (BUG-016)

- Add `repairStorageInvariants()`: runs on every mount before migration; clears
  `s3b_provider` if it contains whitespace or exceeds 20 chars; repairs stored
  profiles with corrupted provider field. Idempotent no-op once data is clean.
- `loadCredentials()`: sanitize provider on read — return null for any value that
  fails the identifier check, so corrupted data never enters app state
- `saveCredentials()`: sanitize provider on write — write `''` if the value is
  not a valid short identifier, so corruption cannot be re-persisted
- `readUrlParams()`: validate provider hash param before accepting — ignore any
  value containing whitespace or exceeding 20 chars
- `CredentialForm`: inline validation errors block submit when key ID, secret key,
  bucket, or region contain whitespace; warn when bucket exceeds 63 characters
- Extract `credentialErrors()` to `src/lib/credential-validation.js` (pure, tested)
- Add 27 new tests across storage, url-params, and credential-validation suites

## [1.13.0] — 2026-06-02 — Multi-profile credential management

- Add named profile storage: save N connection profiles (endpoint, bucket, key ID,
  provider) to localStorage; secret key is never stored
- Profile picker on connect screen: select a saved profile to pre-fill the form
- "Save as profile" explicit action with user-defined display name
- Delete profile from picker
- Silent migration: existing credentials become a named default profile on first load
- Current profile name shown in connected sidebar
- Storage layer: versioned envelope (`{ version: 1, profiles: [] }`), upsert primitive,
  tolerant loading (unknown fields preserved for forward compatibility)
- Profile keys stored outside `LS_KEYS` so `clearCredentials()` does not wipe them
  on disconnect

## [1.12.24] — 2026-06-02 — Make background update check toggleable in settings

- Add `loadUpdateCheckEnabled` / `saveUpdateCheckEnabled` to `storage.js`
- `UpdateBanner` accepts `enabled` prop; polling starts/stops reactively via `useEffect` dependency
- `SettingsPanel` exposes a "Background update checks" checkbox with immediate effect (no Save needed)
- Defaults to enabled — no behaviour change for existing users

## [1.12.23] — 2026-06-02 — Add live instance link and canonical repo note to README

- Add "Try it live" link to bucketer.hidayahtech.net and canonical GitLab repo reference below the badges

## [1.12.22] — 2026-06-02 — Add About modal and expand README intro

- Add `AboutModal` component with five-pitch product overview and personal author note
- About modal accessible from footer "About" link and splash screen "Learn more →"
- Splash screen "About Bucketer" section replaced with full narrative description
- README intro rebuilt: five-pitch marketing section, narrative, author note with Palestine solidarity statement
- Save prose narrative to `docs/narrative-description.md` for reuse elsewhere

## [1.12.21] — 2026-06-02 — Expand app title to full descriptive name

- Set `appTitle` constant in `build.mjs` as single source for `<title>`, `og:title`, and `twitter:title`
- Title is now "Bucketer — In-Browser S3-Compatible Bucket Manager" across all three tags

## [1.12.20] — 2026-06-02 — Add Open Graph meta tags and OG preview image

- Add `og:title`, `og:description`, `og:image`, `og:url`, and Twitter Card meta tags to `src/index.html`
- Add `src/assets/og-image.png` (1200×630, optimized with oxipng) for link preview cards
- Update `build.mjs` to copy `og-image.png` to `dist/` on every build

## [1.12.19] — 2026-06-02 — Inline header logo as component

- Convert header logo from static `<img>` to inline Preact component
- Bump logo size to 3rem for better visibility

## [1.12.18] — 2026-06-01 — Update footer with Bucketer repo link

- Footer now reads "Bucketer — Copyright © 2026 HidayahTech, LLC"
- "Bucketer" links to the canonical GitLab repo so visitors can find the source

## [1.12.17] — 2026-06-01 — Fix version tag push timing

- Fix pre-push hook so version tags are pushed immediately rather than one commit late
- Hook now explicitly pushes the new tag itself instead of relying on push.followTags
- Tag-only recursive pushes skip the build/test cycle to avoid redundant work

## [1.12.16] — 2026-06-01 — Upstream release check in changelog

- Add "Check for upstream release" button to the changelog modal
- Fetches the latest GitLab release via API and displays the release badge alongside a status line (up to date / update available with link)
- Result is cached for the duration of the tab session

## [1.12.15] — 2026-06-01 — README badges

- Add pipeline status, latest release, and AGPL v3 license badges to README

## [1.12.14] — 2026-06-01 — CI release job

- Added `scripts/release.mjs` — uploads `dist/index.html` to the Package Registry and creates a GitLab Release with CHANGELOG description and asset link
- `.gitlab-ci.yml` now has two stages: `test` and `release`
- Release job runs only on version tags (`v*.*.*`), depends on the test job, uses `CI_JOB_TOKEN` (no PAT needed)
- Test job passes `dist/index.html` as an artifact to the release job

## [1.12.13] — 2026-06-01 — Auto-tag on push

- Pre-push hook now runs `npm run build` before `npm test` (full local validation)
- Pre-push hook auto-creates an annotated version tag if one does not exist for the current `package.json` version
- `push.followTags true` configured by `npm install` via the `prepare` script — tags travel with every push automatically
- CLAUDE.md updated to document the tagging guarantee

## [1.12.12] — 2026-06-01 — Build before test in GitLab CI

- GitLab CI now runs `npm run build` before `npm test`
- CI validates the build from source in a clean environment, then tests its own output rather than the committed dist file

## [1.12.11] — 2026-06-01 — Link copyright footer to HidayahTech website

- Copyright notice in the app footer now links to `https://hidayahtech.com`
- Link inherits the muted footer color; accent color on hover

## [1.12.10] — 2026-06-01 — Add copyright footer to app UI

- Added a footer bar at the bottom of the app displaying "Copyright © 2026 HidayahTech, LLC"
- Styled with `--text-muted` and a top border; adapts to dark mode automatically

## [1.12.9] — 2026-06-01 — Add copyright notices

- Added `Copyright (C) 2026 HidayahTech, LLC` to the top of all 24 source files (`src/**/*.js`, `src/**/*.jsx`)
- `build.mjs` injects the notice into the generated `src/lib/changelog.js` so it survives rebuilds
- Added copyright line to top of `LICENSE` file
- Added License section to `README.md` with copyright and AGPL-3.0 reference

## [1.12.8] — 2026-06-01 — Extract preparePutBody and add BUG-003 tests

- Extracted `preparePutBody(file)` from `UploadQueue.jsx` into `src/lib/upload-queue.js` (exported)
- `uploadSmall` now calls `preparePutBody(file)` instead of inlining the conversion
- BUG-003 regression tests added to `test/calc-part-size.test.js`: returns Uint8Array, never Blob, content preserved, empty file produces empty array
- Added **Coverage:** line for BUG-003 in `BUG-LOG.md`
- Test count: 272 → 276

## [1.12.7] — 2026-06-01 — Document test suite in CLAUDE.md and update BUG-LOG

- Added "Test Suite" section to `CLAUDE.md`: lists all 14 test files with their scope, explains the two-layer structure (unit vs build-output), and documents how to add new tests
- Updated `BUG-LOG.md`: added **Coverage:** lines to BUG-001, BUG-002, BUG-007, BUG-008, BUG-012, BUG-013, BUG-015 linking each to its implementing test file and suite

## [1.12.6] — 2026-06-01 — Fill remaining test gaps

- `mimeType()` tests added to `test/media.test.js`: 11 tests covering MIME type lookup, case-insensitivity, unknown/no-extension returns null, nested path handling
- Upload log tests added to `test/indexeddb-storage.test.js`: `saveUploadLogEntry`, `loadUploadLog` (newest-first ordering, field preservation), `clearUploadLog`
- Test count: 256 → 272

## [1.12.5] — 2026-06-01 — Extract corsJson and buildFileIdentityWithHash; add tests

- Extracted `corsJson(origin)` from `SetupGuide.jsx` into `src/lib/cors-config.js` (exported)
- New `test/cors-config.test.js`: 11 tests — structure, AllowedMethods (BUG-012), AllowedHeaders (SDK headers must be explicit), ExposeHeaders
- Extracted `buildFileIdentityWithHash(file)` into `src/lib/indexeddb.js` (exported); `UploadQueue.jsx` now calls it instead of inlining the three-line pattern
- BUG-008 regression tests added to `test/indexeddb-storage.test.js`: contentHash present, deterministic, content-sensitive
- The SDK headers `amz-sdk-invocation-id` and `amz-sdk-request` must appear explicitly — the `x-amz-*` wildcard does not cover them

## [1.12.4] — 2026-06-01 — Extract collectParts and add BUG-007 tests

- Extracted `collectParts(client, {bucket, key, uploadId})` from `UploadQueue.jsx` into `src/lib/upload-queue.js` (exported)
- `ListPartsCommand` import moved from the component to the lib module
- New `test/collect-parts.test.js`: 7 tests using a mock S3 client
- BUG-007 regression tests: two-page and three-page pagination, stops on `IsTruncated=false`, handles missing `Parts` field, preserves ETag through pagination

## [1.12.3] — 2026-06-01 — Add s3-client.js tests

- New `test/s3-client.test.js`: 12 tests for `createS3Client` region resolution and `forcePathStyle`
- Region priority: `regionOverride` > `extractRegion()` > `us-east-1` fallback; all three tiers tested
- R2 region is always `auto`; B2 and AWS extract from endpoint subdomain
- `forcePathStyle` true for B2 and MinIO; false for R2, AWS, generic

## [1.12.2] — 2026-06-01 — Add file-entries.js tests

- New `test/file-entries.test.js`: 10 tests for `collectFileEntries` using a pure JS FileSystemEntry mock
- Flat list, nested folder traversal, mixed root entries, and correct relative path construction
- Pagination invariant: folders with 150 and 250 files (simulated with batches of 100) must collect all entries — not just the first 100
- Error resilience: unreadable file entries are silently skipped without throwing

## [1.12.1] — 2026-06-01 — Add storage.js tests

- New `test/storage.test.js`: 23 tests covering the full credential and settings persistence layer
- Security invariant: `secretKey` must go to `sessionStorage`, not `localStorage`; asserted at the storage-value level
- Credential round-trip: all fields saved and loaded correctly; `provider` returns `null` (not empty string) when absent
- `clearCredentials` wipes both stores; `clearCapabilities` resets to defaults
- Settings round-trips for all settings functions: maxKeys, partConcurrency, partSizeMB, fileConcurrency
- `listingCacheTTL` edge case: `0` (disable cache) must not be treated as falsy — checked explicitly
- `loadCapabilities` returns defaults when storage is empty or contains corrupted JSON

## [1.12.0] — 2026-06-01 — IndexedDB resume record and file hash tests

- Added `fake-indexeddb` as devDependency to provide an in-memory IndexedDB in Node
- New `test/indexeddb-storage.test.js`: 11 tests covering `saveResumeRecord`, `loadResumeRecord`, `deleteResumeRecord`, and `computeFileHash`
- Resume record tests: round-trip fidelity, null return for missing key, overwrite at same key, independent keys
- Delete tests: removal confirmed, no-op delete resolves cleanly, sibling keys are preserved
- `computeFileHash` tests: determinism, content sensitivity, and the partial-hash invariant (only head+tail 64 KB are hashed — two files with identical endpoints but different middle produce the same hash)

## [1.11.9] — 2026-06-01 — Extract calcPartSize and add tests

- Moved `calcPartSize` from `UploadQueue.jsx` into `src/lib/upload-queue.js` (exported) so it can be tested without loading JSX
- New `test/calc-part-size.test.js`: 11 tests covering the 5 MB floor, 10,000-part ceiling, preferred size override, and falsy preferred values
- Also fixed `test/build.test.js` to operate on the HTML frame and JS bundle separately — whole-file string matching produced false positives when changelog text contained tag-like strings as data

## [1.11.8] — 2026-06-01 — Add build output structural tests

- New `test/build.test.js`: 14 assertions on `dist/index.html` verifying production build invariants
- BUG-001 regression: placeholder must not survive into dist; output must be a valid HTML document
- BUG-002 regression: Preact JSX transform must be active; no React runtime artifacts in output
- BUG-012 regression: CORS template must include DELETE in AllowedMethods
- Version consistency: app-version meta tag must match package.json version
- Single-bundle assertions: HTML frame has no injected tags before the bundle; no external script or stylesheet references

## [1.11.7] — 2026-06-01 — Add indexeddb pure-function tests

- New `test/indexeddb-pure.test.js`: 18 tests covering pure functions and localStorage-based tab conflict detection
- BUG-015 regression tests: `uploadExpiryWarningMs('b2')` must return `null`; R2 and generic must return 7 days
- `buildFileIdentity` and `fileIdentityMatches`: identity construction and all three mismatch cases
- Tab conflict detection: this-tab vs other-tab discrimination, inactive cleanup, multi-key independence, other-tab entry not removed by this tab's `markUploadInactive`

## [1.11.6] — 2026-06-01 — Add url-params test suite

- New `test/url-params.test.js`: 19 tests covering `buildShareUrl`, `readUrlParams`, `hasUrlParams`, and `pushPrefixHistory`
- BUG-013 regression test: params must live in the hash fragment, never the query string
- Credential exclusion test: `keyId` and `secretKey` must never appear in share URLs
- `pushPrefixHistory` tests: hash vs query string, pushState vs replaceState, param preservation, root navigation removes prefix key

## [1.11.5] — 2026-06-01 — Improve test suite quality

- Removed redundant lookup-table assertions from media.test.js; kept one representative per category plus tests that exercise actual logic (case-insensitivity, path handling, charset stripping)
- Added explicit HTML/JS security invariant tests to mediaKind and mimeKind (these kinds must resolve to 'text', never a rendered type)
- Added hostname false-positive tests to detectProvider: provider domain in a URL path or as a hostname suffix must not match
- Added MinIO and DO Spaces to defaultMaxKeys coverage
- Added Code-vs-name precedence test to parseS3Error
- Removed misleading BUG-007 comment from leafName tests
- Removed "all tasks eventually complete" from UploadQueue tests (no specific invariant)
- Test count: 133 → 117 (16 removed were duplicate code-path assertions)

## [1.11.4] — 2026-06-01 — Apply intent comments to all source files

- Added WHY-focused comments to all JS/JSX source files documenting design intent, spec references, and non-obvious invariants
- Covers all 9 lib/ modules and all 14 components including Browser.jsx and UploadQueue.jsx
- Key invariants documented: resume record saved before first part upload, text preview forces text/plain for security, listing cache invalidated on every mutation, rename uses copy-before-delete, dragCounter debounce for nested drag events

## [1.11.3] — 2026-06-01 — Anchor provider detection to hostname

- Provider detection now parses the endpoint URL and tests patterns against the hostname only, preventing false matches on paths or query strings
- Detection regexes anchored with `$` to prevent suffix-based misdetection

## [1.11.2] — 2026-06-01 — Document update poller in README

- Expanded security model section to explicitly state the update poll targets the app's own URL only, never a third-party host, and stops once a new build is detected

## [1.11.1] — 2026-06-01 — Sandbox PDF preview iframe

- Added `sandbox=""` to the PDF preview `<iframe>` — disables scripts, forms, popups, same-origin access, and top navigation; native PDF rendering is unaffected

## [1.11.0] — 2026-06-01 — SVG favicon, drop favicon.ico

- Favicon is now an inline SVG data URL — the same SVG already imported for the app logo is reused, adding zero bytes to the bundle
- `dist/favicon.ico` removed from the repo; ImageMagick build dependency dropped
- `<link rel="icon">` in the HTML shell carries a placeholder `href="data:image/svg+xml,"` to suppress the browser's default `/favicon.ico` auto-request before JS runs
- JS overwrites the placeholder with the real logo URL at module init; null-guarded to prevent a crash if the element is ever absent
- Updated README: `dist/favicon.ico` is no longer committed

## [1.10.9] — 2026-06-01 — Tighten Caddy CSP connect-src

- Caddy deployment example now uses the same scoped `connect-src` provider list as the nginx example, replacing the permissive `connect-src https:` (any HTTPS host)

## [1.10.8] — 2026-06-01 — Add security model section to README

- Added "Security model" section to README covering trust boundaries, credential storage, and the role of `connect-src` CSP as a mitigation against dependency exfiltration

## [1.10.7] — 2026-06-01 — Move internal planning docs to docs/

- Moved `IMPROVEMENT-PLAN.md`, `SPEC-DRIFT.md`, `QUESTIONS.md`, `TODO.md`, and `s3-browser-spec-v0.15.md` from the repo root into `docs/`

## [1.10.6] — 2026-06-01 — Drop full fetch from update checker

- Update checker no longer pre-fetches the full page when a new build is detected
- `app-version` is now extracted from the same 512-byte range fetch as `build-id` (both are within the range boundary guaranteed by the build invariant)
- Polling stops as soon as a different build-id is confirmed; the user decides when to reload

## [1.10.5] — 2026-06-01 — Unified changelog pipeline

- `CHANGELOG.md` is now the single source of truth for version history — `src/lib/changelog.js` is generated by `build.mjs` on every build and must not be edited directly
- Changelog headings now carry a title field: `## [version] — date — Title`
- Build fails if `package.json` version does not match the top `CHANGELOG.md` entry
- Added missing v1.10.1 entry to `CHANGELOG.md`

## [1.10.4] — 2026-06-01 — AGPL-3.0 license

- Added LICENSE file: GNU Affero General Public License v3.0 (AGPL-3.0)

## [1.10.3] — 2026-06-01 — README correction

- Fixed README: `dist/index.html` and `dist/favicon.ico` are committed to the repo (not gitignored) — updated docs to reflect this and explain the rationale (auditability)

## [1.10.2] — 2026-05-31 — Developer tooling cleanup

- Moved `@anthropic-ai/claude-code` out of project dependencies into a gitignored `.tools/` directory — it no longer appears in `package.json` or `package-lock.json`
- Added `.tools/` to `.gitignore`
- Updated `CLAUDE.md` with Claude Code setup instructions and corrected the workflow note about the package

## [1.10.1] — 2026-05-28 — Spec drift documentation

- Added `SPEC-DRIFT.md` — documents all implementation drift from spec v0.15, including features implemented beyond original scope

## [1.10.0] — 2026-05-28 — Smarter update check

- Update check now uses a HEAD request as a fast first step — if ETag/Last-Modified headers match, no body is fetched at all
- Falls back to a 512-byte Range request to compare build IDs when HEAD is inconclusive, instead of fetching the full page every poll
- Once a real update is confirmed, fetches the full page with default cache mode so the browser can cache it for the user's subsequent reload
- Update banner now shows the specific version number: "Version 1.10.0 is available."

## [1.9.0] — 2026-05-28 — Build invariants and app-version metadata

- App version is now embedded in the built HTML as a `<meta name="app-version">` tag, available to the update checker
- Build script enforces a build invariants check: both `build-id` and `app-version` meta tags must fall within the first 512 bytes of the output, matching the update checker's range fetch boundary
- Build fails loudly with a clear message if a structural change would push metadata past the byte limit

## [1.8.0] — 2026-05-28 — Listing cache and refresh button

- Folder listings are cached in memory to avoid redundant network calls when revisiting folders
- Cache TTL is configurable in Settings: Off, 30 s, 2 min (default), or 10 min
- Mutations (delete, rename, create folder, upload) always invalidate the cache for the affected folder
- Refresh button (↺) in the browser toolbar forces a fresh listing regardless of cache state
- Cache is session-scoped (in-memory only) and resets on reconnect — no stale data across sessions

## [1.7.0] — 2026-05-28 — Dark mode

- Full dark mode support via `prefers-color-scheme: dark` — no manual toggle needed
- All UI surfaces, modals, tables, and status indicators adapt automatically to the system theme

## [1.6.0] — 2026-05-28 — Drag-and-drop upload

- Files and folders can now be dropped directly onto the file browser to queue them for upload
- Visual drop target overlay appears while dragging over the browser area
- Folder drops preserve directory structure (same as the upload queue's folder picker)
- Dropped files are queued into the existing upload queue targeting the current folder

## [1.5.0] — 2026-05-28 — File properties panel

- Properties button (ℹ) on each file row opens a panel showing HeadObject metadata
- Displays Content-Type, file size, last modified date, ETag, storage class, version ID, and any custom x-amz-meta-* headers

## [1.4.0] — 2026-05-28 — Rename files

- Rename button (✎) on each file row activates an inline edit field
- Confirm with Enter or the ✓ button; cancel with Escape or ✕
- Validates that the new name is non-empty, contains no slashes, and is not already taken
- Implemented as a server-side copy + delete to preserve all object metadata

## [1.3.0] — 2026-05-28 — Multi-select and batch operations

- Checkboxes on file rows and a select-all header checkbox for bulk selection
- Batch delete: confirm and delete all selected files in one operation
- Batch copy links: generate presigned URLs for all selected files (one per line) with the same duration picker as single-file copy
- Selection is cleared automatically on folder navigation

## [1.2.0] — 2026-05-28 — Create folder

- New folder button in the browser toolbar creates a folder at the current prefix
- Validates the name (no slashes, no duplicates) before creating
- Folder appears immediately in the listing without a full reload

## [1.1.0] — 2026-05-28 — Filter and search

- Filter bar above the file table to search files and folders by name in real time
- Shows a match count (X of Y) when a filter is active
- Filter resets automatically when navigating into a different folder
- Preview navigation respects the active filter so arrow keys stay within results

## [1.0.0] — 2026-05-28 — Initial release

- Object browser with folder navigation, sorting by name/size/date, and paginated listing
- File preview for images, audio, video, PDF, and plain text (100 KB cap)
- File upload with queue management, per-file progress, and editable destination folder
- Download files via presigned S3 URLs
- Copy shareable link with configurable expiry: 1 hr / 24 hr / 7 days / custom duration
- Delete individual files and folders with progress reporting
- Support for AWS S3, Backblaze B2, Cloudflare R2, and other S3-compatible providers
- Credentials stored locally in browser (IndexedDB) — never sent to any server
- Permission capability detection for list, download, upload, and delete operations
- Shareable connection URL (endpoint + bucket, no credentials)
