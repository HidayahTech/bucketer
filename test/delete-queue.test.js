import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runDeleteOperation } from '../src/lib/delete-queue.js';

// ── Mock S3 client factory ────────────────────────────────────────────────────
//
// listPages: Map<prefix, pages[]> where each page is { keys, isTruncated, nextToken }
// deleteResults: array of { errors } returned in order per DeleteObjectsCommand call
//
// send() dispatches on command constructor name so no SDK module mocking is needed.

function mockClient({ listPages = new Map(), deleteResults = [] } = {}) {
  let deleteCallIndex = 0;
  return {
    send(cmd) {
      const name = cmd.constructor?.name ?? '';

      if (name === 'ListObjectsV2Command') {
        const { Prefix, ContinuationToken } = cmd.input;
        const pages = listPages.get(Prefix);
        if (!pages) return Promise.reject(new Error(`unexpected prefix: ${Prefix}`));
        const page = ContinuationToken
          ? pages.find(p => p.nextToken === ContinuationToken && pages.indexOf(p) > 0)
          : pages[0];
        if (!page) return Promise.reject(new Error(`no page for token: ${ContinuationToken}`));
        return Promise.resolve({
          Contents: page.keys.map(Key => ({ Key })),
          IsTruncated: page.isTruncated ?? false,
          NextContinuationToken: page.nextToken,
        });
      }

      if (name === 'DeleteObjectsCommand') {
        const result = deleteResults[deleteCallIndex++] ?? { errors: [] };
        if (result.networkError) return Promise.reject(result.networkError);
        return Promise.resolve({ Errors: result.errors });
      }

      return Promise.reject(new Error(`unexpected command: ${name}`));
    },
  };
}

// Collect all onProgress updates into an array for inspection.
async function runAndCollect(client, bucket, op) {
  const updates = [];
  await runDeleteOperation(client, bucket, op, u => updates.push({ ...u }));
  return updates;
}

// ── Files-only path ───────────────────────────────────────────────────────────

