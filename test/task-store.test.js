import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore } from '../src/lib/task-store.js';

// Manual scheduler: captures the flush callback so tests control "frames".
function makeScheduler() {
  const state = { queued: null };
  return {
    state,
    schedule: (fn) => { state.queued = fn; return 1; },
    cancel: () => { state.queued = null; },
    frame: () => { const fn = state.queued; state.queued = null; if (fn) fn(); },
  };
}

function makeStore() {
  const s = makeScheduler();
  return { store: createTaskStore(s.schedule, s.cancel), sched: s };
}

describe('taskStore — add / get / subscribe', () => {
  test('add assigns a unique id and returns it; get() includes the task', () => {
    const { store } = makeStore();
    const id1 = store.add({ kind: 'delete', status: 'running' });
    const id2 = store.add({ kind: 'move', status: 'running' });
    assert.notEqual(id1, id2);
    assert.equal(store.get().length, 2);
    assert.equal(store.get()[0].id, id1);
    assert.equal(store.get()[0].kind, 'delete');
  });

  test('subscribe fires immediately with current tasks and on every add/remove', () => {
    const { store } = makeStore();
    const calls = [];
    store.subscribe(tasks => calls.push(tasks.length));
    assert.deepEqual(calls, [0], 'immediate call with empty list');
    const id = store.add({ kind: 'delete' });
    assert.deepEqual(calls, [0, 1]);
    store.remove(id);
    assert.deepEqual(calls, [0, 1, 0]);
  });

  test('unsubscribe stops notifications', () => {
    const { store } = makeStore();
    const calls = [];
    const unsub = store.subscribe(tasks => calls.push(tasks.length));
    unsub();
    store.add({ kind: 'delete' });
    assert.deepEqual(calls, [0], 'no call after unsubscribe');
  });
});

describe('taskStore — batched updates', () => {
  test('non-urgent updates coalesce until the frame fires', () => {
    const { store, sched } = makeStore();
    const id = store.add({ kind: 'delete', current: 0 });
    store.update(id, { current: 1 });
    store.update(id, { current: 2 });
    assert.equal(store.get()[0].current, 0, 'not applied before frame');
    sched.frame();
    assert.equal(store.get()[0].current, 2, 'last patch wins after frame');
  });

  test('urgent updates flush immediately, preserving pending fields', () => {
    const { store, sched } = makeStore();
    const id = store.add({ kind: 'delete', current: 0, status: 'running' });
    store.update(id, { current: 5 });                    // pending
    store.update(id, { status: 'done' }, true);          // urgent
    assert.equal(store.get()[0].status, 'done');
    assert.equal(store.get()[0].current, 5, 'pending progress not lost by urgent flush');
    sched.frame(); // no-op, nothing pending
  });

  test('pending update for a removed task never reaches subscribers', () => {
    const { store, sched } = makeStore();
    const id = store.add({ kind: 'delete' });
    store.update(id, { current: 1 });
    store.remove(id);
    sched.frame();
    assert.equal(store.get().length, 0);
  });

  test('remove with pending updates notifies subscribers exactly once', () => {
    const { store } = makeStore();
    const id = store.add({ kind: 'delete' });
    const calls = [];
    store.subscribe(tasks => calls.push(tasks.length));
    store.update(id, { current: 1 });
    store.remove(id);
    assert.deepEqual(calls, [1, 0], 'one notification for the remove, none for the flushed patch');
  });
});

describe('taskStore — cancellation registry', () => {
  test('requestCancel marks the task and isCancelRequested reflects it synchronously', () => {
    const { store } = makeStore();
    const id = store.add({ kind: 'delete', cancelRequested: false });
    assert.equal(store.isCancelRequested(id), false);
    store.requestCancel(id);
    assert.equal(store.isCancelRequested(id), true, 'synchronous — engines poll this between batches');
    assert.equal(store.get()[0].cancelRequested, true, 'urgent patch applied for UI');
  });

  test('remove clears the cancel-request entry', () => {
    const { store } = makeStore();
    const id = store.add({ kind: 'delete' });
    store.requestCancel(id);
    store.remove(id);
    assert.equal(store.isCancelRequested(id), false);
  });
});
