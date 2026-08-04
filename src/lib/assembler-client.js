// src/lib/assembler-client.js
// Copyright (C) 2026 HidayahTech, LLC
// Promise-based bridge over the zip-assembler worker's message protocol, so runInPlaceJob
// never touches raw postMessage. See the design doc (D1, D7).
export function createAssemblerClient(worker) {
  const pendingEnd = new Map(); // key -> {resolve, reject}
  let readyResolve, finishResolve, finishReject;
  let fatalCb = null;
  worker.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'ready') readyResolve?.({ supported: true });
    else if (m.type === 'unsupported') readyResolve?.({ supported: false, reason: m.reason });
    else if (m.type === 'written') pendingEnd.get(m.key)?.resolve({ crc: m.crc, size: m.size });
    else if (m.type === 'entryError') pendingEnd.get(m.key)?.reject(Object.assign(new Error(m.message), { name: m.name }));
    else if (m.type === 'finished') finishResolve?.({ totalBytes: m.totalBytes });
    else if (m.type === 'fatal') { fatalCb?.({ name: m.name, message: m.message }); finishReject?.(Object.assign(new Error(m.message), { name: m.name })); }
  });
  return {
    init(stagingName, layout, freshKeys) {
      return new Promise((res) => { readyResolve = res; worker.postMessage({ type: 'init', stagingName, layout, freshKeys }); });
    },
    writeChunk(key, u8) {
      const buffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      worker.postMessage({ type: 'chunk', key, buffer }, [buffer]);
    },
    endEntry(key) {
      return new Promise((resolve, reject) => { pendingEnd.set(key, { resolve, reject }); worker.postMessage({ type: 'entryEnd', key }); })
        .finally(() => pendingEnd.delete(key));
    },
    finish(records) {
      return new Promise((res, rej) => { finishResolve = res; finishReject = rej; worker.postMessage({ type: 'finish', records }); });
    },
    abort() { worker.postMessage({ type: 'abort' }); },
    onFatal(cb) { fatalCb = cb; },
  };
}
