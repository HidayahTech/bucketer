// test/assembler-client.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssemblerClient } from '../src/lib/assembler-client.js';

// A fake worker that echoes the protocol deterministically, auto-acking chunks so writeChunk
// (now awaitable, backpressure-gated) resolves without a test having to drive acks manually.
function fakeWorker() {
  const listeners = [];
  const w = {
    postMessage(msg) {
      queueMicrotask(() => {
        if (msg.type === 'init') emit({ type: 'ready' });
        else if (msg.type === 'chunk') emit({ type: 'ack', bytes: msg.buffer.byteLength });
        else if (msg.type === 'entryEnd') emit({ type: 'written', key: msg.key, crc: 123, size: 4 });
        else if (msg.type === 'finish') emit({ type: 'finished', totalBytes: 999 });
      });
    },
    addEventListener(_e, fn) { listeners.push(fn); },
    terminate() {},
  };
  function emit(data) { for (const fn of listeners) fn({ data }); }
  return { w, emit };
}

// A fake worker whose 'chunk' handling never auto-acks — the test drives acks manually via
// `emit` to exercise the credit-window backpressure path deterministically.
function controllableFakeWorker() {
  const listeners = [];
  const w = {
    postMessage(msg) {
      queueMicrotask(() => {
        if (msg.type === 'init') emit({ type: 'ready' });
        // 'chunk': no auto-ack — the test controls draining via emit({type:'ack',...}).
      });
    },
    addEventListener(_e, fn) { listeners.push(fn); },
    terminate() {},
  };
  function emit(data) { for (const fn of listeners) fn({ data }); }
  return { w, emit };
}

test('client: init resolves {supported:true} on ready; endEntry resolves with written record', async () => {
  const { w } = fakeWorker();
  const c = createAssemblerClient(w);
  const initRes = await c.init('s.zip', { entries: [] }, ['x']);
  assert.deepEqual(initRes, { supported: true });
  c.writeChunk('x', new Uint8Array([1, 2, 3, 4]));
  const rec = await c.endEntry('x');
  assert.deepEqual(rec, { crc: 123, size: 4 });
  const fin = await c.finish([]);
  assert.deepEqual(fin, { totalBytes: 999 });
});

test('client: init resolves {supported:false} when the worker reports unsupported', async () => {
  const { w, emit } = fakeWorker();
  w.postMessage = (msg) => { if (msg.type === 'init') queueMicrotask(() => emit({ type: 'unsupported', reason: 'no createSyncAccessHandle in worker' })); };
  const c = createAssemblerClient(w);
  const initRes = await c.init('s.zip', { entries: [] }, []);
  assert.equal(initRes.supported, false);
  assert.match(initRes.reason, /createSyncAccessHandle/);
});

test('client: entryError rejects the matching endEntry', async () => {
  const { w, emit } = fakeWorker();
  // override entryEnd to error
  const orig = w.postMessage;
  w.postMessage = (msg) => { if (msg.type === 'entryEnd') queueMicrotask(() => emit({ type: 'entryError', key: msg.key, name: 'Bad', message: 'nope' })); else orig(msg); };
  const c = createAssemblerClient(w);
  await c.init('s.zip', { entries: [] }, ['x']);
  await assert.rejects(() => c.endEntry('x'), /nope/);
});

test('client: onFatal fires on a fatal message', async () => {
  const { w, emit } = fakeWorker();
  const c = createAssemblerClient(w);
  let fatal = null;
  c.onFatal((f) => { fatal = f; });
  await c.init('s.zip', { entries: [] }, []);
  emit({ type: 'fatal', name: 'QuotaExceededError', message: 'full' });
  assert.equal(fatal.name, 'QuotaExceededError');
});

test('client: writeChunk backpressure — blocks past writeWindowBytes until an ack drains it', async () => {
  const { w, emit } = controllableFakeWorker();
  const c = createAssemblerClient(w, { writeWindowBytes: 10 });
  await c.init('s.zip', { entries: [] }, ['x']);

  let p1Settled = false;
  c.writeChunk('x', new Uint8Array(6)).then(() => { p1Settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(p1Settled, true, 'a chunk that keeps outstanding under the window resolves immediately');

  let p2Settled = false;
  const p2 = c.writeChunk('x', new Uint8Array(6)); // outstanding now 12 > window of 10
  p2.then(() => { p2Settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(p2Settled, false, 'a chunk that pushes outstanding over the window must not resolve yet');

  emit({ type: 'ack', bytes: 6 }); // outstanding drops back to 6 <= 10
  await p2;
  assert.equal(p2Settled, true, 'draining outstanding under the window via an ack resolves the pending writeChunk');
});

test('client: a pending writeChunk is released (not left hanging) when abort() is called', async () => {
  const { w } = controllableFakeWorker();
  const c = createAssemblerClient(w, { writeWindowBytes: 5 });
  await c.init('s.zip', { entries: [] }, ['x']);

  const p = c.writeChunk('x', new Uint8Array(10)); // exceeds window; no ack will ever arrive
  c.abort();
  await p; // must resolve, not hang forever
});

test('client: a pending writeChunk is released (not left hanging) when a fatal message arrives', async () => {
  const { w, emit } = controllableFakeWorker();
  const c = createAssemblerClient(w, { writeWindowBytes: 5 });
  await c.init('s.zip', { entries: [] }, ['x']);

  const p = c.writeChunk('x', new Uint8Array(10)); // exceeds window; no ack will ever arrive
  emit({ type: 'fatal', name: 'QuotaExceededError', message: 'full' });
  await p; // must resolve, not hang forever
});
