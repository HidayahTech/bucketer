// Tests for collectFileEntries() — FileSystemEntry tree traversal.
//
// collectFileEntries() recursively walks drag-and-drop FileSystemEntry trees.
// The key invariant: it must call readEntries() in a loop until the batch is
// empty. The Directory Reader API returns at most 100 entries per call; stopping
// after the first call would silently drop files in large directories.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectFileEntries } from '../src/lib/file-entries.js';

// ── Mock FileSystemEntry helpers ──────────────────────────────────────────────

function makeFile(name, content = 'x') {
  const file = new Blob([content]);
  Object.defineProperty(file, 'name', { value: name });
  return file;
}

function fileEntry(name, content) {
  const file = makeFile(name, content);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok, _err) => ok(file),
  };
}

// Simulates a DirectoryReader that returns entries in batches of `batchSize`.
// Real browsers return at most 100 per call; the empty batch signals exhaustion.
function directoryEntry(name, entries, batchSize = 100) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (ok, _err) => {
          const batch = entries.slice(offset, offset + batchSize);
          offset += batchSize;
          ok(batch);
        },
      };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('collectFileEntries — flat file list', () => {
  test('returns a single file entry', async () => {
    const result = await collectFileEntries([fileEntry('a.txt')]);
    assert.equal(result.length, 1);
    assert.equal(result[0].relativePath, 'a.txt');
  });

  test('returns multiple file entries in order', async () => {
    const entries = ['a.txt', 'b.jpg', 'c.mp4'].map(fileEntry);
    const result = await collectFileEntries(entries);
    assert.deepEqual(result.map(r => r.relativePath), ['a.txt', 'b.jpg', 'c.mp4']);
  });

  test('returns empty array for empty input', async () => {
    assert.deepEqual(await collectFileEntries([]), []);
  });
});

describe('collectFileEntries — folder traversal', () => {
  test('flattens a single level of nesting with correct paths', async () => {
    const folder = directoryEntry('photos', [
      fileEntry('a.jpg'), fileEntry('b.jpg'),
    ]);
    const result = await collectFileEntries([folder]);
    assert.deepEqual(result.map(r => r.relativePath).sort(), ['photos/a.jpg', 'photos/b.jpg']);
  });

  test('traverses deeply nested folders', async () => {
    const inner = directoryEntry('inner', [fileEntry('deep.txt')]);
    const outer = directoryEntry('outer', [inner, fileEntry('top.txt')]);
    const result = await collectFileEntries([outer]);
    const paths = result.map(r => r.relativePath).sort();
    assert.ok(paths.includes('outer/inner/deep.txt'), 'deep file must be included');
    assert.ok(paths.includes('outer/top.txt'),        'shallow file must be included');
    assert.equal(result.length, 2);
  });

  test('mixes files and folders at the root level', async () => {
    const entries = [
      fileEntry('root.txt'),
      directoryEntry('sub', [fileEntry('child.txt')]),
    ];
    const result = await collectFileEntries(entries);
    const paths = result.map(r => r.relativePath).sort();
    assert.ok(paths.includes('root.txt'),      'root file must be present');
    assert.ok(paths.includes('sub/child.txt'), 'folder child must be present');
    assert.equal(result.length, 2);
  });
});

describe('collectFileEntries — readEntries pagination (>100 files)', () => {
  // Critical invariant: the Directory Reader API returns at most 100 entries per
  // readEntries() call. collectFileEntries() must loop until the batch is empty —
  // not stop after the first call. Stopping early would silently drop files.

  test('collects all 150 files from a folder that returns them in two batches', async () => {
    const files = Array.from({ length: 150 }, (_, i) => fileEntry(`file-${i}.txt`));
    const folder = directoryEntry('big', files, 100); // 100 per readEntries call
    const result = await collectFileEntries([folder]);
    assert.equal(result.length, 150, 'all 150 files must be collected across both batches');
  });

  test('collects all 250 files spread across three batches', async () => {
    const files = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.jpg`));
    const folder = directoryEntry('huge', files, 100);
    const result = await collectFileEntries([folder]);
    assert.equal(result.length, 250, 'all 250 files must be collected');
  });

  test('paths include the folder prefix even for large directories', async () => {
    const files = Array.from({ length: 120 }, (_, i) => fileEntry(`img-${i}.png`));
    const folder = directoryEntry('gallery', files, 100);
    const result = await collectFileEntries([folder]);
    assert.ok(result.every(r => r.relativePath.startsWith('gallery/')),
      'all paths must carry the folder prefix');
  });
});

describe('collectFileEntries — error resilience', () => {
  // Unreadable files resolve without throwing — the entry is silently skipped.
  test('skips unreadable files without throwing', async () => {
    const unreadable = {
      isFile: true,
      isDirectory: false,
      name: 'broken.bin',
      file: (_ok, err) => err(new Error('permission denied')),
    };
    const result = await collectFileEntries([unreadable, fileEntry('good.txt')]);
    assert.equal(result.length, 1);
    assert.equal(result[0].relativePath, 'good.txt');
  });
});
