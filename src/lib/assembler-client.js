// src/lib/assembler-client.js
// Copyright (C) 2026 HidayahTech, LLC
// Promise-based bridge over the zip-assembler worker's message protocol, so runInPlaceJob
// never touches raw postMessage. See the design doc (D1, D7).
//
// Worker-queue backpressure: writeChunk transfers the chunk's ArrayBuffer fire-and-forget
// as before, but now tracks a global outstanding-bytes credit window. Once outstanding
// exceeds writeWindowBytes, writeChunk returns a promise that only resolves once the
// worker's `ack` messages have drained outstanding back under the window — so a fast
// fetch reader awaiting writeChunk is throttled to the worker's actual write rate instead
// of piling unbounded chunks into its message queue.
export function createAssemblerClient(worker, { writeWindowBytes = 16 * 1024 * 1024 } = {}) {
  const pendingEnd = new Map(); // key -> {resolve, reject}
  let readyResolve, finishResolve, finishReject;
  let fatalCb = null;
  let outstanding = 0;
  let waiters = []; // FIFO of resolve fns for writeChunk calls blocked on the credit window

  // Releases every queued waiter unconditionally — used when the job is ending (finish,
  // abort) or has hit a fatal error, so a writeChunk promise can never hang past the job's
  // lifetime regardless of whether outstanding ever drops back under the window.
  function releaseWaiters() {
    const w = waiters;
    waiters = [];
    for (const resolve of w) resolve();
  }

  // Normal drain path: an ack lowered outstanding, so release waiters if the window is
  // satisfied again. All queued waiters share the same global threshold, so if it's
  // satisfied at all, every waiter is satisfied at once.
  function drainWaiters() {
    if (waiters.length && outstanding <= writeWindowBytes) releaseWaiters();
  }

  worker.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'ready') readyResolve?.({ supported: true });
    else if (m.type === 'unsupported') readyResolve?.({ supported: false, reason: m.reason });
    else if (m.type === 'written') pendingEnd.get(m.key)?.resolve({ crc: m.crc, size: m.size });
    else if (m.type === 'entryError') pendingEnd.get(m.key)?.reject(Object.assign(new Error(m.message), { name: m.name }));
    else if (m.type === 'ack') { outstanding -= m.bytes; drainWaiters(); }
    else if (m.type === 'finished') { finishResolve?.({ totalBytes: m.totalBytes }); releaseWaiters(); }
    else if (m.type === 'fatal') { fatalCb?.({ name: m.name, message: m.message }); finishReject?.(Object.assign(new Error(m.message), { name: m.name })); releaseWaiters(); }
  });
  return {
    init(stagingName, layout, freshKeys) {
      return new Promise((res) => { readyResolve = res; worker.postMessage({ type: 'init', stagingName, layout, freshKeys }); });
    },
    writeChunk(key, u8) {
      const len = u8.byteLength;
      const buffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      worker.postMessage({ type: 'chunk', key, buffer }, [buffer]);
      outstanding += len;
      if (outstanding <= writeWindowBytes) return Promise.resolve();
      return new Promise((resolve) => { waiters.push(resolve); });
    },
    endEntry(key) {
      return new Promise((resolve, reject) => { pendingEnd.set(key, { resolve, reject }); worker.postMessage({ type: 'entryEnd', key }); })
        .finally(() => pendingEnd.delete(key));
    },
    finish(records) {
      return new Promise((res, rej) => { finishResolve = res; finishReject = rej; worker.postMessage({ type: 'finish', records }); })
        .finally(() => releaseWaiters());
    },
    abort() { worker.postMessage({ type: 'abort' }); releaseWaiters(); },
    onFatal(cb) { fatalCb = cb; },
  };
}
