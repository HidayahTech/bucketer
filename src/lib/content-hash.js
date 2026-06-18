// Copyright (C) 2026 HidayahTech, LLC
// Codec for Bucketer's content-hash stamp value (duplicate detection).
//
// WHY THIS FILE EXISTS: the stamp's wire format ("<scheme>:<hex>") is a small,
// self-contained concern. Keeping the build/parse pair together — separate from both
// the upload code that writes it and the scan code that reads it — makes the format
// easy to evolve and test in isolation.
//
// The value is self-describing so the algorithm + method are derivable from the stamp
// itself, and a future scheme (e.g. "sha256-full") is distinguishable and never
// cross-matches the current one. Anything we don't recognize is rejected (null) rather
// than silently accepted — the dedup engine treats null as "no usable stamp signal".

import { CONTENT_HASH_SCHEME } from './constants.js';

// Schemes this build knows how to interpret for matching. Strictly enumerated so an
// unrecognized scheme is ignored rather than guessed at.
const KNOWN_SCHEMES = new Set([CONTENT_HASH_SCHEME]);

// 64-char lowercase hex = a SHA-256 digest. Uppercase is never emitted, so it is
// treated as malformed (we never want two encodings of the same digest to differ).
const HEX64 = /^[0-9a-f]{64}$/;

// Build the metadata value for a computed hash, or null when there is no hash to stamp
// (e.g. SubtleCrypto unavailable) so the caller omits the metadata key entirely.
export function buildContentHashValue(hash) {
  if (!hash) return null;
  return `${CONTENT_HASH_SCHEME}:${hash}`;
}

// Parse a stamp value into { scheme, hex }, or null when it is not a string, has no
// separator, uses an unknown scheme, or carries a malformed digest.
export function parseContentHash(value) {
  if (typeof value !== 'string') return null;
  const sep = value.indexOf(':');
  if (sep < 0) return null;
  const scheme = value.slice(0, sep);
  const hex = value.slice(sep + 1);
  if (!KNOWN_SCHEMES.has(scheme)) return null;
  if (!HEX64.test(hex)) return null;
  return { scheme, hex };
}
