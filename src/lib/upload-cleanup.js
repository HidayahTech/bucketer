// Copyright (C) 2026 HidayahTech, LLC
// Multipart upload abort + resume record cleanup helper.
//
// WHY THIS FILE EXISTS: the sequence "abort the S3 multipart session, then delete
// the local resume record" was copy-pasted in three places in UploadQueue.jsx. Any
// change to the cleanup sequence (e.g. adding a log entry on abort) had to be made
// in all three locations. Centralizing here means one change propagates everywhere.
//
// WHAT BELONGS HERE: abortMultipartSession() and any future cleanup helpers that
// must always be called together. Best-effort only — errors are swallowed.
//
// WHAT DOES NOT BELONG HERE: cleanup paths that need to surface errors to the UI
// (e.g. handleCancel in UploadQueue.jsx, which shows a banner if abort fails).
// Those cases keep their own inline try/catch.

import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { deleteResumeRecord } from './resume-records.js';

// Best-effort: abort the S3 multipart session AND delete the resume record.
// Both operations are swallowed on error — use only where failure is acceptable.
// For error-surfacing paths, handle abort and deleteResumeRecord inline.
//
// params: { bucket, key, uploadId, provider, endpoint }
export async function abortMultipartSession(client, { bucket, key, uploadId, provider, endpoint }) {
  await client.send(
    new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
  ).catch(() => {});
  await deleteResumeRecord({ provider, endpoint, bucket, destinationKey: key }).catch(() => {});
}
