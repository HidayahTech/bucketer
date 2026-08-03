// Copyright (C) 2026 HidayahTech, LLC
// Checkpointed enumeration: turn bucket roots into a durable, resumable worklist.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// Enumerating a TB-scale prefix can itself run long enough to be interrupted, so it is
// resumable in its own right. Each page of objects is committed together with the
// continuation token that follows it (see appendManifestPage's atomicity invariant), so a
// crash mid-enumeration resumes from the last committed page rather than starting over.
//
// A job can have multiple roots (files or prefixes). File roots commit straight from
// their captured listing data—no request. Prefix roots crawl as before. The checkpoint
// generalizes to { rootIndex, continuationToken, done }: a crash resumes from the last
// committed page of root i, and the items+checkpoint single-transaction invariant is
// unchanged.
//
// Memory is bounded: crawlPrefix hands over one page at a time and this module writes it
// straight through to IndexedDB. Nothing accumulates the key list.

import { crawlPrefix } from './crawl-prefix.js';
import { appendManifestPage, ITEM_STATUS } from './download-records.js';
import { isDirectoryMarker, flatNameForKey, NAMING_MODES } from './download-naming.js';
import { isArchivedStorageClass } from './storage-class.js';
import { rootsOfJob, ROOT_TYPES } from './download-roots.js';

// enumerateJob(client, job, { onProgress, shouldCancel, maxKeys })
// Walks the job's roots in order. File roots commit straight from their captured listing
// data — no request. Prefix roots crawl as before. The checkpoint generalizes to
// { rootIndex, continuationToken, done }: a crash resumes from the last committed page
// of root i, and the items+checkpoint single-transaction invariant is unchanged.
export async function enumerateJob(client, job, { onProgress, shouldCancel, maxKeys } = {}) {
  const mode = job.mode || NAMING_MODES.LEAF;
  const roots = rootsOfJob(job);
  let objects = 0;
  let bytes = 0;
  let archived = 0;
  let archivedBytes = 0;

  const toItem = (o) => {
    const isArchived = isArchivedStorageClass(o.StorageClass, job.provider);
    if (isArchived) { archived += 1; archivedBytes += o.Size ?? 0; }
    return {
      key:          o.Key,
      size:         o.Size ?? 0,
      etag:         o.ETag,
      lastModified: o.LastModified ? new Date(o.LastModified).getTime() : null,
      localName:    flatNameForKey(o.Key, mode),
      storageClass: o.StorageClass ?? null,
      status:       isArchived ? ITEM_STATUS.SKIPPED : ITEM_STATUS.PENDING,
      ...(isArchived ? { skipReason: 'archived' } : {}),
    };
  };

  const startIndex = job.enumeration?.rootIndex ?? 0;
  let i = startIndex;
  while (i < roots.length) {
    if (shouldCancel?.()) return { objects, bytes, archived, archivedBytes, cancelled: true, done: false };

    if (roots[i].type === ROOT_TYPES.FILE) {
      // Consecutive file roots batch into one page; the commit advances rootIndex past
      // the whole batch atomically. Directory markers cannot be ticked, but the filter
      // matches the crawl path so both routes into the manifest behave identically.
      const items = [];
      let j = i;
      while (j < roots.length && roots[j].type === ROOT_TYPES.FILE) {
        const r = roots[j];
        if (!isDirectoryMarker(r.key)) {
          items.push(toItem({
            Key: r.key, Size: r.size, ETag: r.etag,
            LastModified: r.lastModified != null ? new Date(r.lastModified) : null,
            StorageClass: r.storageClass,
          }));
        }
        j += 1;
      }
      objects += items.length;
      for (const it of items) bytes += it.size;
      await appendManifestPage(job.id, items, {
        rootIndex: j, continuationToken: null,
        ...(j >= roots.length ? { done: true } : {}),
      });
      onProgress?.({ objects, bytes });
      i = j;
      continue;
    }

    // The stored token belongs to the checkpointed root only.
    //
    // If this is the trailing root and it's an empty prefix, crawlPrefix's onBatch never
    // fires, so appendManifestPage below is never called for it — the persisted checkpoint
    // is left without done:true even though the function's own return value (below) reports
    // done. Inert today: nothing consumes enumeration.done and re-enumeration is idempotent
    // via item-id dedup, but a future resume-enumeration feature must not rely on the
    // persisted flag.
    const startToken = i === startIndex ? job.enumeration?.continuationToken : undefined;
    const rootIdx = i;
    const result = await crawlPrefix(client, job.bucket, roots[i].prefix, {
      maxKeys, shouldCancel, startToken,
      onBatch: async (contents, { nextToken }) => {
        const items = contents.filter(o => !isDirectoryMarker(o.Key)).map(toItem);
        objects += items.length;
        for (const it of items) bytes += it.size;
        // Committed even when `items` is empty: a page of nothing but folder markers
        // still has to advance the token, or a resume would replay it forever.
        await appendManifestPage(job.id, items, nextToken
          ? { rootIndex: rootIdx, continuationToken: nextToken }
          : {
              rootIndex: rootIdx + 1, continuationToken: null,
              ...(rootIdx + 1 >= roots.length ? { done: true } : {}),
            });
        onProgress?.({ objects, bytes });
      },
    });
    if (result.cancelled) return { objects, bytes, archived, archivedBytes, cancelled: true, done: false };
    i += 1;
  }

  return { objects, bytes, archived, archivedBytes, cancelled: false, done: true };
}
