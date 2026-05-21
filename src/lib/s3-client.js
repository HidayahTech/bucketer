// S3 client factory (§4.3)
import { S3Client } from '@aws-sdk/client-s3';
import { requiresPathStyle, extractRegion, PROVIDERS } from './provider.js';

export function createS3Client({ endpoint, bucket, keyId, secretKey, provider, regionOverride }) {
  const region = regionOverride || extractRegion(endpoint, provider) || 'us-east-1';

  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: secretKey },
    forcePathStyle: requiresPathStyle(provider),
  });
}
