import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateMove, validateCopy } from '../src/lib/move-guards.js';

// Structural guards that depend ONLY on the selected keys and chosen destination
// (not on what the destination actually contains — that's the runtime collision
// check). These run synchronously in the picker to disable "Move here" with a reason.

describe('validateMove — invalid moves return an error string', () => {
  test('blocks moving a folder into itself', () => {
    const err = validateMove({ files: [], prefixes: ['photos/'], dest: 'photos/' });
    assert.equal(typeof err, 'string');
    assert.ok(err.length > 0);
  });

  test('blocks moving a folder into one of its own descendants', () => {
    const err = validateMove({ files: [], prefixes: ['photos/'], dest: 'photos/2024/' });
    assert.ok(err, 'moving photos/ into photos/2024/ must be blocked');
  });

  test('blocks moving a folder into its current parent (no-op)', () => {
    const err = validateMove({ files: [], prefixes: ['photos/2024/'], dest: 'photos/' });
    assert.ok(err, 'folder is already in photos/');
  });

  test('blocks moving a file into its current prefix (no-op / rename)', () => {
    const err = validateMove({ files: ['photos/2024/a.jpg'], prefixes: [], dest: 'photos/2024/' });
    assert.ok(err, 'file is already in photos/2024/');
  });

  test('blocks a root-level file moved back to root', () => {
    const err = validateMove({ files: ['notes.txt'], prefixes: [], dest: '' });
    assert.ok(err, 'notes.txt is already at root');
  });
});

describe('validateMove — valid moves return null', () => {
  test('folder to an unrelated destination', () => {
    assert.equal(validateMove({ files: [], prefixes: ['photos/'], dest: 'archive/' }), null);
  });

  test('file to a different prefix', () => {
    assert.equal(validateMove({ files: ['reports/q1.pdf'], prefixes: [], dest: 'archive/' }), null);
  });

  test('file and folder together to root', () => {
    assert.equal(validateMove({ files: ['reports/q1.pdf'], prefixes: ['photos/2024/'], dest: '' }), null);
  });

  test('does NOT false-block a sibling whose name merely shares a string prefix', () => {
    // 'photos/' vs 'photo/' — descendant check must use trailing-slash prefixes so
    // 'photos/' is not treated as inside 'photo/'.
    assert.equal(validateMove({ files: [], prefixes: ['photo/'], dest: 'photos/' }), null);
    assert.equal(validateMove({ files: [], prefixes: ['photos/'], dest: 'photo/' }), null);
  });
});

// #17 — copy guards are looser than move: copying to the current location is valid
// (it produces a renamed duplicate), so only the into-itself/descendant guard remains.
describe('validateCopy', () => {
  test('blocks copying a folder into itself or a descendant', () => {
    assert.ok(validateCopy({ prefixes: ['photos/'], dest: 'photos/' }));
    assert.ok(validateCopy({ prefixes: ['photos/'], dest: 'photos/2024/' }));
  });

  test('ALLOWS copying a folder into its current parent (a duplicate, not a no-op)', () => {
    assert.equal(validateCopy({ prefixes: ['photos/2024/'], dest: 'photos/' }), null);
  });

  test('ALLOWS copying a file into its current prefix (a renamed duplicate)', () => {
    assert.equal(validateCopy({ files: ['photos/a.jpg'], prefixes: [], dest: 'photos/' }), null);
  });

  test('allows a copy to an unrelated destination', () => {
    assert.equal(validateCopy({ prefixes: ['photos/'], dest: 'archive/' }), null);
  });

  test('does NOT false-block a sibling sharing a string prefix', () => {
    assert.equal(validateCopy({ prefixes: ['photo/'], dest: 'photos/' }), null);
  });
});
