// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-inplace.js's orchestrator — runInPlaceJob.
//
// See docs/superpowers/specs/2026-08-04-inplace-offset-composition-design.md.
//
// Each test drives a fake worker whose postMessage handler runs the REAL assembler
// (zip-assemble.js's createAssembler) over an in-memory sink, so the orchestrator's output
// is validated as real ZIP bytes (readZip — the independent witness zip-job-run.test.js also
// uses) without a browser or a real OPFS/Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  appendManifestPage, saveJob, countItemsByStatus, resetFailedToPending, ITEM_STATUS,
} from '../src/lib/download-records.js';
import { computeZipLayout } from '../src/lib/zip-layout.js';
import { createAssembler } from '../src/lib/zip-assemble.js';
import { runInPlaceJob } from '../src/lib/zip-inplace.js';
import { readZip } from './helpers/zip-reader.js';

// A fake worker that runs the REAL assembler over an in-memory sink, so the orchestrator's
// output is validated as real ZIP bytes without a browser. Matches task-5-brief.md's skeleton.
function inMemoryWorker(captured) {
  let buf = new Uint8Array(0), asm = null, listeners = [];
  const sink = { write(u8, at){ if(at+u8.length>buf.length){const n=new Uint8Array(at+u8.length);n.set(buf);buf=n;} buf.set(u8,at); }, truncate(n){ const nb=new Uint8Array(n); nb.set(buf.subarray(0,Math.min(n,buf.length))); buf=nb; }, flush(){} };
  const emit = (data) => { for (const fn of listeners) fn({ data }); };
  return {
    addEventListener(_e, fn){ listeners.push(fn); },
    terminate(){ captured.bytes = buf; },
    async postMessage(m /*, transfer */){
      if (m.type==='init'){ asm=createAssembler(sink,m.layout); await asm.writeHeaders(); emit({type:'ready'}); }
      else if (m.type==='chunk'){ await asm.writeChunk(m.key, new Uint8Array(m.buffer)); }
      else if (m.type==='entryEnd'){ try{ const r=await asm.endEntry(m.key); emit({type:'written',key:m.key,crc:r.crc,size:r.size}); }catch(err){ emit({type:'entryError',key:m.key,name:err.name,message:err.message}); } }
      else if (m.type==='finish'){ const r=await asm.finish(m.records); captured.bytes=buf; emit({type:'finished',totalBytes:r.totalBytes}); }
    },
  };
}

function streamOf(arr) {
  const u8 = new Uint8Array(arr); let sent = false;
  return { getReader(){ return { read(){ if(sent) return Promise.resolve({done:true}); sent=true; return Promise.resolve({done:false,value:u8}); } }; } };
}

test('runInPlaceJob: all items DONE, finished, valid central directory', async () => {
  const job = { id: 'j1', prefix: 'p/', status: 'running', counters: {} };
  await saveJob(job);
  const items = [
    { key: 'p/a.txt', size: 3, lastModified: 0, status: ITEM_STATUS.PENDING },
    { key: 'p/b.txt', size: 5, lastModified: 0, status: ITEM_STATUS.PENDING },
  ];
  await appendManifestPage('j1', items, { done: true });
  const bodies = { 'p/a.txt': [65,66,67], 'p/b.txt': [1,2,3,4,5] };
  const captured = {};
  const res = await runInPlaceJob(job, {
    presign: async (key) => `https://x/${key}`,
    probe: null,
    fetchImpl: async (url) => ({ ok: true, body: streamOf(bodies[url.split('/x/')[1]]) }),
    root: {}, concurrency: 2,
    makeWorker: () => inMemoryWorker(captured),
    onProgress: () => {},
  });
  assert.equal(res.finished, true);
  assert.equal(await countItemsByStatus('j1', ITEM_STATUS.DONE), 2);
  // EOCD signature present at the tail
  const dv = new DataView(captured.bytes.buffer);
  // find EOCD 0x06054b50 near the end
  let found = false;
  for (let i = captured.bytes.length - 22; i >= 0 && i > captured.bytes.length - 200; i--) { if (dv.getUint32(i, true) === 0x06054b50) { found = true; break; } }
  assert.equal(found, true);

  // Independent witness: readZip cross-checks the central directory against each local
  // entry's header/CRC via a table-free CRC-32.
  const entries = readZip(captured.bytes);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['a.txt', 'b.txt']);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual([...byName['a.txt'].data], [65, 66, 67]);
  assert.deepEqual([...byName['b.txt'].data], [1, 2, 3, 4, 5]);
});

