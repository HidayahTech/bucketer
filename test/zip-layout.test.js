import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localHeaderBytes, dataDescriptorBytes, dosDateTime, createZipWriter } from '../src/lib/zip-writer.js';
import { computeZipLayout } from '../src/lib/zip-layout.js';

test('localHeaderBytes: 30 + name length, independent of size', () => {
  const b = localHeaderBytes('a/b.txt', { time: 0, date: 0x21 });
  assert.equal(b.length, 30 + new TextEncoder().encode('a/b.txt').length);
  assert.equal(new DataView(b.buffer).getUint32(0, true), 0x04034b50); // SIG_LOCAL
});

test('dataDescriptorBytes: 16 non-zip64, 24 zip64', () => {
  assert.equal(dataDescriptorBytes({ crc: 1, size: 10, zip64: false }).length, 16);
  assert.equal(dataDescriptorBytes({ crc: 1, size: 10, zip64: true }).length, 24);
});

test('computeZipLayout: offsets chain, gapless, key order preserved', () => {
  const items = [
    { key: 'p/a.txt', size: 3, lastModified: 0 },
    { key: 'p/b.bin', size: 5, lastModified: 0 },
  ];
  const { entries, centralDirOffset, totalDataEnd } = computeZipLayout(items, 'p/', {});
  assert.equal(entries[0].headerOffset, 0);
  assert.equal(entries[0].dataOffset, entries[0].headerOffset + entries[0].headerBytes);
  assert.equal(entries[0].descriptorOffset, entries[0].dataOffset + 3);
  assert.equal(entries[0].entryEnd, entries[0].descriptorOffset + 16);
  assert.equal(entries[1].headerOffset, entries[0].entryEnd); // gapless chain
  assert.equal(entries[1].descriptorOffset, entries[1].dataOffset + 5);
  assert.equal(centralDirOffset, entries[1].entryEnd);
  assert.equal(totalDataEnd, centralDirOffset);
  assert.equal(entries[0].path, 'a.txt'); // prefix stripped
});

test('computeZipLayout: >4GiB entry is zip64 with a 24-byte descriptor', () => {
  const items = [{ key: 'big', size: 0x100000000, lastModified: 0 }];
  const { entries } = computeZipLayout(items, '', {});
  assert.equal(entries[0].zip64, true);
  assert.equal(entries[0].descriptorBytes, 24);
});

// Cross-check: in-place layout + a manual assemble must equal createZipWriter's bytes
// for the SAME order. Proven fully in Task 3; here just assert the layout's data offsets
// match where a serial append writer would place each entry's data.
test('computeZipLayout matches serial writer entry offsets for same order', async () => {
  const items = [
    { key: 'a.txt', size: 2, lastModified: 0 },
    { key: 'b.txt', size: 4, lastModified: 0 },
  ];
  const { entries } = computeZipLayout(items, '', {});
  const chunks = [];
  const w = createZipWriter({ write: (u8) => { chunks.push(u8.slice()); } }, {});
  const recs = [];
  for (const it of items) {
    const off = w.offset;
    await w.beginEntry(it.key, { declaredSize: it.size });
    await w.update(new Uint8Array(it.size).fill(65));
    recs.push({ ...(await w.endEntry()), start: off });
  }
  assert.equal(recs[0].start, entries[0].headerOffset);
  assert.equal(recs[1].start, entries[1].headerOffset);
});
