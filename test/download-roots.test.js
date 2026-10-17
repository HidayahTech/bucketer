// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-roots.js — the multi-root scope vocabulary.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT_TYPES,
  fileRoot,
  prefixRoot,
  normalizeRoots,
  rootsOfJob,
  selectionLabel,
  isQuickZipSelection,
} from '../src/lib/download-roots.js';
import { MEDIUM_MAX } from '../src/lib/zip-prefetch.js';

const obj = (Key, Size = 10, StorageClass = null) => ({
  Key,
  Size,
  ETag: `"${Key}"`,
  LastModified: new Date(1700000000000),
  StorageClass,
});

describe('fileRoot', () => {
  test('captures everything the listing row knew', () => {
    assert.deepEqual(fileRoot(obj('a/b.txt', 42, 'GLACIER')), {
      type: ROOT_TYPES.FILE,
      key: 'a/b.txt',
      size: 42,
      etag: '"a/b.txt"',
      lastModified: 1700000000000,
      storageClass: 'GLACIER',
    });
  });
  test('tolerates missing size, date and class', () => {
    const r = fileRoot({ Key: 'x' });
    assert.equal(r.size, 0);
    assert.equal(r.lastModified, null);
    assert.equal(r.storageClass, null);
  });
});

describe('normalizeRoots', () => {
  test('prefixes come first, then files, order preserved', () => {
    const roots = normalizeRoots({ files: [obj('z.txt'), obj('a.txt')], prefixes: ['p2/', 'p1/'] });
    assert.deepEqual(
      roots.map((r) => (r.type === 'prefix' ? r.prefix : r.key)),
      ['p2/', 'p1/', 'z.txt', 'a.txt'],
    );
  });
  test('a file under a selected prefix is dropped — the crawl will produce it', () => {
    const roots = normalizeRoots({ files: [obj('photos/x.jpg'), obj('other.txt')], prefixes: ['photos/'] });
    assert.deepEqual(
      roots.map((r) => (r.type === 'prefix' ? r.prefix : r.key)),
      ['photos/', 'other.txt'],
    );
  });
  test('empty selection normalizes to no roots', () => {
    assert.deepEqual(normalizeRoots({ files: [], prefixes: [] }), []);
  });
});

describe('rootsOfJob', () => {
  test('prefers explicit roots', () => {
    const roots = [prefixRoot('p/')];
    assert.equal(rootsOfJob({ roots, prefix: 'ignored/' }), roots);
  });
  test('a legacy prefix-only job reads as one prefix root', () => {
    assert.deepEqual(rootsOfJob({ prefix: 'photos/' }), [{ type: ROOT_TYPES.PREFIX, prefix: 'photos/' }]);
  });
  test('a legacy job with no prefix at all reads as the bucket root', () => {
    assert.deepEqual(rootsOfJob({}), [{ type: ROOT_TYPES.PREFIX, prefix: '' }]);
  });
});

describe('selectionLabel', () => {
  test('pluralizes and names the capture location', () => {
    assert.equal(selectionLabel(3, 'bkt', 'photos/'), '3 selected items in bkt/photos/');
    assert.equal(selectionLabel(1, 'bkt', ''), '1 selected item in bkt');
  });
});

// Slice 4b: a small selection of files downloads as a ZIP straight away, without the panel.
describe('isQuickZipSelection', () => {
  test('two or more files within the medium tier qualify', () => {
    assert.equal(isQuickZipSelection({ files: [obj('a'), obj('b')], prefixes: [] }), true);
    const half = MEDIUM_MAX / 2;
    assert.equal(isQuickZipSelection({ files: [obj('a', half), obj('b', half)], prefixes: [] }), true);
  });
  test('one file does not: it downloads directly, not as a ZIP', () => {
    assert.equal(isQuickZipSelection({ files: [obj('a')], prefixes: [] }), false);
  });
  test('any folder keeps the panel: its size is unknown until listed', () => {
    assert.equal(isQuickZipSelection({ files: [obj('a'), obj('b')], prefixes: ['p/'] }), false);
  });
  test('a total above the medium tier keeps the panel', () => {
    assert.equal(isQuickZipSelection({ files: [obj('a', MEDIUM_MAX), obj('b', 1)], prefixes: [] }), false);
  });
});
