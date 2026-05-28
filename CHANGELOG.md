# Changelog

All notable changes to Bucketer are documented here.
Versioning follows [Semantic Versioning](https://semver.org/).

---

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
