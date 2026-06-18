// Copyright (C) 2026 HidayahTech, LLC
// Streaming byte-for-byte comparison — the certainty gate for duplicate detection.
//
// WHY THIS FILE EXISTS: deletion must never rest on a hash. MD5 and SHA-1 are broken
// for collision resistance (colliding files are constructible), and even SHA-256 is a
// hash with a theoretical bound. The only way to be certain two objects are identical
// is to compare their actual bytes. This module does exactly that — streaming, so it
// never holds whole objects in memory, and aborting as soon as a difference is found.
//
// Inputs are async iterables of Uint8Array chunks (e.g. a fetch body ReadableStream).
// Chunk boundaries are arbitrary and need not align between sources.

const EMPTY = new Uint8Array(0);

function asU8(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(v);
}

// Pulls one chunk at a time from an async iterable, skipping empty chunks and returning
// an empty Uint8Array at EOF. Pulling lazily (one chunk per call) is what lets the
// comparison abort without over-reading a source past a detected mismatch.
class ChunkPuller {
  constructor(iterable) {
    this.it = iterable[Symbol.asyncIterator]();
    this.done = false;
  }
  async next() {
    while (!this.done) {
      const r = await this.it.next();
      if (r.done) { this.done = true; return EMPTY; }
      if (r.value && r.value.length) return asU8(r.value);
    }
    return EMPTY;
  }
}

function rangesEqual(a, aOff, bytes, bOff, len) {
  for (let i = 0; i < len; i++) {
    if (a[aOff + i] !== bytes[bOff + i]) return false;
  }
  return true;
}

// Compares a single reference source against many candidate sources in one pass over
// the reference (so each source is read at most once). Returns a boolean[] aligned with
// `candidates`: true means byte-identical to the reference. A candidate that diverges is
// marked false and not read any further.
export async function verifyAgainstReference(reference, candidates) {
  const ref = new ChunkPuller(reference);
  const states = candidates.map((c) => ({ puller: new ChunkPuller(c), leftover: EMPTY, matching: true }));

  for (;;) {
    const refBuf = await ref.next();
    const refEof = refBuf.length === 0;

    await Promise.all(states.map(async (s) => {
      if (!s.matching) return;

      if (refEof) {
        // Reference is exhausted; an identical candidate must also be exhausted.
        if (s.leftover.length === 0) s.leftover = await s.puller.next();
        if (s.leftover.length !== 0) s.matching = false;
        return;
      }

      // Consume exactly refBuf.length bytes from the candidate, comparing as we go.
      let need = refBuf.length;
      let offset = 0;
      while (need > 0) {
        if (s.leftover.length === 0) {
          s.leftover = await s.puller.next();
          if (s.leftover.length === 0) { s.matching = false; return; } // candidate shorter
        }
        const take = Math.min(need, s.leftover.length);
        if (!rangesEqual(s.leftover, 0, refBuf, offset, take)) { s.matching = false; return; }
        s.leftover = s.leftover.subarray(take);
        offset += take;
        need -= take;
      }
    }));

    if (refEof) break;
    if (states.every((s) => !s.matching)) break; // every candidate already diverged
  }

  return states.map((s) => s.matching);
}

// Convenience wrapper: are two byte sources identical?
export async function streamsIdentical(a, b) {
  const [equal] = await verifyAgainstReference(a, [b]);
  return equal;
}
