// Copyright (C) 2026 HidayahTech, LLC
// ZIP naming: entry paths inside the archive, the exported filename, and the OPFS staging
// filename. Split out of zip-job.js so zip-layout.js (in-place composition's byte-offset
// planner) and zip-inplace.js can both depend on these without closing an import cycle
// through zip-job.js itself (zip-job.js -> zip-inplace.js -> zip-layout.js used to import
// zipEntryPath back from zip-job.js). zip-job.js re-exports zipEntryPath/zipFileName so its
// existing importers are unaffected.

import { sanitizeSegment } from './download-naming.js';

// Keys keep their real folder structure inside the zip — that is the point of the format.
// Relative to the scope's captured prefix; a key outside it (possible in a selection with
// mixed roots) keeps its full path rather than escaping upward.
export function zipEntryPath(key, capturedPrefix = '') {
  const rel = capturedPrefix && key.startsWith(capturedPrefix) ? key.slice(capturedPrefix.length) : key;
  return rel.split('/').filter(Boolean).map(sanitizeSegment).join('/');
}

export function zipFileName(bucket, capturedPrefix = '', now = new Date()) {
  const segs = capturedPrefix.split('/').filter(Boolean);
  const base = sanitizeSegment(segs.length ? segs[segs.length - 1] : bucket);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${base}-${stamp}.zip`;
}

// Both zip engines (serial and in-place) share the same OPFS staging file for a given job
// id by design — D8's runtime fallback resumes the SAME file the in-place engine was
// writing — so this must have exactly one definition.
export const stagingName = (jobId) => `bucketer-zip-${jobId}.zip`;