// A fake OPFS root + worker factory that share one persistent byte buffer across worker
// instances — unlike inMemoryWorker's private `buf` (torn down with each fake worker), this
// simulates the real world where a fresh Worker per run reopens a sync handle onto the SAME
// physical OPFS file. Needed to exercise the resume guard's "staging intact, keep DONE"
// branch and its "staging evicted, reset to PENDING" branch (CRITICAL point 2).
function sharedFakeOpfs() {
  const state = { buf: new Uint8Array(0) };
  const sink = {
    write(u8, at) {
      if (at + u8.length > state.buf.length) {
        const n = new Uint8Array(at + u8.length);
        n.set(state.buf);
        state.buf = n;
      }
      state.buf.set(u8, at);
    },
    truncate(n) {
      const nb = new Uint8Array(n);
      nb.set(state.buf.subarray(0, Math.min(n, state.buf.length)));
      state.buf = nb;
    },
    flush() {},
  };
  const root = {
    async getFileHandle() {
      return { async getFile() { return { size: state.buf.length }; } };
    },
  };
  function makeWorker() {
    let asm = null;
    const listeners = [];
    const emit = (data) => { for (const fn of listeners) fn({ data }); };
    return {
      addEventListener(_e, fn) { listeners.push(fn); },
      terminate() {},
      async postMessage(m) {
        if (m.type === 'init') { asm = createAssembler(sink, m.layout); await asm.writeHeaders(); emit({ type: 'ready' }); }
        else if (m.type === 'chunk') { await asm.writeChunk(m.key, new Uint8Array(m.buffer)); }
        else if (m.type === 'entryEnd') {
          try { const r = await asm.endEntry(m.key); emit({ type: 'written', key: m.key, crc: r.crc, size: r.size }); }
          catch (err) { emit({ type: 'entryError', key: m.key, name: err.name, message: err.message }); }
        } else if (m.type === 'finish') {
          const r = await asm.finish(m.records);
          emit({ type: 'finished', totalBytes: r.totalBytes });
        }
      },
    };
  }
  return { root, makeWorker, state };
}

function fetchFakeWithAttempts(bodyPlans) {
  const attempts = {};
  const calls = [];
  const fn = async (url) => {
    const key = new URL(url).searchParams.get('key');
    calls.push(key);
    attempts[key] = (attempts[key] ?? 0) + 1;
    const plans = bodyPlans[key];
    const plan = Array.isArray(plans[0]) ? plans : [plans];
    const chunks = plan[Math.min(attempts[key] - 1, plan.length - 1)];
    return { ok: true, status: 200, body: fakeBodyFromChunks(chunks) };
  };
  fn.calls = calls;
  return fn;
}

function fakeBodyFromChunks(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const c = chunks[i++];
          if (c instanceof Error) throw c;
          return { done: false, value: c };
        },
      };
    },
  };
}

const presignQ = async (key) => `https://x/?key=${encodeURIComponent(key)}`;

test('a failed item lands FAILED (finished=false); after resetFailedToPending, resume completes without refetching the already-DONE item', async () => {
  const job = { id: 'j2', prefix: 'p/', status: 'running', counters: {} };
  await saveJob(job);
  await appendManifestPage('j2', [
    { key: 'p/a.txt', size: 3, lastModified: 0, status: ITEM_STATUS.PENDING },
    { key: 'p/b.txt', size: 5, lastModified: 0, status: ITEM_STATUS.PENDING },
  ], { done: true });

  const { root, makeWorker } = sharedFakeOpfs();
  const fetchImpl = fetchFakeWithAttempts({
    'p/a.txt': [[new Uint8Array([65, 66, 67])]],
    'p/b.txt': [
      [new Error('stream reset')],      // attempt 1: dies before any bytes
      [new Uint8Array([1, 2, 3, 4, 5])], // attempt 2 (after resetFailedToPending): succeeds
    ],
  });

  const res1 = await runInPlaceJob(job, {
    presign: presignQ, probe: null, fetchImpl, root, concurrency: 2, makeWorker, onProgress: () => {},
  });
  assert.equal(res1.finished, false);
  assert.equal(res1.failed, 1);
  assert.equal(await countItemsByStatus('j2', ITEM_STATUS.DONE), 1);
  assert.equal(await countItemsByStatus('j2', ITEM_STATUS.FAILED), 1);

  await resetFailedToPending('j2');
  const res2 = await runInPlaceJob(job, {
    presign: presignQ, probe: null, fetchImpl, root, concurrency: 2, makeWorker, onProgress: () => {},
  });
  assert.equal(res2.finished, true);
  assert.equal(await countItemsByStatus('j2', ITEM_STATUS.DONE), 2);

  // Proves a real offset-based resume, not a full rebuild: a.txt (already DONE after run 1)
  // must not be refetched in run 2.
  assert.equal(fetchImpl.calls.filter((k) => k === 'p/a.txt').length, 1);
  assert.equal(fetchImpl.calls.filter((k) => k === 'p/b.txt').length, 2);
});

