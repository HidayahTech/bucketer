// test/assembler-client.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssemblerClient } from '../src/lib/assembler-client.js';

// A fake worker that echoes the protocol deterministically.
function fakeWorker() {
  const listeners = [];
  const w = {
    postMessage(msg) {
      queueMicrotask(() => {
        if (msg.type === 'init') emit({ type: 'ready' });
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
