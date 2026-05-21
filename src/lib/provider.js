// Provider detection and per-provider configuration (§4.8, §5)

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

// Regex patterns for auto-detection from endpoint URL
const PATTERNS = [
  { re: /\.backblazeb2\.com/i,        provider: PROVIDERS.B2 },
  { re: /\.r2\.cloudflarestorage\.com/i, provider: PROVIDERS.R2 },
  { re: /\.wasabisys\.com/i,          provider: PROVIDERS.WASABI },
  { re: /\.amazonaws\.com/i,          provider: PROVIDERS.AWS },
  { re: /\.digitaloceanspaces\.com/i, provider: PROVIDERS.DO_SPACES },
];

export function detectProvider(endpoint) {
  for (const { re, provider } of PATTERNS) {
    if (re.test(endpoint)) return provider;
  }
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

// Whether this provider requires forcePathStyle (§5, Group A)
export function requiresPathStyle(provider) {
  return provider === PROVIDERS.B2 || provider === PROVIDERS.MINIO;
}

// Default MaxKeys per page for listing (§4.7)
export function defaultMaxKeys(provider) {
  return provider === PROVIDERS.B2 ? 200 : 1000;
}

// Whether CORS needs manual config (Group D — Wasabi is automatic)
export function needsCorsConfig(provider) {
  return provider !== PROVIDERS.WASABI;
}
