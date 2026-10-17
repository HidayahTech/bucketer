// Copyright (C) 2026 HidayahTech, LLC
// The multi-root scope vocabulary for download jobs.
//
// See docs/superpowers/specs/2026-08-02-download-entry-points-design.md.
//
// A job's scope is an ordered list of roots: prefixes to crawl, and files already fully
// known from the listing row the user ticked — enumerating a file root costs no request.
// Everything downstream of the manifest never sees roots at all.
import { MEDIUM_MAX } from './zip-prefetch.js';

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
    if (!prefixes.some((p) => o.Key.startsWith(p))) roots.push(fileRoot(o));
  }
  return roots;
}

// Legacy read-path shim: jobs persisted before roots existed carry only a prefix.
// No migration write — the field is additive.
//
// job.roots absent (undefined) means a legacy prefix job — the shim is the intended path.
// job.roots present but empty ([]) also falls through to prefixRoot(job.prefix ?? ''), i.e.
// the whole-bucket root — unreachable today because every entry point (toolbar, folder row,
// selection bar) always supplies at least one root. Do not let a future caller pass an empty
// selection expecting a no-op; it will enumerate the entire bucket instead.
export function rootsOfJob(job) {
  if (job.roots?.length) return job.roots;
  return [prefixRoot(job.prefix ?? '')];
}

export function selectionLabel(count, bucket, capturedPrefix = '') {
  const where = capturedPrefix ? `${bucket}/${capturedPrefix}` : bucket;
  return `${count} selected item${count === 1 ? '' : 's'} in ${where}`;
}

// Layout A (slice 4b): a selection of two or more files whose sizes the listing already
// gives, small enough for the ZIP engine's in-memory/temp tiers together (MEDIUM_MAX),
// downloads as a ZIP straight away; folders and bigger selections keep the panel, which
// lists and sizes them first. One file is a plain download, not a ZIP. Archived objects
// and storage limits are checked after listing (App falls back to the panel).
export function isQuickZipSelection({ files = [], prefixes = [] }) {
  if (prefixes.length > 0 || files.length < 2) return false;
  return files.reduce((n, o) => n + (o.Size ?? 0), 0) <= MEDIUM_MAX;
}
