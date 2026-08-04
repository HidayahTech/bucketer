// Copyright (C) 2026 HidayahTech, LLC
// Bounded-prefetch tuning + the file-size tier router for concurrent ZIP downloads.
// See docs/superpowers/specs/2026-08-04-download-concurrency-design.md (D1, D2).

export const CONCURRENCY = 4;        // default concurrent fetches
export const MAX_CONCURRENCY = 8;    // ceiling
export const TINY_MAX = 4 * 1024 * 1024;    // <= this: buffer in memory
export const MEDIUM_MAX = 64 * 1024 * 1024; // <= this: buffer in an OPFS temp file; else stream solo

export function classifyTier(size) {
  const n = size || 0;
  if (n <= TINY_MAX) return 'memory';
  if (n <= MEDIUM_MAX) return 'temp';
  return 'solo';
}
