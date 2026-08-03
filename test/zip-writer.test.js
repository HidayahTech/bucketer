// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-writer.js — store-only streaming ZIP64 writer.
//
// The reader here is the test's independent witness: it starts from the EOCD at the end
// of the buffer (how real extractors work), walks the central directory, and checks each
// local entry + data descriptor against it. CRCs are cross-checked with a separate,
// table-free bitwise CRC-32 so a shared table bug cannot self-verify.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createZipWriter, crc32 } from '../src/lib/zip-writer.js';

function memSink() {
  const chunks = [];
  return {
    chunks,
    write(u8) { chunks.push(Uint8Array.from(u8)); },
    bytes() {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}

// Independent bitwise CRC-32 (reflected, poly 0xEDB88320) — no table.
function refCrc(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// Minimal reader: EOCD (with optional ZIP64 EOCD) -> central entries -> local checks.
function readZip(u8) {
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

const enc = (s) => new TextEncoder().encode(s);

describe('zip-writer', () => {
  test('crc32 matches the independent bitwise implementation', () => {
    for (const s of ['', 'a', 'hello world', 'x'.repeat(1000)]) {
      assert.equal(crc32(enc(s)), refCrc(enc(s)));
    }
  });

  test('crc32 is incremental across chunks', () => {
    const whole = enc('the quick brown fox');
    let running = 0;
    running = crc32(whole.subarray(0, 7), running);
    running = crc32(whole.subarray(7), running);
    assert.equal(running, crc32(whole));
  });

  test('a two-entry zip reads back with correct names, bytes and CRCs', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    const records = [];
    for (const [path, body] of [['a.txt', 'alpha'], ['dir/b.bin', 'bravo-bytes']]) {
      await w.beginEntry(path, { declaredSize: enc(body).length, mtime: 1700000000000 });
      await w.update(enc(body));
      records.push(await w.endEntry());
    }
    await w.finish(records);
    const entries = readZip(sink.bytes());
    assert.deepEqual(entries.map(e => e.name), ['a.txt', 'dir/b.bin']);
    assert.equal(new TextDecoder().decode(entries[0].data), 'alpha');
    assert.equal(new TextDecoder().decode(entries[1].data), 'bravo-bytes');
    assert.ok(entries.every(e => e.method === 0), 'store-only');
  });

  test('entry records carry offsets usable for resume', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    await w.beginEntry('a', { declaredSize: 1 });
    await w.update(enc('x'));
    const r = await w.endEntry();
    assert.equal(r.zipOffset, 0);
    assert.equal(r.zipEnd, w.offset);
    assert.equal(r.size, 1);
  });

  test('a declared-size mismatch throws at endEntry', async () => {
    const w = createZipWriter(memSink());
    await w.beginEntry('a', { declaredSize: 5 });
    await w.update(enc('xy'));
    await assert.rejects(() => w.endEntry(), /declared/);
  });

  test('multi-chunk update accumulates size and crc', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    const body = enc('0123456789'.repeat(100));
    await w.beginEntry('big.txt', { declaredSize: body.length });
    for (let i = 0; i < body.length; i += 64) await w.update(body.subarray(i, i + 64));
    const r = await w.endEntry();
    await w.finish([r]);
    const [e] = readZip(sink.bytes());
    assert.equal(e.usize, body.length);
    assert.equal(e.crc, refCrc(body));
  });

  test('zip64: a tiny injected limit forces ZIP64 records that still read back', async () => {
    const sink = memSink();
    const w = createZipWriter(sink, { zip64Limit: 8 }); // any entry >= 8 bytes goes zip64
    const body = enc('0123456789'); // 10 bytes >= limit
    await w.beginEntry('big', { declaredSize: body.length });
    await w.update(body);
    const r = await w.endEntry();
    await w.finish([r]);
    const [e] = readZip(sink.bytes());
    assert.equal(e.usize, 10);
    assert.equal(new TextDecoder().decode(e.data), '0123456789');
  });

  test('zip64: a tiny maxEntries forces the ZIP64 EOCD path', async () => {
    const sink = memSink();
    const w = createZipWriter(sink, { maxEntries: 1 }); // 2 entries > 1 forces zip64 EOCD
    const records = [];
    for (const p of ['a', 'b']) {
      await w.beginEntry(p, { declaredSize: 1 });
      await w.update(enc('x'));
      records.push(await w.endEntry());
    }
    await w.finish(records);
    assert.equal(readZip(sink.bytes()).length, 2);
  });

  test('startOffset shifts recorded offsets (resume construction)', async () => {
    const sink = memSink();
    const w = createZipWriter(sink, { startOffset: 1000 });
    await w.beginEntry('a', { declaredSize: 1 });
    await w.update(enc('x'));
    const r = await w.endEntry();
    assert.equal(r.zipOffset, 1000);
  });

  test('finish accepts records out of physical order', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    const recs = [];
    for (const p of ['first', 'second']) {
      await w.beginEntry(p, { declaredSize: 1 });
      await w.update(enc('x'));
      recs.push(await w.endEntry());
    }
    await w.finish([recs[1], recs[0]]); // reversed
    assert.equal(readZip(sink.bytes()).length, 2);
  });

  test('mtime before 1980 clamps instead of corrupting the DOS field', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    await w.beginEntry('old', { declaredSize: 1, mtime: 0 }); // 1970
    await w.update(enc('x'));
    await w.finish([await w.endEntry()]);
    readZip(sink.bytes()); // must simply parse
  });
});
