// Copyright (C) 2026 HidayahTech, LLC
// File identity hashing and matching for multipart upload resume (§4.15, REQ-8).
//
// WHY THIS FILE EXISTS: file identity is a self-contained concern — hashing and
// matching have no dependency on the database schema or any other upload operation.
// Separating it makes the hashing strategy easy to understand and test in isolation.
//
// WHAT BELONGS HERE: functions that build, store-augment, and compare file identities.
// Provider session expiry knowledge (uploadExpiryWarningMs) lives here because it
// informs how long a stored identity is trustworthy.
//
// WHAT DOES NOT BELONG HERE: database reads/writes (resume-records.js), cross-tab
// tracking (active-uploads.js), or upload log entries (upload-log.js).

// UploadId expiry by provider:
// - R2: auto-expires after 7 days (documented)
// - B2: no automatic expiry — incomplete uploads persist indefinitely until
//       AbortMultipartUpload is called or a lifecycle rule triggers (Q1 resolved)
// - Others: unknown, use R2's value as a conservative default
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function uploadExpiryWarningMs(provider) {
  if (provider === 'b2') return null; // B2 sessions don't expire automatically
  return SEVEN_DAYS_MS; // R2 and others: warn after 7 days
}

// SHA-256 of the first and last 64 KB of the file (§4.15 file identity). Partial hash
// is fast enough for interactive use without reading the entire file. Returns null if
// SubtleCrypto is unavailable (some Safari / Private Browsing contexts) — resume still
// works using name/size/mtime without the content hash.
export async function computeFileHash(file) {
  try {
    const CHUNK = 64 * 1024;
    const parts = [];
    parts.push(file.slice(0, CHUNK));
    if (file.size > CHUNK) {
      parts.push(file.slice(Math.max(file.size - CHUNK, CHUNK)));
    }
    const buf  = await new Blob(parts).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // SubtleCrypto unavailable (e.g. Safari + file://)
  }
}

// Build a verifiable identity for a File. On resume, fileIdentityMatches() confirms the
// user re-selected the same file — not one that was renamed, resized, or replaced since
// the upload started. The optional contentHash (stored separately by the caller) provides
// extra certainty when name/size/mtime happen to collide.
export function buildFileIdentity(file) {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

export function fileIdentityMatches(identity, file) {
  return (
    identity.name         === file.name &&
    identity.size         === file.size &&
    identity.lastModified === file.lastModified
  );
}

// BUG-008: contentHash must be added to fileIdentity BEFORE saveResumeRecord is called.
// Adding it after means a crash between save and hash write leaves a record without a hash,
// so a content-changed file would not be detected on resume.
export async function buildFileIdentityWithHash(file) {
  const identity = buildFileIdentity(file);
  const hash     = await computeFileHash(file);
  if (hash) identity.contentHash = hash;
  return identity;
}
