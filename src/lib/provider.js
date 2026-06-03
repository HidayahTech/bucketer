// Copyright (C) 2026 HidayahTech, LLC
// Provider detection and per-provider configuration (§4.8, §5).
//
// This is the single place where provider-specific behavioral differences are encoded
// (path-style URLs, region extraction, default page size, CORS requirements). All other
// modules are provider-agnostic and call these helpers when they need to vary behavior.

export const PROVIDERS = {
  B2: 'b2',
  R2: 'r2',
  WASABI: 'wasabi',
  AWS: 'aws',
  DO_SPACES: 'do_spaces',
  MINIO: 'minio',
  GENERIC: 'generic',
};

export const PROVIDER_LABELS = {
  [PROVIDERS.B2]: 'Backblaze B2',
  [PROVIDERS.R2]: 'Cloudflare R2',
  [PROVIDERS.WASABI]: 'Wasabi',
  [PROVIDERS.AWS]: 'AWS S3',
  [PROVIDERS.DO_SPACES]: 'DigitalOcean Spaces',
  [PROVIDERS.MINIO]: 'MinIO',
  [PROVIDERS.GENERIC]: 'Generic S3',
};

// Tested against the endpoint hostname only (not the full URL). Hostname-only matching
// prevents false positives on path components or query strings (e.g. a reverse proxy
// at /r2/ would incorrectly match if we tested the full URL). Patterns are anchored
// with $ to prevent suffix-based misdetection (e.g. 'mybackblazeb2.com' must not match).
const PATTERNS = [
  { re: /\.backblazeb2\.com$/i,        provider: PROVIDERS.B2 },
  { re: /\.r2\.cloudflarestorage\.com$/i, provider: PROVIDERS.R2 },
  { re: /\.wasabisys\.com$/i,          provider: PROVIDERS.WASABI },
  { re: /\.amazonaws\.com$/i,          provider: PROVIDERS.AWS },
  { re: /\.digitaloceanspaces\.com$/i, provider: PROVIDERS.DO_SPACES },
];

export function detectProvider(endpoint) {
  try {
    const host = new URL(endpoint).hostname;
    for (const { re, provider } of PATTERNS) {
      if (re.test(host)) return provider;
    }
  } catch { /* unparseable endpoint — fall through to GENERIC */ }
  return PROVIDERS.GENERIC;
}

// Extract region from endpoint URL for providers that embed it
export function extractRegion(endpoint, provider) {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    switch (provider) {
      case PROVIDERS.B2: {
        // https://s3.{region}.backblazeb2.com
        const m = host.match(/^s3\.([^.]+)\.backblazeb2\.com$/i);
        return m ? m[1] : null;
      }
      case PROVIDERS.WASABI: {
        // s3.wasabisys.com (no region segment) is the legacy us-east-1 endpoint
        // https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions
        if (/^s3\.wasabisys\.com$/i.test(host)) return 'us-east-1';
        // https://s3.{region}.wasabisys.com
        const m = host.match(/^s3\.([^.]+)\.wasabisys\.com$/i);
        return m ? m[1] : null;
      }
      case PROVIDERS.AWS: {
        // https://s3.{region}.amazonaws.com
        const m = host.match(/^s3\.([^.]+)\.amazonaws\.com$/i);
        return m ? m[1] : null;
      }
      case PROVIDERS.DO_SPACES: {
        // https://{region}.digitaloceanspaces.com
        const m = host.match(/^([^.]+)\.digitaloceanspaces\.com$/i);
        return m ? m[1] : null;
      }
      case PROVIDERS.R2:
        return 'auto';
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// B2 and MinIO require path-style URLs (§5 Group A). Using virtual-hosted style for
// these providers sends requests to the wrong host and produces auth-like errors that
// are hard to diagnose (noted as a snag in §4.3).
export function requiresPathStyle(provider) {
  return provider === PROVIDERS.B2 || provider === PROVIDERS.MINIO;
}

// B2: 200 because ListObjectsV2 is a Class C operation (billed per call); smaller pages
// make the cost of browsing legible. Others: 1000 (S3 API maximum; no per-call cost).
// User can override via Settings, persisted in localStorage.
export function defaultMaxKeys(provider) {
  return provider === PROVIDERS.B2 ? 200 : 1000;
}

// Whether CORS needs manual config (Group D — Wasabi is automatic)
export function needsCorsConfig(provider) {
  return provider !== PROVIDERS.WASABI;
}
