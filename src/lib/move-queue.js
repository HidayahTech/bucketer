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
//   { phase: 'done', moved, errors: [...], movedPrefixes, cancelled }
//
// movedKeys are SOURCE keys whose copy+delete both succeeded (caller removes those rows).
// movedPrefixes are source folders whose every key moved cleanly (caller removes the row).
// Collision/skip errors carry `skipped: true` so the UI can show them apart from failures.
// shouldCancel() is polled between objects; in-flight copies complete.
import { ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { COPY_MULTIPART_THRESHOLD } from './constants.js';
import {
  destKeyForFile,
  destKeyForFolderObject,
  freeFileKey,
  freeFolderPrefix,
  renamedFolderPrefix,
  renameFolderKey,
  copySource,
} from './move-key.js';
import { copyObjectMultipart } from './move-multipart.js';
import { sendWithRetry } from './s3-retry.js';
import { saveMoveJob, updateMoveJob, deleteMoveJob } from './move-jobs.js';

const CONCURRENCY = 8;

async function listAllObjectsForPrefix(client, bucket, pfx) {
  const objs = [];
  let token;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pfx,
        MaxKeys: 1000,
        ContinuationToken: token,
      }),
    );
    (resp.Contents || []).forEach((o) => objs.push({ key: o.Key, size: o.Size ?? 0 }));
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return objs;
}

// Object identity across a move (GitLab #74 / R02, #75 / R04). A source is deleted only when
// it is still the object that was copied: its ETag is read before the copy and again just
// before the delete. Resume finishes a "destination already exists" item only when the job
// record says THIS move wrote it (the destination ETag returned by its own copy) and that
// object is still there; anything less is reported and the source is kept. This works on
// every provider but is not atomic: a writer between the final HEAD and the DELETE is not
// caught (conditional copy/delete headers — #35 — would close that, where supported).
const SOURCE_CHANGED =
  'The source changed while it was being moved, so it was kept — the destination holds the earlier version.';
const DEST_UNVERIFIED =
  "An object already exists at the destination that this move can't confirm it wrote, so the source was kept.";

// The key's ETag ('' if the provider sends none), or null if the key does not exist.
async function headEtag(client, bucket, key) {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ETag ?? '';
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
    throw err;
  }
}

// Delete the source only if it is unchanged since srcEtag. Returns SOURCE_CHANGED when it was
// kept; null when deleted (or already gone). Delete/HEAD failures throw to the caller.
async function deleteSourceIfUnchanged(client, bucket, sourceKey, srcEtag) {
  const now = await headEtag(client, bucket, sourceKey);
  if (now === null) return null;
  if (now !== srcEtag) return SOURCE_CHANGED;
  await sendWithRetry(client, () => new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));
  return null;
}

// Copy one item; returns the destination ETag the copy produced. For a move/rename (deletes
// the source afterwards) the source ETag is captured first and returned too.
async function copyItem(client, bucket, item, captureSource, multipartOpts) {
  let srcEtag = null;
  if (captureSource) {
    srcEtag = await headEtag(client, bucket, item.sourceKey);
    if (srcEtag === null) throw new Error('The source no longer exists.');
  }
  let destEtag;
  if (item.size > COPY_MULTIPART_THRESHOLD) {
    destEtag = await copyObjectMultipart(client, {
      bucket,
      sourceKey: item.sourceKey,
      destKey: item.destKey,
      size: item.size,
      ...multipartOpts,
    });
  } else {
    const resp = await sendWithRetry(
      client,
      () =>
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: copySource(bucket, item.sourceKey),
          Key: item.destKey,
          MetadataDirective: 'COPY',
        }),
    );
    destEtag = resp?.CopyObjectResult?.ETag;
  }
  return { srcEtag, destEtag: destEtag ?? '' };
}

async function discoverPrefixObjects(client, bucket, prefixes, shouldCancel = () => false) {
  const map = new Map();
  let idx = 0;
  async function worker() {
    while (idx < prefixes.length && !shouldCancel()) {
      const pfx = prefixes[idx++];
      map.set(pfx, await listAllObjectsForPrefix(client, bucket, pfx));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prefixes.length) }, worker));
  return map;
}

