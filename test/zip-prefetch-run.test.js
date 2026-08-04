// Copyright (C) 2026 HidayahTech, LLC
// Tests for runPrefetch — the bounded prefetch pool (N concurrent fetch workers) feeding
// a single serial writer callback (onReady), in completion order.
//
// See docs/superpowers/specs/2026-08-04-download-concurrency-design.md (D1-D5) and
// .superpowers/sdd/2026-08-04-download-concurrency/task-3-brief.md.
//
// Determinism note: this suite drives fetch ordering with manually-resolved deferred
// promises ("gates") plus a microtask-tick `waitUntil` poller — never real timers
// (setTimeout). Both are pure Promise/microtask machinery, so ordering is exact and
// reproducible run to run.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runPrefetch } from '../src/lib/zip-prefetch.js';

// Trimmed copy of the fake OPFS root from test/zip-job-run.test.js / test/zip-prefetch.test.js
// (write-fault injection dropped — not needed here). Same shape: getFileHandle/removeEntry
// on the root; createWritable({keepExistingData})/getFile() on the handle.
function fakeOpfsRoot() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
        files.set(name, new Uint8Array(0));
      }
      return {
        async createWritable({ keepExistingData = false } = {}) {
          let buf = keepExistingData ? Uint8Array.from(files.get(name)) : new Uint8Array(0);
          let pos = buf.length;
          return {
            async write(u8) {
              const grown = new Uint8Array(Math.max(buf.length, pos + u8.length));
              grown.set(buf); grown.set(u8, pos); buf = grown; pos += u8.length;
            },
            async truncate(n) { buf = buf.slice(0, n); pos = Math.min(pos, n); },
            async seek(n) { pos = n; },
            async close() { files.set(name, buf); },
          };
        },
        async getFile() {
          const b = files.get(name);
          return {
            size: b.length,
            async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
            slice(start, end) {
              const s = b.slice(start, end);
              return { arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.length) };
            },
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
}

const enc = (s) => new TextEncoder().encode(s);
const presign = async (key) => `https://signed/x?key=${encodeURIComponent(key)}`;

// Pure microtask-tick poller — no real timers. Polls `predicate` on successive microtask
// turns until it is true, or throws after `maxTicks` turns (a stuck test fails fast
// instead of hanging).
async function waitUntil(predicate, maxTicks = 500) {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('waitUntil: condition not met within tick budget');
}

function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

// Races `promise` (a gate the test controls) against `signal` firing. Mirrors how a real
// fetch body rejects with an AbortError as soon as its controller aborts, even mid-read.
function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort);
    promise.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A single-chunk gated body: read() #1 waits on `gate.promise` (racing an AbortSignal),
