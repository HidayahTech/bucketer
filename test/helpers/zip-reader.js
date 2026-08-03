// Copyright (C) 2026 HidayahTech, LLC
// Shared test-only ZIP reader: the independent witness used by both zip-writer.test.js and
// zip-job-run.test.js to verify what createZipWriter (and, on top of it, runZipJob) actually
// wrote to a byte sink.
//
// It starts from the EOCD at the end of the buffer (how real extractors work), walks the
// central directory, and checks each local entry + data descriptor against it. CRCs are
// cross-checked with a separate, table-free bitwise CRC-32 so a shared table bug in
// src/lib/zip-writer.js cannot self-verify.
import assert from 'node:assert/strict';

// Independent bitwise CRC-32 (reflected, poly 0xEDB88320) — no table.
export function refCrc(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// Minimal reader: EOCD (with optional ZIP64 EOCD) -> central entries -> local checks.
export function readZip(u8) {
  const d = dv(u8);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (d.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, 'EOCD signature present');
  let count = d.getUint16(eocd + 10, true);
  let cdSize = d.getUint32(eocd + 12, true);
  let cdOff = d.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
    const locOff = eocd - 20;
    assert.equal(d.getUint32(locOff, true), 0x07064b50, 'ZIP64 EOCD locator present');
    const z64Off = Number(d.getBigUint64(locOff + 8, true));
    assert.equal(d.getUint32(z64Off, true), 0x06064b50, 'ZIP64 EOCD present');
    count = Number(d.getBigUint64(z64Off + 32, true));
    cdSize = Number(d.getBigUint64(z64Off + 40, true));
    cdOff = Number(d.getBigUint64(z64Off + 48, true));
  }
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    assert.equal(d.getUint32(p, true), 0x02014b50, `central header ${n}`);
    const flags = d.getUint16(p + 8, true);
    const method = d.getUint16(p + 10, true);
    let crc = d.getUint32(p + 16, true);
    let csize = d.getUint32(p + 20, true);
    let usize = d.getUint32(p + 24, true);
    const nameLen = d.getUint16(p + 28, true);
    const extraLen = d.getUint16(p + 30, true);
    const cmtLen = d.getUint16(p + 32, true);
    let lho = d.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra (id 0x0001): fields present only for the 0xFFFFFFFF markers, in order
    // usize, csize, offset.
    let q = p + 46 + nameLen;
    const extraEnd = q + extraLen;
    while (q < extraEnd) {
      const id = d.getUint16(q, true), sz = d.getUint16(q + 2, true);
      if (id === 0x0001) {
        let r = q + 4;
        if (usize === 0xFFFFFFFF) { usize = Number(d.getBigUint64(r, true)); r += 8; }
        if (csize === 0xFFFFFFFF) { csize = Number(d.getBigUint64(r, true)); r += 8; }
        if (lho === 0xFFFFFFFF) { lho = Number(d.getBigUint64(r, true)); r += 8; }
      }
      q += 4 + sz;
    }
    entries.push({ name, method, flags, crc, csize, usize, lho });
    p = p + 46 + nameLen + extraLen + cmtLen;
  }
  assert.equal(p, cdOff + cdSize, 'central directory size matches');
  // Local checks: header + streamed data + data descriptor.
  for (const e of entries) {
    assert.equal(d.getUint32(e.lho, true), 0x04034b50, `local header ${e.name}`);
    const flags = d.getUint16(e.lho + 6, true);
    assert.ok(flags & 0x0008, 'streaming bit set');
    assert.ok(flags & 0x0800, 'UTF-8 bit set');
    const nameLen = d.getUint16(e.lho + 26, true);
    const extraLen = d.getUint16(e.lho + 28, true);
    const dataStart = e.lho + 30 + nameLen + extraLen;
    const data = u8.subarray(dataStart, dataStart + e.csize);
    assert.equal(refCrc(data), e.crc, `crc of ${e.name}`);
    e.data = data;
  }
  return entries;
}
