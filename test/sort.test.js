import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nameComparator, numericComparator } from '../src/lib/sort.js';

describe('nameComparator', () => {
  test('ascending: a before b', () => {
    const cmp = nameComparator('asc');
    assert.ok(cmp('apple', 'banana') < 0);
    assert.ok(cmp('banana', 'apple') > 0);
  });

  test('ascending: equal names return 0', () => {
    const cmp = nameComparator('asc');
    assert.equal(cmp('apple', 'apple'), 0);
  });

  test('descending: reverses order', () => {
    const cmp = nameComparator('desc');
    assert.ok(cmp('apple', 'banana') > 0);
    assert.ok(cmp('banana', 'apple') < 0);
  });

  test('case-insensitive (sensitivity: base)', () => {
    const cmp = nameComparator('asc');
    assert.equal(cmp('Apple', 'apple'), 0);
    assert.equal(cmp('BANANA', 'banana'), 0);
  });

  test('numbers sort lexicographically as strings', () => {
    const cmp = nameComparator('asc');
    // '10' < '9' lexicographically — this is expected for name sort
    const sorted = ['9.txt', '10.txt', '2.txt'].sort(cmp);
    assert.deepEqual(sorted, ['10.txt', '2.txt', '9.txt']);
  });
});

describe('numericComparator', () => {
  test('ascending: smaller number first', () => {
    const cmp = numericComparator('asc');
    assert.ok(cmp(1, 10) < 0);
    assert.ok(cmp(10, 1) > 0);
  });

  test('ascending: equal values return 0', () => {
    const cmp = numericComparator('asc');
    assert.equal(cmp(5, 5), 0);
  });

  test('descending: reverses order', () => {
    const cmp = numericComparator('desc');
    assert.ok(cmp(1, 10) > 0);
    assert.ok(cmp(10, 1) < 0);
  });

  test('handles zero and negative values', () => {
    const cmp = numericComparator('asc');
    assert.ok(cmp(0, 1) < 0);
    assert.ok(cmp(-1, 0) < 0);
    assert.equal(cmp(0, 0), 0);
  });
});
