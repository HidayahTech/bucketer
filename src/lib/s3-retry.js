// Shared throttling-retry helper for per-request S3 operations. The move feature issues
// many individual CopyObject / UploadPartCopy / DeleteObject requests (one per object,
// many per large object), so large folder moves on B2/Wasabi will hit SlowDown/503/429
// throttling. Each send is wrapped here with exponential backoff + jitter.
//
// delete-queue.js keeps its own private copy of this logic (batched DeleteObjects); this
// module is the per-request equivalent used by move-queue.js and move-multipart.js.

const MAX_RETRIES   = 4;
const RETRY_BASE_MS = 500;

export function isThrottlingError(err) {
  const code   = err.Code || err.code || err.name || '';
  const status = err.$metadata?.httpStatusCode;
  return code === 'SlowDown' || code === 'ServiceUnavailable' ||
         code === 'ThrottlingException' || status === 503 || status === 429;
}

// Sends the command produced by makeCommand(), retrying only on throttling errors.
// makeCommand is a thunk (not a prebuilt command) so each attempt gets a fresh command
// instance, matching how the AWS SDK expects commands to be single-use.
export async function sendWithRetry(client, makeCommand, { maxRetries = MAX_RETRIES, baseMs = RETRY_BASE_MS } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await client.send(makeCommand());
    } catch (err) {
      if (attempt < maxRetries && isThrottlingError(err)) {
        const base  = baseMs * 2 ** attempt;
        const delay = Math.round(base * (0.75 + Math.random() * 0.5));
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      } else {
        throw err;
      }
    }
  }
}