export async function runMoveOperation(client, bucket, op, onProgress, shouldCancel = () => false) {
  return runTransfer(client, bucket, op, onProgress, 'move', shouldCancel);
}

export async function runCopyOperation(client, bucket, op, onProgress, shouldCancel = () => false) {
  return runTransfer(client, bucket, op, onProgress, 'copy', shouldCancel);
}

// Folder rename: a single folder relabeled at the same parent. Reuses the transfer core
// (copy-then-delete, like move), with a prefix-swap remap and block-on-collision.
export async function runRenameOperation(client, bucket, op, onProgress, shouldCancel = () => false) {
  return runTransfer(client, bucket, op, onProgress, 'rename', shouldCancel);
}

// Shared core for move ('move') and copy-and-keep ('copy'). Copy renames on collision
// (never overwrites) and skips the source delete; move skips colliding objects and
// deletes each source only after its copy is confirmed.
async function runTransfer(client, bucket, op, onProgress, mode, shouldCancel) {
  const dest = op.dest ?? '';
  const looseFiles = (op.files || []).map((f) => (typeof f === 'string' ? { key: f, size: 0 } : f));
  const prefixes = op.prefixes || [];

  // Rename: compute the single target prefix once; every key is prefix-swapped onto it.
  const renameTarget = mode === 'rename' ? renamedFolderPrefix(prefixes[0], op.renameTo) : null;

  // Build the work list: { sourceKey, size, destKey, prefix }.
  const work = looseFiles.map((f) => ({
    sourceKey: f.key,
    size: f.size ?? 0,
    destKey: destKeyForFile(f.key, dest),
    prefix: null,
  }));

  let prefixObjects = new Map();
  if (prefixes.length > 0) {
    onProgress({ phase: 'discovering' });
    try {
      prefixObjects = await discoverPrefixObjects(client, bucket, prefixes, shouldCancel);
    } catch (err) {
      onProgress({
        phase: 'done',
        moved: 0,
        errors: [{ key: '(listing)', message: err.message }],
        movedPrefixes: [],
        cancelled: false,
      });
      return;
    }
    if (shouldCancel()) {
      onProgress({ phase: 'done', moved: 0, errors: [], movedPrefixes: [], cancelled: true });
      return;
    }
    for (const pfx of prefixes) {
      for (const o of prefixObjects.get(pfx) || []) {
        const destKey =
          mode === 'rename' ? renameFolderKey(pfx, o.key, renameTarget) : destKeyForFolderObject(pfx, o.key, dest);
        work.push({ sourceKey: o.key, size: o.size, destKey, prefix: pfx });
      }
    }
  }

  // Nothing to move (e.g. empty op, or only empty folders): finish without a dest crawl.
  if (work.length === 0) {
    onProgress({
      phase: 'done',
      moved: 0,
      errors: [],
      movedPrefixes: mode !== 'copy' ? [...prefixes] : [],
      cancelled: false,
    });
    return;
  }

  // Collision check: one crawl of the destination prefix → set of existing keys.
  onProgress({ phase: 'checking' });
  let existing;
  try {
    const scanPrefix = mode === 'rename' ? renameTarget : dest;
    const destObjs = await listAllObjectsForPrefix(client, bucket, scanPrefix);
    existing = new Set(destObjs.map((o) => o.key));
  } catch (err) {
    onProgress({
      phase: 'done',
      moved: 0,
      errors: [{ key: '(listing)', message: err.message }],
      movedPrefixes: [],
      cancelled: false,
    });
    return;
  }
  if (shouldCancel()) {
    onProgress({ phase: 'done', moved: 0, errors: [], movedPrefixes: [], cancelled: true });
    return;
  }

  const errors = [];
  const movable = [];
  if (mode === 'rename') {
    // Block wholesale if the target folder already exists — never merge.
    if (existing.size > 0) {
      onProgress({
        phase: 'done',
        moved: 0,
        errors: [{ key: prefixes[0], message: `A folder named "${op.renameTo}" already exists.`, skipped: true }],
        movedPrefixes: [],
        cancelled: false,
      });
      return;
    }
    movable.push(...work);
  } else if (mode === 'copy') {
    // Rename on collision so a copy never overwrites. Folders are remapped coherently
    // under one free folder prefix; loose files get a " (n)" suffix. `taken` grows as
    // destinations are claimed so intra-batch collisions are also avoided.
    const taken = new Set(existing);
    const isTakenPrefix = (p) => {
      for (const k of taken) if (k.startsWith(p)) return true;
      return false;
    };
    const folderGroups = new Map();
    for (const item of work) {
      if (item.prefix === null) continue;
      if (!folderGroups.has(item.prefix)) folderGroups.set(item.prefix, []);
      folderGroups.get(item.prefix).push(item);
    }
    for (const [pfx, group] of folderGroups) {
      const folderTop = destKeyForFolderObject(pfx, pfx, dest);
      const freeTop = freeFolderPrefix(folderTop, isTakenPrefix);
      for (const item of group) {
        item.destKey = freeTop + item.destKey.slice(folderTop.length);
        taken.add(item.destKey);
        movable.push(item);
      }
    }
    for (const item of work) {
      if (item.prefix !== null) continue;
      item.destKey = freeFileKey(item.destKey, (k) => taken.has(k));
      taken.add(item.destKey);
      movable.push(item);
    }
  } else {
    const claimed = new Set(); // destKeys claimed earlier in this same batch (intra-batch collisions)
    for (const item of work) {
      if (item.destKey === item.sourceKey) {
        errors.push({ key: item.sourceKey, message: 'Already in this location — skipped.', skipped: true });
      } else if (existing.has(item.destKey) || claimed.has(item.destKey)) {
        errors.push({
          key: item.sourceKey,
          message: 'An object already exists at the destination — skipped.',
          skipped: true,
        });
      } else {
        claimed.add(item.destKey);
        movable.push(item);
      }
    }
  }

  // Byte progress for the queue's bar/speed/ETA (uniform with the ZIP download). bytesTotal
  // is the sum of every object's size; bytesDone accumulates as objects — and, for large
  // objects, their individual parts — finish copying.
  const bytesTotal = movable.reduce((sum, it) => sum + (it.size || 0), 0);
  let bytesDone = 0;
  onProgress({ phase: 'moving', total: work.length, bytesTotal, bytesDone });
  if (errors.length > 0) onProgress({ moved: 0, errors: [...errors], movedKeys: [], bytesDone, bytesTotal });

  // Resumable-move persistence: only for mode 'move' with a job id. The record — carrying
  // each in-flight multipart uploadId — is written before any part copy so a reload can
  // resume. Writes are serialized (concurrent workers share one record) and best-effort: a
  // failed persist must never fail the move itself.
  const persisting = mode === 'move' && !!op.jobId;
  const inflightUploads = {};
  let persistChain = Promise.resolve();
  const persist = (fn) => {
    persistChain = persistChain.then(fn).catch(() => {});
    return persistChain;
  };
  if (persisting) {
    await persist(() =>
      saveMoveJob({
        id: op.jobId,
        provider: op.provider,
        endpoint: op.endpoint,
        bucket,
        mode,
        dest,
        capturedPrefix: op.capturedPrefix ?? '',
        createdAt: op.createdAt ?? Date.now(),
        items: movable.map((m) => ({ sourceKey: m.sourceKey, destKey: m.destKey, size: m.size })),
        inflightUploads: {},
        copied: {},
      }),
    );
  }

  let moved = 0;
  let mi = 0;
  let cancelled = false;
  const movedKeySet = new Set();
  const copied = {}; // sourceKey → { srcEtag, destEtag }: proof for resume that this move wrote the dest
  async function worker() {
    while (mi < movable.length) {
      if (shouldCancel()) {
        cancelled = true;
        return;
      }
      const item = movable[mi++];
      let identity;
      try {
        identity = await copyItem(client, bucket, item, mode !== 'copy', {
          onUploadIdCreated: persisting
            ? (uploadId, partSize) => {
                inflightUploads[item.sourceKey] = { uploadId, partSize };
                persist(() => updateMoveJob(op.jobId, { inflightUploads: { ...inflightUploads } }));
              }
            : undefined,
          onPartCopied: (bytes) => {
            bytesDone += bytes;
            onProgress({ moved, errors: [...errors], movedKeys: [], bytesDone, bytesTotal });
          },
        });
        if (item.size > COPY_MULTIPART_THRESHOLD) {
          if (persisting) {
            // Complete succeeded — this upload is no longer in flight.
            delete inflightUploads[item.sourceKey];
            persist(() => updateMoveJob(op.jobId, { inflightUploads: { ...inflightUploads } }));
          }
        } else {
          bytesDone += item.size || 0;
        }
      } catch (err) {
        // A fresh multipart copy aborts its upload on failure (move-multipart.js), so drop
        // any stale in-flight entry — resume would find no parts and must start it fresh.
        if (persisting && inflightUploads[item.sourceKey]) {
          delete inflightUploads[item.sourceKey];
          persist(() => updateMoveJob(op.jobId, { inflightUploads: { ...inflightUploads } }));
        }
        errors.push({ key: item.sourceKey, message: err.message || String(err) });
        onProgress({ moved, errors: [...errors], movedKeys: [] });
        continue;
      }
      // Move only: copy confirmed — delete the source. A failure here means the object
      // now exists in both places (a duplicate, not a move): report it and leave both.
      if (mode !== 'copy') {
        if (persisting) {
          copied[item.sourceKey] = identity;
          await persist(() => updateMoveJob(op.jobId, { copied: { ...copied } }));
        }
        try {
          const kept = await deleteSourceIfUnchanged(client, bucket, item.sourceKey, identity.srcEtag);
          if (kept) {
            errors.push({ key: item.sourceKey, message: kept });
            onProgress({ moved, errors: [...errors], movedKeys: [] });
            continue;
          }
        } catch (err) {
          errors.push({
            key: item.sourceKey,
            message: `Copied to the destination, but the source could not be deleted — it now exists in both places (${err.message || String(err)}).`,
          });
          onProgress({ moved, errors: [...errors], movedKeys: [] });
          continue;
        }
        movedKeySet.add(item.sourceKey);
      }
      moved++;
      onProgress({
        moved,
        errors: [...errors],
        movedKeys: mode !== 'copy' ? [item.sourceKey] : [],
        bytesDone,
        bytesTotal,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, movable.length) }, worker));

  // A source folder is complete only when every object in it was confirmed
  // moved (copy + delete). Equivalent to the old "no errors" rule when the run
  // wasn't cancelled; strictly safer when it was.
  const movedPrefixes =
    mode !== 'copy'
      ? prefixes.filter((pfx) => (prefixObjects.get(pfx) || []).every((o) => movedKeySet.has(o.key)))
      : [];

  // A cleanly-finished move leaves no record; an interrupted or partial one is kept so it can
  // be resumed or discarded. "Clean" ignores collision skips (those items were never movable) —
  // only a real copy/delete failure or a cancel leaves work behind. `resumable` tells the app
  // it can offer Resume immediately, without waiting for a reconnect.
  const clean = !cancelled && movedKeySet.size === movable.length;
  const resumable = persisting && !clean;
  if (persisting) {
    await persist(() =>
      clean ? deleteMoveJob(op.jobId) : updateMoveJob(op.jobId, { inflightUploads: { ...inflightUploads } }),
    );
  }

  onProgress({ phase: 'done', moved, errors: [...errors], movedPrefixes, cancelled, bytesDone, bytesTotal, resumable });
}

