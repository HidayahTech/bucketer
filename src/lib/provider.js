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
        if (!m) return null;
        // Some Wasabi regions use legacy alias slugs that differ from canonical SigV4 names.
        // Using the alias slug causes SigV4 signing failures; map to canonical names.
        const WASABI_ALIASES = {
          'nl-1': 'eu-central-1', 'de-1': 'eu-central-2',
          'uk-1': 'eu-west-1',    'fr-1': 'eu-west-2',
          'uk-2': 'eu-west-3',    'it-1': 'eu-south-1',
        };
        return WASABI_ALIASES[m[1]] ?? m[1];
      }
      case PROVIDERS.AWS: {
        // Virtual-hosted: {bucket}.s3.{region}.amazonaws.com
        const vh = host.match(/^[^.]+\.s3\.([^.]+)\.amazonaws\.com$/i);
        if (vh) return vh[1];
        // Dualstack: s3.dualstack.{region}.amazonaws.com
        const ds = host.match(/^s3\.dualstack\.([^.]+)\.amazonaws\.com$/i);
        if (ds) return ds[1];
        // FIPS: s3-fips.{region}.amazonaws.com
        const fips = host.match(/^s3-fips\.([^.]+)\.amazonaws\.com$/i);
        if (fips) return fips[1];
        // Legacy dash: s3-{region}.amazonaws.com
        const dash = host.match(/^s3-([^.]+)\.amazonaws\.com$/i);
        if (dash) return dash[1];
        // Standard: s3.{region}.amazonaws.com
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

// B2 supports both path-style and virtual-hosted URLs; we force path-style because users
// supply a plain regional endpoint (s3.us-west-004.backblazeb2.com), not a bucket-prefixed
// one. MinIO genuinely requires path-style (virtual-hosted mode is disabled by default).
export function requiresPathStyle(provider) {
  return provider === PROVIDERS.B2 || provider === PROVIDERS.MINIO;
}

// B2: 200 because smaller pages make browsing feel snappier at B2's typical latency.
// Others: 1000 (S3 API maximum). User can override via Settings, persisted in localStorage.
export function defaultMaxKeys(provider) {
  return provider === PROVIDERS.B2 ? 200 : 1000;
}

// Whether CORS needs manual config (Group D — Wasabi is automatic)
export function needsCorsConfig(provider) {
  return provider !== PROVIDERS.WASABI;
}

// Build the canonical HTTPS endpoint URL for a known provider + region string.
// Returns null when the endpoint cannot be constructed from region alone:
//   R2 requires an account ID; MinIO/Generic have no standard hostname pattern.
//
// Doc sources (all fetched 2026-06-04, verified against project review docs):
//   B2:        https://www.backblaze.com/docs/cloud-storage-data-regions
//   Wasabi:    https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions
//   AWS:       https://docs.aws.amazon.com/general/latest/gr/s3.html
//   DO Spaces: https://docs.digitalocean.com/products/spaces/details/availability/
export function buildEndpoint(provider, region) {
  if (!region) return null;
  switch (provider) {
    case PROVIDERS.B2:
      return `https://s3.${region}.backblazeb2.com`;
    case PROVIDERS.WASABI:
      // us-east-1 uses the legacy bare endpoint (no region segment in hostname).
      // All other regions follow the standard template.
      return region === 'us-east-1'
        ? 'https://s3.wasabisys.com'
        : `https://s3.${region}.wasabisys.com`;
    case PROVIDERS.AWS:
      return `https://s3.${region}.amazonaws.com`;
    case PROVIDERS.DO_SPACES:
      return `https://${region}.digitaloceanspaces.com`;
    default:
      return null;
  }
}
