import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localHeaderBytes, dataDescriptorBytes, dosDateTime, createZipWriter } from '../src/lib/zip-writer.js';
import { computeZipLayout } from '../src/lib/zip-layout.js';
import { allocateZipPaths } from '../src/lib/zip-naming.js';

test('localHeaderBytes: 30 + name length, independent of size', () => {
  const b = localHeaderBytes('a/b.txt', { time: 0, date: 0x21 });
  assert.equal(b.length, 30 + new TextEncoder().encode('a/b.txt').length);
  assert.equal(new DataView(b.buffer).getUint32(0, true), 0x04034b50); // SIG_LOCAL
});

test('localHeaderBytes: length fixed at 30 + name regardless of zip64; version-needed flags it', () => {
  const nonZip64 = localHeaderBytes('a/b.txt', { time: 0, date: 0x21, zip64: false });
  const zip64 = localHeaderBytes('a/b.txt', { time: 0, date: 0x21, zip64: true });
  const nameLen = new TextEncoder().encode('a/b.txt').length;
  assert.equal(nonZip64.length, 30 + nameLen);
  assert.equal(zip64.length, 30 + nameLen);
  assert.equal(new DataView(nonZip64.buffer).getUint16(4, true), 20); // version needed
  assert.equal(new DataView(zip64.buffer).getUint16(4, true), 45); // version needed
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
  const w = createZipWriter(
    {
      write: (u8) => {
        chunks.push(u8.slice());
      },
    },
    {},
  );
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

// #79 (R06): allocateZipPaths gives every key a distinct archive path.

test('allocateZipPaths: sanitizer collisions get " (n)" suffixes; unique keys are untouched', () => {
  const m = allocateZipPaths(['p/a:b.txt', 'p/a?b.txt', 'p/plain.txt'], 'p/');
  assert.equal(m.get('p/plain.txt'), 'plain.txt');
  assert.deepEqual([m.get('p/a:b.txt'), m.get('p/a?b.txt')].sort(), ['a_b (1).txt', 'a_b.txt']);
});

test('allocateZipPaths: a file never takes a path that is a folder in the archive', () => {
  const m = allocateZipPaths(['docs', 'docs/inner.txt']);
  assert.equal(m.get('docs/inner.txt'), 'docs/inner.txt');
  assert.equal(m.get('docs'), 'docs (1)');
});

test('allocateZipPaths: case-only differences are kept apart', () => {
  const m = allocateZipPaths(['A.txt', 'a.txt']);
  assert.notEqual(m.get('A.txt').toLowerCase(), m.get('a.txt').toLowerCase());
});

test('allocateZipPaths: deterministic regardless of input order (resume / engine fallback)', () => {
  const keys = ['x/a:b', 'x/a?b', 'x/a|b', 'x/Q', 'x/q'];
  const a = allocateZipPaths(keys, 'x/');
  const b = allocateZipPaths([...keys].reverse(), 'x/');
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test('computeZipLayout: colliding keys get distinct entry paths (#79)', () => {
  const { entries } = computeZipLayout([
    { key: 'a:b.txt', size: 3 },
    { key: 'a?b.txt', size: 3 },
  ]);
  assert.equal(new Set(entries.map((e) => e.path)).size, 2);
});