describe('runDeleteOperation — files only (no prefix discovery)', () => {
  test('skips discovery phase and goes directly to deleting', async () => {
    const client = mockClient({ deleteResults: [{ errors: [] }] });
    const op = { files: ['a.txt', 'b.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const phases = updates.filter(u => u.phase).map(u => u.phase);
    assert.ok(!phases.includes('discovering'), 'must not emit discovering phase for files-only op');
    assert.ok(phases.includes('deleting'), 'must emit deleting phase');
    assert.ok(phases.includes('done'), 'must emit done phase');
  });

  test('reports correct total and deleted count', async () => {
    const client = mockClient({ deleteResults: [{ errors: [] }] });
    const op = { files: ['a.txt', 'b.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const deleting = updates.find(u => u.phase === 'deleting');
    assert.equal(deleting.total, 2);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 2);
    assert.equal(done.errors.length, 0);
  });

  test('emits deletedKeys in incremental batch update', async () => {
    const client = mockClient({ deleteResults: [{ errors: [] }] });
    const op = { files: ['x.txt', 'y.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const batchUpdate = updates.find(u => u.deletedKeys);
    assert.ok(batchUpdate, 'must emit at least one update with deletedKeys');
    assert.deepEqual(batchUpdate.deletedKeys.sort(), ['x.txt', 'y.txt']);
  });

  test('empty files array completes immediately with 0 deleted', async () => {
    const client = mockClient();
    const op = { files: [], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.ok(done, 'must emit done');
    assert.equal(done.deleted, 0);
    assert.equal(done.errors.length, 0);
  });
});

// ── Prefix discovery ──────────────────────────────────────────────────────────

describe('runDeleteOperation — prefix discovery', () => {
  test('emits discovering phase before deleting', async () => {
    const listPages = new Map([['folder/', [{ keys: ['folder/a.txt'], isTruncated: false }]]]);
    const client = mockClient({ listPages, deleteResults: [{ errors: [] }] });
    const op = { files: [], prefixes: ['folder/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const phases = updates.filter(u => u.phase).map(u => u.phase);
    assert.deepEqual(phases, ['discovering', 'deleting', 'done']);
  });

  test('discovers and deletes keys inside a prefix', async () => {
    const listPages = new Map([['photos/', [{ keys: ['photos/a.jpg', 'photos/b.jpg'], isTruncated: false }]]]);
    const client = mockClient({ listPages, deleteResults: [{ errors: [] }] });
    const op = { files: [], prefixes: ['photos/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 2);
    assert.deepEqual(done.deletedPrefixes, ['photos/']);
  });

  test('paginates ListObjectsV2 across multiple pages', async () => {
    const listPages = new Map([['docs/', [
      { keys: ['docs/a.txt', 'docs/b.txt'], isTruncated: true, nextToken: 'tok1' },
      { keys: ['docs/c.txt'], isTruncated: false, nextToken: 'tok1' },
    ]]]);
    const client = mockClient({ listPages, deleteResults: [{ errors: [] }] });
    const op = { files: [], prefixes: ['docs/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 3, 'must collect all keys across both pages');
  });

  test('empty folder completes with 0 deleted and prefix in deletedPrefixes', async () => {
    const listPages = new Map([['empty/', [{ keys: [], isTruncated: false }]]]);
    const client = mockClient({ listPages });
    const op = { files: [], prefixes: ['empty/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 0);
    assert.deepEqual(done.deletedPrefixes, ['empty/']);
  });

  test('discovery failure emits done with error and stops immediately', async () => {
    const client = {
      send() { return Promise.reject(new Error('AccessDenied')); },
    };
    const op = { files: [], prefixes: ['secret/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.ok(done, 'must emit done even on discovery failure');
    assert.equal(done.deleted, 0);
    assert.equal(done.errors.length, 1);
    assert.equal(done.errors[0].key, '(listing)');
    assert.ok(done.errors[0].message.includes('AccessDenied'));
  });
});

// ── Mixed files + prefixes ────────────────────────────────────────────────────

describe('runDeleteOperation — mixed files and prefixes', () => {
  test('combines direct files with discovered prefix keys into one delete run', async () => {
    const listPages = new Map([['img/', [{ keys: ['img/a.png', 'img/b.png'], isTruncated: false }]]]);
    const client = mockClient({ listPages, deleteResults: [{ errors: [] }] });
    const op = { files: ['root.txt'], prefixes: ['img/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 3, 'must delete direct file + 2 prefix keys');
    assert.deepEqual(done.deletedPrefixes, ['img/']);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('runDeleteOperation — partial errors', () => {
  test('S3 per-key errors are reported and excluded from deleted count', async () => {
    const client = mockClient({
      deleteResults: [{ errors: [{ Key: 'b.txt', Code: 'AccessDenied', Message: 'Forbidden' }] }],
    });
    const op = { files: ['a.txt', 'b.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 1, 'only successfully deleted key should count');
    assert.equal(done.errors.length, 1);
    assert.equal(done.errors[0].key, 'b.txt');
  });

  test('prefix with partial errors is excluded from deletedPrefixes', async () => {
    const listPages = new Map([['folder/', [{ keys: ['folder/ok.txt', 'folder/fail.txt'], isTruncated: false }]]]);
    const client = mockClient({
      listPages,
      deleteResults: [{ errors: [{ Key: 'folder/fail.txt', Code: 'InternalError', Message: 'oops' }] }],
    });
    const op = { files: [], prefixes: ['folder/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deletedPrefixes.length, 0, 'prefix with a failed key must not appear in deletedPrefixes');
    assert.equal(done.errors.length, 1);
  });

  test('prefix where all keys succeed appears in deletedPrefixes', async () => {
    const listPages = new Map([['folder/', [{ keys: ['folder/a.txt', 'folder/b.txt'], isTruncated: false }]]]);
    const client = mockClient({ listPages, deleteResults: [{ errors: [] }] });
    const op = { files: [], prefixes: ['folder/'] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.deepEqual(done.deletedPrefixes, ['folder/']);
  });

  test('network error on DeleteObjectsCommand marks all batch keys as errors', async () => {
    const client = mockClient({
      deleteResults: [{ networkError: new Error('NetworkFailure') }],
    });
    const op = { files: ['a.txt', 'b.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 0);
    assert.equal(done.errors.length, 2, 'every key in a failed batch must produce an error entry');
    assert.ok(done.errors.every(e => e.message === 'NetworkFailure'));
  });
});

// ── Throttling retry ─────────────────────────────────────────────────────────
//
// sendBatchWithRetry uses real setTimeout for backoff. Tests replace
// global.setTimeout with a zero-delay shim so retries run immediately.

function withFastRetry(fn) {
  const real = global.setTimeout;
  global.setTimeout = (cb, _delay) => real(cb, 0);
  return fn().finally(() => { global.setTimeout = real; });
}

function throttleError(code = 'SlowDown') {
  const err = new Error(code);
  err.code = code;
  return err;
}

describe('runDeleteOperation — throttling retry', () => {
  test('retries on SlowDown and succeeds on the second attempt', () => withFastRetry(async () => {
    let calls = 0;
    const client = {
      send(cmd) {
        if (cmd.constructor?.name !== 'DeleteObjectsCommand') return Promise.reject(new Error('unexpected'));
        calls++;
        return calls === 1
          ? Promise.reject(throttleError('SlowDown'))
          : Promise.resolve({ Errors: [] });
      },
    };
    const op = { files: ['a.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    assert.equal(calls, 2, 'must retry exactly once before succeeding');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 1);
    assert.equal(done.errors.length, 0);
  }));

  test('retries on 503 httpStatusCode', () => withFastRetry(async () => {
    let calls = 0;
    const client = {
      send(cmd) {
        if (cmd.constructor?.name !== 'DeleteObjectsCommand') return Promise.reject(new Error('unexpected'));
        calls++;
        if (calls === 1) {
          const err = new Error('ServiceUnavailable');
          err.$metadata = { httpStatusCode: 503 };
          return Promise.reject(err);
        }
        return Promise.resolve({ Errors: [] });
      },
    };
    const op = { files: ['a.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    assert.equal(calls, 2);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 1);
  }));

  test('retries on 429 httpStatusCode', () => withFastRetry(async () => {
    let calls = 0;
    const client = {
      send(cmd) {
        if (cmd.constructor?.name !== 'DeleteObjectsCommand') return Promise.reject(new Error('unexpected'));
        calls++;
        if (calls === 1) {
          const err = new Error('TooManyRequests');
          err.$metadata = { httpStatusCode: 429 };
          return Promise.reject(err);
        }
        return Promise.resolve({ Errors: [] });
      },
    };
    const op = { files: ['a.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    assert.equal(calls, 2);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 1);
  }));

  test('does not retry on non-throttling errors', () => withFastRetry(async () => {
    let calls = 0;
    const client = {
      send(cmd) {
        if (cmd.constructor?.name !== 'DeleteObjectsCommand') return Promise.reject(new Error('unexpected'));
        calls++;
        return Promise.reject(new Error('AccessDenied'));
      },
    };
    const op = { files: ['a.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    assert.equal(calls, 1, 'must not retry on a non-throttling error');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.errors.length, 1);
    assert.equal(done.errors[0].message, 'AccessDenied');
  }));

  test('gives up after MAX_RETRIES and reports error', () => withFastRetry(async () => {
    let calls = 0;
    const client = {
      send(cmd) {
        if (cmd.constructor?.name !== 'DeleteObjectsCommand') return Promise.reject(new Error('unexpected'));
        calls++;
        return Promise.reject(throttleError('SlowDown'));
      },
    };
    const op = { files: ['a.txt', 'b.txt'], prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    assert.equal(calls, 5, 'must try 1 initial + 4 retries = 5 total');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 0);
    assert.equal(done.errors.length, 2, 'all keys in the exhausted batch must be reported as errors');
  }));
});

// ── Batch chunking ────────────────────────────────────────────────────────────

describe('runDeleteOperation — batch chunking', () => {
  test('splits more than 1000 keys into multiple DeleteObjectsCommand calls', async () => {
    let deleteCallCount = 0;
    const client = {
      send(cmd) {
        const name = cmd.constructor?.name ?? '';
        if (name === 'DeleteObjectsCommand') {
          deleteCallCount++;
          return Promise.resolve({ Errors: [] });
        }
        return Promise.reject(new Error(`unexpected: ${name}`));
      },
    };
    const files = Array.from({ length: 1500 }, (_, i) => `file-${i}.txt`);
    const op = { files, prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    assert.ok(deleteCallCount >= 2, `expected at least 2 batch calls, got ${deleteCallCount}`);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.deleted, 1500);
  });

  test('incremental deletedKeys updates accumulate before done', async () => {
    let deleteCallCount = 0;
    const client = {
      send(cmd) {
        const name = cmd.constructor?.name ?? '';
        if (name === 'DeleteObjectsCommand') {
          deleteCallCount++;
          return Promise.resolve({ Errors: [] });
        }
        return Promise.reject(new Error(`unexpected: ${name}`));
      },
    };
    const files = Array.from({ length: 1500 }, (_, i) => `file-${i}.txt`);
    const op = { files, prefixes: [] };
    const updates = await runAndCollect(client, 'my-bucket', op);

    const batchUpdates = updates.filter(u => u.deletedKeys);
    const totalIncremental = batchUpdates.reduce((sum, u) => sum + u.deletedKeys.length, 0);
    assert.equal(totalIncremental, 1500, 'all keys must appear in incremental deletedKeys updates');
  });
});
