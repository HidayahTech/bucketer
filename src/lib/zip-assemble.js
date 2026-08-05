// Copyright (C) 2026 HidayahTech, LLC
// Pure positioned-write ZIP assembler. Given a precomputed layout (zip-layout.js), it writes
// each entry's local header, streams its data straight to the entry's slot (any order), writes
// the data descriptor once the entry completes, and finally the central directory at the known
// offset. Sink-agnostic (an OPFS SyncAccessHandle in the worker; an in-memory sink in tests).
// See docs/superpowers/specs/2026-08-04-inplace-offset-composition-design.md.
import { crc32, localHeaderBytes, dataDescriptorBytes, centralDirectoryBytes } from './zip-writer.js';

export function createAssembler(sink, layout) {
  const byKey = new Map(layout.entries.map((e) => [e.key, e]));
  const state = new Map(); // key -> { written, crc }

  return {
    async writeHeaders() {
      for (const e of layout.entries) {
        await sink.write(localHeaderBytes(e.path, { time: e.time, date: e.date, zip64: e.zip64 }), e.headerOffset);
      }
      await sink.truncate(layout.totalDataEnd);
    },

    async writeChunk(key, u8) {
      const e = byKey.get(key);
      if (!e) throw new Error(`unknown entry ${key}`);
      const s = state.get(key) || { written: 0, crc: 0 };
      if (s.written + u8.length > e.declaredSize) {
        throw new Error(`entry ${key}: overflow (${s.written + u8.length} > ${e.declaredSize})`);
      }
      await sink.write(u8, e.dataOffset + s.written);
      s.written += u8.length;
      s.crc = crc32(u8, s.crc);
      state.set(key, s);
    },

    async endEntry(key) {
      const e = byKey.get(key);
      const s = state.get(key) || { written: 0, crc: 0 };
      if (s.written !== e.declaredSize) {
        throw new Error(`entry ${key}: wrote ${s.written} but declared ${e.declaredSize}`);
      }
      await sink.write(dataDescriptorBytes({ crc: s.crc, size: s.written, zip64: e.zip64 }), e.descriptorOffset);
      return { crc: s.crc, size: s.written };
    },

    async finish(records) {
      const cd = centralDirectoryBytes(records, { cdStart: layout.centralDirOffset });
      await sink.write(cd, layout.centralDirOffset);
      await sink.flush();
      return { totalBytes: layout.centralDirOffset + cd.length };
    },
  };
}
