// URL-based session configuration and browser history helpers.
// All params live in the hash fragment (#) so they are never sent to the server.

function hashParams() {
  return new URLSearchParams(window.location.hash.slice(1));
}

// Read config fields from the hash (endpoint, bucket, provider, region).
// Returned object is merged over stored credentials so the form is pre-filled.
export function readUrlParams() {
  const p = hashParams();
  const out = {};
  if (p.has('endpoint')) out.endpoint = p.get('endpoint');
  if (p.has('bucket'))   out.bucket   = p.get('bucket');
  if (p.has('provider')) out.provider = p.get('provider');
  if (p.has('region'))   out.regionOverride = p.get('region');
  return out;
}

// True when at least one config param is present in the current hash.
export function hasUrlParams() {
  const p = hashParams();
  return ['endpoint', 'bucket', 'provider', 'region'].some(k => p.has(k));
}

// Build a shareable URL with the connection config in the hash (no credentials).
// Returns null when running from file:// (no meaningful origin to share).
export function buildShareUrl(credentials) {
  if (window.location.protocol === 'file:') return null;
  const p = new URLSearchParams();
  if (credentials.endpoint)       p.set('endpoint', credentials.endpoint);
  if (credentials.bucket)         p.set('bucket',   credentials.bucket);
  if (credentials.provider)       p.set('provider', credentials.provider);
  if (credentials.regionOverride) p.set('region',   credentials.regionOverride);
  const hash = p.toString();
  const base = window.location.origin + window.location.pathname;
  return hash ? `${base}#${hash}` : base;
}

// Push (or replace) the current S3 prefix into browser history, preserving all
// other hash params. Safe to call from file:// — Chrome blocks pushState there,
// so failures are silently swallowed.
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
