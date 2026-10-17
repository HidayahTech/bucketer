// Copyright (C) 2026 HidayahTech, LLC
// ZIP naming: entry paths inside the archive, the exported filename, and the OPFS staging
// filename. Split out of zip-job.js so zip-layout.js (in-place composition's byte-offset
// planner) and zip-inplace.js can both depend on these without closing an import cycle
// through zip-job.js itself (zip-job.js -> zip-inplace.js -> zip-layout.js used to import
// zipEntryPath back from zip-job.js). zip-job.js re-exports zipEntryPath/zipFileName so its
// existing importers are unaffected.

import { sanitizeSegment } from './download-naming.js';
import { freeFileKey } from './move-key.js';

// Keys keep their real folder structure inside the zip — that is the point of the format.
// Relative to the scope's captured prefix; a key outside it (possible in a selection with
// mixed roots) keeps its full path rather than escaping upward.
export function zipEntryPath(key, capturedPrefix = '') {
  const rel = capturedPrefix && key.startsWith(capturedPrefix) ? key.slice(capturedPrefix.length) : key;
  return rel.split('/').filter(Boolean).map(sanitizeSegment).join('/');
}

// One unique archive path per key (GitLab #79 / R06). Sanitizing can map distinct keys to one
// path (`a:b`/`a?b` → `a_b`, a trailing dot, `//`, NFC vs NFD), and extractors then keep one
// and silently drop the rest. Paths are also kept distinct case-insensitively (macOS and
// Windows extract `A.txt` and `a.txt` onto one file), and a file never takes a path that is
// a folder elsewhere in the archive. A loser gets the " (n)" suffix moves use. Folders are
// never renamed, so the tree stays recognisable.
//
// Deterministic over the key SET (keys are processed in sorted order), so both engines, a
// resumed run and the in-place→serial fallback all assign the same paths, provided they pass
// the job's full key list rather than only the keys a run streams.
export function allocateZipPaths(keys, capturedPrefix = '') {
  const fold = (p) => p.normalize('NFC').toLowerCase();
  const sorted = [...keys].sort();
  const base = new Map(sorted.map((k) => [k, zipEntryPath(k, capturedPrefix)]));
  const folders = new Set();
  for (const p of base.values()) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) folders.add(fold(segs.slice(0, i).join('/')));
  }
  const taken = new Set();
  const out = new Map();
  for (const k of sorted) {
    const path = freeFileKey(base.get(k), (c) => taken.has(fold(c)) || folders.has(fold(c)));
    taken.add(fold(path));
    out.set(k, path);
  }
  return out;
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
