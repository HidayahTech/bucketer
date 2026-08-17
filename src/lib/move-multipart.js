// Multipart server-side copy for objects above the single-request CopyObject cap (5 GiB).
// Uses UploadPartCopy, which copies BYTES ONLY — unlike single-request CopyObject with
// MetadataDirective:'COPY', it does not carry Content-Type or custom metadata. So we
// HeadObject the source first and re-specify that metadata on CreateMultipartUpload.
import {
  HeadObjectCommand, CreateMultipartUploadCommand, UploadPartCopyCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { calcPartSize, uploadPartsWithPool, collectParts } from './upload-queue.js';
import { PART_CONCURRENCY, COPY_PART_SIZE_DEFAULT, COPY_PART_SIZE_MAX } from './constants.js';
import { sendWithRetry, isRetryableUploadError } from './s3-retry.js';
import { copySource } from './move-key.js';

// Callbacks (all optional):
//   onPartCopied(bytes)        — per part accounted for (copied now, or already done on resume),
//                                for real byte progress on a large single-file copy.
//   onUploadIdCreated(id, ps)  — fired right after CreateMultipartUpload so the caller can
//                                persist the upload id BEFORE any part copy (resume needs it).
// resumeUploadId: continue an existing multipart upload — skip Create, find parts already
//   copied via ListParts, copy only the missing ranges. On a resume failure the upload is
//   kept (not aborted) so it can be resumed again; a fresh copy still aborts its orphan.
export async function copyObjectMultipart(client, { bucket, sourceKey, destKey, size, preferredPartBytes = COPY_PART_SIZE_DEFAULT, onPartCopied, onUploadIdCreated, resumeUploadId }) {
  // Copy parts are server-side (no client memory), so we use a large part size — capped at
  // the universal-safe 4 GB ceiling — to keep the request count low. calcPartSize still
  // enforces the ≥5 MB floor and the ≤10,000-part limit. All non-final parts are the same
  // size (partSize), which Cloudflare R2 requires. A resume passes the original part size as
  // preferredPartBytes, so the byte ranges line up with the parts already uploaded.
  const partSize = calcPartSize(size, Math.min(preferredPartBytes, COPY_PART_SIZE_MAX));

  let uploadId;
  const doneEtags = new Map(); // PartNumber → ETag, for parts already copied (resume)
  if (resumeUploadId) {
    uploadId = resumeUploadId;
    for (const p of await collectParts(client, { bucket, key: destKey, uploadId })) {
      doneEtags.set(p.PartNumber, p.ETag);
    }
  } else {
    // UploadPartCopy copies bytes only, so carry the source's metadata forward here.
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceKey }));
    const create = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket, Key: destKey,
      ContentType: head.ContentType,
      Metadata: head.Metadata,
      ContentDisposition: head.ContentDisposition,
      ContentEncoding: head.ContentEncoding,
      CacheControl: head.CacheControl,
    }));
    uploadId = create.UploadId;
    onUploadIdCreated?.(uploadId, partSize);
  }

  try {
    const partCount = Math.ceil(size / partSize);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const parts = new Array(partCount);

    await uploadPartsWithPool(partNumbers, async (partNumber) => {
      const start = (partNumber - 1) * partSize;
      const end   = Math.min(start + partSize, size) - 1; // CopySourceRange is INCLUSIVE
      // Already copied in a prior session: reuse its ETag, still report its bytes so
      // progress stays absolute across the resume.
      if (doneEtags.has(partNumber)) {
        parts[partNumber - 1] = { PartNumber: partNumber, ETag: doneEtags.get(partNumber) };
        onPartCopied?.(end - start + 1);
        return;
      }
      const resp = await sendWithRetry(client, () => new UploadPartCopyCommand({
        Bucket: bucket, Key: destKey, UploadId: uploadId, PartNumber: partNumber,
        CopySource: copySource(bucket, sourceKey),
        CopySourceRange: `bytes=${start}-${end}`,
      }), { retryOn: isRetryableUploadError });
      // Part ETag is nested under CopyPartResult (NOT resp.ETag, as with UploadPart).
      parts[partNumber - 1] = { PartNumber: partNumber, ETag: resp.CopyPartResult.ETag };
      onPartCopied?.(end - start + 1);
    }, PART_CONCURRENCY);

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: destKey, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (err) {
    // A fresh copy aborts its orphaned session (best-effort; swallow abort errors so the
    // original failure propagates). A resume leaves the upload intact so it stays resumable
    // — the persisted job record + Discard own its cleanup. The source is never deleted on
    // failure either way.
    if (!resumeUploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: destKey, UploadId: uploadId }));
      } catch { /* ignore */ }
    }
    throw err;
  }
}
