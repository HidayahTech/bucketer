import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UploadQueue, uploadPartsWithPool } from '../src/lib/upload-queue.js';

// Helper: a task that resolves after `ms` milliseconds
function delayed(ms, value) {
  return () => new Promise(resolve => setTimeout(() => resolve(value), ms));
}

// Helper: a task that rejects after `ms` milliseconds
function failing(ms) {
  return () => new Promise((_, reject) => setTimeout(() => reject(new Error('fail')), ms));
}

describe('UploadQueue concurrency', () => {
  test('runs up to concurrency limit simultaneously', async () => {
    const q = new UploadQueue(2);
    let running = 0;
    let peak = 0;

    // Each task increments running, records the peak, then holds for 20ms
    const task = () => new Promise(resolve => {
      running++;
      peak = Math.max(peak, running);
      setTimeout(() => { running--; resolve(); }, 20);
    });

    await Promise.all([q.enqueue(task), q.enqueue(task), q.enqueue(task)]);
    assert.equal(peak, 2, 'no more than 2 tasks should run simultaneously');
  });

  test('N=1 runs tasks serially', async () => {
    const q = new UploadQueue(1);
    const order = [];

    // With concurrency=1, tasks must complete in enqueue order
    await Promise.all([
      q.enqueue(() => new Promise(r => setTimeout(() => { order.push(1); r(); }, 20))),
      q.enqueue(async () => { order.push(2); }),
    ]);

    assert.deepEqual(order, [1, 2]);
  });

});

describe('UploadQueue clear()', () => {
  test('drops pending tasks without affecting the running one', async () => {
    const q = new UploadQueue(1);
    let pendingRan = 0;

    // Occupy the single slot with a slow task
    const running = q.enqueue(delayed(30));

    // Queue two more — they will be pending while the first runs
    q.enqueue(() => { pendingRan++; });
    q.enqueue(() => { pendingRan++; });

    q.clear();
    await running; // the running task completes normally

    assert.equal(pendingRan, 0, 'cleared tasks should never run');
  });

  test('queue accepts new tasks after clear()', async () => {
    const q = new UploadQueue(1);
    q.enqueue(delayed(30));
    q.clear();

    // After clear, a new task should run
    const result = await q.enqueue(delayed(5, 'new'));
    assert.equal(result, 'new');
  });
});

describe('UploadQueue error handling', () => {
  // BUG context: a rejected task must still free its slot so the queue drains.
  // Verified by the .finally() in _drain() — this test would catch a regression
  // if .finally() were changed to .then() which doesn't run on rejection.
  test('rejected task frees its slot', async () => {
    const q = new UploadQueue(1);
    let secondRan = false;

    const first = q.enqueue(failing(10));
    const second = q.enqueue(async () => { secondRan = true; });

    await first.catch(() => {}); // swallow the expected rejection
    await second;

    assert.equal(secondRan, true, 'second task must run after first rejects');
  });

  test('rejection propagates to the caller', async () => {
    const q = new UploadQueue(1);
    const err = new Error('upload failed');
    await assert.rejects(
      q.enqueue(() => Promise.reject(err)),
      { message: 'upload failed' }
    );
  });

  test('one failed task does not prevent subsequent tasks from running', async () => {
    const q = new UploadQueue(2);
    const results = [];

    await Promise.allSettled([
      q.enqueue(failing(5)),
      q.enqueue(async () => { results.push('b'); }),
      q.enqueue(async () => { results.push('c'); }),
    ]);

    assert.ok(results.includes('b'), 'b should run');
    assert.ok(results.includes('c'), 'c should run');
  });
});

// ── uploadPartsWithPool (T2-2) ────────────────────────────────────────────────
// Resume path must use the same worker-pool as fresh uploads. A serial for-loop
// runs 1 part at a time — ~4× slower than the configured PART_CONCURRENCY default.

describe('uploadPartsWithPool', () => {
  test('processes all parts exactly once', async () => {
    const processed = new Set();
    await uploadPartsWithPool([1, 2, 3, 4, 5], async (n) => {
      processed.add(n);
    }, 2);
    assert.deepEqual([...processed].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  test('respects concurrency limit — peak in-flight equals concurrency', async () => {
    let inFlight = 0;
    let peakInFlight = 0;

    await uploadPartsWithPool([1, 2, 3, 4, 5, 6, 7, 8], async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
    }, 3);

    assert.ok(peakInFlight > 1,
      `pool must upload more than 1 part at a time (was serial: peak=${peakInFlight})`);
    assert.ok(peakInFlight <= 3,
      `pool must not exceed concurrency=3 (peak=${peakInFlight})`);
  });

  test('concurrency=1 processes parts serially in order', async () => {
    const order = [];
    await uploadPartsWithPool([3, 1, 2], async (n) => { order.push(n); }, 1);
    assert.deepEqual(order, [3, 1, 2]);
  });

  test('propagates errors from workFn', async () => {
    await assert.rejects(
      uploadPartsWithPool([1], async () => { throw new Error('part failed'); }, 1),
      { message: 'part failed' }
    );
  });
});

describe('UploadQueue concurrency property', () => {
  test('concurrency can be changed between enqueues', async () => {
    const q = new UploadQueue(1);
    let peak = 0;
    let running = 0;

    // First batch at concurrency=1
    await q.enqueue(delayed(5));

    // Raise concurrency before next batch
    q.concurrency = 3;

    const task = () => new Promise(resolve => {
      running++;
      peak = Math.max(peak, running);
      setTimeout(() => { running--; resolve(); }, 20);
    });

    await Promise.all([q.enqueue(task), q.enqueue(task), q.enqueue(task)]);
    assert.equal(peak, 3, 'should allow 3 concurrent after raising concurrency');
  });
});
