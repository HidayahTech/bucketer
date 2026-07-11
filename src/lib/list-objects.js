// Copyright (C) 2026 HidayahTech, LLC
// One page of a bucket listing, with the same transient-error resilience that the
// upload/move/delete paths already get via withUploadRetry. Listing was previously the
// only S3 read issued without any retry, so a momentary SlowDown/503/429 or a network
// blip surfaced as an opaque connect / "Load more" failure (#23). Now a transient error
// is retried with backoff+jitter before the failure ever reaches the UI.
//
// Returns the raw SDK ListObjectsV2 response (Contents / CommonPrefixes /
// NextContinuationToken / IsTruncated). `signal` is threaded to the SDK send so an
// in-flight request aborts, and short-circuits the retry loop the moment it fires.
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { withUploadRetry } from './s3-retry.js';

export function listObjectsPage(client, { bucket, prefix, token, maxKeys, signal } = {}) {
  return withUploadRetry(
    () => client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        Delimiter: '/',
        MaxKeys: maxKeys,
        ContinuationToken: token || undefined,
      }),
      { abortSignal: signal },
    ),
    { signal },
  );
}
