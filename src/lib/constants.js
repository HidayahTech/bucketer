// Copyright (C) 2026 HidayahTech, LLC
// Centralized application constants.
//
// WHY THIS FILE EXISTS: thresholds and configuration were previously scattered
// across UploadQueue.jsx and Browser.jsx. Centralizing them here means a single
// change (e.g. adjusting the multipart threshold) propagates everywhere automatically.
//
// WHAT BELONGS HERE: hard-coded limits, default values, and UI presets that are
// referenced by more than one file or that form part of a documented invariant.
//
// WHAT DOES NOT BELONG HERE: per-user settings (those live in storage.js),
// runtime state, or values derived from user input.

// Upload routing: files below this size use a single PutObjectCommand;
// files at or above use multipart. Must match the 5 MB spec minimum (§4.6).
export const MULTIPART_THRESHOLD = 5 * 1024 * 1024;

// Files at or above this size show a warning recommending native tools (§4.6).
export const LARGE_FILE_WARN = 50 * 1024 * 1024 * 1024;

// Move routing: a single-request CopyObject is capped at 5 GiB by S3 (and B2).
// Objects above this must be copied with multipart UploadPartCopy. Distinct from
// MULTIPART_THRESHOLD above, which governs fresh uploads (5 MiB).
export const COPY_MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024;

// Default part size for multipart server-side copy (UploadPartCopy). Unlike an upload part
// — a live ArrayBuffer in browser memory, hence the small 5 MiB upload floor — a copy part
// is a server-side byte-range copy that never enters the browser, so there is zero
// client-memory cost to large parts. Large parts mean far fewer requests: at the upload
// floor a huge object is pinned at the 10,000-part cap, whereas at 1 GiB a 1 TB object is
// ~1,024 parts and a 250 GB object ~250.
export const COPY_PART_SIZE_DEFAULT = 1024 * 1024 * 1024; // 1 GiB

// Universal safe ceiling for a copy part across every S3 provider Bucketer supports.
// Providers split into two camps on the documented maximum part size: AWS / Cloudflare R2 /
// MinIO allow 5 GiB (5,368,709,120), while Backblaze B2 / Wasabi / DigitalOcean Spaces allow
// only 5 GB (5,000,000,000). 4 GB decimal sits comfortably below BOTH ceilings, and also
// below 2^32 (4,294,967,296) — so it never lands on the 32-bit boundary value — making it
// safe on any S3-compatible endpoint, including an uncharacterized "Generic S3" one.
export const COPY_PART_SIZE_MAX = 4_000_000_000; // 4 GB (decimal)

// Default concurrent file uploads when no user preference is saved.
export const DEFAULT_FILE_CONCURRENCY = 3;

// Default concurrent part uploads per file (peak memory: PART_CONCURRENCY × partSize).
export const PART_CONCURRENCY = 4;

// Adaptive mode: target total concurrent HTTP streams across all active uploads.
export const ADAPTIVE_CONNECTION_BUDGET = 16;

// Adaptive mode: minimum part count for a file to be eligible for the probe.
// At default 5 MiB parts this is 100 MiB. Files below this complete too quickly
// for a meaningful two-phase throughput comparison.
export const PROBE_THRESHOLD_PARTS = 20;

// Default ceiling on the total bytes held in ArrayBuffers across all concurrently
// uploading parts (summed over every active file). Caps part concurrency so that
// concurrency × partSize stays within budget — preventing runaway memory that crashes
// the tab. Overridable per-user via the "Upload memory budget" setting (loadUploadMemoryMB);
// this constant is the fallback default and the source of truth for that default.
//
// BUG-033: the previous 200 MiB default divided into a user-chosen large part size
// (floor(200 / 128) = 1 for 128 MiB parts) silently collapsed concurrency to a single
// sequential stream — the user's explicit concurrency was ignored. 1 GiB keeps large
// parts parallel: 128 MiB → 8 concurrent, 64 MiB → 16, 50 MiB → 20 (both capped to 16
// by ADAPTIVE_CONNECTION_BUDGET). Peak RAM is only approached when the part size is
// large; ordinary 5 MiB uploads stay near 80 MiB regardless of this value.
export const DEFAULT_UPLOAD_MEMORY_MB = 1024; // 1 GiB
export const MAX_ADAPTIVE_MEMORY_BYTES = DEFAULT_UPLOAD_MEMORY_MB * 1024 * 1024;

