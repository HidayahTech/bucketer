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

// Adaptive mode: maximum total bytes held in ArrayBuffer across all concurrent
// parts for a single file. Caps part concurrency when calcPartSize raises the part
// size for very large files, preventing runaway memory usage that crashes the tab.
// At default 5 MiB parts this allows up to 40 concurrent parts (capped to 16 by
// ADAPTIVE_CONNECTION_BUDGET). At 50 MiB parts it caps to 4 concurrent.
export const MAX_ADAPTIVE_MEMORY_BYTES = 200 * 1024 * 1024; // 200 MiB

// Presigned URL lifetime in seconds. 1 hour: long enough for interactive use
// but short enough that a leaked URL expires overnight without manual rotation.
export const PRESIGN_EXPIRES = 3600;

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
