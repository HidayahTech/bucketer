import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeZipLayout } from '../src/lib/zip-layout.js';
import { createAssembler } from '../src/lib/zip-assemble.js';
import { createZipWriter } from '../src/lib/zip-writer.js';

function memSink(size = 0) {
  let buf = new Uint8Array(size);
  return {
    write(u8, at) {
      if (at + u8.length > buf.length) { const n = new Uint8Array(at + u8.length); n.set(buf); buf = n; }
      buf.set(u8, at);
    },
    truncate(n) { const nb = new Uint8Array(n); nb.set(buf.subarray(0, Math.min(n, buf.length))); buf = nb; },
    flush() {},
    bytes: () => buf,
  };
}

test('assembler: out-of-order entries produce the same bytes as the serial writer', async () => {
  const items = [
    { key: 'a.txt', size: 3, lastModified: 0 },
    { key: 'b.txt', size: 5, lastModified: 0 },
    { key: 'c.txt', size: 2, lastModified: 0 },
  ];
  const data = { 'a.txt': [65, 66, 67], 'b.txt': [1, 2, 3, 4, 5], 'c.txt': [9, 8] };
  const layout = computeZipLayout(items, '', {});
  const sink = memSink();
  const asm = createAssembler(sink, layout);
  await asm.writeHeaders();
  // feed entries in a DIFFERENT order than layout (c, a, b) — the whole point
  const recs = {};
  for (const key of ['c.txt', 'a.txt', 'b.txt']) {
    await asm.writeChunk(key, new Uint8Array(data[key]));
    const r = await asm.endEntry(key);
    recs[key] = r;
  }
  const records = layout.entries.map((e) => ({ path: e.path, zipOffset: e.headerOffset, size: recs[e.key].size, crc: recs[e.key].crc, time: e.time, date: e.date }));
  await asm.finish(records);

  // Reference: serial writer, SAME (layout/key) order
  const ref = [];
  const w = createZipWriter({ write: (u8) => ref.push(u8.slice()) }, {});
  const refRecs = [];
  for (const it of items) {
    await w.beginEntry(it.key, { declaredSize: it.size });
    await w.update(new Uint8Array(data[it.key]));
    refRecs.push(await w.endEntry());
  }
  await w.finish(refRecs);
  const refBytes = Buffer.concat(ref.map(Buffer.from));
  assert.deepEqual(Buffer.from(sink.bytes()), refBytes);
});

test('assembler: chunked writes accumulate; oversize throws; undersize endEntry throws', async () => {
  const items = [{ key: 'x', size: 4, lastModified: 0 }];
  const layout = computeZipLayout(items, '', {});
  const asm = createAssembler(memSink(), layout);
  await asm.writeHeaders();
  await asm.writeChunk('x', new Uint8Array([1, 2]));
  await asm.writeChunk('x', new Uint8Array([3, 4]));
  const r = await asm.endEntry('x');
  assert.equal(r.size, 4);

  const asm2 = createAssembler(memSink(), layout);
  await asm2.writeHeaders();
  await assert.rejects(async () => { await asm2.writeChunk('x', new Uint8Array([1, 2, 3, 4, 5])); });

  const asm3 = createAssembler(memSink(), layout);
  await asm3.writeHeaders();
  await asm3.writeChunk('x', new Uint8Array([1, 2]));
  await assert.rejects(async () => { await asm3.endEntry('x'); }); // size 2 != 4
});
