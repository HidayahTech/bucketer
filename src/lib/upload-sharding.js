// Copyright (C) 2026 HidayahTech, LLC
import { uploadPartsWithPool } from './upload-queue.js';
// Multi-origin upload sharding. Browsers cap concurrent connections
// at ~6 per origin (HTTP/1.1). The same bucket is reachable via two distinct origins —
// path-style (s3.<region>.<host>/bucket) and virtual-hosted (bucket.s3.<region>.<host>) —
// and each origin gets its own connection pool. Splitting a multipart upload's parts
// across both roughly doubles effective concurrency on providers that are still HTTP/1.1.
//
// Verified against Backblaze B2: the endpoint TLS cert covers *.s3.<region>.backblazeb2.com,
// and both addressing styles route to the same bucket (the AWS SDK builds
// bucket.s3.<region>.backblazeb2.com under forcePathStyle:false). Pure, S3-free, unit-testable.

// Providers verified to be HTTP/1.1 AND to accept BOTH path-style and virtual-hosted
// addressing with a TLS cert that covers the bucket-as-subdomain name. Conservative
// allowlist — extend only after verifying a provider's protocol + cert + routing:
//   b2     — s3.<region>.backblazeb2.com is HTTP/1.1; cert *.s3.<region>.backblazeb2.com.
//   aws    — s3.<region>.amazonaws.com is HTTP/1.1; cert *.s3.<region>.amazonaws.com.
//   wasabi — s3.<region>.wasabisys.com is HTTP/1.1; cert *.s3.<region>.wasabisys.com.
// R2 is HTTP/2 (Cloudflare edge) → sharding gives no benefit (coalescing/multiplexing);
// MinIO/generic are deployment-specific. Sharding never *breaks* an excluded provider — it
// just isn't attempted (and the per-upload probe would fall back anyway).
const VHOST_SHARDABLE_PROVIDERS = new Set(['b2', 'aws', 'wasabi']);

// Provider-only capability check (no bucket) — drives the Settings toggle visibility.
export function isShardCapableProvider(provider) {
  return VHOST_SHARDABLE_PROVIDERS.has(provider);
}

// A bucket name is virtual-host shardable only if it is a single valid DNS label: the
// cert wildcard is one level (*.s3.<region>.<host>), so a dotted name would fail TLS,
// and S3 virtual-hosted addressing requires a DNS-compatible name. 3–63 chars, starts and
// ends alphanumeric, lowercase letters / digits / hyphens between.
const DNS_LABEL = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function isVhostShardable(bucket, provider) {
  return VHOST_SHARDABLE_PROVIDERS.has(provider)
    && typeof bucket === 'string'
    && DNS_LABEL.test(bucket);
}

// Uploads parts across multiple "lanes", each lane being { client, concurrency }. Every
// lane runs its own `concurrency` workers; all workers pull from one shared queue of part
// numbers, so work self-balances and total in-flight equals the sum of lane concurrencies.
// workFn(partNumber, client) must return a Promise. This generalises uploadPartsWithPool
// (the single-lane case) — each lane carries the S3 client for its origin.
export async function uploadPartsAcrossLanes(partNumbers, lanes, workFn) {
  const queue = [...partNumbers];
  async function worker(client) {
    for (;;) {
      const partNumber = queue.shift();
      if (partNumber === undefined) break;
      await workFn(partNumber, client);
    }
  }
  const workers = [];
  for (const lane of lanes) {
    const n = Math.max(1, lane.concurrency);
    for (let i = 0; i < n; i++) workers.push(worker(lane.client));
  }
  await Promise.all(workers);
}

// After the probe (part 1 on the added origin) fails, decide whether to fall back to
// single-origin or propagate. We fall back for ANY provider rejection — signature/host/CORS/
// 4xx, or an exhausted transient blip — because the default origin is always available and
// falling back only forfeits the speedup, never correctness. A user abort must NOT fall back:
// it has to propagate so the upload actually stops.
export function shouldFallbackFromVhost(err) {
  if (!err) return false;
  return !(err.name === 'AbortError' || err.message === 'Upload aborted');
}

// Uploads partNumbers across two origins when the provider accepts it, else a single pool.
// `fallbackClient` addresses the bucket via the provider's DEFAULT style (path-style for B2,
// virtual-hosted for AWS) — the origin guaranteed to work. `probeClient` addresses it via the
// OTHER style, giving a second connection-pool origin. Part 1 probes the added origin; if it
// is rejected (anything but an abort), the whole file continues single-origin on the default —
// so enabling sharding can never cause a failure, only a missed speedup.
// workFn(partNumber, client) performs the actual send. Returns { sharded }.
export async function uploadPartsSharded(partNumbers, workFn, { fallbackClient, probeClient, shardConcurrency, poolConcurrency }) {
  if (!partNumbers.length) return { sharded: false };
  const [first, ...rest] = partNumbers;

  let sharded = true;
  try {
    await workFn(first, probeClient);      // probe the added (second) origin
  } catch (err) {
    if (!shouldFallbackFromVhost(err)) throw err;   // abort → propagate, don't fall back
    sharded = false;
    await workFn(first, fallbackClient);   // re-upload part 1 on the always-available default origin
  }

  if (sharded) {
    await uploadPartsAcrossLanes(rest, [
      { client: fallbackClient, concurrency: shardConcurrency },
      { client: probeClient,    concurrency: shardConcurrency },
    ], workFn);
  } else {
    await uploadPartsWithPool(rest, (n) => workFn(n, fallbackClient), poolConcurrency);
  }
  return { sharded };
}
