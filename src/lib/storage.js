// Copyright (C) 2026 HidayahTech, LLC
// Credential and settings persistence (REQ-6, §4.5).
//
// Dual-storage model: non-sensitive fields (endpoint, bucket, keyId, provider,
// regionOverride) go to localStorage and survive tab close. The secret key goes
// to sessionStorage only — cleared when the tab closes so it is never written to
// disk. This is the core credential security posture: users must re-enter their
// secret key each session, but are not burdened with re-entering endpoint/bucket.
//
// All storage calls go through safe wrappers that swallow errors from private
// browsing mode and other restrictive contexts. The app degrades gracefully
// (credentials are not persisted) rather than crashing.

const LS_KEYS = {
  endpoint: 's3b_endpoint',
  bucket: 's3b_bucket',
  keyId: 's3b_key_id',
  provider: 's3b_provider',
  regionOverride: 's3b_region_override',
  maxKeys: 's3b_max_keys',
  partConcurrency: 's3b_part_concurrency',
  partSizeMB:      's3b_part_size_mb',
  fileConcurrency: 's3b_file_concurrency',
  listingCacheTTL: 's3b_listing_cache_ttl',
  capabilities: 's3b_capabilities',
};
const SS_KEY_SECRET = 's3b_secret_key';

// Wrap storage access — private browsing throws on every read/write.
// Returns empty string rather than null so falsy checks work consistently.
function safeGet(storage, key) {
  try { return storage.getItem(key) ?? ''; } catch { return ''; }
}
function safeSet(storage, key, value) {
  try { storage.setItem(key, value); } catch { /* private mode — in-memory state continues */ }
}
function safeRemove(storage, key) {
  try { storage.removeItem(key); } catch { /* */ }
}

export function loadCredentials() {
  return {
    endpoint:       safeGet(localStorage, LS_KEYS.endpoint),
    bucket:         safeGet(localStorage, LS_KEYS.bucket),
    keyId:          safeGet(localStorage, LS_KEYS.keyId),
    secretKey:      safeGet(sessionStorage, SS_KEY_SECRET),
    provider:       safeGet(localStorage, LS_KEYS.provider) || null,
    regionOverride: safeGet(localStorage, LS_KEYS.regionOverride),
  };
}

export function saveCredentials({ endpoint, bucket, keyId, secretKey, provider, regionOverride }) {
  safeSet(localStorage, LS_KEYS.endpoint, endpoint);
  safeSet(localStorage, LS_KEYS.bucket, bucket);
  safeSet(localStorage, LS_KEYS.keyId, keyId);
  safeSet(localStorage, LS_KEYS.provider, provider || '');
  safeSet(localStorage, LS_KEYS.regionOverride, regionOverride || '');
  safeSet(sessionStorage, SS_KEY_SECRET, secretKey);
}

// Called on disconnect AND on credential change. Does not clear capability
// state — caller must call clearCapabilities() separately.
export function clearCredentials() {
  Object.values(LS_KEYS).forEach(k => safeRemove(localStorage, k));
  safeRemove(sessionStorage, SS_KEY_SECRET);
}

export function loadMaxKeys() {
  const v = safeGet(localStorage, LS_KEYS.maxKeys);
  return v ? parseInt(v, 10) : null; // null → use provider default
}

export function saveMaxKeys(n) {
  safeSet(localStorage, LS_KEYS.maxKeys, String(n));
}

export function loadPartConcurrency() {
  const v = safeGet(localStorage, LS_KEYS.partConcurrency);
  return v ? parseInt(v, 10) : null; // null → caller uses its own default
}

export function savePartConcurrency(n) {
  safeSet(localStorage, LS_KEYS.partConcurrency, String(n));
}

export function loadPartSizeMB() {
  const v = safeGet(localStorage, LS_KEYS.partSizeMB);
  return v ? parseInt(v, 10) : null; // null → caller uses its own default
}

export function savePartSizeMB(n) {
  safeSet(localStorage, LS_KEYS.partSizeMB, String(n));
}

export function loadFileConcurrency() {
  const v = safeGet(localStorage, LS_KEYS.fileConcurrency);
  return v ? parseInt(v, 10) : null; // null → caller uses its own default
}

export function saveFileConcurrency(n) {
  safeSet(localStorage, LS_KEYS.fileConcurrency, String(n));
}

export function loadListingCacheTTL() {
  const v = safeGet(localStorage, LS_KEYS.listingCacheTTL);
  // Check !== '' (not !v) because 0 is a valid value meaning "disable cache".
  return v !== '' ? parseInt(v, 10) : null; // null → caller uses default (120 s)
}

export function saveListingCacheTTL(seconds) {
  safeSet(localStorage, LS_KEYS.listingCacheTTL, String(seconds));
}

// Per-operation permission state (§4.12). Each of { list, download, upload, delete }
// starts as 'unknown' (assumed permitted) and transitions to 'denied' only after an
// actual operation fails with AccessDenied / 403 / 401. The UI disables buttons only
// for 'denied' — 'unknown' means not yet tested, so operations remain enabled.
// Stored as JSON in a single key; parse failure returns safe defaults so a corrupted
// entry never breaks the app. Clearing credentials must also clear this (caller's job).
export function loadCapabilities() {
  try {
    const raw = localStorage.getItem(LS_KEYS.capabilities);
    return raw ? JSON.parse(raw) : defaultCapabilities();
  } catch {
    return defaultCapabilities();
  }
}

export function saveCapabilities(caps) {
  safeSet(localStorage, LS_KEYS.capabilities, JSON.stringify(caps));
}

export function clearCapabilities() {
  safeRemove(localStorage, LS_KEYS.capabilities);
}

export function defaultCapabilities() {
  return { list: 'unknown', download: 'unknown', upload: 'unknown', delete: 'unknown' };
}
