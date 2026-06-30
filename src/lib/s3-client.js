// Copyright (C) 2026 HidayahTech, LLC
// S3Client factory (§4.3). Called once per credential set; the returned client is
// stateless and reused for all operations until the user disconnects.
import { S3Client } from '@aws-sdk/client-s3';
import { requiresPathStyle, extractRegion, PROVIDERS } from './provider.js';

export function createS3Client({ endpoint, bucket, keyId, secretKey, provider, regionOverride }) {
  // Region resolution order (first non-null wins):
  //   1. regionOverride — user's explicit input from CredentialForm
  //   2. extractRegion() — auto-extracted from the endpoint URL structure (§5 Group B)
  //   3. 'us-east-1' — safe fallback that satisfies SigV4 signing for most providers
  const region = regionOverride || extractRegion(endpoint, provider) || 'us-east-1';

  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: secretKey },
    forcePathStyle: requiresPathStyle(provider),
    // Opt out of the SDK's default (WHEN_SUPPORTED, since v3.729.0) automatic CRC32
    // checksum on PutObject/UploadPart. We never request a checksum on uploads, so the
    // CRC32 is pure overhead — a second per-part body traversal on the main thread on
    // top of the SigV4 SHA-256 — and S3-compatible providers (R2/B2) have rejected the
    // unsolicited x-amz-checksum-crc32 header. WHEN_REQUIRED keeps checksums only for
    // operations that mandate them. Object integrity on multipart is ETag-based.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}
