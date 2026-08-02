// Copyright (C) 2026 HidayahTech, LLC
// The multi-root scope vocabulary for download jobs.
//
// See docs/superpowers/specs/2026-08-02-download-entry-points-design.md.
//
// A job's scope is an ordered list of roots: prefixes to crawl, and files already fully
// known from the listing row the user ticked — enumerating a file root costs no request.
// Everything downstream of the manifest never sees roots at all.

export const ROOT_TYPES = { FILE: 'file', PREFIX: 'prefix' };

export function fileRoot(o) {
  return {
    type: ROOT_TYPES.FILE,
    key: o.Key,
    size: o.Size ?? 0,
    etag: o.ETag,
    lastModified: o.LastModified ? new Date(o.LastModified).getTime() : null,
    storageClass: o.StorageClass ?? null,
  };
}

export function prefixRoot(prefix) {
  return { type: ROOT_TYPES.PREFIX, prefix };
}

// A ticked file under a ticked folder is dropped: the crawl will produce it, and keeping
// it would duplicate a manifest row.
export function normalizeRoots({ files = [], prefixes = [] }) {
  const roots = prefixes.map(prefixRoot);
  for (const o of files) {
    if (!prefixes.some(p => o.Key.startsWith(p))) roots.push(fileRoot(o));
  }
  return roots;
}

// Legacy read-path shim: jobs persisted before roots existed carry only a prefix.
// No migration write — the field is additive.
export function rootsOfJob(job) {
  if (job.roots?.length) return job.roots;
  return [prefixRoot(job.prefix ?? '')];
}

export function selectionLabel(count, bucket, capturedPrefix = '') {
  const where = capturedPrefix ? `${bucket}/${capturedPrefix}` : bucket;
  return `${count} selected item${count === 1 ? '' : 's'} in ${where}`;
}
