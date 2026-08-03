// Copyright (C) 2026 HidayahTech, LLC
// ZIP delivery: entry naming, the quota gate, and (below, Task 3) job orchestration.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md.

import { sanitizeSegment } from './download-naming.js';
import { QUOTA_SAFETY } from './browser-capability.js';

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

// The gate, in the spec's order: capability, then fit, then the lazy-persist path.
// Unknown quota is optimistic per selectTier's philosophy — a quota failure is catchable
// at runtime, refusing up front denies the mechanism to browsers that will not say.
export function zipGate({ caps, sendableBytes, quota, persisted }) {
  if (!caps?.opfs || !caps?.streamingFetch || !caps?.writableFiles) {
    return { state: 'unavailable', reason: 'This browser cannot stage a ZIP.' };
  }
  if (quota?.quotaBytes == null) return { state: 'offered', reason: null };
  const free = Math.max(0, quota.quotaBytes - (quota.usageBytes ?? 0));
  if (sendableBytes <= free * QUOTA_SAFETY) return { state: 'offered', reason: null };
  const gb = (n) => (n / 1e9).toFixed(1);
  const reason = `Needs about ${gb(sendableBytes)} GB of temporary browser storage; ${gb(free)} GB available.`;
  return persisted ? { state: 'unavailable', reason } : { state: 'needs-storage', reason };
}
