// #15 — transient success toasts. Framework-agnostic pub-sub store so any code
// (component handlers, queue callbacks) can raise a toast without prop drilling.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createToastStore } from '../src/lib/toast.js';

describe('toast store (#15)', () => {
  test('show() adds a toast and notifies subscribers', () => {
    const store = createToastStore();
    let seen = null;
    store.subscribe(t => { seen = t; });
    const id = store.show('Saved', { duration: 0 });
    assert.equal(store.get().length, 1);
    assert.equal(store.get()[0].message, 'Saved');
    assert.equal(store.get()[0].id, id);
    assert.equal(seen.length, 1);
  });

  test('each toast gets a unique id', () => {
    const store = createToastStore();
    const a = store.show('a', { duration: 0 });
    const b = store.show('b', { duration: 0 });
    assert.notEqual(a, b);
    assert.equal(store.get().length, 2);
  });

  test('dismiss(id) removes only that toast', () => {
    const store = createToastStore();
    const a = store.show('a', { duration: 0 });
    store.show('b', { duration: 0 });
    store.dismiss(a);
    assert.deepEqual(store.get().map(t => t.message), ['b']);
  });

  test('defaults type to success', () => {
    const store = createToastStore();
    store.show('hi', { duration: 0 });
    assert.equal(store.get()[0].type, 'success');
  });

  test('auto-dismisses after the duration', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const store = createToastStore();
      store.show('bye', { duration: 3000 });
      assert.equal(store.get().length, 1);
      mock.timers.tick(3000);
      assert.equal(store.get().length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  test('subscribe returns an unsubscribe that stops notifications', () => {
    const store = createToastStore();
    let calls = 0;
    const unsub = store.subscribe(() => { calls++; });
    unsub();
    store.show('x', { duration: 0 });
    assert.equal(calls, 1);
  });
});
