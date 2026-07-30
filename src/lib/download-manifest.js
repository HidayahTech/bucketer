// Copyright (C) 2026 HidayahTech, LLC
// Checkpointed enumeration: turn a bucket prefix into a durable, resumable worklist.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// Enumerating a TB-scale prefix can itself run long enough to be interrupted, so it is
// resumable in its own right. Each page of objects is committed together with the
// continuation token that follows it (see appendManifestPage's atomicity invariant), so a
// crash mid-enumeration resumes from the last committed page rather than starting over.
//
// Memory is bounded: crawlPrefix hands over one page at a time and this module writes it
// straight through to IndexedDB. Nothing accumulates the key list.

import { crawlPrefix } from './crawl-prefix.js';
import { appendManifestPage, ITEM_STATUS } from './download-records.js';
import { isDirectoryMarker, flatNameForKey, NAMING_MODES } from './download-naming.js';

// enumerateJob(client, job, { onProgress, shouldCancel, maxKeys })
// Returns { objects, bytes, cancelled, done } — counts, never keys.
export async function enumerateJob(client, job, { onProgress, shouldCancel, maxKeys } = {}) {
  const mode = job.mode || NAMING_MODES.LEAF;
  let objects = 0;
  let bytes = 0;

  const result = await crawlPrefix(client, job.bucket, job.prefix, {
    maxKeys,
    shouldCancel,
    startToken: job.enumeration?.continuationToken,
    onBatch: async (contents, { nextToken }) => {
      // Folder markers are zero-byte keys ending in "/". They represent a directory that
      // may not even exist elsewhere in the listing, and nobody wants them as files.
      const items = contents
        .filter(o => !isDirectoryMarker(o.Key))
        .map(o => ({
          key:          o.Key,
          size:         o.Size ?? 0,
          etag:         o.ETag,
          lastModified: o.LastModified ? new Date(o.LastModified).getTime() : null,
          localName:    flatNameForKey(o.Key, mode),
          status:       ITEM_STATUS.PENDING,
        }));

      objects += items.length;
      for (const it of items) bytes += it.size;

      // Committed even when `items` is empty: a page of nothing but folder markers still
      // has to advance the token, or a resume would replay it forever.
      await appendManifestPage(job.id, items, {
        continuationToken: nextToken,
        ...(nextToken ? {} : { done: true }),
      });

      onProgress?.({ objects, bytes });
    },
  });

  return { objects, bytes, cancelled: result.cancelled, done: !result.cancelled };
}
