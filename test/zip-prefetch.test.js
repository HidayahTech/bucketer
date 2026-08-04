// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, TINY_MAX, MEDIUM_MAX, CONCURRENCY } from '../src/lib/zip-prefetch.js';

describe('classifyTier', () => {
  test('tiny/medium/solo boundaries', () => {
    assert.equal(classifyTier(0), 'memory');
    assert.equal(classifyTier(TINY_MAX), 'memory');
    assert.equal(classifyTier(TINY_MAX + 1), 'temp');
    assert.equal(classifyTier(MEDIUM_MAX), 'temp');
    assert.equal(classifyTier(MEDIUM_MAX + 1), 'solo');
  });
  test('missing size is bufferable', () => {
    assert.equal(classifyTier(undefined), 'memory');
    assert.equal(classifyTier(null), 'memory');
  });
  test('default concurrency is 4', () => { assert.equal(CONCURRENCY, 4); });
});
