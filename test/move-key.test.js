import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { destKeyForFile, folderBase, destKeyForFolderObject } from '../src/lib/move-key.js';

// S3 has no move/rename — a move recomputes each object's key under a new prefix.
// These pure functions are the heart of that remapping. Getting them wrong silently
// scatters objects to the wrong keys, so every worked example is pinned here.

describe('destKeyForFile', () => {
  test('moves a loose file into the destination, keeping its leaf name', () => {
    assert.equal(destKeyForFile('reports/q1.pdf', 'archive/'), 'archive/q1.pdf');
  });

  test('moves a root-level file into a folder', () => {
    assert.equal(destKeyForFile('notes.txt', 'archive/'), 'archive/notes.txt');
  });

  test('moves a nested file into the root (empty destination)', () => {
    assert.equal(destKeyForFile('reports/q1.pdf', ''), 'q1.pdf');
  });
});

describe('folderBase', () => {
  test('is the parent of the folder, so the folder name is preserved', () => {
    assert.equal(folderBase('photos/2024/'), 'photos/');
  });

  test('is empty for a top-level folder', () => {
    assert.equal(folderBase('docs/'), '');
  });
});

describe('destKeyForFolderObject', () => {
  const dest = 'archive/';

  test('preserves the moved folder name under the destination', () => {
    assert.equal(
      destKeyForFolderObject('photos/2024/', 'photos/2024/jan/a.jpg', dest),
      'archive/2024/jan/a.jpg',
    );
  });

  test('remaps the folder-marker object itself', () => {
    assert.equal(
      destKeyForFolderObject('photos/2024/', 'photos/2024/', dest),
      'archive/2024/',
    );
  });

  test('preserves deeply nested sub-prefix structure', () => {
    assert.equal(
      destKeyForFolderObject('photos/2024/', 'photos/2024/jan/sub/b.png', dest),
      'archive/2024/jan/sub/b.png',
    );
  });

  test('preserves a top-level folder name when moved', () => {
    assert.equal(
      destKeyForFolderObject('docs/', 'docs/readme.md', dest),
      'archive/docs/readme.md',
    );
  });

  test('moves a folder into the root (empty destination)', () => {
    assert.equal(
      destKeyForFolderObject('photos/2024/', 'photos/2024/a.jpg', ''),
      '2024/a.jpg',
    );
  });
});
