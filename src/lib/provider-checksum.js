// Copyright (C) 2026 HidayahTech, LLC
// Opportunistic provider-checksum adapters for duplicate detection.
//
// WHY THIS FILE EXISTS: a few providers already store a usable content checksum, which
// lets the scan skip a download. But support is inconsistent (R2's GetObjectAttributes is
// unimplemented, DO's is broken, B2's is header-only, MinIO's is buggy for multipart), so
// this is a strict *bonus*, never a dependency. Each adapter:
//   - accepts a checksum ONLY in an exact, known-good FULL_OBJECT shape (a composite,
//     part-size-dependent checksum is not comparable across objects and is rejected),
//   - returns null otherwise so detection falls back to the universal tiers,
//   - fails LOUD (warn) on genuinely unexpected shapes/errors so they can be reported and
//     the adapter refined from real data, and never throws into the scan.
//
// v1 ships exactly one adapter — AWS. Other providers get an adapter only once real probe
// output confirms an exact shape we can validate.

import { GetObjectAttributesCommand } from '@aws-sdk/client-s3';
import { PROVIDERS } from './provider.js';

function defaultWarn(info) {
  try { console.warn('[bucketer:dedup] unexpected provider checksum shape', info); } catch { /* no console */ }
}

// AWS checksum fields in priority order. CRC64NVME first: it is the default and is the one
// algorithm that yields a FULL_OBJECT checksum for multipart objects.
const AWS_ALGOS = [
  ['ChecksumCRC64NVME', 'crc64nvme'],
  ['ChecksumCRC32', 'crc32'],
  ['ChecksumCRC32C', 'crc32c'],
  ['ChecksumSHA256', 'sha256'],
  ['ChecksumSHA1', 'sha1'],
];

// Strictly parse a GetObjectAttributes response into a normalized "<algo>:<value>"
// signature, or null. Only FULL_OBJECT checksums are accepted. A missing checksum or a
// COMPOSITE one is routine (null, no warning); a FULL_OBJECT response we cannot make sense
// of is unexpected (null + warning).
export function parseAwsChecksum(attrs, { warn = defaultWarn, key } = {}) {
  const ck = attrs?.Checksum;
  if (!ck) return null;                       // no additional checksum — routine
  if (ck.ChecksumType !== 'FULL_OBJECT') return null; // composite is not comparable — routine

  const present = AWS_ALGOS.filter(([field]) => ck[field] != null);
  if (present.length !== 1) {
    warn({ provider: 'aws', op: 'GetObjectAttributes', key, expected: 'exactly one FULL_OBJECT checksum algorithm', got: present.map((p) => p[0]) });
    return null;
  }
  const [field, algo] = present[0];
  const value = ck[field];
  if (typeof value !== 'string' || value.length === 0) {
    warn({ provider: 'aws', op: 'GetObjectAttributes', key, expected: 'a non-empty checksum value', got: value });
    return null;
  }
  return `${algo}:${value}`;
}

// AWS adapter: GetObjectAttributes(['Checksum']) → strict parse. GetObjectAttributes
// returns the checksum in the response body, so our existing CORS (which exposes the
// needed headers for body reads) suffices — no CORS change required.
export async function awsAdapter(client, bucket, key, _head, { warn = defaultWarn } = {}) {
  try {
    const attrs = await client.send(new GetObjectAttributesCommand({
      Bucket: bucket, Key: key, ObjectAttributes: ['Checksum'],
    }));
    return parseAwsChecksum(attrs, { warn, key });
  } catch (err) {
    warn({ provider: 'aws', op: 'GetObjectAttributes', key, expected: 'a checksum response', got: `error: ${err?.name || err?.message || err}` });
    return null;
  }
}

// Return the checksum adapter for a provider, or null when none is confirmed for it.
export function providerChecksumAdapter(provider) {
  if (provider === PROVIDERS.AWS) return awsAdapter;
  return null;
}
