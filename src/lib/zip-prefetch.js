// Copyright (C) 2026 HidayahTech, LLC
// Bounded-prefetch tuning + the file-size tier router for concurrent ZIP downloads.
// See docs/superpowers/specs/2026-08-04-download-concurrency-design.md (D1, D2).

import { runPool } from './upload-queue.js';
import { crc32 } from './zip-writer.js';
import { PROBE_KIND } from './download-preflight.js';

export const CONCURRENCY = 4;        // default concurrent fetches
export const MAX_CONCURRENCY = 8;    // ceiling
export const TINY_MAX = 4 * 1024 * 1024;    // <= this: buffer in memory
export const MEDIUM_MAX = 64 * 1024 * 1024; // <= this: buffer in an OPFS temp file; else stream solo

export function classifyTier(size) {
  const n = size || 0;
  if (n <= TINY_MAX) return 'memory';
  if (n <= MEDIUM_MAX) return 'temp';
  return 'solo';
}

// OPFS temp store for medium-tier prefetch buffers: an item too big to hold in memory
// but small enough to stage on disk gets buffered into one of these files while its
// slot in the write order waits, then streamed back out (in TEMP_CHUNK pieces, so the
// consumer never holds the whole buffer at once) once it's its turn.
export const TEMP_CHUNK = 8 * 1024 * 1024; // 8 MiB

export function createTempStore(root) {
  const created = new Set();
  const tempName = (name) => `bucketer-tmp-${name}`;

  return {
    async put(name, chunksIterable) {
      const fname = tempName(name);
      const handle = await root.getFileHandle(fname, { create: true });
      // Tracked as soon as the file exists on disk, not only after a successful write —
      // a chunksIterable that throws/aborts mid-write (e.g. runPrefetch's temp-tier
      // fetch getting cut off by a cancel-triggered AbortError) still leaves this file
      // behind, and removeAll()'s safety-net sweep can only find what's in this set.
      created.add(fname);
      const writable = await handle.createWritable();
      let size = 0;
      for await (const chunk of chunksIterable) {
        await writable.write(chunk);
        size += chunk.byteLength ?? chunk.length;
      }
      await writable.close();
      return { size };
    },

    async open(name) {
      const handle = await root.getFileHandle(tempName(name));
      return {
        stream() {
          return (async function* () {
            const file = await handle.getFile();
            // Chunked via Blob.slice() so a near-MEDIUM_MAX (64 MiB) file is never held
            // whole in memory during read-back — only one TEMP_CHUNK (~8 MiB) at a time,
            // matching D2's "peak memory ≤ N × 4 MiB" invariant (the OPFS temp tier is
            // exactly the mechanism that keeps medium-file bytes off that budget).
            for (let offset = 0; offset < file.size; offset += TEMP_CHUNK) {
              const buf = await file.slice(offset, offset + TEMP_CHUNK).arrayBuffer();
              yield new Uint8Array(buf);
            }
          })();
        },
      };
    },

    async remove(name) {
      const fname = tempName(name);
      try { await root.removeEntry(fname); } catch { /* best effort */ }
      created.delete(fname);
    },

    async removeAll() {
      for (const fname of created) {
        try { await root.removeEntry(fname); } catch { /* best effort */ }
      }
      created.clear();
    },
  };
}

// Three consecutive DENIED probes = a wholesale deny (mirrors download-queue.js's
// DENIED_BLOCK_STREAK). Here it is a ROLLING count across N concurrent workers rather
// than a single sequential loop's counter — see runPrefetch below.
const DENIED_BLOCK_STREAK = 3;

