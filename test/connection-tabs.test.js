// Tests for src/lib/connection-tabs.js — the pure MRU logic behind the header
// quick-switch tab-strip. touchMru maintains a most-recently-used order of connection
// ids; deriveTabs projects that order onto the current connections, dropping stale ids
// and capping the visible count.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { touchMru, deriveTabs } from '../src/lib/connection-tabs.js';

describe('touchMru', () => {
  test('adds a new id to the front', () => {
    assert.deepEqual(touchMru([2, 3], 1), [1, 2, 3]);
  });

  test('moves an existing id to the front without duplicating it', () => {
    assert.deepEqual(touchMru([1, 2, 3], 3), [3, 1, 2]);
  });

  test('a no-op re-touch of the front leaves order unchanged', () => {
    assert.deepEqual(touchMru([1, 2, 3], 1), [1, 2, 3]);
  });
});

describe('deriveTabs', () => {
  const conns = [
    { id: 1, bucket: 'photos' },
    { id: 2, bucket: 'backups' },
    { id: 3, bucket: 'assets' },
  ];

  test('projects mru ids onto connections in mru order', () => {
    assert.deepEqual(deriveTabs([3, 1], conns, 6).map(c => c.id), [3, 1]);
  });

  test('drops mru ids that no longer resolve to a connection', () => {
    assert.deepEqual(deriveTabs([9, 2, 8], conns, 6).map(c => c.id), [2]);
  });

  test('caps the number of tabs', () => {
    assert.equal(deriveTabs([1, 2, 3], conns, 2).length, 2);
    assert.deepEqual(deriveTabs([1, 2, 3], conns, 2).map(c => c.id), [1, 2]);
  });

  test('an empty mru yields no tabs', () => {
    assert.deepEqual(deriveTabs([], conns, 6), []);
  });
});
