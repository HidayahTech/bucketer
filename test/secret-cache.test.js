// Tests for src/lib/secret-cache.js — an in-memory, per-tab store of secrets keyed by
// credential id, so switching back to an account used this session does not re-prompt.
// Never persisted (no localStorage/sessionStorage) — pure module state.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheSecret, getCachedSecret, forgetCachedSecret, clearSecretCache,
} from '../src/lib/secret-cache.js';

beforeEach(() => clearSecretCache());

describe('secret-cache', () => {
  test('caching a secret makes it retrievable by credential id', () => {
    cacheSecret('credA', 's3cr3t');
    assert.equal(getCachedSecret('credA'), 's3cr3t');
  });

  test('an unknown credential id returns null', () => {
    assert.equal(getCachedSecret('nope'), null);
  });

  test('caching an empty/falsy secret stores nothing', () => {
    cacheSecret('credA', '');
    cacheSecret('credB', null);
    cacheSecret('credC', undefined);
    assert.equal(getCachedSecret('credA'), null);
    assert.equal(getCachedSecret('credB'), null);
    assert.equal(getCachedSecret('credC'), null);
  });

  test('secrets are isolated per credential id', () => {
    cacheSecret('credA', 'aaa');
    cacheSecret('credB', 'bbb');
    assert.equal(getCachedSecret('credA'), 'aaa');
    assert.equal(getCachedSecret('credB'), 'bbb');
  });

  test('forgetCachedSecret removes one, leaving others', () => {
    cacheSecret('credA', 'aaa');
    cacheSecret('credB', 'bbb');
    forgetCachedSecret('credA');
    assert.equal(getCachedSecret('credA'), null);
    assert.equal(getCachedSecret('credB'), 'bbb');
  });

  test('clearSecretCache empties everything', () => {
    cacheSecret('credA', 'aaa');
    cacheSecret('credB', 'bbb');
    clearSecretCache();
    assert.equal(getCachedSecret('credA'), null);
    assert.equal(getCachedSecret('credB'), null);
  });
});
