#!/usr/bin/env node
// Algorithmic microbenchmarks for UploadQueue hotspots.
// No browser, no servers. Run: node perf/bench-algorithms.mjs
// Override defaults: BENCH_N=7000 BENCH_ITERS=200 node perf/bench-algorithms.mjs

import { performance } from 'perf_hooks';

const N     = parseInt(process.env.BENCH_N     ?? '7000', 10);
const ITERS = parseInt(process.env.BENCH_ITERS ?? '200',  10);

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    status: i < 3 ? 'uploading' : 'queued',
    size: 1024,
    bytesUploaded: 0,
    speed: 0,
    eta: null,
  }));
}

function bench(label, fn, iters = ITERS) {
  for (let i = 0; i < 5; i++) fn(); // warmup
  const t = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const avg = (performance.now() - t) / iters;
  console.log(`  ${label.padEnd(40)} ${avg.toFixed(4).padStart(9)} ms/call`);
  return avg;
}

console.log(`\nBucketer algorithmic benchmarks  (N=${N}, ${ITERS} iterations each)\n`);
const results = {};

// ── Hotspot 1: updateItem ────────────────────────────────────────────────────
console.log('Hotspot 1 — updateItem: find-and-patch one item by id');
{
  const items = makeItems(N);
  const targetId = Math.floor(N / 2);

  results.h1_before = bench('array.map()  [BEFORE]', () => {
    items.map(it => it.id === targetId ? { ...it, status: 'done' } : it);
  });

  const map = new Map(items.map(it => [it.id, it]));
  results.h1_after = bench('Map.set()    [AFTER] ', () => {
    const next = new Map(map);
    next.set(targetId, { ...map.get(targetId), status: 'done' });
  });

  console.log(`  → speedup: ${(results.h1_before / results.h1_after).toFixed(1)}×\n`);
}

// ── Hotspot 2: BatchSummary filter passes ────────────────────────────────────
console.log('Hotspot 2 — BatchSummary: aggregate stats from items array');
{
  const items = makeItems(N);

  results.h2_before = bench('8× filter + 2× reduce [BEFORE]', () => {
    const doneItems     = items.filter(i => i.status === 'done');
    const abortedItems  = items.filter(i => i.status === 'aborted');
    const errorItems    = items.filter(i => i.status === 'error');
    const pausedItems   = items.filter(i => i.status === 'paused');
    const inFlightItems = items.filter(i => i.status === 'uploading' || i.status === 'resuming');
    const queuedCount   = items.filter(i => i.status === 'queued').length;
    const totalBytes    = items.reduce((s, i) => s + i.size, 0);
    const confirmedBytes = items.reduce((s, i) => s + (i.status === 'done' ? i.size : i.bytesUploaded), 0);
    void [doneItems, abortedItems, errorItems, pausedItems, inFlightItems, queuedCount, totalBytes, confirmedBytes];
  });

  // After: O(1) counter reads + one micro-filter over in-flight only (~3 items)
  let doneCount = 0, errorCount = 0, abortedCount = 0, pausedCount = 0;
  let queuedCount = N - 3, totalBytes = N * 1024, confirmedBytes = 0;
  const inFlightItems = items.slice(0, 3);

  results.h2_after = bench('counters + 1× filter  [AFTER] ', () => {
    const inFlight = inFlightItems.filter(i => i.status === 'uploading' || i.status === 'resuming');
    void [doneCount, errorCount, abortedCount, pausedCount, queuedCount, totalBytes, confirmedBytes, inFlight];
  });

  console.log(`  → speedup: ${(results.h2_before / results.h2_after).toFixed(1)}×\n`);
}

// ── Hotspot 5: drain detection ────────────────────────────────────────────────
console.log('Hotspot 5 — drain detection: any active items remaining?');
{
  const items = makeItems(N);

  results.h5_before = bench('items.some()    [BEFORE]', () => {
    items.some(i => i.status === 'uploading' || i.status === 'resuming' || i.status === 'queued');
  });

  let activeCount = 3;
  results.h5_after = bench('activeCount > 0 [AFTER] ', () => {
    void (activeCount > 0);
  });

  console.log(`  → speedup: ${(results.h5_before / results.h5_after).toFixed(1)}×\n`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('Summary');
console.log('  Hotspot 1 (updateItem):     ' + `${(results.h1_before / results.h1_after).toFixed(1)}× faster after fix`);
console.log('  Hotspot 2 (BatchSummary):   ' + `${(results.h2_before / results.h2_after).toFixed(1)}× faster after fix`);
console.log('  Hotspot 5 (drain detect):   ' + `${(results.h5_before / results.h5_after).toFixed(1)}× faster after fix`);
console.log('');
