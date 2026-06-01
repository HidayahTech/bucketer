# Changelog

All notable changes to Bucketer are documented here.
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.10.4] — 2026-06-01

- Added LICENSE file: GNU Affero General Public License v3.0 (AGPL-3.0)

## [1.10.3] — 2026-06-01

- Fixed README: `dist/index.html` and `dist/favicon.ico` are committed to the repo (not gitignored) — updated docs to reflect this and explain the rationale (auditability)

## [1.10.2] — 2026-05-31

- Moved `@anthropic-ai/claude-code` out of project dependencies into a gitignored `.tools/` directory — it no longer appears in `package.json` or `package-lock.json`
- Added `.tools/` to `.gitignore`
- Updated `CLAUDE.md` with Claude Code setup instructions and corrected the workflow note about the package

## [1.10.0] — 2026-05-28

- Update check now uses a HEAD request as a fast first step — if ETag/Last-Modified headers match, no body is fetched at all
- Falls back to a 512-byte Range request to compare build IDs when HEAD is inconclusive, instead of fetching the full page every poll
- Once a real update is confirmed, fetches the full page with default cache mode so the browser can cache it for the user's subsequent reload
- Update banner now shows the specific version number: "Version 1.10.0 is available."

## [1.9.0] — 2026-05-28

- App version is now embedded in the built HTML as a `<meta name="app-version">` tag, available to the update checker
- Build script enforces a build invariants check: both `build-id` and `app-version` meta tags must fall within the first 512 bytes of the output, matching the update checker's range fetch boundary
- Build fails loudly with a clear message if a structural change would push metadata past the byte limit

## [1.8.0] — 2026-05-28

- Folder listings are cached in memory to avoid redundant network calls when revisiting folders
- Cache TTL is configurable in Settings: Off, 30 s, 2 min (default), or 10 min
- Mutations (delete, rename, create folder, upload) always invalidate the cache for the affected folder
- Refresh button (↺) in the browser toolbar forces a fresh listing regardless of cache state
- Cache is session-scoped (in-memory only) and resets on reconnect — no stale data across sessions

## [1.7.0] — 2026-05-28

- Full dark mode support via `prefers-color-scheme: dark` — no manual toggle needed
- All UI surfaces, modals, tables, and status indicators adapt automatically to the system theme

## [1.6.0] — 2026-05-28

- Files and folders can now be dropped directly onto the file browser to queue them for upload
- Visual drop target overlay appears while dragging over the browser area
- Folder drops preserve directory structure (same as the upload queue's folder picker)
- Dropped files are queued into the existing upload queue targeting the current folder

## [1.5.0] — 2026-05-28

- Properties button (ℹ) on each file row opens a panel showing HeadObject metadata
- Displays Content-Type, file size, last modified date, ETag, storage class, version ID, and any custom x-amz-meta-* headers

## [1.4.0] — 2026-05-28

- Rename button (✎) on each file row activates an inline edit field
- Confirm with Enter or the ✓ button; cancel with Escape or ✕
- Validates that the new name is non-empty, contains no slashes, and is not already taken
- Implemented as a server-side copy + delete to preserve all object metadata

## [1.3.0] — 2026-05-28

- Checkboxes on file rows and a select-all header checkbox for bulk selection
- Batch delete: confirm and delete all selected files in one operation
- Batch copy links: generate presigned URLs for all selected files (one per line) with the same duration picker as single-file copy
- Selection is cleared automatically on folder navigation

## [1.2.0] — 2026-05-28

- New folder button in the browser toolbar creates a folder at the current prefix
- Validates the name (no slashes, no duplicates) before creating
- Folder appears immediately in the listing without a full reload

## [1.1.0] — 2026-05-28

- Filter bar above the file table to search files and folders by name in real time
- Shows a match count (X of Y) when a filter is active
- Filter resets automatically when navigating into a different folder
- Preview navigation respects the active filter so arrow keys stay within results

## [1.0.0] — 2026-05-28

Initial release.

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
