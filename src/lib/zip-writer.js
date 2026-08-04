// Copyright (C) 2026 HidayahTech, LLC
// Store-only streaming ZIP64 writer over an injected byte sink.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md.
//
// Streaming means the CRC is unknown when an entry starts, so every entry sets the
// data-descriptor bit (3) and writes crc/sizes after its bytes (APPNOTE 4.4.4). Sizes ARE
// known up front (the manifest records them), which decides each entry's ZIP64-ness before
// its local header is written — and gives a free integrity check: a streamed length that
// disagrees with the manifest fails the entry rather than corrupting the archive.
// Store-only (method 0) is deliberate: S3-hosted media is mostly incompressible and CPU
// time is the enemy of 10 GiB jobs.

const SIG_LOCAL = 0x04034b50;
const SIG_DESC = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOC = 0x07064b50;
// Bit 3: sizes/crc follow the data. Bit 11: name is UTF-8.
const FLAGS = 0x0008 | 0x0800;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, seed = 0) {
  let crc = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// DOS timestamps cannot express pre-1980; clamp rather than wrap.
export function dosDateTime(mtime) {
  const d = mtime != null ? new Date(mtime) : null;
  if (!d || d.getFullYear() < 1980) return { time: 0, date: 0x21 }; // 1980-01-01 00:00
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ByteBuilder {
  constructor() { this.parts = []; this.len = 0; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.push(b); }
  push(u8) { this.parts.push(u8); this.len += u8.length; }
  bytes() {
    const out = new Uint8Array(this.len); let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

// Local header size never depends on ZIP64 — sizes/crc are always deferred to the data
// descriptor (bit 3), so the header is always 30 bytes + name bytes. The version-needed
// field's VALUE does still flag zip64 (45 vs 20), matching the original beginEntry.
export function localHeaderBytes(path, { time, date, zip64 = false }) {
  const nameBytes = new TextEncoder().encode(path);
  const b = new ByteBuilder();
  b.u32(SIG_LOCAL);
  b.u16(zip64 ? 45 : 20);          // version needed
  b.u16(FLAGS);
  b.u16(0);                        // method: store
  b.u16(time); b.u16(date);
  b.u32(0); b.u32(0); b.u32(0);    // crc, csize, usize: in the descriptor
  b.u16(nameBytes.length);
  b.u16(0);                        // no local extra: descriptor carries the truth
  b.push(nameBytes);
  return b.bytes();
}

export function dataDescriptorBytes({ crc, size, zip64 }) {
  const b = new ByteBuilder();
  b.u32(SIG_DESC);
  b.u32(crc);
  if (zip64) { b.u64(size); b.u64(size); } else { b.u32(size); b.u32(size); }
  return b.bytes();
}

export function centralDirectoryBytes(entries, { zip64Limit = 0xFFFFFFFF, maxEntries = 0xFFFF, cdStart }) {
  const b = new ByteBuilder();
  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.path);
    const sizeMark = e.size >= zip64Limit ? 0xFFFFFFFF : e.size;
    const offMark = e.zipOffset >= zip64Limit ? 0xFFFFFFFF : e.zipOffset;
    const extra = new ByteBuilder();
    if (sizeMark === 0xFFFFFFFF || offMark === 0xFFFFFFFF) {
      const fields = new ByteBuilder();
      if (sizeMark === 0xFFFFFFFF) { fields.u64(e.size); fields.u64(e.size); } // usize, csize
      if (offMark === 0xFFFFFFFF) fields.u64(e.zipOffset);
      extra.u16(0x0001); extra.u16(fields.len); extra.push(fields.bytes());
    }
    b.u32(SIG_CENTRAL);
    b.u16(45);                                   // version made by
    b.u16(sizeMark === 0xFFFFFFFF || offMark === 0xFFFFFFFF ? 45 : 20);
    b.u16(FLAGS); b.u16(0);
    b.u16(e.time ?? 0); b.u16(e.date ?? 0x21);
    b.u32(e.crc);
    b.u32(sizeMark); b.u32(sizeMark);
    b.u16(nameBytes.length); b.u16(extra.len); b.u16(0);
    b.u16(0); b.u16(0); b.u32(0);
    b.u32(offMark);
    b.push(nameBytes);
    b.push(extra.bytes());
  }
  const cdSize = b.len;
  const needZip64 = entries.length > maxEntries || cdStart >= zip64Limit || cdSize >= zip64Limit;
  if (needZip64) {
    const z64At = cdStart + cdSize;
    b.u32(SIG_Z64_EOCD); b.u64(44); b.u16(45); b.u16(45);
    b.u32(0); b.u32(0);
    b.u64(entries.length); b.u64(entries.length);
    b.u64(cdSize); b.u64(cdStart);
    b.u32(SIG_Z64_LOC); b.u32(0); b.u64(z64At); b.u32(1);
  }
  b.u32(SIG_EOCD); b.u16(0); b.u16(0);
  const cnt = needZip64 ? 0xFFFF : entries.length;
  b.u16(cnt); b.u16(cnt);
  b.u32(needZip64 ? 0xFFFFFFFF : cdSize);
  b.u32(needZip64 ? 0xFFFFFFFF : cdStart);
  b.u16(0);
  return b.bytes();
}

export function createZipWriter(sink, { zip64Limit = 0xFFFFFFFF, maxEntries = 0xFFFF, startOffset = 0 } = {}) {
  let offset = startOffset;
  let cur = null; // { path, nameBytes, zipOffset, declaredSize, zip64, crc, size, time, date }

  const write = async (u8) => { await sink.write(u8); offset += u8.length; };

  return {
    get offset() { return offset; },

    async beginEntry(path, { mtime = null, declaredSize = 0 } = {}) {
      if (cur) throw new Error('previous entry not ended');
      // Declared size decides descriptor width up front; offset can also force ZIP64 in
      // the central record, but that never changes the local layout.
      const zip64 = declaredSize >= zip64Limit;
      const { time, date } = dosDateTime(mtime);
      cur = { path, zipOffset: offset, declaredSize, zip64, crc: 0, size: 0, time, date };
      await write(localHeaderBytes(path, { time, date, zip64 }));
    },

    async update(chunk) {
      if (!cur) throw new Error('no entry in progress');
      cur.crc = crc32(chunk, cur.crc);
      cur.size += chunk.length;
      await write(chunk);
    },

    async endEntry() {
      if (!cur) throw new Error('no entry in progress');
      if (cur.size !== cur.declaredSize) {
        const e = cur; cur = null;
        throw new Error(`entry ${e.path}: streamed ${e.size} bytes but declared ${e.declaredSize}`);
      }
      await write(dataDescriptorBytes({ crc: cur.crc, size: cur.size, zip64: cur.zip64 }));
      const rec = { path: cur.path, zipOffset: cur.zipOffset, zipEnd: offset, size: cur.size, crc: cur.crc, time: cur.time, date: cur.date };
      cur = null;
      return rec;
    },

    async finish(entries) {
      if (cur) throw new Error('entry in progress');
      const cdStart = offset;
      await write(centralDirectoryBytes(entries, { zip64Limit, maxEntries, cdStart }));
      return { totalBytes: offset - startOffset };
    },
  };
}
