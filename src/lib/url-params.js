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

import { normalizeBasePrefix, sanitizeNavPrefix } from './base-prefix.js';

function hashParams() {
  return new URLSearchParams(window.location.hash.slice(1));
}

// The navigation `prefix` param, validated and normalized (#68). Deliberately NOT part of
// readUrlParams(): `prefix` is navigation state, not connection config, and a bare
// `#prefix=` must never count as "connection details pre-filled from URL".
export function readHashPrefix() {
  return sanitizeNavPrefix(hashParams().get('prefix'));
}

// #70: does a link's connection config differ from what is stored? The mount-time
// auto-connect (a tab that still holds a secret) may only proceed when the answer is no —
// otherwise a pasted or stale link would silently sign the stored key's requests to a
// different endpoint/bucket/floor. Only fields the link actually set are compared.
const CONNECTION_FIELDS = ['endpoint', 'bucket', 'keyId', 'provider', 'regionOverride', 'basePrefix'];
function canon(field, value) {
  const v = (value || '').trim();
  if (field === 'endpoint') return v.replace(/\/$/, '');
  if (field === 'basePrefix') return normalizeBasePrefix(v);
  return v;
}
export function urlChangesConnection(fromUrl, stored) {
  return CONNECTION_FIELDS.some((f) => f in (fromUrl || {}) && canon(f, fromUrl[f]) !== canon(f, (stored || {})[f]));
}

// #70: what the link set, in the user's words, for the pre-fill banner — so a floor
// arriving from a link is never silent.
export function describeUrlParams(fromUrl) {
  const out = [];
  if (fromUrl.endpoint) out.push('endpoint');
  if (fromUrl.bucket) out.push('bucket');
  if (fromUrl.basePrefix) out.push(`base folder ${fromUrl.basePrefix}`);
  if (fromUrl.keyId) out.push('key ID');
  if (fromUrl.regionOverride) out.push('region');
  if (fromUrl.provider) out.push('provider');
  return out;
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
    } catch {
      /* unparseable — ignore */
    }
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
  if (p.has('region')) {
    const v = p.get('region');
    // Same guard as keyId (#68): a region is a short identifier; it reaches the SigV4
    // credential scope, so a crafted link must not inject free text.
    if (v && v.length <= 64 && !/\s/.test(v)) out.regionOverride = v;
  }
  if (p.has('basePrefix')) {
    const v = p.get('basePrefix');
    // Same defensive posture as bucket: reject traversal and Windows-path pastes,
    // cap length. Prefixes legitimately contain most other characters (spaces
    // included), so normalization is the only other treatment (#60).
    if (v && v.length <= 1024 && !v.includes('\\') && !v.split('/').some((s) => s === '..')) {
      const normalized = normalizeBasePrefix(v);
      if (normalized) out.basePrefix = normalized;
    }
  }
  return out;
}

// True when at least one config param is present in the current hash.
export function hasUrlParams() {
  const p = hashParams();
  return ['endpoint', 'bucket', 'provider', 'region', 'keyId', 'basePrefix'].some((k) => p.has(k));
}

// Build a shareable URL with the connection config in the hash. The secret key is
// never included. The access key ID is included only when includeKeyId is set — this
// is the "everything but the secret" variant, so a recipient only enters the secret.
// Returns null when running from file:// (no meaningful origin to share).
// prefix (#69): the folder the link should open in. Emitted only when non-empty AND
// different from the connection's floor, so a link copied at the root of an unscoped
// connection, or at the floor of a scoped one, is byte-identical to pre-#69 output. The
// recipient's floor still outranks it (Browser clamps with a notice), so a folder link can
// never turn into a 403. `prefix` is navigation state, not connection config: readUrlParams
// deliberately never consumes it (readHashPrefix does).
export function buildShareUrl(credentials, { includeKeyId = false, prefix = '' } = {}) {
  if (window.location.protocol === 'file:') return null;
  const p = new URLSearchParams();
  if (credentials.endpoint) p.set('endpoint', credentials.endpoint);
  if (credentials.bucket) p.set('bucket', credentials.bucket);
  if (credentials.provider) p.set('provider', credentials.provider);
  if (credentials.regionOverride) p.set('region', credentials.regionOverride);
  if (credentials.basePrefix) p.set('basePrefix', credentials.basePrefix);
  if (includeKeyId && credentials.keyId) p.set('keyId', credentials.keyId);
  const folder = normalizeBasePrefix(prefix);
  if (folder && folder !== normalizeBasePrefix(credentials.basePrefix)) p.set('prefix', folder);
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
    else p.delete('prefix');
    const hash = p.toString();
    const url = window.location.pathname + (hash ? '#' + hash : '');
    if (replace) window.history.replaceState({ prefix }, '', url);
    else window.history.pushState({ prefix }, '', url);
  } catch {
    /* file:// */
  }
}
