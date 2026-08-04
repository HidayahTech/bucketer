// Copyright (C) 2026 HidayahTech, LLC
// Bounded-prefetch tuning + the file-size tier router for concurrent ZIP downloads.
// See docs/superpowers/specs/2026-08-04-download-concurrency-design.md (D1, D2).

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
      const writable = await handle.createWritable();
      let size = 0;
      for await (const chunk of chunksIterable) {
        await writable.write(chunk);
        size += chunk.length;
      }
      await writable.close();
      created.add(fname);
      return { size };
    },

    async open(name) {
      const handle = await root.getFileHandle(tempName(name));
      return {
        stream() {
          return (async function* () {
            const file = await handle.getFile();
            const buf = new Uint8Array(await file.arrayBuffer());
            for (let offset = 0; offset < buf.length; offset += TEMP_CHUNK) {
              yield buf.slice(offset, offset + TEMP_CHUNK);
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
