// Multipart server-side copy for objects above the single-request CopyObject cap (5 GiB).
// Uses UploadPartCopy, which copies BYTES ONLY — unlike single-request CopyObject with
// MetadataDirective:'COPY', it does not carry Content-Type or custom metadata. So we
// HeadObject the source first and re-specify that metadata on CreateMultipartUpload.
import {
  HeadObjectCommand, CreateMultipartUploadCommand, UploadPartCopyCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { calcPartSize, uploadPartsWithPool } from './upload-queue.js';
import { PART_CONCURRENCY, COPY_PART_SIZE_DEFAULT, COPY_PART_SIZE_MAX } from './constants.js';
import { sendWithRetry, isRetryableUploadError } from './s3-retry.js';
import { copySource } from './move-key.js';

// onPartCopied(bytes) fires once per successfully copied part with that part's byte count,
// so the caller can report real byte progress for a large single-file copy (which would
// otherwise appear as one indivisible object until it finishes).
export async function copyObjectMultipart(client, { bucket, sourceKey, destKey, size, preferredPartBytes = COPY_PART_SIZE_DEFAULT, onPartCopied }) {
  // Carry the source's metadata forward (UploadPartCopy would otherwise drop it).
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceKey }));

  const create = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket, Key: destKey,
    ContentType: head.ContentType,
    Metadata: head.Metadata,
    ContentDisposition: head.ContentDisposition,
    ContentEncoding: head.ContentEncoding,
    CacheControl: head.CacheControl,
  }));
  const uploadId = create.UploadId;

  try {
    // Copy parts are server-side (no client memory), so we use a large part size — capped at
    // the universal-safe 4 GB ceiling — to keep the request count low. calcPartSize still
    // enforces the ≥5 MB floor and the ≤10,000-part limit. All non-final parts are the same
    // size (partSize), which Cloudflare R2 requires.
    const partSize = calcPartSize(size, Math.min(preferredPartBytes, COPY_PART_SIZE_MAX));
    const partCount = Math.ceil(size / partSize);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const parts = new Array(partCount);

    await uploadPartsWithPool(partNumbers, async (partNumber) => {
      const start = (partNumber - 1) * partSize;
      const end   = Math.min(start + partSize, size) - 1; // CopySourceRange is INCLUSIVE
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
    // Best-effort cleanup of the orphaned multipart session; swallow abort errors so the
    // original failure propagates. The source object is never deleted on failure.
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: destKey, UploadId: uploadId }));
    } catch { /* ignore */ }
    throw err;
  }
}
