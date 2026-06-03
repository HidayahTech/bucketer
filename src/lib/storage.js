// Copyright (C) 2026 HidayahTech, LLC
// Credential, settings, and profile persistence (REQ-6, §4.5).
//
// Dual-storage model: non-sensitive fields (endpoint, bucket, keyId, provider,
// regionOverride) go to localStorage and survive tab close. The secret key goes
// to sessionStorage only — cleared when the tab closes so it is never written to
// disk. This is the core credential security posture: users must re-enter their
// secret key each session, but are not burdened with re-entering endpoint/bucket.
//
// Profiles extend this model to N saved connections. Profile data uses separate
// storage keys (LS_KEY_PROFILES, LS_KEY_LAST_PROFILE_ID) that are deliberately
// outside LS_KEYS so clearCredentials() does not remove them on disconnect.
// Secret keys are never stored in profiles.
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
  updateCheckEnabled: 's3b_update_check_enabled',
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

// Default true — preserves existing behaviour for users who have never changed it.
export function loadUpdateCheckEnabled() {
  const v = safeGet(localStorage, LS_KEYS.updateCheckEnabled);
  return v === '' ? true : v === 'true';
}

export function saveUpdateCheckEnabled(enabled) {
  safeSet(localStorage, LS_KEYS.updateCheckEnabled, String(enabled));
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

// Profile storage — keys are OUTSIDE LS_KEYS so clearCredentials() does not wipe them.
const LS_KEY_PROFILES        = 's3b_profiles';
const LS_KEY_LAST_PROFILE_ID = 's3b_last_profile_id';
const PROFILES_VERSION = 1;

function emptyProfileData() {
  return { version: PROFILES_VERSION, profiles: [] };
}

export function loadProfiles() {
  try {
    const raw = localStorage.getItem(LS_KEY_PROFILES);
    if (!raw) return emptyProfileData();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) return emptyProfileData();
    return parsed; // unknown fields preserved — caller gets the full envelope
  } catch {
    return emptyProfileData();
  }
}

function saveProfilesData(data) {
  safeSet(localStorage, LS_KEY_PROFILES, JSON.stringify(data));
}

// Upsert by id — replaces existing profile if id matches, appends if new.
// Unknown fields on the incoming profile object are preserved as-is.
// secretKey is deliberately stripped — it is never persisted in profiles.
export function saveProfile(profile) {
  // eslint-disable-next-line no-unused-vars
  const { secretKey: _dropped, ...safeProfile } = profile;
  const data = loadProfiles();
  const idx = data.profiles.findIndex(p => p.id === safeProfile.id);
  if (idx >= 0) {
    data.profiles[idx] = { ...data.profiles[idx], ...safeProfile };
  } else {
    data.profiles.push({ ...safeProfile });
  }
  saveProfilesData(data);
}

export function deleteProfile(id) {
  const data = loadProfiles();
  data.profiles = data.profiles.filter(p => p.id !== id);
  saveProfilesData(data);
}

export function loadLastProfileId() {
  const v = safeGet(localStorage, LS_KEY_LAST_PROFILE_ID);
  return v ? Number(v) : null;
}

export function saveLastProfileId(id) {
  if (id == null) {
    safeRemove(localStorage, LS_KEY_LAST_PROFILE_ID);
  } else {
    safeSet(localStorage, LS_KEY_LAST_PROFILE_ID, String(id));
  }
}

// Idempotent — reads legacy flat keys and creates a default profile if no profiles
// exist yet. Safe to call on every mount; does nothing if profiles already exist.
export function migrateProfilesFromLegacy() {
  const data = loadProfiles();
  if (data.profiles.length > 0) return; // already migrated

  const endpoint       = safeGet(localStorage, LS_KEYS.endpoint);
  const bucket         = safeGet(localStorage, LS_KEYS.bucket);
  const keyId          = safeGet(localStorage, LS_KEYS.keyId);
  const provider       = safeGet(localStorage, LS_KEYS.provider) || null;
  const regionOverride = safeGet(localStorage, LS_KEYS.regionOverride);

  if (!endpoint && !bucket && !keyId) return; // nothing to migrate

  const providerLabel = provider ? provider.toUpperCase() : '';
  const name = providerLabel && bucket
    ? `${providerLabel} — ${bucket}`
    : bucket || 'Default';

  const profile = {
    id: Date.now(),
    name,
    endpoint,
    bucket,
    keyId,
    provider,
    regionOverride,
  };
  saveProfilesData({ version: PROFILES_VERSION, profiles: [profile] });
  saveLastProfileId(profile.id);
}
