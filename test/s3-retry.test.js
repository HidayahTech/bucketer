import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThrottlingError,
  isTransientNetworkError,
  isRetryableUploadError,
  withUploadRetry,
} from '../src/lib/s3-retry.js';

// ── isTransientNetworkError ───────────────────────────────────────────────────
// Browser fetch failures surface as a TypeError with a browser-specific message.
// These are transient (dropped/reset connection, DNS/routing blip) and safe to retry
// for idempotent part uploads and multipart completion. AbortError is NOT transient.

describe('isTransientNetworkError', () => {
  test('Firefox fetch NetworkError', () => {
    assert.equal(isTransientNetworkError(new TypeError('NetworkError when attempting to fetch resource.')), true);
  });

  test('Chromium fetch failure', () => {
    assert.equal(isTransientNetworkError(new TypeError('Failed to fetch')), true);
  });

  test('Safari fetch failure', () => {
    assert.equal(isTransientNetworkError(new TypeError('Load failed')), true);
  });

  test('a TimeoutError is transient', () => {
    const e = new Error('timed out'); e.name = 'TimeoutError';
    assert.equal(isTransientNetworkError(e), true);
  });

  test('a connection-reset code is transient', () => {
    const e = new Error('socket hang up'); e.code = 'ECONNRESET';
    assert.equal(isTransientNetworkError(e), true);
  });

  test('AbortError is NOT transient (user cancelled)', () => {
    const e = new Error('The operation was aborted'); e.name = 'AbortError';
    assert.equal(isTransientNetworkError(e), false);
  });

  test('an S3 AccessDenied error is NOT transient', () => {
    const e = new Error('Access Denied'); e.name = 'AccessDenied'; e.$metadata = { httpStatusCode: 403 };
    assert.equal(isTransientNetworkError(e), false);
  });

  test('null/undefined is not transient', () => {
    assert.equal(isTransientNetworkError(null), false);
    assert.equal(isTransientNetworkError(undefined), false);
  });
});

// ── isRetryableUploadError ────────────────────────────────────────────────────

describe('isRetryableUploadError', () => {
  test('throttling errors are retryable', () => {
    assert.equal(isRetryableUploadError({ name: 'SlowDown' }), true);
    assert.equal(isRetryableUploadError({ $metadata: { httpStatusCode: 503 } }), true);
  });

  test('transient network errors are retryable', () => {
    assert.equal(isRetryableUploadError(new TypeError('NetworkError when attempting to fetch resource.')), true);
  });

  test('a plain 403 / access denied is NOT retryable', () => {
    const e = new Error('denied'); e.name = 'AccessDenied'; e.$metadata = { httpStatusCode: 403 };
    assert.equal(isRetryableUploadError(e), false);
  });
});

// ── withUploadRetry ───────────────────────────────────────────────────────────

describe('withUploadRetry', () => {
  test('returns the result when the operation succeeds on the first try', async () => {
    let calls = 0;
    const r = await withUploadRetry(async () => { calls++; return 'ok'; }, { baseMs: 1 });
    assert.equal(r, 'ok');
    assert.equal(calls, 1);
  });

  test('retries a transient error, then succeeds', async () => {
    let calls = 0;
    const r = await withUploadRetry(async () => {
      calls++;
      if (calls < 3) throw new TypeError('NetworkError when attempting to fetch resource.');
      return 'done';
    }, { baseMs: 1 });
    assert.equal(r, 'done');
    assert.equal(calls, 3);
  });

  test('gives up after maxRetries and throws the last error', async () => {
    let calls = 0;
    await assert.rejects(
      withUploadRetry(async () => { calls++; throw new TypeError('Failed to fetch'); }, { maxRetries: 2, baseMs: 1 }),
      { message: 'Failed to fetch' },
    );
    assert.equal(calls, 3, 'initial attempt + 2 retries');
  });

  test('does NOT retry a non-retryable error', async () => {
    let calls = 0;
    const denied = new Error('denied'); denied.name = 'AccessDenied'; denied.$metadata = { httpStatusCode: 403 };
    await assert.rejects(
      withUploadRetry(async () => { calls++; throw denied; }, { maxRetries: 3, baseMs: 1 }),
      { name: 'AccessDenied' },
    );
    assert.equal(calls, 1, 'must not retry a permission error');
  });

  test('does NOT retry once the abort signal is set', async () => {
    let calls = 0;
    const signal = { aborted: true };
    await assert.rejects(
      withUploadRetry(async () => { calls++; throw new TypeError('NetworkError when attempting to fetch resource.'); }, { baseMs: 1, signal }),
      { name: 'TypeError' },
    );
    assert.equal(calls, 1, 'aborted upload must not keep retrying');
  });
});