// Resume a persisted, interrupted move (jobRecord from move-jobs.js). The safety net is a
// re-scan of the destination: any object already at its destKey was moved in a prior session
// — its source is deleted (idempotently) and it is counted done, never re-copied. Remaining
// items are copied fresh, except one whose multipart upload is still in flight
// (record.inflightUploads[sourceKey]): that one continues via ListParts, copying only the
// parts not yet done. A clean finish deletes the record.
export async function resumeMoveOperation(client, bucket, jobRecord, onProgress, shouldCancel = () => false) {
  const { id, dest, items, inflightUploads = {} } = jobRecord;
  // Records written before #74 carry no copy proof: their existing destinations are reported
  // as unverified and their sources kept.
  const copied = { ...jobRecord.copied };

  let existing;
  try {
    const destObjs = await listAllObjectsForPrefix(client, bucket, dest);
    existing = new Set(destObjs.map((o) => o.key));
  } catch (err) {
    onProgress({
      phase: 'done',
      moved: 0,
      errors: [{ key: '(listing)', message: err.message }],
      movedPrefixes: [],
      cancelled: false,
    });
    return;
  }

  const already = items.filter((it) => existing.has(it.destKey)); // destination exists — verify before deleting
  const pending = items.filter((it) => !existing.has(it.destKey)); // still to copy

  const bytesTotal = pending.reduce((sum, it) => sum + (it.size || 0), 0);
  let bytesDone = 0;
  onProgress({ phase: 'moving', total: items.length, bytesTotal, bytesDone });

  const errors = [];
  let moved = 0;
  let cancelled = false;
  const liveInflight = { ...inflightUploads };
  let persistChain = Promise.resolve();
  const persist = (fn) => {
    persistChain = persistChain.then(fn).catch(() => {});
    return persistChain;
  };

  // Objects already at the destination: finish the move by removing the source (idempotent).
  for (const it of already) {
    if (shouldCancel()) {
      cancelled = true;
      break;
    }
    try {
      const proof = copied[it.sourceKey];
      const destNow = proof ? await headEtag(client, bucket, it.destKey) : null;
      const kept =
        !proof || destNow !== proof.destEtag
          ? DEST_UNVERIFIED
          : await deleteSourceIfUnchanged(client, bucket, it.sourceKey, proof.srcEtag);
      if (kept) {
        errors.push({ key: it.sourceKey, message: kept });
        onProgress({ moved, errors: [...errors], movedKeys: [] });
        continue;
      }
      moved++;
      onProgress({ moved, errors: [...errors], movedKeys: [it.sourceKey], bytesDone, bytesTotal });
    } catch (err) {
      errors.push({ key: it.sourceKey, message: err.message || String(err) });
      onProgress({ moved, errors: [...errors], movedKeys: [] });
    }
  }

  let pi = 0;
  async function worker() {
    while (pi < pending.length) {
      if (shouldCancel()) {
        cancelled = true;
        return;
      }
      const it = pending[pi++];
      const resumeUploadId = liveInflight[it.sourceKey]?.uploadId;
      let identity;
      try {
        identity = await copyItem(client, bucket, it, true, {
          preferredPartBytes: liveInflight[it.sourceKey]?.partSize,
          resumeUploadId,
          onUploadIdCreated: resumeUploadId
            ? undefined
            : (uploadId, partSize) => {
                liveInflight[it.sourceKey] = { uploadId, partSize };
                persist(() => updateMoveJob(id, { inflightUploads: { ...liveInflight } }));
              },
          onPartCopied: (bytes) => {
            bytesDone += bytes;
            onProgress({ moved, errors: [...errors], movedKeys: [], bytesDone, bytesTotal });
          },
        });
        if (it.size > COPY_MULTIPART_THRESHOLD) {
          delete liveInflight[it.sourceKey];
          persist(() => updateMoveJob(id, { inflightUploads: { ...liveInflight } }));
        } else {
          bytesDone += it.size || 0;
        }
      } catch (err) {
        errors.push({ key: it.sourceKey, message: err.message || String(err) });
        onProgress({ moved, errors: [...errors], movedKeys: [] });
        continue;
      }
      copied[it.sourceKey] = identity;
      await persist(() => updateMoveJob(id, { copied: { ...copied } }));
      try {
        const kept = await deleteSourceIfUnchanged(client, bucket, it.sourceKey, identity.srcEtag);
        if (kept) {
          errors.push({ key: it.sourceKey, message: kept });
          onProgress({ moved, errors: [...errors], movedKeys: [] });
          continue;
        }
      } catch (err) {
        errors.push({
          key: it.sourceKey,
          message: `Copied to the destination, but the source could not be deleted — it now exists in both places (${err.message || String(err)}).`,
        });
        onProgress({ moved, errors: [...errors], movedKeys: [] });
        continue;
      }
      moved++;
      onProgress({ moved, errors: [...errors], movedKeys: [it.sourceKey], bytesDone, bytesTotal });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  const clean = !cancelled && errors.length === 0;
  await persist(() => (clean ? deleteMoveJob(id) : updateMoveJob(id, { inflightUploads: { ...liveInflight } })));
  onProgress({
    phase: 'done',
    moved,
    errors: [...errors],
    movedPrefixes: [],
    cancelled,
    bytesDone,
    bytesTotal,
    resumable: !clean,
  });
}