// runPrefetch(items, { fetchImpl, presign, probe, root, concurrency, onReady, onProgress,
//                       shouldCancel })
//   -> { failed: [{item, message}], denied, blocked, cancelled }
//
// Up to `concurrency` fetch workers pull items off a shared queue (via runPool,
// upload-queue.js's generalized N-worker pool) and race each other over the network.
// Every completed file is handed to the single serial writer `onReady` — guarded by a
// single-slot promise-chain lock so it is never invoked concurrently — in COMPLETION
// order (fastest fetch first), not manifest order. A worker always awaits `onReady`
// before taking its next item, which is what bounds the number of fetched-but-unwritten
// buffers to ~concurrency (natural backpressure; no separate semaphore needed).
//
// The cancel check inside that lock (not just before enqueuing the call) matters: a
// worker can finish fetching and queue its onReady call before `cancelled` flips, but
// the queued closure only actually runs once it reaches the front of the writer chain —
// by which point cancellation may already be observed. Skipping onReady there (rather
// than only gating new intake) is what stops a write-after-cancel.
//
// A NETWORK probe result (CORS/offline) blocks the whole job immediately — mirroring
// download-queue.js's sequential engine — rather than failing items one by one: it sets
// `blocked` to the first such probe result, stops new intake, and aborts in-flight
// fetches. It is never recorded in `failed`.
//
// Tiering (classifyTier): memory buffers accumulate in an array of chunks and compute
// their CRC as they stream; temp buffers stream straight into an OPFS temp file
// (tempStore.put) computing CRC over the same pass, then are read back for the writer via
// tempStore.open(...).stream(); solo files are handed to the writer as a LIVE stream with
// no pre-buffering and no pre-computed CRC (the writer computes it itself while copying,
// exactly as zip-writer.js's update() already does) — solo is therefore the one tier
// whose "active" download window spans the entire onReady call, not just the fetch.
//
// The rolling DENIED breaker deliberately differs from download-queue.js's sequential
// version: under concurrency, "consecutive" can't mean position in one loop, so it is a
// shared counter incremented only on DENIED and reset to 0 only on a successful onReady
// (not on every non-DENIED probe result, unlike the sequential engine) — this is the
// simplification the design's D4 rolling-count directive calls for, made explicit here
// because the two behave differently for interleaved MISSING/TRANSIENT results.
export async function runPrefetch(items, {
  fetchImpl,
  presign,
  probe,
  root,
  concurrency = CONCURRENCY,
  onReady,
  onProgress,
  shouldCancel = () => false,
} = {}) {
  const tempStore = createTempStore(root);

  const failed = [];
  let denied = false;
  let blocked = null;
  let cancelled = false;
  let consecutiveDenied = 0;
  let stopIntake = false;
  let bytesDone = 0;
  let tempSeq = 0;

  // "Currently downloading" per D5 — memory/temp entries leave this set the moment their
  // fetch finishes (before onReady runs); solo entries stay in it for the whole onReady
  // call, since their bytes are still flowing live while the writer consumes them.
  const activeState = new Map();
  const inFlightControllers = new Set();

  const snapshotActive = () => Array.from(activeState.values()).map((a) => ({ ...a }));
  const emitProgress = () => onProgress?.({ active: snapshotActive(), bytesDone });

  const abortAllInFlight = () => {
    for (const c of inFlightControllers) { try { c.abort(); } catch { /* already settled */ } }
  };

  // Checked at item-pickup and right after each onReady settles — both are the points at
  // which a worker is about to make a new decision (take a new item, or hand back control
  // to the pool). The moment ANY worker notices, it aborts every OTHER worker's in-flight
  // fetch too, so cancellation lands promptly even though only one worker "asked".
  const noteCancelIfRequested = () => {
    if (!cancelled && shouldCancel()) {
      cancelled = true;
      stopIntake = true;
      abortAllInFlight();
    }
  };

  // Single-slot mutex via a promise chain: each caller's fn only starts once the
  // previous one has settled (success or failure), guaranteeing onReady is never
  // invoked concurrently while still letting N fetches race ahead of it.
  let writerTail = Promise.resolve();
  const withWriterLock = (fn) => {
    const run = writerTail.then(fn);
    writerTail = run.then(() => {}, () => {});
    return run;
  };

  const arrayToAsyncIterable = (chunks) => (async function* () {
    for (const c of chunks) yield c;
  })();

  async function processItem(item) {
    noteCancelIfRequested();
    if (stopIntake) return; // cancelled or denied-tripped: leave PENDING for a resume.

    const controller = new AbortController();
    inFlightControllers.add(controller);
    let tempName = null;

    const bump = (n) => {
      bytesDone += n;
      const cur = activeState.get(item.key);
      if (cur) cur.bytes += n;
      emitProgress();
    };

    try {
      const url = await presign(item.key, item.localName);

      if (probe) {
        const result = await probe(url);
        if (result.kind === PROBE_KIND.NETWORK) {
          // Job-wide, immediately: CORS/offline can't be fixed by moving to the next
          // item. Mirrors download-queue.js's sequential engine, which blocks on the
          // first NETWORK result rather than accumulating per-item failures. Not pushed
          // to `failed` — only the first NETWORK result is recorded as `blocked`, but
          // every NETWORK result (first or not) is excluded from `failed`.
          if (!blocked) {
            blocked = result;
            stopIntake = true;
            abortAllInFlight();
          }
          return;
        }
        if (result.kind !== PROBE_KIND.OK) {
          if (result.kind === PROBE_KIND.DENIED) {
            consecutiveDenied += 1;
            if (consecutiveDenied >= DENIED_BLOCK_STREAK) {
              denied = true;
              stopIntake = true;
            }
          }
          failed.push({ item, message: result.message || `probe: ${result.kind}` });
          return;
        }
      }

      activeState.set(item.key, { key: item.key, size: item.size ?? 0, bytes: 0 });
      emitProgress();

      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res || !res.ok || !res.body) {
        throw new Error(`fetch failed (${res?.status ?? 'no response'})`);
      }

      const tier = classifyTier(item.size);
      let entry;

      if (tier === 'memory') {
        const reader = res.body.getReader();
        const chunks = [];
        let crc = 0, size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32(value, crc);
          size += value.length;
          chunks.push(value);
          bump(value.length);
        }
        activeState.delete(item.key);
        emitProgress();
        entry = { item, tier, crc, size, chunks: arrayToAsyncIterable(chunks) };
      } else if (tier === 'temp') {
        tempName = `p${tempSeq++}`;
        const reader = res.body.getReader();
        let crc = 0, size = 0;
        async function* source() {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            crc = crc32(value, crc);
            size += value.length;
            bump(value.length);
            yield value;
          }
        }
        await tempStore.put(tempName, source());
        activeState.delete(item.key);
        emitProgress();
        const handle = await tempStore.open(tempName);
        entry = { item, tier, crc, size, chunks: handle.stream() };
      } else {
        // solo: no pre-buffering, no pre-computed CRC — the live reader is handed
        // straight to the writer, and "active" tracking only clears once the writer has
        // fully drained it (bytes are still being downloaded for the whole onReady call).
        const reader = res.body.getReader();
        entry = {
          item, tier, crc: null, size: item.size ?? 0,
          chunks: (async function* () {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bump(value.length);
                yield value;
              }
            } finally {
              activeState.delete(item.key);
              emitProgress();
            }
          })(),
        };
      }

      // Guarded INSIDE the lock (see the top-of-function note): `cancelled` is checked
      // at the moment this closure actually reaches the front of the writer chain, not
      // just before it was enqueued.
      const wrote = await withWriterLock(async () => {
        if (cancelled) return false;
        await onReady(entry);
        return true;
      });

      if (!wrote) {
        // Skipped for cancel: discard rather than write. For solo specifically, its
        // generator (and the activeState cleanup in its own `finally`) never got a
        // chance to start, since nothing ever iterated it — clean up here instead.
        activeState.delete(item.key);
        emitProgress();
      }
      // Either the writer just finished draining the temp file (wrote===true), or the
      // write was skipped and the buffer is being discarded (wrote===false) — in both
      // cases the temp file's job is done and it must not be left behind.
      if (tempName) await tempStore.remove(tempName).catch(() => {});

      if (wrote) consecutiveDenied = 0;
      noteCancelIfRequested();
    } catch (err) {
      if ((cancelled || blocked) && err?.name === 'AbortError') {
        // Cut off by our own cancel- or NETWORK-block-triggered abort: not this item's
        // fault. Leave it untouched (neither done nor failed) for a resume to re-fetch.
        // A temp-tier item can be mid-tempStore.put() when this fires, leaving a
        // partial bucketer-tmp-* file on OPFS — remove it immediately rather than
        // relying solely on the end-of-run removeAll() safety net below.
        if (tempName) await tempStore.remove(tempName).catch(() => {});
      } else {
        failed.push({ item, message: err?.message || String(err) });
        if (tempName) await tempStore.remove(tempName).catch(() => {});
      }
      activeState.delete(item.key);
      emitProgress();
    } finally {
      inFlightControllers.delete(controller);
    }
  }

  try {
    await runPool(items, processItem, concurrency);
  } finally {
    // Safety-net sweep, on every exit path (done/failed/denied/blocked/cancelled): every
    // happy-path and genuine-failure temp is already individually removed above and so
    // no longer in the store's created-set — this only clears whatever an abort path
    // left behind (now trackable regardless of write outcome, per the fix to
    // createTempStore.put's created.add(fname) above). Especially important on the
    // quota-STORAGE pause path (via a caller's shouldCancel): pausing because storage is
    // low must never itself orphan bytes.
    await tempStore.removeAll();
  }

  return { failed, denied, blocked, cancelled };
}
