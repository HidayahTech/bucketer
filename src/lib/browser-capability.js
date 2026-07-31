// Copyright (C) 2026 HidayahTech, LLC
// What this browser can actually do with a download, decided by feature detection.
//
// Findings behind this module are in docs/review-download-parity/ (measured 2026-07-31).
//
// THE RULE: capability is decided by asking for the API, never by what the browser calls
// itself. Identity strings are trivially altered and change meaning between releases; a
// compatibility database can also simply be wrong — Chrome for Android shipped folder access
// in version 132 while caniuse still reports it missing. The API either exists or it does not.
//
// THE THREE MECHANISMS, and why there are three:
//
//   MANAGED_FOLDER  Write into a folder the user picks. Real folder tree, resume to the
//                   exact byte, no quota ceiling. Chromium only — Mozilla and WebKit have
//                   both formally declined to implement the pickers.
//   STAGED          Stage in the browser's private storage, then hand the finished file to
//                   the download manager. Measured to cost the same at 2 GiB as at 64 MiB
//                   (22-92 MiB on Chromium, 15-25 MiB on Firefox), so it can move files
//                   larger than the machine's memory. Files arrive flat, and the size of any
//                   single file is bounded by the storage quota.
//   HANDOFF         Give the browser a link and let its download manager do everything. No
//                   progress and no completion signal — but the application never holds the
//                   file, so it is the only mechanism with no size ceiling at all. This is
//                   why the least capable option is kept rather than replaced.
//
// Holding the file in memory is deliberately absent: measured at 1.00x the file's size on
// Chromium and 1.62x on Firefox, it is strictly worse than STAGED wherever STAGED exists.

export const TIERS = {
  MANAGED_FOLDER: 'managed-folder',
  STAGED: 'staged',
  HANDOFF: 'handoff',
};

const LABELS = {
  [TIERS.MANAGED_FOLDER]: 'Managed folder',
  [TIERS.STAGED]: 'Staged',
  [TIERS.HANDOFF]: 'Browser-managed',
};

// Leave headroom under the reported quota: the estimate is approximate by design, and other
// site data shares the same allowance.
const QUOTA_SAFETY = 0.9;

const isFn = v => typeof v === 'function';

export function detectCapabilities(win = globalThis) {
  const nav = win?.navigator ?? {};
  const fileHandleProto = win?.FileSystemFileHandle?.prototype;

  // `in`, never property access: reading a getter off a prototype invokes it with the
  // prototype as the receiver and throws "Illegal invocation" in a real browser.
  const streamingFetch = !!win?.Response?.prototype && ('body' in win.Response.prototype);

  return {
    directoryPicker: isFn(win?.showDirectoryPicker),
    savePicker:      isFn(win?.showSaveFilePicker),
    writableFiles:   isFn(fileHandleProto?.createWritable),
    opfs:            isFn(nav?.storage?.getDirectory),
    storageEstimate: isFn(nav?.storage?.estimate),
    streamingFetch,
    likelyMobile:    detectMobileHint(win),
  };
}

// ADVISORY ONLY. Backgrounding and page-memory limits are the real mobile constraints and
// neither is feature-detectable, so the UI needs some signal to warn with. It must never
// gate a capability — that is what detectCapabilities is for. Prefers the structured
// client hint over anything resembling a parsed identity string.
function detectMobileHint(win) {
  const uaMobile = win?.navigator?.userAgentData?.mobile;
  if (typeof uaMobile === 'boolean') return uaMobile;
  try { return !!win?.matchMedia?.('(pointer: coarse)')?.matches; } catch { return false; }
}

// Best first. HANDOFF is always present — it needs nothing from the browser beyond a link.
export function availableTiers(caps) {
  const tiers = [];
  if (caps.directoryPicker && caps.writableFiles) tiers.push(TIERS.MANAGED_FOLDER);
  if (caps.opfs && caps.streamingFetch) tiers.push(TIERS.STAGED);
  tiers.push(TIERS.HANDOFF);
  return tiers;
}

// selectTier(caps, { largestFileBytes, totalBytes, quotaBytes, prefer })
//
// `largestFileBytes`, not `totalBytes`, decides whether staging fits: one file is staged at
// a time, so a 500 GB job of small files stages perfectly well while a single 40 GB file may
// not. An unknown quota is treated optimistically — a quota failure is catchable at runtime
// and can fall back, whereas refusing up front would deny the better mechanism to every
// browser that does not report one.
export function selectTier(caps, { largestFileBytes = 0, quotaBytes = null, prefer = null } = {}) {
  const tiers = availableTiers(caps);
  if (prefer && tiers.includes(prefer)) return prefer;

  if (tiers.includes(TIERS.MANAGED_FOLDER)) return TIERS.MANAGED_FOLDER;

  if (tiers.includes(TIERS.STAGED)) {
    const fits = quotaBytes == null || largestFileBytes < quotaBytes * QUOTA_SAFETY;
    if (fits) return TIERS.STAGED;
  }

  return TIERS.HANDOFF;
}

export function tierLabel(tier) {
  return LABELS[tier] ?? LABELS[TIERS.HANDOFF];
}

// Reads the storage allowance, or null when the browser will not say. Callers must treat
// null as "unknown", never as zero.
export async function readStorageQuota(nav = globalThis.navigator) {
  try {
    if (!isFn(nav?.storage?.estimate)) return null;
    const e = await nav.storage.estimate();
    return { quotaBytes: e?.quota ?? null, usageBytes: e?.usage ?? null };
  } catch {
    return null;
  }
}
