import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const BATCH_SIZE    = 1000;
const CONCURRENCY   = 8;
const MAX_RETRIES   = 4;
const RETRY_BASE_MS = 500;

function isThrottlingError(err) {
  const code   = err.Code || err.code || err.name || '';
  const status = err.$metadata?.httpStatusCode;
  return code === 'SlowDown' || code === 'ServiceUnavailable' ||
         code === 'ThrottlingException' || status === 503 || status === 429;
}

async function sendBatchWithRetry(client, bucket, batch) {
  let attempt = 0;
  while (true) {
    try {
      const resp = await client.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: batch, Quiet: true },
      }));
      return { batch, respErrors: resp.Errors || [] };
    } catch (err) {
      if (attempt < MAX_RETRIES && isThrottlingError(err)) {
        const base  = RETRY_BASE_MS * 2 ** attempt;
        const delay = Math.round(base * (0.75 + Math.random() * 0.5));
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      } else {
        return { batch, networkError: err };
      }
    }
  }
}

async function listAllKeysForPrefix(client, bucket, pfx) {
  const keys = [];
  let token;
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: pfx, MaxKeys: 1000, ContinuationToken: token,
    }));
    (resp.Contents || []).forEach(o => keys.push(o.Key));
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function discoverPrefixKeys(client, bucket, prefixes) {
  const prefixKeys = new Map();
  // Worker-pool: cap concurrent ListObjectsV2 crawls at CONCURRENCY to avoid
  // saturating the connection pool and triggering 503 throttling on large prefix sets.
  let idx = 0;
  async function worker() {
    while (idx < prefixes.length) {
      const pfx = prefixes[idx++];
      prefixKeys.set(pfx, await listAllKeysForPrefix(client, bucket, pfx));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prefixes.length) }, worker));
  return prefixKeys;
}

// Executes a delete operation end-to-end: discover folder contents (if any),
// then delete all keys in parallel batches of BATCH_SIZE with CONCURRENCY groups.
//
// onProgress(update) is called with partial op fields on each state transition:
//   { phase: 'discovering' }
//   { phase: 'deleting', total: N }
//   { deleted: N, errors: [...], deletedKeys: [...] }   — after each batch group
//   { phase: 'done', deleted: N, errors: [...], deletedPrefixes: [...] }
//
// deletedKeys in incremental updates allows the caller to update UI state
// incrementally rather than waiting for the full operation to complete.
// deletedPrefixes in the done update lists prefixes whose entire contents
// were successfully deleted (safe to remove from the folder listing).
export async function runDeleteOperation(client, bucket, op, onProgress) {
  const allKeys    = [...op.files];
  let prefixKeys   = new Map();

  if (op.prefixes.length > 0) {
    onProgress({ phase: 'discovering' });
    try {
      prefixKeys = await discoverPrefixKeys(client, bucket, op.prefixes);
      prefixKeys.forEach(keys => allKeys.push(...keys));
    } catch (err) {
      onProgress({ phase: 'done', deleted: 0, errors: [{ key: '(listing)', message: err.message }], deletedPrefixes: [] });
      return;
    }
  }

  if (allKeys.length === 0) {
    onProgress({ phase: 'done', deleted: 0, errors: [], deletedPrefixes: [...op.prefixes] });
    return;
  }

  onProgress({ phase: 'deleting', total: allKeys.length });

  const errors = [];
  let deleted = 0;
  const batches = [];
  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    batches.push(allKeys.slice(i, i + BATCH_SIZE).map(Key => ({ Key })));
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(
      batches.slice(i, i + CONCURRENCY).map(async batch => {
        const { respErrors = [], networkError } = await sendBatchWithRetry(client, bucket, batch);
        const batchDeletedKeys = [];
        if (networkError) {
          batch.forEach(o => errors.push({ key: o.Key, message: networkError.message }));
        } else {
          const errorKeySet = new Set(respErrors.map(e => e.Key));
          errors.push(...respErrors.map(e => ({ key: e.Key, message: e.Message || e.Code })));
          batch.forEach(o => { if (!errorKeySet.has(o.Key)) batchDeletedKeys.push(o.Key); });
          deleted += batch.length - respErrors.length;
        }
        onProgress({ deleted, errors: [...errors], deletedKeys: batchDeletedKeys });
      })
    );
  }

  const errorKeySet = new Set(errors.map(e => e.key));
  const deletedPrefixes = op.prefixes.filter(pfx =>
    (prefixKeys.get(pfx) || []).every(k => !errorKeySet.has(k))
  );

  onProgress({ phase: 'done', deleted, errors: [...errors], deletedPrefixes });
}
