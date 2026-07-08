// Copyright (C) 2026 HidayahTech, LLC
// Master-queue task store (docs/intent/master-queue.md §5.2) — module-level
// pub-sub, same pattern as toast.js, so any code can enqueue and observe tasks
// without prop drilling. MasterQueue.jsx subscribes and renders.
//
// Progress updates route through createUpdateBatcher so per-object onProgress
// storms (8-concurrent move workers, delete batch groups) cost at most one
// re-render per animation frame; urgent patches (status transitions, cancel
// requests) flush immediately.
//
// Cancel requests live in a Set beside the batcher, not behind it: engines poll
// isCancelRequested() between batches and must see the request synchronously.
//
// createTaskStore(scheduleFlush, cancelFlush) returns an isolated store (tests
// inject a manual scheduler); the module also exports a shared singleton bound
// to requestAnimationFrame (setTimeout fallback keeps Node imports working).
import { createUpdateBatcher } from './update-batcher.js';

export function createTaskStore(scheduleFlush, cancelFlush) {
  let tasks = [];
  let nextId = 1;
  const listeners = new Set();
  const cancelRequests = new Set();
  let suppressEmit = false;
  const emit = () => { if (suppressEmit) return; for (const l of listeners) l(tasks); };

  const batcher = createUpdateBatcher(
    (fn) => { tasks = fn(tasks); emit(); },
    scheduleFlush,
    cancelFlush,
  );

  const add = (task) => {
    const id = `task-${nextId++}`;
    tasks = [...tasks, { ...task, id }];
    emit();
    return id;
  };

  const update = (id, patch, urgent = false) => batcher.update(id, patch, urgent);

  const remove = (id) => {
    // Apply pending patches without notifying — remove is one logical event
    // and must emit exactly once.
    suppressEmit = true;
    batcher.flush();
    suppressEmit = false;
    cancelRequests.delete(id);
    tasks = tasks.filter(t => t.id !== id);
    emit();
  };

  const requestCancel = (id) => {
    cancelRequests.add(id);
    update(id, { cancelRequested: true }, true);
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    fn(tasks);
    return () => listeners.delete(fn);
  };

  return {
    subscribe,
    get: () => tasks,
    add,
    update,
    remove,
    requestCancel,
    isCancelRequested: (id) => cancelRequests.has(id),
    flush: batcher.flush,
  };
}

const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);
const caf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame
  : clearTimeout;
export const taskStore = createTaskStore(raf, caf);
