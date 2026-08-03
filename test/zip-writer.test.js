// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-writer.js — store-only streaming ZIP64 writer.
//
// The reader (test/helpers/zip-reader.js, shared with zip-job-run.test.js) is the test's
// independent witness: it starts from the EOCD at the end of the buffer (how real
// extractors work), walks the central directory, and checks each local entry + data
// descriptor against it. CRCs are cross-checked with a separate, table-free bitwise
// CRC-32 so a shared table bug cannot self-verify.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createZipWriter, crc32 } from '../src/lib/zip-writer.js';
import { readZip, refCrc } from './helpers/zip-reader.js';

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