// Presigned URL lifetime in seconds. 1 hour: long enough for interactive use
// but short enough that a leaked URL expires overnight without manual rotation.
export const PRESIGN_EXPIRES = 3600;

// Lifetime for URLs handed to the browser's own download manager. Deliberately the SigV4
// maximum, and deliberately NOT tuned down or estimated from file size.
//
// A browser resuming an interrupted download re-requests the ORIGINAL URL — it cannot be
// given a fresh signature. AWS documents the consequence: "if the connection drops and the
// client tries to restart the download after the expiration time passes, the download
// fails." That failure is a 403 the app cannot observe and the user cannot diagnose.
//
// The exposure side is small and bounded: presigned URLs cannot be revoked individually
// (there is no registry — the URL is derived, not issued), so lifetime is the exposure
// window. But these URLs never leave the machine, and what they grant access to is a file
// already sitting unencrypted in the same downloads folder. A too-short expiry silently
// kills a multi-day transfer; a long one re-exposes what is already on disk.
//
// Scope matters: share links (CopyLinkPopover) keep user-chosen durations, because bounding
// exposure is the point there, and preview/inline URLs keep PRESIGN_EXPIRES for issue #13.
// Note some providers may enforce a shorter ceiling than SigV4's 7 days, and temporary
// (STS) credentials cap the URL at their own lifetime regardless of what is requested.
export const DOWNLOAD_PRESIGN_EXPIRES = 7 * 24 * 60 * 60;

// Pause between handing successive files to the browser's download manager. Browsers
// throttle — and prompt about — rapid programmatic downloads, so the queue is paced
// rather than dumped. The cost is negligible: issuing a few thousand files takes minutes
// while the transfers themselves take hours or days.
export const DOWNLOAD_ISSUE_DELAY_MS = 250;

// Maximum bytes fetched for text preview. Prevents loading multi-GB log files
// into browser memory. Response status 206 indicates truncation.
export const TEXT_PREVIEW_LIMIT = 100 * 1024;

// Preset durations shown in the copy-link popover. Max is 7 days — the upper
// bound enforced by the presigner's allowed range for most providers.
export const COPY_LINK_PRESETS = [
  { label: '1 hour',   seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days',   seconds: 604800 },
];

// S3 custom metadata key for the original file modification time.
// Stored as x-amz-meta-file-mtime in object metadata; value is ISO 8601.
export const FILE_MTIME_KEY = 'file-mtime';

// Duplicate detection — Bucketer's own content-hash stamp (§ duplicate-detection).
// App-namespaced custom metadata key, stored as x-amz-meta-bucketer-content-hash.
// The value is self-describing ("<scheme>:<hex>") so the algorithm + method are
// derivable and future schemes never cross-match. See src/lib/content-hash.js.
// This stamp is only ever a *candidate filter* for dedup — never a deletion gate;
// byte-for-byte comparison is what confirms identity.
export const CONTENT_HASH_KEY = 'bucketer-content-hash';

// Current stamp scheme: SHA-256 of the first + last 64 KiB of the file
// (computeFileHash in file-identity.js). "ht64k" = head/tail 64 KiB sample.
export const CONTENT_HASH_SCHEME = 'sha256-ht64k';

// Duplicate scan: concurrent HeadObject calls when probing size-collision groups.
// Matches the delete-queue worker-pool width to avoid 503 throttling on large sets.
export const DEDUP_HEAD_CONCURRENCY = 8;

// Duplicate verify: above this size, byte-for-byte verification is still allowed but
// the UI must show the estimated egress and require an explicit confirmation first.
export const DEDUP_VERIFY_MAX_BYTES = 256 * 1024 * 1024; // 256 MiB
