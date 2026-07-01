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

// Browser fetch failures surface as a TypeError with a browser-specific message
// ("NetworkError when attempting to fetch resource." in Firefox, "Failed to fetch" in
// Chromium, "Load failed" in Safari), or as a TimeoutError / connection-reset code.
// These are transient — a dropped/reset connection, a momentary DNS or routing blip —
// and safe to retry for idempotent S3 part uploads and multipart completion. AbortError
// (a deliberate user cancel) is explicitly NOT transient and must never be retried.
const TRANSIENT_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'];

export function isTransientNetworkError(err) {
  if (!err) return false;
  const name = err.name || '';
  if (name === 'AbortError') return false;
  if (name === 'TimeoutError') return true;
  const msg = (err.message || '').toLowerCase();
  if (name === 'TypeError' && /networkerror|failed to fetch|load failed|network request failed/.test(msg)) return true;
  return TRANSIENT_CODES.includes(err.code || err.Code || '');
}

// Errors worth retrying on the upload path: server throttling OR a transient network blip.
export function isRetryableUploadError(err) {
  return isThrottlingError(err) || isTransientNetworkError(err);
}

// Retries an idempotent async operation on throttling/transient-network errors with
// exponential backoff + jitter. The multipart upload path (part uploads + completion)
// otherwise fails an entire large upload on a single transient blip, because the raw SDK
// send does not reliably retry a fetch TypeError. `run` is an async thunk; an optional
// abort `signal` short-circuits retries the moment the upload is cancelled.
export async function withUploadRetry(run, { maxRetries = MAX_RETRIES, baseMs = RETRY_BASE_MS, signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (attempt < maxRetries && isRetryableUploadError(err) && !signal?.aborted) {
        const base  = baseMs * 2 ** attempt;
        const delay = Math.round(base * (0.75 + Math.random() * 0.5));
        await new Promise(r => setTimeout(r, delay));
        attempt++;
        onRetry?.(attempt, err);   // diagnostics: count transient retries for the upload log
      } else {
        throw err;
      }
    }
  }
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
