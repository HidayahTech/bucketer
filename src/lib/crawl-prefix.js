// Copyright (C) 2026 HidayahTech, LLC
// Streaming prefix crawler: page through a prefix without ever holding it in memory.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// The delete, move, and dedup engines each buffer an entire prefix's keys into an array
// or Set before acting, which is the High-severity OOM recorded in
// docs/review-v1.26.3/next-level-review.md. This module is the replacement primitive
// (roadmap Phase 2 / Epic #6): it hands each page to a callback and keeps only counters,
// so a prefix with a million objects costs the same memory as one with ten.
//
// Those existing callers are deliberately NOT migrated here — that is its own change with
// its own regression surface. This ships the primitive; adopting it comes later.

import { ListObjectsV2Command } from '@aws-sdk/client-s3';

const DEFAULT_MAX_KEYS = 1000;

// crawlPrefix(client, bucket, prefix, { onBatch, shouldCancel, maxKeys, startToken })
//
// onBatch(objects, { nextToken }) is awaited before the next page is requested, so a
// consumer that persists each page cannot fall behind the crawl. `nextToken` is the token
// that resumes *after* this batch — persist it with the batch and enumeration itself
// becomes resumable across sessions.
//
// Returns { objects, bytes, cancelled, nextToken } — counts only, never the keys.
export async function crawlPrefix(client, bucket, prefix, {
  onBatch,
  shouldCancel = () => false,
  maxKeys = DEFAULT_MAX_KEYS,
  startToken = undefined,
} = {}) {
  let token = startToken;
  let objects = 0;
  let bytes = 0;

  for (;;) {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      MaxKeys: maxKeys,
      ContinuationToken: token,
    }));

    const contents = resp.Contents || [];
    // Trust IsTruncated, not the presence of a token: some implementations echo a stale
    // NextContinuationToken on the final page, which would loop forever.
    const nextToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;

    if (contents.length > 0) {
      objects += contents.length;
      for (const o of contents) bytes += o.Size || 0;
      await onBatch(contents, { nextToken });
    }

    token = nextToken;
    if (!token) return { objects, bytes, cancelled: false, nextToken: undefined };

    // Checked between pages: an in-flight ListObjectsV2 cannot be recalled, so this is
    // the only point where stopping is honest.
    if (shouldCancel()) return { objects, bytes, cancelled: true, nextToken: token };
  }
}
