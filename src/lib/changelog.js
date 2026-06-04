// Copyright (C) 2026 HidayahTech, LLC
// @generated — do not edit directly. Source of truth: CHANGELOG.md (parsed by build.mjs).

export const CURRENT_VERSION = '1.14.1';

export const CHANGELOG = [
  {
    "version": "1.14.1",
    "date": "2026-06-04",
    "title": "Fix rename: add missing DeleteObjectCommand import; add Command import invariant",
    "changes": [
      "**Bug fix (T1-1):** Browser.jsx was missing DeleteObjectCommand from its @aws-sdk/client-s3 import. Every rename threw ReferenceError after the copy step succeeded, leaving a duplicate file. Lost during the v1.14.0 unified-delete refactor.",
      "**Test invariant (T1-2):** Added source-level assertion to test/source-invariants.test.js that scans every src/ file importing from @aws-sdk/client-s3 and asserts every new XCommand() usage has a matching named import. Prevents this class of bug from silently shipping again."
    ]
  },
  {
    "version": "1.14.0",
    "date": "2026-06-03",
    "title": "Unified delete, preview prefetch, collapsible upload queue, global queue actions",
    "changes": [
      {
        "group": "Unified delete workflow",
        "items": [
          "Replaced three separate delete code paths (single-file, multi-file, multi-folder) with a single unified flow",
          "All delete requests — one file, many files, one folder, many folders, or any mix — go through the same confirm → discover → delete → done pipeline",
          "Folder checkboxes added to the file listing; select-all now covers both files and folders",
          "Batch bar counts files and folders separately (\"X files, Y folders selected\")",
          "Non-blocking execution: the confirm modal starts the operation then dismisses; progress appears in a panel in App.jsx that survives folder navigation (same pattern as UploadQueue)",
          "Each delete operation shows spinner during discover/delete phases, ✓ on clean completion (auto-dismisses after 3 s), ✕ with expandable error detail on failure",
          "Delete batches run at CONCURRENCY=8 (up from 3) with exponential-backoff retry on 503/429/SlowDown throttling responses",
          "Fixed: selection bar (\"X files, Y folders selected\") now clears as items are removed from the listing after a successful delete",
          "src/lib/delete-queue.js — new execution module",
          "src/components/DeleteQueue.jsx — new UI component: confirm modal overlay + collapsible progress entries"
        ]
      },
      {
        "group": "Preview signed-URL cache",
        "items": [
          "Signed URLs for previewed items are cached for 55 minutes (5-minute buffer before the 1-hour expiry); re-opening the same file within that window skips the HeadObject and URL-signing round-trip entirely and lets the browser serve the image from its own HTTP cache",
          "Cache is cleared on folder navigation to prevent unbounded growth"
        ]
      },
      {
        "group": "Preview prefetch",
        "items": [
          "After the current preview item loads, the next and previous items are prefetched in the background so navigation feels instant",
          "Level 1 (all previewable types): HeadObject + signed URL generated and cached — eliminates the \"thinking\" delay on navigation",
          "Level 2 (images and text): image content downloaded via a hidden Image element if within the configured size limit; text fetched via the existing range request and stored in the cache so navigation requires zero network activity",
          "Audio, video, and PDF: Level 1 only — URL cached, no content download",
          "New setting \"Preview prefetch\" in Settings: Off / 1 MB / 5 MB (default) / 10 MB / 25 MB — takes effect immediately without a page reload"
        ]
      },
      {
        "group": "Small image preview",
        "items": [
          "Images smaller than 128×128 px now fill the preview container (object-fit: contain at 100% width/height) so they are no longer uselessly tiny",
          "Images detected as pixel art (natural size < 128×128) get image-rendering: pixelated so they scale up crisply without blurring"
        ]
      },
      {
        "group": "Collapsible upload queue",
        "items": [
          "Each batch of dropped/selected files is now a collapsible row in the upload panel, independent of other batches",
          "Batches with few files start expanded; larger batches start collapsed — configurable via new \"Upload queue expand threshold\" setting in Settings (default: 5)",
          "Collapsed view shows a one-liner summary (file count, progress, speed, ETA)",
          "Batches auto-collapse 3 seconds after all files complete",
          "A Dismiss button appears once a batch is fully settled (no active or queued items); removes it from the panel",
          "Cancel button is now per-batch rather than clearing the entire queue",
          "Desktop notifications changed from per-file to one summary notification per batch when it settles (\"3 files uploaded\", \"2 uploaded · 1 failed\", etc.)"
        ]
      },
      {
        "group": "Global queue actions bar",
        "items": [
          "A compact action bar appears above the batch list when multiple batches are present or when actions span batches",
          "\"Dismiss all done\" — removes all settled batches in one click (shown when 2+ batches are fully settled)",
          "\"Retry all failed\" — re-queues every failed item across all batches (shown when any item has error status)",
          "\"Cancel all\" — cancels all active and queued batches; uses the same two-click confirm pattern as per-batch cancel (shown when any upload is active or queued)",
          "\"Collapse all\" / \"Expand all\" — toggle visibility of all batch rows at once (shown when 2+ batches exist with at least 2 in the same state)"
        ]
      },
      {
        "group": "Upload speed display improvements",
        "items": [
          "Batch transfer rate now uses a rolling 6-second derivative of confirmed bytes rather than summing per-item speeds; small files (single PutObject, no progress events) contribute the same as large files (continuous multipart updates), so the rate is accurate and uniform regardless of file size",
          "Completed items in the per-file list now show their measured average upload speed (\"✓ Complete · 2.1 MB/s\"), giving a consistent display between in-progress large files and finished small files"
        ]
      },
      {
        "group": "Browser extension upload blocking detection",
        "items": [
          "Uploads blocked by ad/content blockers (uBlock Origin, etc.) now show an actionable warning rather than a cryptic network error: \"Request may have been blocked by a browser extension\" with guidance to disable the extension for the page or allowlist the destination domain",
          "Detection covers all three browsers: Firefox (\"NetworkError when attempting to fetch resource\"), Chrome (\"Failed to fetch\"), Safari (\"Load failed\"); correctly ignored when an HTTP response was received (genuine server errors are unaffected)"
        ]
      },
      {
        "group": "Failed upload visibility",
        "items": [
          "Batches containing failed items now show a red left accent border, making them immediately scannable across a long queue without expanding anything",
          "Failed items float to the top of their batch's expanded list so they are visible without scrolling",
          "Batches are force-expanded the first time an error appears, so failures are never hidden behind a collapsed \"Show\" button"
        ]
      },
      {
        "group": "In-app changelog grouping",
        "items": [
          "The changelog modal now renders a second level of hierarchy: **Bold section headers** in CHANGELOG.md become labelled groups with their items nested beneath them; entries without headers render as a flat list as before (no change to older releases)"
        ]
      },
      {
        "group": "Upload queue bug fixes",
        "items": [
          "Fixed page freeze (Firefox \"Script terminated by timeout\") caused by Preact diffing 15 000+ UploadLog rows on every queue update; upload history now renders at most 200 rows (all entries still counted for summary stats)",
          "Fixed upload history panel popping in and out during active uploads; the panel no longer hides after initial load",
          "Fixed re-dragging a previously cancelled folder showing files as \"paused\"; cancel now deletes the IndexedDB resume record",
          "Fixed race condition where cancelling a batch during the resume-record lookup could set cancelled items back to \"paused\""
        ]
      }
    ]
  },
  {
    "version": "1.13.22",
    "date": "2026-06-03",
    "title": "Remove redundant preview button from file row actions",
    "changes": [
      "The filename is already clickable (accent colour, underline on hover) and opens",
      "Removing it reduces the actions column from 5 buttons to 4"
    ]
  },
  {
    "version": "1.13.21",
    "date": "2026-06-03",
    "title": "Fix preview modal layout jank with fixed-height content stage",
    "changes": [
      "Preview content area now has a fixed height (clamp(300px, 70vh, 700px)) so the",
      "Added --surface-raised background on the stage so the loading spinner and",
      "Audio previews use a compact 140px stage instead of the full height; for files",
      "Image and video max-height changed from 72vh to 100% — container is now",
      "PDF height changed from 70vh to 100%; text preview fills and scrolls"
    ]
  },
  {
    "version": "1.13.20",
    "date": "2026-06-03",
    "title": "Parallelize DeleteObjectsCommand batches (3 concurrent)",
    "changes": [
      "Both batch-delete (selected files) and folder-delete now send up to 3",
      "For a 10,000-object delete this reduces round-trips from 10 serial requests",
      "Folder-delete uses per-batch .catch() so a single failing request does"
    ]
  },
  {
    "version": "1.13.19",
    "date": "2026-06-03",
    "title": "Batch rAF-aligned updateItem calls; add slow-mock latency option",
    "changes": [
      "Extracted createUpdateBatcher (src/lib/update-batcher.js) — coalesces",
      "All 14 status-change updateItem call sites in UploadQueue.jsx now pass",
      "Added 14 unit tests covering merge semantics, urgent/non-urgent paths, and",
      "Added MOCK_S3_LATENCY_MS env var to perf/mock-s3.mjs for realistic",
      "BatchSummary self-time: 877ms → 724ms (−17%) at 1000 files, 0ms latency"
    ]
  },
  {
    "version": "1.13.18",
    "date": "2026-06-03",
    "title": "Replace 8 filter/reduce passes in BatchSummary with a single loop",
    "changes": [
      "Replaced 8 separate filter/reduce calls in BatchSummary (run on every"
    ]
  },
  {
    "version": "1.13.17",
    "date": "2026-06-03",
    "title": "Cache formatted timestamps in UploadLog and raise bench default to 1000 files",
    "changes": [
      "Added module-level Map cache to formatCompletedAt in UploadLog.jsx so",
      "Changed default BENCH_FILES from 200 to 1000 in perf/bench-browser.mjs"
    ]
  },
  {
    "version": "1.13.16",
    "date": "2026-06-03",
    "title": "Throttle rAF animation loops to 15fps and skip when tab hidden",
    "changes": [
      "Both animation loops in UploadQueue.jsx (BatchSummary bytes counter and"
    ]
  },
  {
    "version": "1.13.15",
    "date": "2026-06-03",
    "title": "Use version string as build-id for deterministic builds",
    "changes": [
      "build-id meta tag now contains the version string (e.g. 1.13.15) instead"
    ]
  },
  {
    "version": "1.13.14",
    "date": "2026-06-03",
    "title": "Debounce setLogKey to eliminate dominant CPU hotspot",
    "changes": [
      "Debounced onLogEntry callback in App.jsx (fires at most every 500ms) to"
    ]
  },
  {
    "version": "1.13.13",
    "date": "2026-06-03",
    "title": "Add performance benchmarking harness and unify build modes",
    "changes": [
      "Added npm run perftest — full browser benchmark using Playwright + CDP profiling",
      "Added npm run bench — fast algorithmic microbenchmarks (no browser required)",
      "Unified build configuration in build.mjs with explicit --mode=prod|dev|perf;",
      "Simplified serve.mjs to delegate build logic to build.mjs --mode=dev",
      "Perf builds write to perf/index.html; dist/ is never touched by benchmarks",
      "Added data-testid attributes to upload queue file input and completion indicator"
    ]
  },
  {
    "version": "1.13.12",
    "date": "2026-06-03",
    "title": "Add design-intent documentation for all components and libraries",
    "changes": [
      "Added docs/intent/ documentation set (baseline v1.11.3): architecture overview,"
    ]
  },
  {
    "version": "1.13.11",
    "date": "2026-06-03",
    "title": "Fix file concurrency setting not taking effect mid-queue",
    "changes": [
      "Changing the file concurrency setting while uploads are in progress had",
      "Fix: re-read loadFileConcurrency() in runUpload's finally block,"
    ]
  },
  {
    "version": "1.13.10",
    "date": "2026-06-03",
    "title": "Add per-queue desktop notification mute toggle",
    "changes": [
      "Add \"Notifs on / Notifs off\" toggle button to the batch summary header.",
      "State is queue-scoped (resets when the queue is cleared) and does not"
    ]
  },
  {
    "version": "1.13.9",
    "date": "2026-06-03",
    "title": "Fix profile save capturing empty fields and clearing the form",
    "changes": [
      "handleSaveProfile was reading from credentials state (only updated",
      "Fix: build the profile from liveFormData; sync credentials after"
    ]
  },
  {
    "version": "1.13.8",
    "date": "2026-06-03",
    "title": "Trim surrounding whitespace from pasted credential values",
    "changes": [
      "Pasting a value with leading or trailing whitespace into any credential"
    ]
  },
  {
    "version": "1.13.7",
    "date": "2026-06-03",
    "title": "Fix profile save button not enabling as form is filled",
    "changes": [
      "\"Save as profile…\" was always disabled while typing because ProfilePicker"
    ]
  },
  {
    "version": "1.13.6",
    "date": "2026-06-03",
    "title": "Fix Wasabi bare endpoint region auto-detection",
    "changes": [
      "s3.wasabisys.com (no region segment) is Wasabi's documented legacy"
    ]
  },
  {
    "version": "1.13.5",
    "date": "2026-06-03",
    "title": "Add serve link to file:// banner and fix banner link color",
    "changes": [
      "Add a \"Run npm run serve for a local server\" link to the file://",
      "Set .banner a color to --accent so links in banners are readable"
    ]
  },
  {
    "version": "1.13.4",
    "date": "2026-06-03",
    "title": "Require valid fields before saving a profile",
    "changes": [
      "Disable \"Save as profile…\" button unless endpoint is a valid URL,",
      "Add canSaveProfile() to credential-validation.js (pure, tested).",
      "Disabled button shows a tooltip explaining what is needed.",
      "Add 13 new tests for canSaveProfile covering presence, URL validity,"
    ]
  },
  {
    "version": "1.13.3",
    "date": "2026-06-03",
    "title": "Storage & Privacy viewer",
    "changes": [
      "Add \"Storage & Privacy\" modal (footer link, always accessible regardless of",
      "Six collapsible sections: Connection, Saved Profiles, Upload History,",
      "Secret key shown as presence indicator only (\"Present (session only)\" /",
      "\"Clear All App Data\" removes every localStorage, sessionStorage, and IndexedDB",
      "New wipeAllAppData(), resetSettings(), deleteAllProfiles() in storage.js.",
      "New loadAllResumeRecords(), clearAllResumeRecords(), deleteDatabase(),",
      "Storage catalog documented in docs/storage-catalog.md; feature design in"
    ]
  },
  {
    "version": "1.13.2",
    "date": "2026-06-03",
    "title": "Fix saved profile not populating form fields on load",
    "changes": [
      "Fix: selecting a saved profile after disconnect left the credential form blank.",
      "Mount useEffect now uses profile data as the base for auto-connect, matching"
    ]
  },
  {
    "version": "1.13.1",
    "date": "2026-06-03",
    "title": "Credential field validation and storage write-boundary enforcement (BUG-016)",
    "changes": [
      "Add repairStorageInvariants(): runs on every mount before migration; clears",
      "loadCredentials(): sanitize provider on read — return null for any value that",
      "saveCredentials(): sanitize provider on write — write '' if the value is",
      "readUrlParams(): validate provider hash param before accepting — ignore any",
      "CredentialForm: inline validation errors block submit when key ID, secret key,",
      "Extract credentialErrors() to src/lib/credential-validation.js (pure, tested)",
      "Add 27 new tests across storage, url-params, and credential-validation suites"
    ]
  },
  {
    "version": "1.13.0",
    "date": "2026-06-02",
    "title": "Multi-profile credential management",
    "changes": [
      "Add named profile storage: save N connection profiles (endpoint, bucket, key ID,",
      "Profile picker on connect screen: select a saved profile to pre-fill the form",
      "\"Save as profile\" explicit action with user-defined display name",
      "Delete profile from picker",
      "Silent migration: existing credentials become a named default profile on first load",
      "Current profile name shown in connected sidebar",
      "Storage layer: versioned envelope ({ version: 1, profiles: [] }), upsert primitive,",
      "Profile keys stored outside LS_KEYS so clearCredentials() does not wipe them"
    ]
  },
  {
    "version": "1.12.24",
    "date": "2026-06-02",
    "title": "Make background update check toggleable in settings",
    "changes": [
      "Add loadUpdateCheckEnabled / saveUpdateCheckEnabled to storage.js",
      "UpdateBanner accepts enabled prop; polling starts/stops reactively via useEffect dependency",
      "SettingsPanel exposes a \"Background update checks\" checkbox with immediate effect (no Save needed)",
      "Defaults to enabled — no behaviour change for existing users"
    ]
  },
  {
    "version": "1.12.23",
    "date": "2026-06-02",
    "title": "Add live instance link and canonical repo note to README",
    "changes": [
      "Add \"Try it live\" link to bucketer.hidayahtech.net and canonical GitLab repo reference below the badges"
    ]
  },
  {
    "version": "1.12.22",
    "date": "2026-06-02",
    "title": "Add About modal and expand README intro",
    "changes": [
      "Add AboutModal component with five-pitch product overview and personal author note",
      "About modal accessible from footer \"About\" link and splash screen \"Learn more →\"",
      "Splash screen \"About Bucketer\" section replaced with full narrative description",
      "README intro rebuilt: five-pitch marketing section, narrative, author note with Palestine solidarity statement",
      "Save prose narrative to docs/narrative-description.md for reuse elsewhere"
    ]
  },
  {
    "version": "1.12.21",
    "date": "2026-06-02",
    "title": "Expand app title to full descriptive name",
    "changes": [
      "Set appTitle constant in build.mjs as single source for <title>, og:title, and twitter:title",
      "Title is now \"Bucketer — In-Browser S3-Compatible Bucket Manager\" across all three tags"
    ]
  },
  {
    "version": "1.12.20",
    "date": "2026-06-02",
    "title": "Add Open Graph meta tags and OG preview image",
    "changes": [
      "Add og:title, og:description, og:image, og:url, and Twitter Card meta tags to src/index.html",
      "Add src/assets/og-image.png (1200×630, optimized with oxipng) for link preview cards",
      "Update build.mjs to copy og-image.png to dist/ on every build"
    ]
  },
  {
    "version": "1.12.19",
    "date": "2026-06-02",
    "title": "Inline header logo as component",
    "changes": [
      "Convert header logo from static <img> to inline Preact component",
      "Bump logo size to 3rem for better visibility"
    ]
  },
  {
    "version": "1.12.18",
    "date": "2026-06-01",
    "title": "Update footer with Bucketer repo link",
    "changes": [
      "Footer now reads \"Bucketer — Copyright © 2026 HidayahTech, LLC\"",
      "\"Bucketer\" links to the canonical GitLab repo so visitors can find the source"
    ]
  },
  {
    "version": "1.12.17",
    "date": "2026-06-01",
    "title": "Fix version tag push timing",
    "changes": [
      "Fix pre-push hook so version tags are pushed immediately rather than one commit late",
      "Hook now explicitly pushes the new tag itself instead of relying on push.followTags",
      "Tag-only recursive pushes skip the build/test cycle to avoid redundant work"
    ]
  },
  {
    "version": "1.12.16",
    "date": "2026-06-01",
    "title": "Upstream release check in changelog",
    "changes": [
      "Add \"Check for upstream release\" button to the changelog modal",
      "Fetches the latest GitLab release via API and displays the release badge alongside a status line (up to date / update available with link)",
      "Result is cached for the duration of the tab session"
    ]
  },
  {
    "version": "1.12.15",
    "date": "2026-06-01",
    "title": "README badges",
    "changes": [
      "Add pipeline status, latest release, and AGPL v3 license badges to README"
    ]
  },
  {
    "version": "1.12.14",
    "date": "2026-06-01",
    "title": "CI release job",
    "changes": [
      "Added scripts/release.mjs — uploads dist/index.html to the Package Registry and creates a GitLab Release with CHANGELOG description and asset link",
      ".gitlab-ci.yml now has two stages: test and release",
      "Release job runs only on version tags (v*.*.*), depends on the test job, uses CI_JOB_TOKEN (no PAT needed)",
      "Test job passes dist/index.html as an artifact to the release job"
    ]
  },
  {
    "version": "1.12.13",
    "date": "2026-06-01",
    "title": "Auto-tag on push",
    "changes": [
      "Pre-push hook now runs npm run build before npm test (full local validation)",
      "Pre-push hook auto-creates an annotated version tag if one does not exist for the current package.json version",
      "push.followTags true configured by npm install via the prepare script — tags travel with every push automatically",
      "CLAUDE.md updated to document the tagging guarantee"
    ]
  },
  {
    "version": "1.12.12",
    "date": "2026-06-01",
    "title": "Build before test in GitLab CI",
    "changes": [
      "GitLab CI now runs npm run build before npm test",
      "CI validates the build from source in a clean environment, then tests its own output rather than the committed dist file"
    ]
  },
  {
    "version": "1.12.11",
    "date": "2026-06-01",
    "title": "Link copyright footer to HidayahTech website",
    "changes": [
      "Copyright notice in the app footer now links to https://hidayahtech.com",
      "Link inherits the muted footer color; accent color on hover"
    ]
  },
  {
    "version": "1.12.10",
    "date": "2026-06-01",
    "title": "Add copyright footer to app UI",
    "changes": [
      "Added a footer bar at the bottom of the app displaying \"Copyright © 2026 HidayahTech, LLC\"",
      "Styled with --text-muted and a top border; adapts to dark mode automatically"
    ]
  },
  {
    "version": "1.12.9",
    "date": "2026-06-01",
    "title": "Add copyright notices",
    "changes": [
      "Added Copyright (C) 2026 HidayahTech, LLC to the top of all 24 source files (src/**/*.js, src/**/*.jsx)",
      "build.mjs injects the notice into the generated src/lib/changelog.js so it survives rebuilds",
      "Added copyright line to top of LICENSE file",
      "Added License section to README.md with copyright and AGPL-3.0 reference"
    ]
  },
  {
    "version": "1.12.8",
    "date": "2026-06-01",
    "title": "Extract preparePutBody and add BUG-003 tests",
    "changes": [
      "Extracted preparePutBody(file) from UploadQueue.jsx into src/lib/upload-queue.js (exported)",
      "uploadSmall now calls preparePutBody(file) instead of inlining the conversion",
      "BUG-003 regression tests added to test/calc-part-size.test.js: returns Uint8Array, never Blob, content preserved, empty file produces empty array",
      "Added **Coverage:** line for BUG-003 in BUG-LOG.md",
      "Test count: 272 → 276"
    ]
  },
  {
    "version": "1.12.7",
    "date": "2026-06-01",
    "title": "Document test suite in CLAUDE.md and update BUG-LOG",
    "changes": [
      "Added \"Test Suite\" section to CLAUDE.md: lists all 14 test files with their scope, explains the two-layer structure (unit vs build-output), and documents how to add new tests",
      "Updated BUG-LOG.md: added **Coverage:** lines to BUG-001, BUG-002, BUG-007, BUG-008, BUG-012, BUG-013, BUG-015 linking each to its implementing test file and suite"
    ]
  },
  {
    "version": "1.12.6",
    "date": "2026-06-01",
    "title": "Fill remaining test gaps",
    "changes": [
      "mimeType() tests added to test/media.test.js: 11 tests covering MIME type lookup, case-insensitivity, unknown/no-extension returns null, nested path handling",
      "Upload log tests added to test/indexeddb-storage.test.js: saveUploadLogEntry, loadUploadLog (newest-first ordering, field preservation), clearUploadLog",
      "Test count: 256 → 272"
    ]
  },
  {
    "version": "1.12.5",
    "date": "2026-06-01",
    "title": "Extract corsJson and buildFileIdentityWithHash; add tests",
    "changes": [
      "Extracted corsJson(origin) from SetupGuide.jsx into src/lib/cors-config.js (exported)",
      "New test/cors-config.test.js: 11 tests — structure, AllowedMethods (BUG-012), AllowedHeaders (SDK headers must be explicit), ExposeHeaders",
      "Extracted buildFileIdentityWithHash(file) into src/lib/indexeddb.js (exported); UploadQueue.jsx now calls it instead of inlining the three-line pattern",
      "BUG-008 regression tests added to test/indexeddb-storage.test.js: contentHash present, deterministic, content-sensitive",
      "The SDK headers amz-sdk-invocation-id and amz-sdk-request must appear explicitly — the x-amz-* wildcard does not cover them"
    ]
  },
  {
    "version": "1.12.4",
    "date": "2026-06-01",
    "title": "Extract collectParts and add BUG-007 tests",
    "changes": [
      "Extracted collectParts(client, {bucket, key, uploadId}) from UploadQueue.jsx into src/lib/upload-queue.js (exported)",
      "ListPartsCommand import moved from the component to the lib module",
      "New test/collect-parts.test.js: 7 tests using a mock S3 client",
      "BUG-007 regression tests: two-page and three-page pagination, stops on IsTruncated=false, handles missing Parts field, preserves ETag through pagination"
    ]
  },
  {
    "version": "1.12.3",
    "date": "2026-06-01",
    "title": "Add s3-client.js tests",
    "changes": [
      "New test/s3-client.test.js: 12 tests for createS3Client region resolution and forcePathStyle",
      "Region priority: regionOverride > extractRegion() > us-east-1 fallback; all three tiers tested",
      "R2 region is always auto; B2 and AWS extract from endpoint subdomain",
      "forcePathStyle true for B2 and MinIO; false for R2, AWS, generic"
    ]
  },
  {
    "version": "1.12.2",
    "date": "2026-06-01",
    "title": "Add file-entries.js tests",
    "changes": [
      "New test/file-entries.test.js: 10 tests for collectFileEntries using a pure JS FileSystemEntry mock",
      "Flat list, nested folder traversal, mixed root entries, and correct relative path construction",
      "Pagination invariant: folders with 150 and 250 files (simulated with batches of 100) must collect all entries — not just the first 100",
      "Error resilience: unreadable file entries are silently skipped without throwing"
    ]
  },
  {
    "version": "1.12.1",
    "date": "2026-06-01",
    "title": "Add storage.js tests",
    "changes": [
      "New test/storage.test.js: 23 tests covering the full credential and settings persistence layer",
      "Security invariant: secretKey must go to sessionStorage, not localStorage; asserted at the storage-value level",
      "Credential round-trip: all fields saved and loaded correctly; provider returns null (not empty string) when absent",
      "clearCredentials wipes both stores; clearCapabilities resets to defaults",
      "Settings round-trips for all settings functions: maxKeys, partConcurrency, partSizeMB, fileConcurrency",
      "listingCacheTTL edge case: 0 (disable cache) must not be treated as falsy — checked explicitly",
      "loadCapabilities returns defaults when storage is empty or contains corrupted JSON"
    ]
  },
  {
    "version": "1.12.0",
    "date": "2026-06-01",
    "title": "IndexedDB resume record and file hash tests",
    "changes": [
      "Added fake-indexeddb as devDependency to provide an in-memory IndexedDB in Node",
      "New test/indexeddb-storage.test.js: 11 tests covering saveResumeRecord, loadResumeRecord, deleteResumeRecord, and computeFileHash",
      "Resume record tests: round-trip fidelity, null return for missing key, overwrite at same key, independent keys",
      "Delete tests: removal confirmed, no-op delete resolves cleanly, sibling keys are preserved",
      "computeFileHash tests: determinism, content sensitivity, and the partial-hash invariant (only head+tail 64 KB are hashed — two files with identical endpoints but different middle produce the same hash)"
    ]
  },
  {
    "version": "1.11.9",
    "date": "2026-06-01",
    "title": "Extract calcPartSize and add tests",
    "changes": [
      "Moved calcPartSize from UploadQueue.jsx into src/lib/upload-queue.js (exported) so it can be tested without loading JSX",
      "New test/calc-part-size.test.js: 11 tests covering the 5 MB floor, 10,000-part ceiling, preferred size override, and falsy preferred values",
      "Also fixed test/build.test.js to operate on the HTML frame and JS bundle separately — whole-file string matching produced false positives when changelog text contained tag-like strings as data"
    ]
  },
  {
    "version": "1.11.8",
    "date": "2026-06-01",
    "title": "Add build output structural tests",
    "changes": [
      "New test/build.test.js: 14 assertions on dist/index.html verifying production build invariants",
      "BUG-001 regression: placeholder must not survive into dist; output must be a valid HTML document",
      "BUG-002 regression: Preact JSX transform must be active; no React runtime artifacts in output",
      "BUG-012 regression: CORS template must include DELETE in AllowedMethods",
      "Version consistency: app-version meta tag must match package.json version",
      "Single-bundle assertions: HTML frame has no injected tags before the bundle; no external script or stylesheet references"
    ]
  },
  {
    "version": "1.11.7",
    "date": "2026-06-01",
    "title": "Add indexeddb pure-function tests",
    "changes": [
      "New test/indexeddb-pure.test.js: 18 tests covering pure functions and localStorage-based tab conflict detection",
      "BUG-015 regression tests: uploadExpiryWarningMs('b2') must return null; R2 and generic must return 7 days",
      "buildFileIdentity and fileIdentityMatches: identity construction and all three mismatch cases",
      "Tab conflict detection: this-tab vs other-tab discrimination, inactive cleanup, multi-key independence, other-tab entry not removed by this tab's markUploadInactive"
    ]
  },
  {
    "version": "1.11.6",
    "date": "2026-06-01",
    "title": "Add url-params test suite",
    "changes": [
      "New test/url-params.test.js: 19 tests covering buildShareUrl, readUrlParams, hasUrlParams, and pushPrefixHistory",
      "BUG-013 regression test: params must live in the hash fragment, never the query string",
      "Credential exclusion test: keyId and secretKey must never appear in share URLs",
      "pushPrefixHistory tests: hash vs query string, pushState vs replaceState, param preservation, root navigation removes prefix key"
    ]
  },
  {
    "version": "1.11.5",
    "date": "2026-06-01",
    "title": "Improve test suite quality",
    "changes": [
      "Removed redundant lookup-table assertions from media.test.js; kept one representative per category plus tests that exercise actual logic (case-insensitivity, path handling, charset stripping)",
      "Added explicit HTML/JS security invariant tests to mediaKind and mimeKind (these kinds must resolve to 'text', never a rendered type)",
      "Added hostname false-positive tests to detectProvider: provider domain in a URL path or as a hostname suffix must not match",
      "Added MinIO and DO Spaces to defaultMaxKeys coverage",
      "Added Code-vs-name precedence test to parseS3Error",
      "Removed misleading BUG-007 comment from leafName tests",
      "Removed \"all tasks eventually complete\" from UploadQueue tests (no specific invariant)",
      "Test count: 133 → 117 (16 removed were duplicate code-path assertions)"
    ]
  },
  {
    "version": "1.11.4",
    "date": "2026-06-01",
    "title": "Apply intent comments to all source files",
    "changes": [
      "Added WHY-focused comments to all JS/JSX source files documenting design intent, spec references, and non-obvious invariants",
      "Covers all 9 lib/ modules and all 14 components including Browser.jsx and UploadQueue.jsx",
      "Key invariants documented: resume record saved before first part upload, text preview forces text/plain for security, listing cache invalidated on every mutation, rename uses copy-before-delete, dragCounter debounce for nested drag events"
    ]
  },
  {
    "version": "1.11.3",
    "date": "2026-06-01",
    "title": "Anchor provider detection to hostname",
    "changes": [
      "Provider detection now parses the endpoint URL and tests patterns against the hostname only, preventing false matches on paths or query strings",
      "Detection regexes anchored with $ to prevent suffix-based misdetection"
    ]
  },
  {
    "version": "1.11.2",
    "date": "2026-06-01",
    "title": "Document update poller in README",
    "changes": [
      "Expanded security model section to explicitly state the update poll targets the app's own URL only, never a third-party host, and stops once a new build is detected"
    ]
  },
  {
    "version": "1.11.1",
    "date": "2026-06-01",
    "title": "Sandbox PDF preview iframe",
    "changes": [
      "Added sandbox=\"\" to the PDF preview <iframe> — disables scripts, forms, popups, same-origin access, and top navigation; native PDF rendering is unaffected"
    ]
  },
  {
    "version": "1.11.0",
    "date": "2026-06-01",
    "title": "SVG favicon, drop favicon.ico",
    "changes": [
      "Favicon is now an inline SVG data URL — the same SVG already imported for the app logo is reused, adding zero bytes to the bundle",
      "dist/favicon.ico removed from the repo; ImageMagick build dependency dropped",
      "<link rel=\"icon\"> in the HTML shell carries a placeholder href=\"data:image/svg+xml,\" to suppress the browser's default /favicon.ico auto-request before JS runs",
      "JS overwrites the placeholder with the real logo URL at module init; null-guarded to prevent a crash if the element is ever absent",
      "Updated README: dist/favicon.ico is no longer committed"
    ]
  },
  {
    "version": "1.10.9",
    "date": "2026-06-01",
    "title": "Tighten Caddy CSP connect-src",
    "changes": [
      "Caddy deployment example now uses the same scoped connect-src provider list as the nginx example, replacing the permissive connect-src https: (any HTTPS host)"
    ]
  },
  {
    "version": "1.10.8",
    "date": "2026-06-01",
    "title": "Add security model section to README",
    "changes": [
      "Added \"Security model\" section to README covering trust boundaries, credential storage, and the role of connect-src CSP as a mitigation against dependency exfiltration"
    ]
  },
  {
    "version": "1.10.7",
    "date": "2026-06-01",
    "title": "Move internal planning docs to docs/",
    "changes": [
      "Moved IMPROVEMENT-PLAN.md, SPEC-DRIFT.md, QUESTIONS.md, TODO.md, and s3-browser-spec-v0.15.md from the repo root into docs/"
    ]
  },
  {
    "version": "1.10.6",
    "date": "2026-06-01",
    "title": "Drop full fetch from update checker",
    "changes": [
      "Update checker no longer pre-fetches the full page when a new build is detected",
      "app-version is now extracted from the same 512-byte range fetch as build-id (both are within the range boundary guaranteed by the build invariant)",
      "Polling stops as soon as a different build-id is confirmed; the user decides when to reload"
    ]
  },
  {
    "version": "1.10.5",
    "date": "2026-06-01",
    "title": "Unified changelog pipeline",
    "changes": [
      "CHANGELOG.md is now the single source of truth for version history — src/lib/changelog.js is generated by build.mjs on every build and must not be edited directly",
      "Changelog headings now carry a title field: ## [version] — date — Title",
      "Build fails if package.json version does not match the top CHANGELOG.md entry",
      "Added missing v1.10.1 entry to CHANGELOG.md"
    ]
  },
  {
    "version": "1.10.4",
    "date": "2026-06-01",
    "title": "AGPL-3.0 license",
    "changes": [
      "Added LICENSE file: GNU Affero General Public License v3.0 (AGPL-3.0)"
    ]
  },
  {
    "version": "1.10.3",
    "date": "2026-06-01",
    "title": "README correction",
    "changes": [
      "Fixed README: dist/index.html and dist/favicon.ico are committed to the repo (not gitignored) — updated docs to reflect this and explain the rationale (auditability)"
    ]
  },
  {
    "version": "1.10.2",
    "date": "2026-05-31",
    "title": "Developer tooling cleanup",
    "changes": [
      "Moved @anthropic-ai/claude-code out of project dependencies into a gitignored .tools/ directory — it no longer appears in package.json or package-lock.json",
      "Added .tools/ to .gitignore",
      "Updated CLAUDE.md with Claude Code setup instructions and corrected the workflow note about the package"
    ]
  },
  {
    "version": "1.10.1",
    "date": "2026-05-28",
    "title": "Spec drift documentation",
    "changes": [
      "Added SPEC-DRIFT.md — documents all implementation drift from spec v0.15, including features implemented beyond original scope"
    ]
  },
  {
    "version": "1.10.0",
    "date": "2026-05-28",
    "title": "Smarter update check",
    "changes": [
      "Update check now uses a HEAD request as a fast first step — if ETag/Last-Modified headers match, no body is fetched at all",
      "Falls back to a 512-byte Range request to compare build IDs when HEAD is inconclusive, instead of fetching the full page every poll",
      "Once a real update is confirmed, fetches the full page with default cache mode so the browser can cache it for the user's subsequent reload",
      "Update banner now shows the specific version number: \"Version 1.10.0 is available.\""
    ]
  },
  {
    "version": "1.9.0",
    "date": "2026-05-28",
    "title": "Build invariants and app-version metadata",
    "changes": [
      "App version is now embedded in the built HTML as a <meta name=\"app-version\"> tag, available to the update checker",
      "Build script enforces a build invariants check: both build-id and app-version meta tags must fall within the first 512 bytes of the output, matching the update checker's range fetch boundary",
      "Build fails loudly with a clear message if a structural change would push metadata past the byte limit"
    ]
  },
  {
    "version": "1.8.0",
    "date": "2026-05-28",
    "title": "Listing cache and refresh button",
    "changes": [
      "Folder listings are cached in memory to avoid redundant network calls when revisiting folders",
      "Cache TTL is configurable in Settings: Off, 30 s, 2 min (default), or 10 min",
      "Mutations (delete, rename, create folder, upload) always invalidate the cache for the affected folder",
      "Refresh button (↺) in the browser toolbar forces a fresh listing regardless of cache state",
      "Cache is session-scoped (in-memory only) and resets on reconnect — no stale data across sessions"
    ]
  },
  {
    "version": "1.7.0",
    "date": "2026-05-28",
    "title": "Dark mode",
    "changes": [
      "Full dark mode support via prefers-color-scheme: dark — no manual toggle needed",
      "All UI surfaces, modals, tables, and status indicators adapt automatically to the system theme"
    ]
  },
  {
    "version": "1.6.0",
    "date": "2026-05-28",
    "title": "Drag-and-drop upload",
    "changes": [
      "Files and folders can now be dropped directly onto the file browser to queue them for upload",
      "Visual drop target overlay appears while dragging over the browser area",
      "Folder drops preserve directory structure (same as the upload queue's folder picker)",
      "Dropped files are queued into the existing upload queue targeting the current folder"
    ]
  },
  {
    "version": "1.5.0",
    "date": "2026-05-28",
    "title": "File properties panel",
    "changes": [
      "Properties button (ℹ) on each file row opens a panel showing HeadObject metadata",
      "Displays Content-Type, file size, last modified date, ETag, storage class, version ID, and any custom x-amz-meta-* headers"
    ]
  },
  {
    "version": "1.4.0",
    "date": "2026-05-28",
    "title": "Rename files",
    "changes": [
      "Rename button (✎) on each file row activates an inline edit field",
      "Confirm with Enter or the ✓ button; cancel with Escape or ✕",
      "Validates that the new name is non-empty, contains no slashes, and is not already taken",
      "Implemented as a server-side copy + delete to preserve all object metadata"
    ]
  },
  {
    "version": "1.3.0",
    "date": "2026-05-28",
    "title": "Multi-select and batch operations",
    "changes": [
      "Checkboxes on file rows and a select-all header checkbox for bulk selection",
      "Batch delete: confirm and delete all selected files in one operation",
      "Batch copy links: generate presigned URLs for all selected files (one per line) with the same duration picker as single-file copy",
      "Selection is cleared automatically on folder navigation"
    ]
  },
  {
    "version": "1.2.0",
    "date": "2026-05-28",
    "title": "Create folder",
    "changes": [
      "New folder button in the browser toolbar creates a folder at the current prefix",
      "Validates the name (no slashes, no duplicates) before creating",
      "Folder appears immediately in the listing without a full reload"
    ]
  },
  {
    "version": "1.1.0",
    "date": "2026-05-28",
    "title": "Filter and search",
    "changes": [
      "Filter bar above the file table to search files and folders by name in real time",
      "Shows a match count (X of Y) when a filter is active",
      "Filter resets automatically when navigating into a different folder",
      "Preview navigation respects the active filter so arrow keys stay within results"
    ]
  },
  {
    "version": "1.0.0",
    "date": "2026-05-28",
    "title": "Initial release",
    "changes": [
      "Object browser with folder navigation, sorting by name/size/date, and paginated listing",
      "File preview for images, audio, video, PDF, and plain text (100 KB cap)",
      "File upload with queue management, per-file progress, and editable destination folder",
      "Download files via presigned S3 URLs",
      "Copy shareable link with configurable expiry: 1 hr / 24 hr / 7 days / custom duration",
      "Delete individual files and folders with progress reporting",
      "Support for AWS S3, Backblaze B2, Cloudflare R2, and other S3-compatible providers",
      "Credentials stored locally in browser (IndexedDB) — never sent to any server",
      "Permission capability detection for list, download, upload, and delete operations",
      "Shareable connection URL (endpoint + bucket, no credentials)"
    ]
  }
];
