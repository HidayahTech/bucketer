// Move orchestration. S3 has no native move, so a move is, per object: a server-side
// copy to the remapped key, then — only after that copy is confirmed — a delete of the
// source. Mirrors delete-queue.js (worker pool, throttling retry, prefix discovery,
// incremental progress) and adds collision pre-checking and the multipart-copy path.
//
// op = { files: [{ key, size }], prefixes: [pfx], dest, capturedPrefix }
//
// onProgress(update) fires on each transition:
//   { phase: 'discovering' }                                  — only if op.prefixes
//   { phase: 'checking' }                                     — destination collision scan
//   { phase: 'moving', total: N }
//   { moved, errors: [...], movedKeys: [...] }                — per completed object
//   { phase: 'done', moved, errors: [...], movedPrefixes }
//
// movedKeys are SOURCE keys whose copy+delete both succeeded (caller removes those rows).
// movedPrefixes are source folders whose every key moved cleanly (caller removes the row).
// Collision/skip errors carry `skipped: true` so the UI can show them apart from failures.
import { ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { COPY_MULTIPART_THRESHOLD } from './constants.js';
import { destKeyForFile, destKeyForFolderObject } from './move-key.js';
import { copyObjectMultipart } from './move-multipart.js';
import { sendWithRetry } from './s3-retry.js';

const CONCURRENCY = 8;

async function listAllObjectsForPrefix(client, bucket, pfx) {
  const objs = [];
  let token;
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: pfx, MaxKeys: 1000, ContinuationToken: token,
    }));
    (resp.Contents || []).forEach(o => objs.push({ key: o.Key, size: o.Size ?? 0 }));
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return objs;
}

async function discoverPrefixObjects(client, bucket, prefixes) {
  const map = new Map();
  let idx = 0;
  async function worker() {
    while (idx < prefixes.length) {
      const pfx = prefixes[idx++];
      map.set(pfx, await listAllObjectsForPrefix(client, bucket, pfx));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prefixes.length) }, worker));
  return map;
}

export async function runMoveOperation(client, bucket, op, onProgress) {
  const dest = op.dest ?? '';
  const looseFiles = (op.files || []).map(f => (typeof f === 'string' ? { key: f, size: 0 } : f));
  const prefixes = op.prefixes || [];

  // Build the work list: { sourceKey, size, destKey, prefix }.
  const work = looseFiles.map(f => ({
    sourceKey: f.key, size: f.size ?? 0, destKey: destKeyForFile(f.key, dest), prefix: null,
  }));

  let prefixObjects = new Map();
  if (prefixes.length > 0) {
    onProgress({ phase: 'discovering' });
    try {
      prefixObjects = await discoverPrefixObjects(client, bucket, prefixes);
    } catch (err) {
      onProgress({ phase: 'done', moved: 0, errors: [{ key: '(listing)', message: err.message }], movedPrefixes: [] });
      return;
    }
    for (const pfx of prefixes) {
      for (const o of (prefixObjects.get(pfx) || [])) {
        work.push({ sourceKey: o.key, size: o.size, destKey: destKeyForFolderObject(pfx, o.key, dest), prefix: pfx });
      }
    }
  }

  // Nothing to move (e.g. empty op, or only empty folders): finish without a dest crawl.
  if (work.length === 0) {
    onProgress({ phase: 'done', moved: 0, errors: [], movedPrefixes: [...prefixes] });
    return;
  }

  // Collision check: one crawl of the destination prefix → set of existing keys.
  onProgress({ phase: 'checking' });
  let existing;
  try {
    const destObjs = await listAllObjectsForPrefix(client, bucket, dest);
    existing = new Set(destObjs.map(o => o.key));
  } catch (err) {
    onProgress({ phase: 'done', moved: 0, errors: [{ key: '(listing)', message: err.message }], movedPrefixes: [] });
    return;
  }

  const errors = [];
  const claimed = new Set();   // destKeys claimed earlier in this same batch (intra-batch collisions)
  const movable = [];
  for (const item of work) {
    if (item.destKey === item.sourceKey) {
      errors.push({ key: item.sourceKey, message: 'Already in this location — skipped.', skipped: true });
    } else if (existing.has(item.destKey) || claimed.has(item.destKey)) {
      errors.push({ key: item.sourceKey, message: 'An object already exists at the destination — skipped.', skipped: true });
    } else {
      claimed.add(item.destKey);
      movable.push(item);
    }
  }

  onProgress({ phase: 'moving', total: work.length });
  if (errors.length > 0) onProgress({ moved: 0, errors: [...errors], movedKeys: [] });

  let moved = 0;
  let mi = 0;
  async function worker() {
    while (mi < movable.length) {
      const item = movable[mi++];
      try {
        if (item.size > COPY_MULTIPART_THRESHOLD) {
          await copyObjectMultipart(client, { bucket, sourceKey: item.sourceKey, destKey: item.destKey, size: item.size });
        } else {
          await sendWithRetry(client, () => new CopyObjectCommand({
            Bucket: bucket, CopySource: `${bucket}/${item.sourceKey}`,
            Key: item.destKey, MetadataDirective: 'COPY',
          }));
        }
      } catch (err) {
        errors.push({ key: item.sourceKey, message: err.message || String(err) });
        onProgress({ moved, errors: [...errors], movedKeys: [] });
        continue;
      }
      // Copy confirmed — delete the source. A failure here means the object now exists in
      // both places (a duplicate, not a move): report it specifically and leave both.
      try {
        await sendWithRetry(client, () => new DeleteObjectCommand({ Bucket: bucket, Key: item.sourceKey }));
      } catch (err) {
        errors.push({
          key: item.sourceKey,
          message: `Copied to the destination, but the source could not be deleted — it now exists in both places (${err.message || String(err)}).`,
        });
        onProgress({ moved, errors: [...errors], movedKeys: [] });
        continue;
      }
      moved++;
      onProgress({ moved, errors: [...errors], movedKeys: [item.sourceKey] });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, movable.length) }, worker));

  const errorKeySet = new Set(errors.map(e => e.key));
  const movedPrefixes = prefixes.filter(pfx =>
    (prefixObjects.get(pfx) || []).every(o => !errorKeySet.has(o.key))
  );

  onProgress({ phase: 'done', moved, errors: [...errors], movedPrefixes });
}
