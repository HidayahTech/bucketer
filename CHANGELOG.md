# Changelog

All notable changes to Bucketer are documented here.
Versioning follows [Semantic Versioning](https://semver.org/).

Heading format: `## [version] — date — Title`

---

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
