// Discovery and classification of incomplete (in-progress) multipart uploads, for the
// cleanup panel. See docs/superpowers/specs/2026-08-16-incomplete-uploads-design.md.
//
// ListMultipartUploads reports pure server-side state, so it finds every incomplete upload
// still on the server regardless of which client (or Bucketer version) created it — including
// record-less orphans left by pre-1.53.0 interrupted moves and uploads from other tools.
import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';

// Paginate ListMultipartUploads to completion. Prefix scopes the scan to the connection's base
// folder (a prefix-scoped key cannot see outside it). Returns [{ key, uploadId, initiated }].
export async function listIncompleteUploads(client, bucket, prefix = '') {
  const out = [];
  let keyMarker;
  let uploadIdMarker;
  do {
    const resp = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: prefix || undefined,
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
    }));
    for (const u of (resp.Uploads || [])) {
      out.push({ key: u.Key, uploadId: u.UploadId, initiated: u.Initiated });
    }
    if (resp.IsTruncated) {
      keyMarker = resp.NextKeyMarker;
      uploadIdMarker = resp.NextUploadIdMarker;
    } else {
      keyMarker = undefined;
    }
  } while (keyMarker);
  return out;
}

// Tag each upload with whether a move-job record references its uploadId (resumable, and its
// jobId) — a resumable upload is already surfaced as a paused Resume row, so the panel shows
// the rest (discard-only orphans). Pure.
export function classifyIncompleteUploads(uploads, moveJobs) {
  const jobByUploadId = new Map();
  for (const job of moveJobs) {
    for (const info of Object.values(job.inflightUploads || {})) {
      if (info?.uploadId) jobByUploadId.set(info.uploadId, job.id);
    }
  }
  return uploads.map((u) => ({
    ...u,
    moveJobId: jobByUploadId.get(u.uploadId) ?? null,
    resumable: jobByUploadId.has(u.uploadId),
  }));
}
