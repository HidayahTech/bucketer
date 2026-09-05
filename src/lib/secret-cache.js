// Copyright (C) 2026 HidayahTech, LLC
// In-memory, per-tab cache of secret keys, keyed by credential id.
//
// WHY: switching between accounts/buckets used this session must not re-prompt for the
// secret each time. The active connection's secret still lives in sessionStorage (so a
// reload stays connected); this cache additionally holds the secrets of OTHER connections
// touched this session so a quick-switch back to one is instant.
//
// SECURITY POSTURE: this is deliberately NOT persisted — no localStorage, no
// sessionStorage. It lives only in JS memory and dies with the tab. It carries no new
// at-rest risk (the spec's Phase-A interim, ahead of any vault revival). An empty/falsy
// secret is never stored, so a blank field can't shadow a real cached secret.
const _secrets = new Map();

export function cacheSecret(credentialId, secret) {
  if (!credentialId || !secret) return;
  _secrets.set(credentialId, secret);
}

export function getCachedSecret(credentialId) {
  return _secrets.get(credentialId) ?? null;
}

export function forgetCachedSecret(credentialId) {
  _secrets.delete(credentialId);
}

export function clearSecretCache() {
  _secrets.clear();
}