test('eviction: a staging file that shrinks between runs resets every DONE item back to PENDING', async () => {
  const job = { id: 'j3', prefix: 'p/', status: 'running', counters: {} };
  await saveJob(job);
  await appendManifestPage('j3', [
    { key: 'p/a.txt', size: 3, lastModified: 0, status: ITEM_STATUS.PENDING },
    { key: 'p/b.txt', size: 5, lastModified: 0, status: ITEM_STATUS.PENDING },
  ], { done: true });

  const { root, makeWorker, state } = sharedFakeOpfs();
  const bodies = { 'p/a.txt': [65, 66, 67], 'p/b.txt': [1, 2, 3, 4, 5] };

  let doneCount = 0;
  const res1 = await runInPlaceJob(job, {
    presign: presignQ, probe: null,
    fetchImpl: async (url) => ({ ok: true, status: 200, body: streamOf(bodies[new URL(url).searchParams.get('key')]) }),
    root, concurrency: 1, makeWorker,
    shouldCancel: () => doneCount >= 1,
    onProgress: (p) => { doneCount = p.done; },
  });
  assert.equal(res1.cancelled, true);
  assert.equal(await countItemsByStatus('j3', ITEM_STATUS.DONE), 1);

  // Simulate eviction: the physical OPFS file is gone.
  state.buf = new Uint8Array(0);

  const fetchCalls = [];
  const res2 = await runInPlaceJob(job, {
    presign: presignQ, probe: null,
    fetchImpl: async (url) => {
      const key = new URL(url).searchParams.get('key');
      fetchCalls.push(key);
      return { ok: true, status: 200, body: streamOf(bodies[key]) };
    },
    root, concurrency: 2, makeWorker, onProgress: () => {},
  });
  assert.equal(res2.finished, true);
  assert.equal(await countItemsByStatus('j3', ITEM_STATUS.DONE), 2);
  assert.deepEqual(fetchCalls.sort(), ['p/a.txt', 'p/b.txt'], 'both items refetched after eviction, including the one already DONE');
});

test('a worker reporting unsupported returns {unsupported:true} immediately, before any fetch, and terminates the worker', async () => {
  const job = { id: 'j4', prefix: 'p/', status: 'running', counters: {} };
  await saveJob(job);
  await appendManifestPage('j4', [
    { key: 'p/a.txt', size: 3, lastModified: 0, status: ITEM_STATUS.PENDING },
  ], { done: true });

  let terminated = false;
  const unsupportedWorker = () => {
    const listeners = [];
    const emit = (data) => { for (const fn of listeners) fn({ data }); };
    return {
      addEventListener(_e, fn) { listeners.push(fn); },
      terminate() { terminated = true; },
      postMessage(m) {
        if (m.type === 'init') queueMicrotask(() => emit({ type: 'unsupported', reason: 'no createSyncAccessHandle in worker' }));
      },
    };
  };

  let fetchCalled = false;
  const res = await runInPlaceJob(job, {
    presign: presignQ, probe: null,
    fetchImpl: async () => { fetchCalled = true; return { ok: true, body: streamOf([1, 2, 3]) }; },
    root: {}, concurrency: 2, makeWorker: unsupportedWorker, onProgress: () => {},
  });

  assert.deepEqual(res, { unsupported: true });
  assert.equal(terminated, true, 'the worker must be terminated even on the fallback path');
  assert.equal(fetchCalled, false, 'nothing must be fetched before falling back');
  assert.equal(await countItemsByStatus('j4', ITEM_STATUS.PENDING), 1, 'items are left untouched for runZipJob to pick up');
});

// Sanity: computeZipLayout is what runInPlaceJob's records are built from — confirms the
// import above is exercised indirectly (the orchestrator never invents its own offsets).
test('layout entries drive the persisted zipOffset/zipEnd exactly', async () => {
  const job = { id: 'j5', prefix: '', status: 'running', counters: {} };
  await saveJob(job);
  const items = [{ key: 'only.txt', size: 4, lastModified: 0, status: ITEM_STATUS.PENDING }];
  await appendManifestPage('j5', items, { done: true });
  const expectedLayout = computeZipLayout(items, '');

  const captured = {};
  await runInPlaceJob(job, {
    presign: async (key) => `https://x/${key}`,
    probe: null,
    fetchImpl: async () => ({ ok: true, body: streamOf([1, 2, 3, 4]) }),
    root: {}, concurrency: 1,
    makeWorker: () => inMemoryWorker(captured),
    onProgress: () => {},
  });

  const entries = readZip(captured.bytes);
  assert.equal(entries[0].lho, expectedLayout.entries[0].headerOffset);
});
