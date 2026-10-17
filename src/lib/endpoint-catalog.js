// Copyright (C) 2026 HidayahTech, LLC
// Endpoint and bucket suggestions for the connect form (accounts A, v1.66.0; REPORT C2, §2.3).
//
// The catalog ships as data, not as a wizard: only providers that publish a finite list of
// regional hosts AND that provider.js already detects, so a picked row also sets the provider and
// region. Region lists from the providers' own pages, fetched 2026-10-16 (BUCKET-1 lane 05):
//   AWS:          https://docs.aws.amazon.com/general/latest/gr/s3.html
//   Wasabi:       https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions
//   DigitalOcean: https://docs.digitalocean.com/products/spaces/details/availability/
// Not listable, so absent: Backblaze B2 (publishes no host list; users copy the Endpoint from the
// bucket card), Cloudflare R2 (the host contains the account id), and self-hosted stores.
import { PROVIDERS, PROVIDER_LABELS, buildEndpoint } from './provider.js';

const REGIONS = {
  [PROVIDERS.AWS]: [
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'af-south-1',
    'ap-east-1',
    'ap-east-2',
    'ap-south-1',
    'ap-south-2',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-southeast-3',
    'ap-southeast-4',
    'ap-southeast-5',
    'ap-southeast-6',
    'ap-southeast-7',
    'ap-northeast-1',
    'ap-northeast-2',
    'ap-northeast-3',
    'ca-central-1',
    'ca-west-1',
    'eu-central-1',
    'eu-central-2',
    'eu-west-1',
    'eu-west-2',
    'eu-west-3',
    'eu-south-1',
    'eu-south-2',
    'eu-north-1',
    'il-central-1',
    'mx-central-1',
    'me-south-1',
    'me-central-1',
    'sa-east-1',
    'us-gov-east-1',
    'us-gov-west-1',
  ],
  [PROVIDERS.WASABI]: [
    'us-east-1',
    'us-east-2',
    'us-central-1',
    'us-west-1',
    'us-west-2',
    'ca-central-1',
    'eu-central-1',
    'eu-central-2',
    'eu-west-1',
    'eu-west-2',
    'eu-west-3',
    'eu-south-1',
    'ap-northeast-1',
    'ap-northeast-2',
    'ap-southeast-1',
    'ap-southeast-2',
  ],
  [PROVIDERS.DO_SPACES]: [
    'nyc3',
    'ams3',
    'sfo2',
    'sfo3',
    'sgp1',
    'lon1',
    'fra1',
    'tor1',
    'blr1',
    'syd1',
    'atl1',
    'ric1',
    'mkc1',
  ],
};

const SHORT_LABEL = {
  [PROVIDERS.AWS]: 'Amazon S3',
  [PROVIDERS.WASABI]: 'Wasabi',
  [PROVIDERS.DO_SPACES]: 'DigitalOcean Spaces',
};

export const ENDPOINT_CATALOG = Object.entries(REGIONS).flatMap(([provider, regions]) =>
  regions.map((region) => ({
    provider,
    region,
    endpoint: buildEndpoint(provider, region),
    label: `${SHORT_LABEL[provider]} · ${region}`,
  })),
);

const norm = (e) => (e || '').trim().replace(/\/$/, '');
const byRecent = (a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || b.id - a.id;

// This device's endpoints (most recent first, each once, labelled with the provider and how many
// buckets were used there), then the catalog minus anything already listed.
export function endpointOptions(connections) {
  const seen = new Map();
  for (const c of [...connections].sort(byRecent)) {
    const e = norm(c.endpoint);
    if (!e) continue;
    const row = seen.get(e) || { endpoint: e, provider: c.provider, buckets: new Set() };
    row.buckets.add(c.bucket);
    seen.set(e, row);
  }
  const history = [...seen.values()].map(({ endpoint, provider, buckets }) => {
    const n = buckets.size;
    const name = (provider && PROVIDER_LABELS[provider]) || 'Used on this device';
    return { endpoint, label: `${name} · ${n} bucket${n === 1 ? '' : 's'}` };
  });
  return [...history, ...ENDPOINT_CATALOG.filter((r) => !seen.has(r.endpoint))];
}

// Buckets used on this endpoint, most recent first.
export function bucketOptions(connections, endpoint) {
  const e = norm(endpoint);
  if (!e) return [];
  return [
    ...new Set(
      [...connections]
        .filter((c) => norm(c.endpoint) === e)
        .sort(byRecent)
        .map((c) => c.bucket),
    ),
  ];
}
