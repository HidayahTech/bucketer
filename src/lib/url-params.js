// Copyright (C) 2026 HidayahTech, LLC
// URL hash fragment serialization for shareable links and browser history (§4.14).
//
// All params live in the hash fragment (#) rather than the query string (?), so they
// are never transmitted to the server in HTTP request URLs (REQ-5). The hash is
// purely client-side; the browser strips it before sending requests.
//
// Shareable URLs include endpoint, bucket, provider, and region. The access key ID
// is included only when explicitly requested (buildShareUrl(creds, { includeKeyId: true })).
// The secret key is never included, so a recipient always authenticates by entering
// at least their secret key.

function hashParams() {
  return new URLSearchParams(window.location.hash.slice(1));
}

// Read config fields from the hash (endpoint, bucket, provider, region, keyId).
// Returned object is merged over stored credentials so the form is pre-filled.
export function readUrlParams() {
  const p = hashParams();
  const out = {};
  if (p.has('endpoint')) {
    const v = p.get('endpoint');
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' || u.protocol === 'http:') out.endpoint = v;
    } catch { /* unparseable — ignore */ }
  }
  if (p.has('bucket')) {
    const v = p.get('bucket');
    // S3 bucket names never contain slashes or path-traversal sequences.
    if (v && !v.includes('/') && !v.includes('\\') && !v.includes('..')) out.bucket = v;
  }
  if (p.has('provider')) {
    const v = p.get('provider');
    // Provider must be a short identifier with no whitespace — same rule as storage.js.
    // Reject anything that looks like free text to prevent URL params from becoming
    // a vector for corrupting the provider field.
    if (v && v.length <= 20 && !/\s/.test(v)) out.provider = v;
  }
  if (p.has('keyId')) {
    const v = p.get('keyId');
    // Access key IDs are short identifiers with no whitespace. Reject overlong or
    // whitespace-bearing values so a crafted link cannot inject free text into the form.
    if (v && v.length <= 128 && !/\s/.test(v)) out.keyId = v;
  }
  if (p.has('region'))   out.regionOverride = p.get('region');
  return out;
}

// True when at least one config param is present in the current hash.
export function hasUrlParams() {
  const p = hashParams();
  return ['endpoint', 'bucket', 'provider', 'region', 'keyId'].some(k => p.has(k));
}

// Build a shareable URL with the connection config in the hash. The secret key is
// never included. The access key ID is included only when includeKeyId is set — this
// is the "everything but the secret" variant, so a recipient only enters the secret.
// Returns null when running from file:// (no meaningful origin to share).
export function buildShareUrl(credentials, { includeKeyId = false } = {}) {
  if (window.location.protocol === 'file:') return null;
  const p = new URLSearchParams();
  if (credentials.endpoint)               p.set('endpoint', credentials.endpoint);
  if (credentials.bucket)                 p.set('bucket',   credentials.bucket);
  if (credentials.provider)               p.set('provider', credentials.provider);
  if (credentials.regionOverride)         p.set('region',   credentials.regionOverride);
  if (includeKeyId && credentials.keyId)  p.set('keyId',    credentials.keyId);
  const hash = p.toString();
  const base = window.location.origin + window.location.pathname;
  return hash ? `${base}#${hash}` : base;
}

// Update browser history when navigating to a prefix (§4.14). Preserves all other
// hash params (endpoint, bucket, provider) while updating only the prefix param.
// replace=true uses replaceState (initial load, back-button restores) so those
// navigations don't add extra entries. Safe on file:// — Chrome blocks pushState
// for local files; errors are silently swallowed.
export function pushPrefixHistory(prefix, replace = false) {
  try {
    const p = hashParams();
    if (prefix) p.set('prefix', prefix);
    else        p.delete('prefix');
    const hash = p.toString();
    const url = window.location.pathname + (hash ? '#' + hash : '');
    if (replace) window.history.replaceState({ prefix }, '', url);
    else         window.history.pushState({ prefix }, '', url);
  } catch { /* file:// */ }
}
