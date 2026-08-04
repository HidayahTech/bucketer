// src/worker/zip-assembler.worker.js
// Copyright (C) 2026 HidayahTech, LLC
// Owns the single exclusive SyncAccessHandle on the staging ZIP and does positioned writes.
// Bundled + inlined as a Blob URL by build.mjs (single-file guarantee). Runtime imports none.
import { createAssembler } from '../lib/zip-assemble.js';

let asm = null;
let handle = null;

function syncSink(sync) {
  return {
    write(u8, at) { sync.write(u8, { at }); },
    truncate(n) { sync.truncate(n); },
    flush() { sync.flush(); },
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
        self.postMessage({ type: 'unsupported', reason: 'no OPFS in worker' });
        return;
      }
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(m.stagingName, { create: true });
      // The ONLY place createSyncAccessHandle can be detected (worker scope). If absent,
      // report unsupported so runInPlaceJob falls back to the serial engine (design D8).
      if (typeof fh.createSyncAccessHandle !== 'function') {
        self.postMessage({ type: 'unsupported', reason: 'no createSyncAccessHandle in worker' });
        return;
      }
      handle = await fh.createSyncAccessHandle();
      asm = createAssembler(syncSink(handle), m.layout);
      await asm.writeHeaders();
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'chunk') {
      await asm.writeChunk(m.key, new Uint8Array(m.buffer));
    } else if (m.type === 'entryEnd') {
      try { const r = await asm.endEntry(m.key); self.postMessage({ type: 'written', key: m.key, crc: r.crc, size: r.size }); }
      catch (err) { self.postMessage({ type: 'entryError', key: m.key, name: err?.name || 'Error', message: err?.message || String(err) }); }
    } else if (m.type === 'finish') {
      const r = await asm.finish(m.records);
      try { handle.close(); } catch { /* best effort */ }
      self.postMessage({ type: 'finished', totalBytes: r.totalBytes });
    } else if (m.type === 'abort') {
      try { handle?.flush(); handle?.close(); } catch { /* best effort */ }
    }
  } catch (err) {
    self.postMessage({ type: 'fatal', name: err?.name || 'Error', message: err?.message || String(err) });
  }
};
