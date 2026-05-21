// Credential and config persistence (§4.5)
// Secret key → sessionStorage; everything else → localStorage

const LS_KEYS = {
  endpoint: 's3b_endpoint',
  bucket: 's3b_bucket',
  keyId: 's3b_key_id',
  provider: 's3b_provider',
  regionOverride: 's3b_region_override',
  maxKeys: 's3b_max_keys',
  partConcurrency: 's3b_part_concurrency',
  partSizeMB:      's3b_part_size_mb',
  capabilities: 's3b_capabilities',
};
const SS_KEY_SECRET = 's3b_secret_key';

function safeGet(storage, key) {
  try { return storage.getItem(key) ?? ''; } catch { return ''; }
}
function safeSet(storage, key, value) {
  try { storage.setItem(key, value); } catch { /* private mode */ }
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

// Capability state (§4.12) — stored as JSON object {list,download,upload} where
// value is 'permitted' | 'denied' | 'unknown'
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
