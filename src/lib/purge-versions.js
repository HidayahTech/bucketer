// Copyright (C) 2026 HidayahTech, LLC
// Async batch deletion of all hidden S3 versions under a prefix.
//
// WHY THIS FILE EXISTS: the "collect remaining pages, then batch-delete in 1000-item
// chunks" logic was 57 lines inside handlePurgeAllConfirm in HiddenVersions.jsx.
// That function had no dependency on Preact state — it only needed the S3 client and
// a description of where to start the pagination. Extracting it here makes it:
//   (a) independently testable with a mock S3 client (see test/purge-versions.test.js)
//   (b) findable by name when the B2 or AWS pagination behaviour changes
//
// WHAT BELONGS HERE: full-exhaust pagination (fetching past the loaded page) and
// batched DeleteObjectsCommand. Row collection from a ListObjectVersions response page.
//
// WHAT DOES NOT BELONG HERE: Preact state management, UI rendering, single-row
// delete operations (those stay in HiddenVersions.jsx), or error display.

import { ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';

// Extracts only old versions (IsLatest=false) and all delete markers from a
// ListObjectVersions response page. Latest versions are shown by the main listing
// and are deliberately excluded here to avoid confusion with "normal" files.
export function collectHiddenVersions(resp) {
  const hidden = [];
  for (const v of (resp.Versions || [])) {
    if (!v.IsLatest) hidden.push({ key: v.Key, versionId: v.VersionId, type: 'old-version', size: v.Size, date: v.LastModified });
  }
  for (const dm of (resp.DeleteMarkers || [])) {
    hidden.push({ key: dm.Key, versionId: dm.VersionId, type: 'delete-marker', isLatest: dm.IsLatest, size: null, date: dm.LastModified });
  }
  return hidden;
}

// Exhausts all pagination starting from the already-loaded page, then batch-deletes
// every hidden version in chunks of 1000 (the S3 DeleteObjects API maximum).
//
// Returns an array of S3 error objects (empty = full success). Does NOT throw —
// errors are accumulated so all batches run even when one fails.
//
// params: { bucket, prefix, initialRows, nextKeyMarker, nextVersionIdMarker, isTruncated }
//   initialRows:          rows already fetched and shown in the UI (may be partial)
//   nextKeyMarker/etc:    pagination markers from the last fetchPage call
//   isTruncated:          whether there are more pages beyond initialRows
export async function purgeAllVersions(client, { bucket, prefix, initialRows, nextKeyMarker, nextVersionIdMarker, isTruncated }) {
  // Collect all rows including any pages not yet loaded into the UI
  let all = [...(initialRows || [])];
  let km    = nextKeyMarker;
  let vim   = nextVersionIdMarker;
  let trunc = isTruncated;

  while (trunc) {
    const resp = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: km ? undefined : (prefix || undefined), // prefix only on the first additional page
      KeyMarker: km || undefined,
      VersionIdMarker: vim || undefined,
    }));
    all   = all.concat(collectHiddenVersions(resp));
    trunc = !!resp.IsTruncated;
    km    = resp.NextKeyMarker  || null;
    vim   = resp.NextVersionIdMarker || null;
  }

  // Batch-delete in chunks of 1000. Continue through every batch even if some fail —
  // accumulate errors so the user sees an aggregate count rather than losing remaining
  // batches silently.
  const allErrors = [];
  for (let i = 0; i < all.length; i += 1000) {
    const batch = all.slice(i, i + 1000);
    try {
      const resp = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map(r => ({ Key: r.key, VersionId: r.versionId })), Quiet: true },
      }));
      if (resp.Errors) allErrors.push(...resp.Errors);
    } catch (batchErr) {
      allErrors.push({ Key: '(network)', Message: batchErr.message || String(batchErr) });
    }
  }

  return allErrors;
}
