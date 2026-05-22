// URL-based session configuration and browser history helpers

// Read config fields from the query string (endpoint, bucket, provider, region).
// Returned object is merged over stored credentials so the form is pre-filled.
export function readUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const out = {};
  if (p.has('endpoint')) out.endpoint = p.get('endpoint');
  if (p.has('bucket'))   out.bucket   = p.get('bucket');
  if (p.has('provider')) out.provider = p.get('provider');
  if (p.has('region'))   out.regionOverride = p.get('region');
  return out;
}

// True when at least one config param is present in the current URL.
export function hasUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return ['endpoint', 'bucket', 'provider', 'region'].some(k => p.has(k));
}

// Build a shareable URL containing the current connection config (no credentials).
// Returns null when running from file:// (no meaningful origin to share).
export function buildShareUrl(credentials) {
  if (window.location.protocol === 'file:') return null;
  const p = new URLSearchParams();
  if (credentials.endpoint)       p.set('endpoint', credentials.endpoint);
  if (credentials.bucket)         p.set('bucket',   credentials.bucket);
  if (credentials.provider)       p.set('provider', credentials.provider);
  if (credentials.regionOverride) p.set('region',   credentials.regionOverride);
  const qs = p.toString();
  const base = window.location.origin + window.location.pathname;
  return qs ? `${base}?${qs}` : base;
}

// Push (or replace) the current S3 prefix into browser history, preserving all
// other query params. Safe to call from file:// — Chrome blocks pushState there,
// so failures are silently swallowed.
export function pushPrefixHistory(prefix, replace = false) {
  try {
    const p = new URLSearchParams(window.location.search);
    if (prefix) p.set('prefix', prefix);
    else        p.delete('prefix');
    const qs = p.toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    if (replace) window.history.replaceState({ prefix }, '', url);
    else         window.history.pushState({ prefix }, '', url);
  } catch { /* file:// */ }
}
