// Probe worker for the "fetch inside the worker" experiment (Approach B).
//
// Unlike the shipped in-place engine — where the MAIN thread fetches each file and
// postMessage-transfers its ArrayBuffers into the assembler worker (Firefox Bug 1407691:
// those transferred buffers pile up in the busy worker until it's terminated) — here the
// worker GENERATES the bytes itself and writes them straight to OPFS via the real assembler.
// No ArrayBuffer ever crosses a thread boundary, so 1407691 cannot apply. Bytes are synthetic
// (same technique as probe-concurrency.html's makeFetchImpl) so the experiment isolates the
// cross-thread-transfer variable rather than real-network buffering.
import { createAssembler } from '/src/lib/zip-assemble.js';

function syncSink(sync) {
  return {
    write(u8, at) { sync.write(u8, { at }); },
    truncate(n) { sync.truncate(n); },
    flush() { sync.flush(); },
  };
}

// Synthetic "fetch": freshly-allocated chunks (never reused/shared, so JS memory pressure is
// real), optional per-file latency to model an RTT.
async function* genChunks(size, chunkBytes, latencyMs) {
  if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
  let sent = 0;
  while (sent < size) {
    const n = Math.min(chunkBytes, size - sent);
    sent += n;
    yield new Uint8Array(n).fill(65);
  }
}

// Minimal N-worker concurrency pool (mirrors upload-queue.js's runPool shape).
async function runPool(items, fn, concurrency) {
  let i = 0;
  const next = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: concurrency }, next));
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(m.stagingName, { create: true });
    if (typeof fh.createSyncAccessHandle !== 'function') {
      self.postMessage({ type: 'error', name: 'Unsupported', message: 'no createSyncAccessHandle' });
      return;
    }
    const sync = await fh.createSyncAccessHandle();
    const asm = createAssembler(syncSink(sync), m.layout);
    await asm.writeHeaders();
    self.postMessage({ type: 'started' });

    const byKey = new Map(m.layout.entries.map((en) => [en.key, en]));
    const done = new Map(); // key -> {crc,size}

    const t0 = performance.now();
    await runPool(m.items, async (it) => {
      const size = byKey.get(it.key).declaredSize;
      for await (const chunk of genChunks(size, m.chunkBytes, m.latencyMs)) {
        await asm.writeChunk(it.key, chunk);
      }
      const rec = await asm.endEntry(it.key);
      done.set(it.key, rec);
    }, m.concurrency);

    const records = m.layout.entries.map((en) => ({
      path: en.path, zipOffset: en.headerOffset,
      size: done.get(en.key).size, crc: done.get(en.key).crc, time: en.time, date: en.date,
    }));
    await asm.finish(records);
    try { sync.flush(); sync.close(); } catch { /* best effort */ }
    try { await root.removeEntry(m.stagingName); } catch { /* best effort */ }

    self.postMessage({ type: 'done', wallMs: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ type: 'error', name: err?.name || 'Error', message: err?.message || String(err) });
  }
};