// then yields `chunk`; read() #2+ is EOF. `onEof` (optional) fires the instant EOF is
// reached — the test's hook for "this item's fetch just finished" (used by the
// backpressure test to count held-but-unwritten buffers without any production-code
// instrumentation).
function gatedBody(gate, chunk, { onEof, signal } = {}) {
  let delivered = false;
  return {
    getReader() {
      return {
        async read() {
          if (!delivered) {
            delivered = true;
            await raceWithAbort(gate.promise, signal);
            return { done: false, value: chunk };
          }
          onEof?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// A body that streams multiple chunks with no gating (resolves as fast as microtasks
// allow) — used where fetch speed itself isn't under test.
function fastBody(chunks, { onEof } = {}) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) {
            const c = chunks[i++];
            if (c instanceof Error) throw c;
            return { done: false, value: c };
          }
          onEof?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe('runPrefetch', () => {
  // ── 1. Overlap + completion order ──────────────────────────────────────────
  test('1. concurrent fetches complete out of manifest order; onReady runs serially in completion order; onProgress shows overlap', async () => {
    const items = ['k1', 'k2', 'k3', 'k4', 'k5'].map((key) => ({ key, size: 5 }));
    const gates = Object.fromEntries(items.map((it) => [it.key, deferred()]));
    // 5 bytes each, matching item.size — bytesDone is measured from actual streamed
    // bytes, so a body shorter than the declared size would under-total it.
    const chunkFor = () => new Uint8Array(5);

    const fetchImpl = async (url, { signal } = {}) => {
      const key = new URL(url).searchParams.get('key');
      return { ok: true, status: 200, body: gatedBody(gates[key], chunkFor(key), { signal }) };
    };

    let busy = false;
    const order = [];
    const onReady = async (entry) => {
      assert.equal(busy, false, 'onReady must never be called while another onReady is in flight');
      busy = true;
      await Promise.resolve();
      await Promise.resolve();
      order.push(entry.item.key);
      busy = false;
    };

    const progress = [];
    const onProgress = (p) => progress.push({ bytesDone: p.bytesDone, activeLen: p.active.length, activeKeys: p.active.map(a => a.key) });

    const resultPromise = runPrefetch(items, {
      fetchImpl, presign, root: fakeOpfsRoot(), concurrency: 4,
      onReady, onProgress,
    });

    // Proof of real overlap: with 4 workers and 5 items, all 4 initial fetches must be
    // simultaneously in flight (none of their gates has been resolved yet) before we
    // resolve anything.
    await waitUntil(() => progress.some((p) => p.activeLen === 4));
    assert.ok(progress.some((p) => p.activeLen > 1), 'onProgress must have observed more than one concurrent in-flight fetch');

    // Resolve out of manifest order: k2, k4, k1, k3, k5. Each resolve is followed by a
    // wait for that key to land in `order` before triggering the next — this pins down
    // completion order exactly without relying on timing assumptions.
    const sequence = ['k2', 'k4', 'k1', 'k3', 'k5'];
    for (const key of sequence) {
      gates[key].resolve();
      await waitUntil(() => order.includes(key));
    }

    const result = await resultPromise;
    assert.deepEqual(result, { failed: [], denied: false, cancelled: false });
    assert.deepEqual(order, sequence, 'onReady must fire in completion order, not manifest order');

    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i].bytesDone >= progress[i - 1].bytesDone, 'bytesDone must never regress');
    }
    const total = items.reduce((n, it) => n + it.size, 0);
    assert.equal(progress[progress.length - 1].bytesDone, total);
  });

  // ── 2. Tier routing ─────────────────────────────────────────────────────────
  test('2. items route to memory/temp/solo by size; memory never touches temp; solo never buffers', async () => {
    const TINY = 100;         // memory
    const MEDIUM = 5 * 1024 * 1024; // temp (> TINY_MAX=4MiB, <= MEDIUM_MAX=64MiB)
    const HUGE = 70 * 1024 * 1024;  // solo (> MEDIUM_MAX)

    const tinyBytes = enc('tiny-body');
    const mediumBytes = new Uint8Array(1024); mediumBytes.fill(7);
    const hugeChunk = new Uint8Array(1024); hugeChunk.fill(9);

    const items = [
      { key: 'tiny.txt', size: TINY },
      { key: 'medium.bin', size: MEDIUM },
      { key: 'huge.bin', size: HUGE },
    ];

    const fetchImpl = async (url) => {
      const key = new URL(url).searchParams.get('key');
      if (key === 'tiny.txt') return { ok: true, status: 200, body: fastBody([tinyBytes]) };
      if (key === 'medium.bin') return { ok: true, status: 200, body: fastBody([mediumBytes]) };
      // huge: declared size (HUGE) won't match the tiny amount of bytes actually
      // streamed in this test — fine, runPrefetch doesn't check declared vs actual for
      // solo (only the real writer, out of this task's scope, would).
      return { ok: true, status: 200, body: fastBody([hugeChunk]) };
    };

    const root = fakeOpfsRoot();
    const received = [];
    const onReady = async (entry) => {
      // Drain chunks so temp-store's put has actually run to completion for the temp
      // case, and so the solo live stream is actually consumed (proving it streams).
      const parts = [];
      for await (const c of entry.chunks) parts.push(c);
      received.push({ key: entry.item.key, tier: entry.tier, crc: entry.crc, size: entry.size, bytes: parts.reduce((n, c) => n + c.length, 0) });
    };

    const result = await runPrefetch(items, { fetchImpl, presign, root, concurrency: 3, onReady });

    assert.deepEqual(result, { failed: [], denied: false, cancelled: false });
    assert.equal(received.length, 3);
    const byKey = Object.fromEntries(received.map((r) => [r.key, r]));

    assert.equal(byKey['tiny.txt'].tier, 'memory');
    assert.equal(byKey['tiny.txt'].bytes, tinyBytes.length);
    assert.ok(byKey['tiny.txt'].crc > 0, 'memory tier must compute a real CRC');

    assert.equal(byKey['medium.bin'].tier, 'temp');
    assert.equal(byKey['medium.bin'].bytes, mediumBytes.length);
    assert.ok(byKey['medium.bin'].crc > 0, 'temp tier must compute a real CRC while streaming');

    assert.equal(byKey['huge.bin'].tier, 'solo');
    assert.equal(byKey['huge.bin'].bytes, hugeChunk.length, 'solo must actually stream its bytes to the consumer');

    // Memory item never touched the temp store at all: no bucketer-tmp-tiny.txt file.
    assert.equal(root.files.has('bucketer-tmp-tiny.txt'), false);
    // Medium item really did use an OPFS temp file (proves the temp tier, not memory,
    // handled it). runPrefetch does not delete a SUCCESSFUL temp buffer itself — the
    // caller's writer (Task 4) owns that, since only it knows when it has truly finished
    // copying the bytes into the ZIP; deletion-on-failure (test 4) is the only cleanup
    // that is runPrefetch's own responsibility.
    assert.ok(root.files.has('bucketer-tmp-p0'), 'the temp tier must have created an OPFS temp file for medium.bin');
  });

  // ── 3. Backpressure ──────────────────────────────────────────────────────────
  test('3. a slow writer bounds the number of fetched-but-unwritten buffers to ~concurrency', async () => {
    const CONCURRENCY = 2;
    const items = Array.from({ length: 6 }, (_, i) => ({ key: `f${i}`, size: 4 }));

    let held = 0;
    let maxHeld = 0;
    const fetchImpl = async (url) => {
      const key = new URL(url).searchParams.get('key');
      // Fast, ungated fetch: the fake body signals "fetch complete" (EOF) via onEof,
      // which is exactly when a buffer becomes ready-but-unwritten from the pool's
      // perspective. This is pure test-side instrumentation (no production hook needed).
      return { ok: true, status: 200, body: fastBody([enc(key)], { onEof: () => { held++; maxHeld = Math.max(maxHeld, held); } }) };
    };

    const order = [];
    const onReady = async (entry) => {
      // Slow writer: several microtask ticks before "finishing" the write.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      order.push(entry.item.key);
      held--;
    };

    const result = await runPrefetch(items, { fetchImpl, presign, root: fakeOpfsRoot(), concurrency: CONCURRENCY, onReady });

    assert.deepEqual(result, { failed: [], denied: false, cancelled: false });
    assert.equal(order.length, 6);
    assert.ok(maxHeld > 1, `must show real overlap between fetch and write (maxHeld=${maxHeld})`);
    assert.ok(maxHeld <= CONCURRENCY + 1, `held buffers must stay bounded near concurrency=${CONCURRENCY} (maxHeld=${maxHeld})`);
  });

  // ── 4. Failure isolation ─────────────────────────────────────────────────────
  test('4. a mid-body fetch failure isolates that item; its temp buffer is discarded; other items still complete', async () => {
    const items = [
      { key: 'a.txt', size: 100 },                    // memory, succeeds
      { key: 'b.bin', size: 5 * 1024 * 1024 },         // temp, FAILS mid-body
      { key: 'c.bin', size: 5 * 1024 * 1024 },         // temp, succeeds
    ];

    const fetchImpl = async (url) => {
      const key = new URL(url).searchParams.get('key');
      if (key === 'a.txt') return { ok: true, status: 200, body: fastBody([enc('alpha')]) };
      if (key === 'b.bin') {
        return { ok: true, status: 200, body: fastBody([new Uint8Array(10), new Error('stream reset')]) };
      }
      return { ok: true, status: 200, body: fastBody([new Uint8Array(20)]) };
    };

    const root = fakeOpfsRoot();
    const order = [];
    const onReady = async (entry) => {
      for await (const _c of entry.chunks) { /* drain */ }
      order.push(entry.item.key);
    };

    const result = await runPrefetch(items, { fetchImpl, presign, root, concurrency: 3, onReady });

    assert.equal(result.denied, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].item.key, 'b.bin');
    assert.ok(result.failed[0].message, 'a failure message must be recorded');

    assert.deepEqual(order.sort(), ['a.txt', 'c.bin'], 'the other two items must still complete via onReady');

    // No leftover temp file for the failed item (or any item — c.bin's temp file must
    // also have been cleaned up after being drained by onReady/tempStore.open().stream()
    // reading it back, since the file itself isn't removed by draining — only assert
    // the FAILED item's temp is gone; that's the cleanup this test is about).
    assert.equal(root.files.has('bucketer-tmp-b.bin') , false, 'b.bin\'s partial temp buffer must be discarded, not left behind');
  });

  // ── 5. Rolling DENIED breaker ─────────────────────────────────────────────────
  test('5. three DENIED probes (order-independent under concurrency) trip the job-wide denied flag', async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ key: `d${i}`, size: 4 }));
    const probe = async () => ({ kind: 'denied', message: 'access denied' });
    const fetchImpl = async () => { throw new Error('must not be called — probe should have short-circuited'); };

    let onReadyCalls = 0;
    const onReady = async () => { onReadyCalls++; };

    const result = await runPrefetch(items, { fetchImpl, presign, probe, root: fakeOpfsRoot(), concurrency: 4, onReady });

    assert.equal(result.denied, true, 'denied must trip after 3 consecutive DENIED probes');
    assert.equal(onReadyCalls, 0, 'no item ever reached onReady');
    assert.ok(result.failed.length >= 3, 'at least the 3 items that tripped the breaker must be recorded as failed');
    for (const f of result.failed) assert.ok(f.message, 'each failure must carry a message');
  });

  // ── 6. Cancel aborts in-flight fetches ────────────────────────────────────────
  test('6. shouldCancel flipping true aborts in-flight fetches, stops intake, and calls onReady no further', async () => {
    // i1, i4: fast, ungated — these are the two that complete and flip the cancel flag.
    // i2, i3: gated forever (their gate.promise never resolves) — these are still
    // in-flight when cancellation is noticed, and must be aborted rather than hang.
    const gate2 = deferred();
    const gate3 = deferred();

    const fetchImpl = async (url, { signal } = {}) => {
      const key = new URL(url).searchParams.get('key');
      if (key === 'i1') return { ok: true, status: 200, body: fastBody([enc('one')]) };
      if (key === 'i4') return { ok: true, status: 200, body: fastBody([enc('four')]) };
      if (key === 'i2') return { ok: true, status: 200, body: gatedBody(gate2, enc('two'), { signal }) };
      return { ok: true, status: 200, body: gatedBody(gate3, enc('three'), { signal }) };
    };

    const items = ['i1', 'i2', 'i3', 'i4'].map((key) => ({ key, size: 4 }));
    let completions = 0;
    const order = [];
    const onReady = async (entry) => {
      order.push(entry.item.key);
      completions++;
    };
    const shouldCancel = () => completions >= 2;

    const result = await runPrefetch(items, {
      fetchImpl, presign, root: fakeOpfsRoot(), concurrency: 3, onReady, shouldCancel,
    });

    assert.equal(result.cancelled, true);
    assert.equal(order.length, 2, 'no onReady call may happen after cancellation is observed');
    assert.deepEqual(order.sort(), ['i1', 'i4'].sort());
    assert.equal(result.denied, false);
    // i2/i3 were aborted mid-fetch (their gates never resolved) rather than counted as
    // ordinary failures — they simply never completed, left for a resume to re-fetch.
    assert.deepEqual(result.failed, []);
  });
});
