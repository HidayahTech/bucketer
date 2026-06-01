// @generated — do not edit directly. Source of truth: CHANGELOG.md (parsed by build.mjs).

export const CURRENT_VERSION = '1.11.6';

export const CHANGELOG = [
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
