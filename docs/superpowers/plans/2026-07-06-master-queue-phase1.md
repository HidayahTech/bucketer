# Master Queue Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the twin DeleteQueue/MoveQueue panels with a single MasterQueue panel backed by a module-level task store, with confirmation extracted to a pre-queue modal, cooperative cancellation for delete/move/copy, and finished rows that persist until dismissed.

**Architecture:** A subscribable `taskStore` (toast.js pub-sub pattern + the existing RAF `update-batcher`) owns all task state. Pure adapter functions in `queue-tasks.js` translate the untouched engines' progress vocabulary (`deleted`/`moved`, phase names) into task patches. `MasterQueue.jsx` subscribes to the store and drives its own controls (cancel/collapse/dismiss) against it — App only creates tasks and runs engines. Spec: `docs/intent/master-queue.md` (§5, §7 Phase 1).

**Tech Stack:** Preact + hooks, plain JS libs, `node --test` unit tests, jsdom component tests (`npm run test:ui`), Playwright e2e (pre-push).

## Global Constraints

- **Engines keep their progress vocabulary** — `delete-queue.js` emits `deleted`, `move-queue.js` emits `moved`; adapters translate. Do not rename engine fields (unit tests depend on them).
- **Preserve user-visible strings exactly**: `Listing folder contents…`, `Checking destination…`, `Deleting/Deleted`, `Moving/Moved`, `Copying/Copied`, `· N skipped`, `· N error(s)`, all confirm-dialog titles and the three provider versioning caveats.
- **Preserve `data-testid="delete-confirm"`** on the confirm button (e2e: `smoke.test.mjs:66`, `batch.test.mjs:56`, `versioning.test.mjs:44` click it).
- **Cancellation is cooperative and batch-boundary honest**: work already in flight completes; `cancelled: true` on the done update only when work was actually skipped.
- **`cancelled` runs must not report unattempted prefixes as completed** — completed-prefix computation switches from "no errors" to "every key confirmed deleted/moved".
- **Retention change (intentional, changelog-worthy)**: finished rows persist until dismissed (no 3-second auto-remove). Success toasts stay.
- **Repo commit convention**: ONE commit for the whole phase, containing the version bump + CHANGELOG entry (matches the one-commit-per-version history). Task steps therefore end in "run tests" checkpoints, not commits — deviation from the usual plan format, per operator workflow rules (always ask before committing; bump every change that lands).
- **Node test runner**: unit tests `npm test` (runs `node --test test/*.test.js` + build tests); component tests `npm run test:ui`. Component test files MUST start with `import '../helpers/with-dom.js'`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/task-store.js` | Create | Module-level pub-sub task store, RAF-batched updates, cancel-request registry |
| `src/lib/queue-tasks.js` | Create | Task factories + engine-update→task-patch adapter (pure, Node-testable) |
| `src/lib/delete-queue.js` | Modify | `shouldCancel` param; `deletedKeySet`-based `deletedPrefixes`; `cancelled` flag |
| `src/lib/move-queue.js` | Modify | Same for move/copy |
| `src/components/DeleteConfirmModal.jsx` | Create | Pre-queue confirmation modal (extracted from DeleteQueue) |
| `src/components/MasterQueue.jsx` | Create | Unified panel; subscribes to taskStore; generic row + error list |
| `src/components/App.jsx` | Modify | `pendingDelete` state; task creation + engine wiring; drop deleteOps/moveOps |
| `src/components/DeleteQueue.jsx` | Delete | Superseded |
| `src/components/MoveQueue.jsx` | Delete | Superseded |
| `src/styles/main.css` | Modify | Replace `.delete-*`/`.move-op*` blocks with one `.queue-*` block |
| `test/task-store.test.js` | Create | Store behavior |
| `test/queue-tasks.test.js` | Create | Factories + adapter |
| `test/delete-queue.test.js` | Modify | Append cancellation tests |
| `test/move-queue.test.js` | Modify | Append cancellation tests |
| `test/components/delete-confirm-modal.test.jsx` | Create | Port of confirm-dialog tests |
| `test/components/master-queue.test.jsx` | Create | Unified panel tests (ports active-op tests from both old files + cancel/dismiss-all) |
| `test/components/delete-queue.test.jsx` | Delete | Split into the two files above |
| `test/components/move-queue.test.jsx` | Delete | Superseded by master-queue tests |
| `CHANGELOG.md` + `package.json` | Modify | v1.35.0 entry + bump (operator confirms level first) |

---

### Task 1: Task store (`src/lib/task-store.js`)

**Files:**
- Create: `src/lib/task-store.js`
- Test: `test/task-store.test.js`

**Interfaces:**
- Consumes: `createUpdateBatcher(setItems, scheduleFlush, cancelFlush)` from `src/lib/update-batcher.js` (existing; patches items matched by `it.id`).
- Produces: `createTaskStore(scheduleFlush, cancelFlush)` → `{ subscribe(fn)→unsub, get()→tasks[], add(task)→id, update(id, patch, urgent=false), remove(id), requestCancel(id), isCancelRequested(id)→bool, flush() }`; module singleton `taskStore` bound to rAF (setTimeout fallback so Node import works).

- [ ] **Step 1: Write the failing test**

Create `test/task-store.test.js`:

```js
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

  test('update for a removed task is dropped silently', () => {
    const { store, sched } = makeStore();
    const id = store.add({ kind: 'delete' });
    store.update(id, { current: 1 });
    store.remove(id);
    sched.frame();
    assert.equal(store.get().length, 0);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/task-store.test.js`
Expected: FAIL — `Cannot find module '.../src/lib/task-store.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/task-store.js`:

```js
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
  const emit = () => { for (const l of listeners) l(tasks); };

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
    batcher.flush(); // apply pending patches first so none resurrect after removal
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/task-store.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Checkpoint — full unit suite still green**

Run: `npm test`
Expected: PASS (no existing test touches these files; failures here mean an accidental edit elsewhere)

---

### Task 2: Task factories + adapter (`src/lib/queue-tasks.js`)

**Files:**
- Create: `src/lib/queue-tasks.js`
- Test: `test/queue-tasks.test.js`

**Interfaces:**
- Produces:
  - `subjectLabel(fileCount, prefixCount)` → `'2 files and 1 folder'`
  - `createDeleteTask({ files, prefixes, capturedPrefix, bucket })` → task object (no id; store assigns)
  - `createTransferTask({ files, prefixes, dest, capturedPrefix, bucket, mode })` → task (`kind: 'move' | 'copy'`)
  - `engineUpdateToPatch(update, countField)` → store patch; `countField` is `'deleted'` or `'moved'`
- Task shape (consumed by Task 6's MasterQueue and Task 7's App): `{ kind, status: 'running'|'done'|'cancelled', subPhase: 'discovering'|'checking'|'deleting'|'moving'|null, subject, files, prefixes, dest?, capturedPrefix, bucket, current, total, errors, collapsed, cancelRequested }`

- [ ] **Step 1: Write the failing test**

Create `test/queue-tasks.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectLabel, createDeleteTask, createTransferTask, engineUpdateToPatch,
} from '../src/lib/queue-tasks.js';

describe('subjectLabel', () => {
  test('files only, singular/plural', () => {
    assert.equal(subjectLabel(1, 0), '1 file');
    assert.equal(subjectLabel(3, 0), '3 files');
  });
  test('folders only and mixed', () => {
    assert.equal(subjectLabel(0, 1), '1 folder');
    assert.equal(subjectLabel(2, 2), '2 files and 2 folders');
  });
});

describe('createDeleteTask', () => {
  test('builds a running delete task with counters zeroed', () => {
    const t = createDeleteTask({
      files: ['a.txt', 'b.txt'], prefixes: ['p/'], capturedPrefix: 'x/', bucket: 'bkt',
    });
    assert.equal(t.kind, 'delete');
    assert.equal(t.status, 'running');
    assert.equal(t.subPhase, null);
    assert.equal(t.subject, '2 files and 1 folder');
    assert.equal(t.current, 0);
    assert.equal(t.total, null);
    assert.deepEqual(t.errors, []);
    assert.equal(t.collapsed, false);
    assert.equal(t.cancelRequested, false);
    assert.equal(t.bucket, 'bkt');
    assert.equal(t.capturedPrefix, 'x/');
  });
});

describe('createTransferTask', () => {
  test('mode copy → kind copy; mode move → kind move; starts in checking', () => {
    const base = { files: [{ key: 'a', size: 1 }], prefixes: [], dest: 'd/', capturedPrefix: '', bucket: 'b' };
    assert.equal(createTransferTask({ ...base, mode: 'copy' }).kind, 'copy');
    const mv = createTransferTask({ ...base, mode: 'move' });
    assert.equal(mv.kind, 'move');
    assert.equal(mv.subPhase, 'checking');
    assert.equal(mv.dest, 'd/');
  });
});

describe('engineUpdateToPatch', () => {
  test('phase transition maps to subPhase', () => {
    assert.deepEqual(engineUpdateToPatch({ phase: 'discovering' }, 'deleted'), { subPhase: 'discovering' });
  });
  test('deleting phase with total', () => {
    const p = engineUpdateToPatch({ phase: 'deleting', total: 42 }, 'deleted');
    assert.equal(p.subPhase, 'deleting');
    assert.equal(p.total, 42);
  });
  test('incremental count maps countField → current, carries errors', () => {
    const p = engineUpdateToPatch({ deleted: 7, errors: [{ key: 'k', message: 'm' }] }, 'deleted');
    assert.equal(p.current, 7);
    assert.equal(p.errors.length, 1);
    assert.equal(p.subPhase, undefined, 'no phase in update → no subPhase in patch');
  });
  test('moved counts through the moved field', () => {
    assert.equal(engineUpdateToPatch({ moved: 3 }, 'moved').current, 3);
  });
  test('done → status done, subPhase cleared', () => {
    const p = engineUpdateToPatch({ phase: 'done', deleted: 9, errors: [] }, 'deleted');
    assert.equal(p.status, 'done');
    assert.equal(p.subPhase, null);
    assert.equal(p.current, 9);
  });
  test('done with cancelled → status cancelled', () => {
    assert.equal(engineUpdateToPatch({ phase: 'done', cancelled: true }, 'deleted').status, 'cancelled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/queue-tasks.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/lib/queue-tasks.js`:

```js
// Copyright (C) 2026 HidayahTech, LLC
// Task factories and progress adapters bridging the delete/move engines
// (delete-queue.js, move-queue.js) to the master task store
// (docs/intent/master-queue.md §5.1). The engines keep their own progress
// vocabulary (deleted/moved counters, phase names); these pure functions
// translate engine updates into task patches so the engines stay untouched
// and independently testable.

export function subjectLabel(fileCount, prefixCount) {
  return [
    fileCount > 0 && `${fileCount} file${fileCount !== 1 ? 's' : ''}`,
    prefixCount > 0 && `${prefixCount} folder${prefixCount !== 1 ? 's' : ''}`,
  ].filter(Boolean).join(' and ');
}

export function createDeleteTask({ files, prefixes, capturedPrefix, bucket }) {
  return {
    kind: 'delete',
    status: 'running',
    subPhase: null,
    subject: subjectLabel(files.length, prefixes.length),
    files, prefixes, capturedPrefix, bucket,
    current: 0, total: null,
    errors: [],
    collapsed: false,
    cancelRequested: false,
  };
}

export function createTransferTask({ files, prefixes, dest, capturedPrefix, bucket, mode }) {
  return {
    kind: mode === 'copy' ? 'copy' : 'move',
    status: 'running',
    subPhase: 'checking',
    subject: subjectLabel(files.length, prefixes.length),
    files, prefixes, dest, capturedPrefix, bucket,
    current: 0, total: null,
    errors: [],
    collapsed: false,
    cancelRequested: false,
  };
}

// Engine progress update → task-store patch. countField is 'deleted' (delete
// engine) or 'moved' (move/copy engine). `cancelled: true` on a done update
// marks a run that stopped early because cancellation was requested.
export function engineUpdateToPatch(update, countField) {
  const patch = {};
  if (update.phase === 'done') {
    patch.status = update.cancelled ? 'cancelled' : 'done';
    patch.subPhase = null;
  } else if (update.phase) {
    patch.subPhase = update.phase;
  }
  if (update.total !== undefined) patch.total = update.total;
  if (update[countField] !== undefined) patch.current = update[countField];
  if (update.errors !== undefined) patch.errors = update.errors;
  return patch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/queue-tasks.test.js`
Expected: PASS

---

### Task 3: Cooperative cancel in the delete engine

**Files:**
- Modify: `src/lib/delete-queue.js`
- Test: `test/delete-queue.test.js` (append; existing tests must pass unmodified)

**Interfaces:**
- Produces: `runDeleteOperation(client, bucket, op, onProgress, shouldCancel = () => false)` — 5th param optional, fully backward compatible. Done update gains `cancelled: boolean`.
- Behavior contract: cancel is checked between prefix crawls, between discovery and deleting, and between batch groups. `deletedPrefixes` now requires every key in the prefix to be in the confirmed-deleted set (equivalent to the old no-errors rule when not cancelled; strictly safer when cancelled).

- [ ] **Step 1: Write the failing tests**

Append to `test/delete-queue.test.js` (reuses the file's existing `mockClient`):

```js
// ── Cooperative cancellation ──────────────────────────────────────────────────

describe('runDeleteOperation — cooperative cancel', () => {
  test('shouldCancel=true after the first batch group stops before the next group', async () => {
    // 8001 keys → 9 batches of ≤1000 → 2 groups (8 + 1). Cancel flips true
    // during the first group, so the 9th batch must never be sent.
    const keys = Array.from({ length: 8001 }, (_, i) => `k${i}.txt`);
    const deleteResults = Array.from({ length: 9 }, () => ({ errors: [] }));
    const client = mockClient({ deleteResults });
    let cancelled = false;
    const updates = [];
    await runDeleteOperation(client, 'b', { files: keys, prefixes: [] }, (u) => {
      updates.push({ ...u });
      cancelled = true; // first incremental update flips the flag
    }, () => cancelled);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, true);
    assert.equal(done.deleted, 8000, 'first group of 8 batches completed; 9th skipped');
  });

  test('cancel during discovery finishes with nothing deleted and cancelled=true', async () => {
    const listPages = new Map([['p/', [{ keys: ['p/a.txt'] }]]]);
    const client = mockClient({ listPages, deleteResults: [{ errors: [] }] });
    const updates = [];
    // Cancelled from the start: discovery workers stop claiming, run ends early.
    await runDeleteOperation(client, 'b', { files: [], prefixes: ['p/'] },
      u => updates.push({ ...u }), () => true);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, true);
    assert.equal(done.deleted, 0);
    assert.deepEqual(done.deletedPrefixes, []);
  });

  test('a cancelled run never lists a partially-deleted prefix in deletedPrefixes', async () => {
    // Prefix with 8001 keys spanning 2 batch groups; cancel after group 1 →
    // some keys undeleted → the prefix must NOT be reported as fully deleted.
    const keys = Array.from({ length: 8001 }, (_, i) => `p/k${i}.txt`);
    const listPages = new Map([['p/', [{ keys }]]]);
    const deleteResults = Array.from({ length: 9 }, () => ({ errors: [] }));
    const client = mockClient({ listPages, deleteResults });
    let cancelled = false;
    const updates = [];
    await runDeleteOperation(client, 'b', { files: [], prefixes: ['p/'] }, (u) => {
      updates.push({ ...u });
      if (u.deletedKeys?.length) cancelled = true;
    }, () => cancelled);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, true);
    assert.deepEqual(done.deletedPrefixes, [], 'partially-deleted prefix must not be reported complete');
  });

  test('uncancelled runs report cancelled=false and unchanged behavior', async () => {
    const client = mockClient({ deleteResults: [{ errors: [] }] });
    const updates = [];
    await runDeleteOperation(client, 'b', { files: ['a.txt'], prefixes: [] },
      u => updates.push({ ...u }));
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, false);
    assert.equal(done.deleted, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/delete-queue.test.js`
Expected: existing tests PASS; the four new tests FAIL (`done.cancelled` is `undefined`)

- [ ] **Step 3: Implement cancellation in `src/lib/delete-queue.js`**

Change `discoverPrefixKeys` (currently lines 49–62) to accept and honor the flag:

```js
async function discoverPrefixKeys(client, bucket, prefixes, shouldCancel = () => false) {
  const prefixKeys = new Map();
  // Worker-pool: cap concurrent ListObjectsV2 crawls at CONCURRENCY to avoid
  // saturating the connection pool and triggering 503 throttling on large prefix sets.
  let idx = 0;
  async function worker() {
    while (idx < prefixes.length && !shouldCancel()) {
      const pfx = prefixes[idx++];
      prefixKeys.set(pfx, await listAllKeysForPrefix(client, bucket, pfx));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prefixes.length) }, worker));
  return prefixKeys;
}
```

Change `runDeleteOperation` (currently lines 77–130) to:

```js
export async function runDeleteOperation(client, bucket, op, onProgress, shouldCancel = () => false) {
  const allKeys    = [...op.files];
  let prefixKeys   = new Map();

  if (op.prefixes.length > 0) {
    onProgress({ phase: 'discovering' });
    try {
      prefixKeys = await discoverPrefixKeys(client, bucket, op.prefixes, shouldCancel);
      prefixKeys.forEach(keys => allKeys.push(...keys));
    } catch (err) {
      onProgress({ phase: 'done', deleted: 0, errors: [{ key: '(listing)', message: err.message }], deletedPrefixes: [], cancelled: false });
      return;
    }
  }

  if (shouldCancel()) {
    onProgress({ phase: 'done', deleted: 0, errors: [], deletedPrefixes: [], cancelled: true });
    return;
  }

  if (allKeys.length === 0) {
    onProgress({ phase: 'done', deleted: 0, errors: [], deletedPrefixes: [...op.prefixes], cancelled: false });
    return;
  }

  onProgress({ phase: 'deleting', total: allKeys.length });

  const errors = [];
  const deletedKeySet = new Set();
  let deleted = 0;
  const batches = [];
  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    batches.push(allKeys.slice(i, i + BATCH_SIZE).map(Key => ({ Key })));
  }

  // Cancellation is cooperative and batch-boundary honest: a group already in
  // flight completes (an issued DeleteObjectsCommand cannot be recalled); the
  // check runs before each group of CONCURRENCY batches starts.
  let cancelled = false;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (shouldCancel()) { cancelled = true; break; }
    await Promise.all(
      batches.slice(i, i + CONCURRENCY).map(async batch => {
        const { respErrors = [], networkError } = await sendBatchWithRetry(client, bucket, batch);
        const batchDeletedKeys = [];
        if (networkError) {
          batch.forEach(o => errors.push({ key: o.Key, message: networkError.message }));
        } else {
          const errorKeySet = new Set(respErrors.map(e => e.Key));
          errors.push(...respErrors.map(e => ({ key: e.Key, message: e.Message || e.Code })));
          batch.forEach(o => { if (!errorKeySet.has(o.Key)) batchDeletedKeys.push(o.Key); });
          deleted += batch.length - respErrors.length;
        }
        batchDeletedKeys.forEach(k => deletedKeySet.add(k));
        onProgress({ deleted, errors: [...errors], deletedKeys: batchDeletedKeys });
      })
    );
  }

  // A prefix is complete only when every key in it was confirmed deleted.
  // (Equivalent to the old "no errors" rule when the run wasn't cancelled;
  // strictly safer when it was — unattempted keys are neither errors nor deleted.)
  const deletedPrefixes = op.prefixes.filter(pfx =>
    (prefixKeys.get(pfx) || []).every(k => deletedKeySet.has(k))
  );

  onProgress({ phase: 'done', deleted, errors: [...errors], deletedPrefixes, cancelled });
}
```

Also update the contract comment above the function (currently lines 64–76): the `onProgress` update list gains `cancelled` on the done line:

```js
//   { phase: 'done', deleted: N, errors: [...], deletedPrefixes: [...], cancelled: bool }
```
and add one line at the end of the comment block:
```js
// shouldCancel() is polled between prefix crawls and batch groups; work already
// in flight completes. cancelled:true on the done update means work was skipped.
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `node --test test/delete-queue.test.js`
Expected: PASS — all existing tests (deletedPrefixes equivalence holds: uncancelled runs attempt every key, so "not an error" ⇔ "in deletedKeySet") and all four new tests

---

### Task 4: Cooperative cancel in the move/copy engine

**Files:**
- Modify: `src/lib/move-queue.js`
- Test: `test/move-queue.test.js` (append; existing tests must pass unmodified)

**Interfaces:**
- Produces: `runMoveOperation(client, bucket, op, onProgress, shouldCancel = () => false)` and `runCopyOperation(...)` — same optional 5th param. Done update gains `cancelled: boolean`. `movedPrefixes` computed from a confirmed-moved key set.

- [ ] **Step 1: Write the failing tests**

Append to `test/move-queue.test.js`, following that file's existing mock-client conventions (read its `mockClient`/setup helpers at the top of the file and reuse them exactly as the existing tests do — the assertions below only need ListObjectsV2 + CopyObject + DeleteObject dispatch):

```js
// ── Cooperative cancellation ──────────────────────────────────────────────────

describe('runMoveOperation — cooperative cancel', () => {
  test('cancel after the first moved object stops the remaining work', async () => {
    // 20 loose files; the cancel flag flips when the first movedKeys update
    // arrives. Workers stop claiming; done reports cancelled with moved < 20.
    const files = Array.from({ length: 20 }, (_, i) => ({ key: `f${i}.txt`, size: 1 }));
    const client = /* mock with empty destination listing and always-succeeding
                      CopyObject/DeleteObject, per this file's existing helper */;
    let cancelled = false;
    const updates = [];
    await runMoveOperation(client, 'b', { files, prefixes: [], dest: 'd/' }, (u) => {
      updates.push({ ...u });
      if (u.movedKeys?.length) cancelled = true;
    }, () => cancelled);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, true);
    assert.ok(done.moved < 20, `moved ${done.moved}, expected fewer than 20`);
  });

  test('cancelled run never lists a partially-moved prefix in movedPrefixes', async () => {
    // Prefix with 20 objects; cancel after first movedKeys update → some
    // objects unmoved → prefix must not be reported complete.
    /* arrange prefix listing with 20 objects per existing helper */
    const done = /* run as above with prefixes: ['p/'] and collect done */;
    assert.equal(done.cancelled, true);
    assert.deepEqual(done.movedPrefixes, []);
  });

  test('uncancelled runs report cancelled=false with behavior unchanged', async () => {
    /* single file, no cancel */
    assert.equal(done.cancelled, false);
    assert.equal(done.moved, 1);
  });
});
```

*(The implementer must materialize the `/* ... */` arrangement lines using the concrete `mockClient` helper already defined at the top of `test/move-queue.test.js` — same dispatch-on-constructor-name style as `test/delete-queue.test.js`. The assertions above are the contract and go in verbatim.)*

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/move-queue.test.js`
Expected: existing PASS, new FAIL (`done.cancelled` undefined)

- [ ] **Step 3: Implement cancellation in `src/lib/move-queue.js`**

Signature changes (currently lines 52–58):

```js
export async function runMoveOperation(client, bucket, op, onProgress, shouldCancel = () => false) {
  return runTransfer(client, bucket, op, onProgress, 'move', shouldCancel);
}

export async function runCopyOperation(client, bucket, op, onProgress, shouldCancel = () => false) {
  return runTransfer(client, bucket, op, onProgress, 'copy', shouldCancel);
}
```

`runTransfer` gains the param: `async function runTransfer(client, bucket, op, onProgress, mode, shouldCancel)`.

`discoverPrefixObjects` worker (currently line 43): `while (idx < prefixes.length && !shouldCancel())` — pass `shouldCancel` through as a 4th parameter, defaulting to `() => false`, mirroring Task 3's `discoverPrefixKeys`.

After the discovery block and again after the collision-check crawl succeeds (i.e., immediately after `existing = new Set(destObjs.map(o => o.key));` at line 100), insert:

```js
  if (shouldCancel()) {
    onProgress({ phase: 'done', moved: 0, errors: [], movedPrefixes: [], cancelled: true });
    return;
  }
```

In the moving worker (currently lines 152–189): declare beside `moved`/`mi`:

```js
  let cancelled = false;
  const movedKeySet = new Set();
```

change the loop head:

```js
  async function worker() {
    while (mi < movable.length) {
      if (shouldCancel()) { cancelled = true; return; }
      const item = movable[mi++];
```

and in the move-mode success path (after the source delete succeeds, before `moved++`):

```js
      if (mode === 'move') {
        try {
          await sendWithRetry(client, () => new DeleteObjectCommand({ Bucket: bucket, Key: item.sourceKey }));
        } catch (err) {
          errors.push({
            key: item.sourceKey,
            message: `Copied to the destination, but the source could not be deleted — it now exists in both places (${err.message || String(err)}).`,
          });
          onProgress({ moved, errors: [...errors], movedKeys: [] });
          continue;
        }
        movedKeySet.add(item.sourceKey);
      }
      moved++;
```

Final prefix computation (currently lines 191–194) becomes:

```js
  // A source folder is complete only when every object in it was confirmed
  // moved (copy + delete). Equivalent to the old "no errors" rule when the run
  // wasn't cancelled; strictly safer when it was.
  const movedPrefixes = mode === 'move'
    ? prefixes.filter(pfx => (prefixObjects.get(pfx) || []).every(o => movedKeySet.has(o.key)))
    : [];

  onProgress({ phase: 'done', moved, errors: [...errors], movedPrefixes, cancelled });
```

Also extend the contract comment at the top of the file (lines 8–17): done line becomes `{ phase: 'done', moved, errors: [...], movedPrefixes, cancelled }`, plus one line: `// shouldCancel() is polled between objects; in-flight copies complete.`

Also update the early-exit `onProgress({ phase: 'done', ... })` calls at lines 79, 91, and 102 to include `cancelled: false`.

- [ ] **Step 4: Run tests to verify everything passes**

Run: `node --test test/move-queue.test.js`
Expected: PASS — all existing + new

---

### Task 5: `DeleteConfirmModal` component

**Files:**
- Create: `src/components/DeleteConfirmModal.jsx`
- Test: `test/components/delete-confirm-modal.test.jsx`

**Interfaces:**
- Produces: `DeleteConfirmModal({ request, provider, onConfirm, onCancel })` where `request = { files: string[], prefixes: string[] }` (capturedPrefix may ride along, unused here). Renders `Modal` with the exact titles/caveats/`data-testid="delete-confirm"` from the old DeleteQueue confirm content.
- Consumes: `Modal` from `./Modal.jsx`, `leafName` from `../lib/format.js`.

- [ ] **Step 1: Write the failing test**

Create `test/components/delete-confirm-modal.test.jsx`. This is a direct port of the "confirm dialog titles", "versioning caveats", and "confirm dialog interactions" describe-blocks of the current `test/components/delete-queue.test.jsx` (lines 41–188) with this mechanical mapping — test names, assertions, and caveat texts stay identical:

- Import `DeleteConfirmModal` from `'../../src/components/DeleteConfirmModal.jsx'` instead of `DeleteQueue`.
- Replace `makeOp(...)`/`ops: [...]` with a `request` prop: `mount(h(DeleteConfirmModal, { request: { files: [...], prefixes: [...] }, provider: 'r2', onConfirm: ..., onCancel: ... }))`.
- `onDismiss` → `onCancel` in the interaction tests; the callbacks take no id (there is no op id pre-queue): `onConfirm: () => { confirmed = true; }` and assert the boolean.
- Drop the "empty state" describe (a conditional render is App's job now) and drop the "active operation states" describe (moves to Task 6).

File header comment:

```jsx
// Tests for DeleteConfirmModal — the pre-queue delete confirmation
// (docs/intent/master-queue.md §5.1: tasks enter the queue already authorized).
// Ported from the confirm-dialog sections of the retired delete-queue.test.jsx.
// The versioning caveats are the highest-risk content — wrong text could
// mislead users into thinking a deletion is reversible when it isn't.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ui`
Expected: the new file FAILS (module not found); all other component tests PASS

- [ ] **Step 3: Write the implementation**

Create `src/components/DeleteConfirmModal.jsx` (content is the `versioningCaveat` ternary + `ConfirmContent` moved verbatim from `DeleteQueue.jsx` lines 13–17 and 47–84, rewrapped):

```jsx
// DeleteConfirmModal — pre-queue confirmation for delete requests. Confirmation
// happens BEFORE a task enters the master queue (docs/intent/master-queue.md
// §5.1): a task in the queue is always already authorized. Extracted from
// DeleteQueue when delete/move ops moved onto the unified MasterQueue panel.
import { leafName } from '../lib/format.js';
import { Modal } from './Modal.jsx';

export function DeleteConfirmModal({ request, provider, onConfirm, onCancel }) {
  const fc = request.files.length;
  const pc = request.prefixes.length;

  const versioningCaveat = provider === 'b2'
    ? 'Backblaze B2 may retain older versions. The current version will be hidden but not immediately purged from storage.'
    : provider === 'wasabi'
    ? 'Wasabi has a 90-day minimum retention period. Objects deleted before 90 days are still billed for the remainder of that window.'
    : 'If versioning is enabled, this creates a delete marker — the object is hidden but recoverable. If versioning is off, deletion is permanent.';

  const title = fc > 0 && pc > 0
    ? `Delete ${fc} file${fc !== 1 ? 's' : ''} and ${pc} folder${pc !== 1 ? 's' : ''}?`
    : fc > 0
    ? `Delete ${fc} file${fc !== 1 ? 's' : ''}?`
    : `Delete ${pc} folder${pc !== 1 ? 's' : ''}?`;

  return (
    <Modal onClose={onCancel}>
      <div class="modal-title">{title}</div>
      {fc === 1 && pc === 0 && (
        <div class="modal-filename" title={request.files[0]}>{leafName(request.files[0])}</div>
      )}
      <div class="modal-body">
        {pc > 0 && (
          <>
            <p class="modal-caveat">
              All objects inside {pc === 1 ? 'this folder' : 'these folders'} will be permanently deleted.
            </p>
            <div class="delete-confirm-prefixes">
              {request.prefixes.map(p => (
                <div key={p} class="modal-filename">{leafName(p.replace(/\/$/, ''))}/</div>
              ))}
            </div>
          </>
        )}
        <p class="modal-caveat">{versioningCaveat}</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button class="btn btn-danger btn-sm" data-testid="delete-confirm" onClick={onConfirm}>Delete</button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:ui`
Expected: PASS (old delete-queue.test.jsx still passes too — DeleteQueue.jsx is untouched until Task 7)

---

### Task 6: `MasterQueue` component + unified CSS

**Files:**
- Create: `src/components/MasterQueue.jsx`
- Modify: `src/styles/main.css` (lines 380–458: replace the two queue blocks; keep `.delete-confirm-prefixes`)
- Test: `test/components/master-queue.test.jsx`

**Interfaces:**
- Produces: `MasterQueue({ store = taskStore })` — self-contained: subscribes to the store and drives cancel (`store.requestCancel`), collapse (`store.update(id, { collapsed: !t.collapsed }, true)`), dismiss (`store.remove`) itself. App renders `<MasterQueue />` with no props.
- Consumes: `taskStore`/`createTaskStore` (Task 1), task shape (Task 2), `leafName`.
- CSS contract: classes `.queue-panel`, `.queue-panel-actions`, `.queue-op`, `.queue-op-expanded`, `.queue-op-header`, `.queue-op-summary`, `.queue-op-icon`, `.queue-op-ok`, `.queue-op-err`, `.queue-op-cancelled`, `.queue-op-errors`, `.queue-op-error-row`, `.queue-op-error-key`, `.queue-op-error-msg`, `.queue-op-error-skip`, `.queue-op-error-more`.

- [ ] **Step 1: Write the failing test**

Create `test/components/master-queue.test.jsx`:

```jsx
// Tests for MasterQueue — the unified operations panel replacing DeleteQueue/
// MoveQueue (docs/intent/master-queue.md §5.3). Ports the active-operation
// assertions from the retired delete-queue/move-queue component tests onto the
// unified .queue-* classes, and adds the new behaviors: cancel, cancelled
// state, persistent finished rows, dismiss-all.
//
// Store mutations happen BEFORE mount (or inside fire handlers) so re-renders
// stay inside preact/test-utils act() — same approach as toast-host.test.jsx.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { MasterQueue } from '../../src/components/MasterQueue.jsx';
import { createTaskStore } from '../../src/lib/task-store.js';
import { createDeleteTask, createTransferTask } from '../../src/lib/queue-tasks.js';

// Urgent updates flush synchronously, so tests never need a frame to fire.
const makeStore = () => createTaskStore(fn => setTimeout(fn, 0), clearTimeout);

function addDelete(store, patch = {}) {
  const id = store.add(createDeleteTask({ files: ['a.txt', 'b.txt'], prefixes: [], capturedPrefix: '', bucket: 'b' }));
  if (Object.keys(patch).length) store.update(id, patch, true);
  return id;
}

describe('MasterQueue — empty state', () => {
  test('renders nothing when the store is empty', () => {
    const { query, cleanup } = mount(h(MasterQueue, { store: makeStore() }));
    assert.equal(query('.queue-panel'), null);
    cleanup();
  });
});

describe('MasterQueue — running states', () => {
  test('delete discovering shows "Listing folder contents…" and a spinner', () => {
    const store = makeStore();
    addDelete(store, { subPhase: 'discovering' });
    const { text, query, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('Listing folder contents'));
    assert.ok(query('.spinner'));
    cleanup();
  });

  test('move checking shows "Checking destination…"', () => {
    const store = makeStore();
    store.add(createTransferTask({ files: [{ key: 'a', size: 1 }], prefixes: [], dest: 'd/', capturedPrefix: '', bucket: 'b', mode: 'move' }));
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('Checking destination'));
    cleanup();
  });

  test('deleting shows verb, subject, and progress', () => {
    const store = makeStore();
    addDelete(store, { subPhase: 'deleting', current: 1, total: 3 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('Deleting 2 files'));
    assert.ok(text().includes('1 / 3'));
    cleanup();
  });

  test('copying uses the Copying verb', () => {
    const store = makeStore();
    const id = store.add(createTransferTask({ files: [{ key: 'a', size: 1 }], prefixes: [], dest: 'd/', capturedPrefix: '', bucket: 'b', mode: 'copy' }));
    store.update(id, { subPhase: 'moving', current: 0, total: 1 }, true);
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('Copying 1 file'));
    cleanup();
  });

  test('running rows show a Cancel button; settled rows do not', () => {
    const store = makeStore();
    addDelete(store);
    const { query, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(query('[data-testid="task-cancel"]'));
    cleanup();
  });
});

describe('MasterQueue — settled states', () => {
  test('done without errors shows ✓, "Deleted", and Dismiss', () => {
    const store = makeStore();
    addDelete(store, { status: 'done', current: 2 });
    const { text, query, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(query('.queue-op-ok'));
    assert.ok(text().includes('Deleted 2 files'));
    assert.ok(text().includes('Dismiss'));
    assert.equal(query('[data-testid="task-cancel"]'), null);
    cleanup();
  });

  test('done with errors shows ✕ and the Show details toggle', () => {
    const store = makeStore();
    addDelete(store, { status: 'done', collapsed: true, errors: [{ key: 'a.txt', message: 'Access Denied' }] });
    const { text, query, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(query('.queue-op-err'));
    assert.ok(text().includes('1 error'));
    assert.ok(text().includes('Show details'));
    cleanup();
  });

  test('expanded error list renders rows, skipped styling, and the >10 truncation footer', () => {
    const store = makeStore();
    const errors = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}.txt`, message: 'boom' }));
    errors[0] = { key: 'skip.txt', message: 'Already in this location — skipped.', skipped: true };
    addDelete(store, { status: 'done', collapsed: false, errors });
    const { text, query, queryAll, cleanup } = mount(h(MasterQueue, { store }));
    assert.equal(queryAll('.queue-op-error-row').length, 11, '10 error rows + the "…and more" footer row');
    assert.ok(query('.queue-op-error-skip'), 'skipped errors get the muted class');
    assert.ok(text().includes('…and 2 more'));
    cleanup();
  });

  test('cancelled shows ⊘ and "Cancelled — deleted X of Y"', () => {
    const store = makeStore();
    addDelete(store, { status: 'cancelled', current: 3, total: 10 });
    const { text, query, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(query('.queue-op-cancelled'));
    assert.ok(text().includes('Cancelled — deleted 3 of 10'));
    cleanup();
  });
});

describe('MasterQueue — interactions', () => {
  test('Cancel click requests cancellation and the button becomes disabled "Cancelling…"', () => {
    const store = makeStore();
    const id = addDelete(store);
    const { query, text, cleanup } = mount(h(MasterQueue, { store }));
    fire(query('[data-testid="task-cancel"]'), 'click');
    assert.equal(store.isCancelRequested(id), true);
    assert.ok(text().includes('Cancelling…'));
    assert.equal(query('[data-testid="task-cancel"]').disabled, true);
    cleanup();
  });

  test('Dismiss removes the task from the store', () => {
    const store = makeStore();
    addDelete(store, { status: 'done' });
    const { cleanup } = mount(h(MasterQueue, { store }));
    const dismiss = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Dismiss');
    fire(dismiss, 'click');
    assert.equal(store.get().length, 0);
    cleanup();
  });

  test('Show details toggles collapsed via the store', () => {
    const store = makeStore();
    const id = addDelete(store, { status: 'done', collapsed: true, errors: [{ key: 'a', message: 'x' }] });
    const { query, cleanup } = mount(h(MasterQueue, { store }));
    const toggle = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Show details'));
    fire(toggle, 'click');
    assert.equal(store.get().find(t => t.id === id).collapsed, false);
    assert.ok(query('.queue-op-errors'), 'error list now expanded');
    cleanup();
  });

  test('"Dismiss all finished" appears at ≥2 settled tasks and clears only those', () => {
    const store = makeStore();
    addDelete(store, { status: 'done' });
    addDelete(store, { status: 'cancelled' });
    const running = addDelete(store);
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('Dismiss all finished'));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Dismiss all finished');
    fire(btn, 'click');
    assert.equal(store.get().length, 1);
    assert.equal(store.get()[0].id, running);
    cleanup();
  });

  test('no "Dismiss all finished" with a single settled task', () => {
    const store = makeStore();
    addDelete(store, { status: 'done' });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(!text().includes('Dismiss all finished'));
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ui`
Expected: new file FAILS (module not found); everything else PASS

- [ ] **Step 3: Write the component**

Create `src/components/MasterQueue.jsx`:

```jsx
// MasterQueue — the unified operations panel (docs/intent/master-queue.md §5.3).
// Subscribes to the shared taskStore and renders one row per task: a generic
// shell (icon, summary, cancel/expand/dismiss controls, error detail list) that
// replaced the near-identical DeleteQueue/MoveQueue panels.
//
// Collapsed = calm: one line per task. Expanded = complete: per-key errors.
// Finished rows persist until dismissed (a delete result is evidence — it must
// not vanish on a timer); "Dismiss all finished" appears at ≥2 settled rows.
// Controls talk to the store directly — App only creates tasks and runs engines.
import { useState, useEffect } from 'preact/hooks';
import { leafName } from '../lib/format.js';
import { taskStore } from '../lib/task-store.js';

const VERBS = {
  delete: { active: 'Deleting', done: 'Deleted' },
  move:   { active: 'Moving',   done: 'Moved' },
  copy:   { active: 'Copying',  done: 'Copied' },
};

function taskSummary(t) {
  const verbs = VERBS[t.kind];
  const skipped = t.errors.filter(e => e.skipped).length;
  const failed  = t.errors.length - skipped;
  const progressText = t.total != null ? ` · ${t.current} / ${t.total}` : '';
  const skippedText  = skipped > 0 ? ` · ${skipped} skipped` : '';
  const failedText   = failed > 0 ? ` · ${failed} error${failed !== 1 ? 's' : ''}` : '';

  if (t.status === 'cancelled') {
    const ofText = t.total != null ? ` of ${t.total}` : '';
    return `Cancelled — ${verbs.done.toLowerCase()} ${t.current}${ofText}${skippedText}${failedText}`;
  }
  if (t.status === 'done') return `${verbs.done} ${t.subject}${skippedText}${failedText}`;
  if (t.subPhase === 'discovering') return 'Listing folder contents…';
  if (t.subPhase === 'checking') return 'Checking destination…';
  return `${verbs.active} ${t.subject}${progressText}${skippedText}${failedText}`;
}

export function MasterQueue({ store = taskStore }) {
  const [tasks, setTasks] = useState(store.get());
  useEffect(() => store.subscribe(setTasks), [store]);
  if (tasks.length === 0) return null;

  const settled = tasks.filter(t => t.status !== 'running');
  return (
    <div class="queue-panel" data-testid="master-queue">
      {settled.length >= 2 && (
        <div class="queue-panel-actions">
          <button type="button" class="btn btn-ghost btn-sm"
            onClick={() => settled.forEach(t => store.remove(t.id))}>
            Dismiss all finished
          </button>
        </div>
      )}
      {tasks.map(t => <TaskRow key={t.id} task={t} store={store} />)}
    </div>
  );
}

function TaskRow({ task, store }) {
  const isSettled = task.status !== 'running';
  const failed    = task.errors.filter(e => !e.skipped).length;
  const hasErrors = task.errors.length > 0;
  const expanded  = isSettled && hasErrors && !task.collapsed;

  return (
    <div class={`queue-op${expanded ? ' queue-op-expanded' : ''}`}>
      <div class="queue-op-header">
        {!isSettled && <span class="spinner" style={{ flexShrink: 0 }} />}
        {task.status === 'done' && failed === 0 && <span class="queue-op-icon queue-op-ok">✓</span>}
        {task.status === 'done' && failed > 0 && <span class="queue-op-icon queue-op-err">✕</span>}
        {task.status === 'cancelled' && <span class="queue-op-icon queue-op-cancelled">⊘</span>}
        <span class="queue-op-summary">{taskSummary(task)}</span>
        {!isSettled && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            data-testid="task-cancel" disabled={task.cancelRequested}
            onClick={() => store.requestCancel(task.id)}>
            {task.cancelRequested ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {isSettled && hasErrors && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            onClick={() => store.update(task.id, { collapsed: !task.collapsed }, true)}>
            {task.collapsed ? 'Show details' : 'Hide'}
          </button>
        )}
        {isSettled && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            onClick={() => store.remove(task.id)}>
            Dismiss
          </button>
        )}
      </div>
      {expanded && (
        <div class="queue-op-errors">
          {task.errors.slice(0, 10).map((e, i) => (
            <div key={i} class="queue-op-error-row">
              <span class="queue-op-error-key" title={e.key}>{leafName(e.key) || e.key}</span>
              <span class={e.skipped ? 'queue-op-error-skip' : 'queue-op-error-msg'}>{e.message}</span>
            </div>
          ))}
          {task.errors.length > 10 && (
            <div class="queue-op-error-row queue-op-error-more">
              …and {task.errors.length - 10} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace the CSS blocks**

In `src/styles/main.css`, replace everything from the `/* ── Delete queue ── */` comment (line 380) through `.move-op-error-more` (line 458) — but KEEP `.delete-confirm-prefixes` (lines 420–425), which moves into the new block — with:

```css
/* ── Master queue (unified operations panel — delete/move/copy tasks) ─────── */
.queue-panel { display: flex; flex-direction: column; gap: .5rem; }
.queue-panel-actions { display: flex; justify-content: flex-end; }
.queue-op {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: .6rem .75rem;
  font-size: .85rem;
}
.queue-op-expanded { padding-bottom: .5rem; }
.queue-op-header { display: flex; align-items: center; gap: .5rem; }
.queue-op-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-op-icon { font-size: .9rem; flex-shrink: 0; }
.queue-op-ok  { color: var(--text-success); }
.queue-op-err { color: var(--text-danger); }
.queue-op-cancelled { color: var(--text-muted); }
.queue-op-errors {
  margin-top: .4rem;
  border-top: 1px solid var(--border);
  padding-top: .4rem;
  display: flex;
  flex-direction: column;
  gap: .2rem;
}
.queue-op-error-row { display: flex; gap: .5rem; font-size: .78rem; align-items: baseline; }
.queue-op-error-key {
  color: var(--text-muted);
  min-width: 0; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--mono);
}
.queue-op-error-msg  { color: var(--text-danger); flex-shrink: 0; }
.queue-op-error-skip { color: var(--text-muted); flex-shrink: 0; }
.queue-op-error-more { color: var(--text-muted); font-style: italic; }
.delete-confirm-prefixes {
  display: flex;
  flex-direction: column;
  gap: .2rem;
  margin: .3rem 0 .5rem;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:ui`
Expected: master-queue.test.jsx PASS. (`delete-queue.test.jsx`/`move-queue.test.jsx` also still pass — old components render fine without their CSS; jsdom tests don't assert styles.)

---

### Task 7: Wire App.jsx; retire DeleteQueue/MoveQueue

**Files:**
- Modify: `src/components/App.jsx`
- Delete: `src/components/DeleteQueue.jsx`, `src/components/MoveQueue.jsx`
- Delete: `test/components/delete-queue.test.jsx`, `test/components/move-queue.test.jsx` (superseded by Tasks 5–6 test files)

**Interfaces:**
- Consumes: `taskStore` (Task 1); `createDeleteTask`, `createTransferTask`, `engineUpdateToPatch` (Task 2); `runDeleteOperation`/`runMoveOperation`/`runCopyOperation` with `shouldCancel` (Tasks 3–4); `DeleteConfirmModal` (Task 5); `MasterQueue` (Task 6).
- Behavior deltas (intentional): finished tasks persist until dismissed (no 3 s auto-remove); a second delete request while a confirm dialog is open replaces the pending one (previously they queued — one dialog at a time either way); cancelled runs with nothing done don't flip capabilities to 'permitted'.

- [ ] **Step 1: Update imports** (App.jsx lines 40–43)

Replace:

```jsx
import { DeleteQueue } from './DeleteQueue.jsx';
import { runDeleteOperation } from '../lib/delete-queue.js';
import { MoveQueue } from './MoveQueue.jsx';
import { runMoveOperation, runCopyOperation } from '../lib/move-queue.js';
```

with:

```jsx
import { DeleteConfirmModal } from './DeleteConfirmModal.jsx';
import { MasterQueue } from './MasterQueue.jsx';
import { runDeleteOperation } from '../lib/delete-queue.js';
import { runMoveOperation, runCopyOperation } from '../lib/move-queue.js';
import { taskStore } from '../lib/task-store.js';
import { createDeleteTask, createTransferTask, engineUpdateToPatch } from '../lib/queue-tasks.js';
```

- [ ] **Step 2: Replace op state with pendingDelete** (App.jsx lines 89–90)

Replace:

```jsx
  const [deleteOps, setDeleteOps] = useState([]);
  const [moveOps, setMoveOps] = useState([]);
```

with:

```jsx
  // Delete requests confirm BEFORE entering the master queue (a queued task is
  // always already authorized). One pending request at a time; a new request
  // replaces an unconfirmed one.
  const [pendingDelete, setPendingDelete] = useState(null);
```

- [ ] **Step 3: Replace the delete handlers** (App.jsx lines 206–264)

Replace `handleDeleteRequest`, `updateDeleteOp`, `handleDeleteConfirm`, `handleDeleteDismiss`, `handleDeleteCollapse` with:

```jsx
  function handleDeleteRequest({ files, prefixes, capturedPrefix }) {
    setPendingDelete({ files, prefixes, capturedPrefix });
  }

  async function handleDeleteConfirm() {
    const req = pendingDelete;
    setPendingDelete(null);
    const task = createDeleteTask({ ...req, bucket: credentials.bucket });
    const id = taskStore.add(task);
    try {
      await runDeleteOperation(client, task.bucket, task, (update) => {
        if (update.deletedKeys?.length) {
          browserActionsRef.current?.removeItems(update.deletedKeys, []);
        }
        if (update.phase === 'done') {
          if (update.deletedPrefixes?.length) {
            browserActionsRef.current?.removeItems([], update.deletedPrefixes);
          }
          browserActionsRef.current?.invalidateCache(task.capturedPrefix);
          // A run cancelled before any request proves nothing about permissions.
          if (update.deleted > 0 || !update.cancelled) {
            handleCapabilityChange('delete', 'permitted');
          }
          if (update.errors.length === 0 && !update.cancelled) {
            const n = req.files.length + req.prefixes.length;
            showToast(`Deleted ${n} item${n === 1 ? '' : 's'}`);
          }
        }
        taskStore.update(id, engineUpdateToPatch(update, 'deleted'), !!update.phase);
      }, () => taskStore.isCancelRequested(id));
    } catch (err) {
      taskStore.update(id, {
        status: 'done', subPhase: null,
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
      }, true);
    }
  }
```

- [ ] **Step 4: Replace the move handlers** (App.jsx lines 266–322)

Replace `updateMoveOp`, `handleMoveRequest`, `handleMoveDismiss`, `handleMoveCollapse` with:

```jsx
  // The MovePickerModal is the confirmation step, so a move/copy request starts
  // its task directly.
  async function handleMoveRequest({ files, prefixes, dest, capturedPrefix, mode = 'move' }) {
    const task = createTransferTask({ files, prefixes, dest, capturedPrefix, bucket: credentials.bucket, mode });
    const id = taskStore.add(task);
    const runOperation = mode === 'copy' ? runCopyOperation : runMoveOperation;
    try {
      await runOperation(client, task.bucket, task, (update) => {
        // Remove moved source rows incrementally (copy+delete confirmed for those keys).
        if (update.movedKeys?.length) {
          browserActionsRef.current?.removeItems(update.movedKeys, []);
        }
        if (update.phase === 'done') {
          if (update.movedPrefixes?.length) {
            browserActionsRef.current?.removeItems([], update.movedPrefixes);
          }
          // Invalidate both the source view and the destination so each refetches.
          browserActionsRef.current?.invalidateCache(task.capturedPrefix);
          browserActionsRef.current?.invalidateCache(task.dest);
          if (update.moved > 0) {
            handleCapabilityChange('upload', 'permitted');
            if (mode === 'move') handleCapabilityChange('delete', 'permitted');
          }
          if (update.errors.length === 0 && !update.cancelled) {
            const verb = mode === 'copy' ? 'Copied' : 'Moved';
            showToast(`${verb} ${update.moved} item${update.moved === 1 ? '' : 's'}`);
          }
        }
        taskStore.update(id, engineUpdateToPatch(update, 'moved'), !!update.phase);
      }, () => taskStore.isCancelRequested(id));
    } catch (err) {
      taskStore.update(id, {
        status: 'done', subPhase: null,
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
      }, true);
    }
  }
```

- [ ] **Step 5: Update the render tree**

With the other modals (after the `DuplicatesModal` block ending at line 406), add:

```jsx
      {pendingDelete && (
        <DeleteConfirmModal
          request={pendingDelete}
          provider={credentials.provider}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setPendingDelete(null)}
        />
      )}
```

Replace the `<DeleteQueue ... />` and `<MoveQueue ... />` blocks (lines 601–613) with:

```jsx
            <MasterQueue />
```

- [ ] **Step 6: Delete the retired files**

```bash
git rm src/components/DeleteQueue.jsx src/components/MoveQueue.jsx test/components/delete-queue.test.jsx test/components/move-queue.test.jsx
```

- [ ] **Step 7: Full verification**

Run, in order (each must pass before the next):
- `npm test` → PASS (unit + structural; build tests run against last build — rebuild next)
- `npm run build` → succeeds, build invariants hold
- `npm test` again (build tests now check the fresh bundle) → PASS
- `npm run test:ui` → PASS (no stale imports of deleted components)
- `node test/e2e/run.mjs` (or the e2e command the repo's pre-push hook runs — check `.git/hooks/pre-push` / `package.json` scripts and use that exact command) → PASS, especially `smoke`, `batch`, `versioning` (delete via `data-testid="delete-confirm"`), `dnd` (moves)

Manual sanity pass (mock S3 or a test bucket via `npm run serve`): delete a file (confirm → task row → ✓ persists until Dismiss); delete a large folder and hit Cancel mid-run (row → "Cancelling…" → "Cancelled — deleted X of Y"); move + copy a file; trigger a collision skip; verify "Dismiss all finished" with two settled rows.

---

### Task 8: CHANGELOG + version bump + single commit (operator gate)

**Files:**
- Modify: `CHANGELOG.md`, `package.json`

- [ ] **Step 1: STOP — operator confirmation.** Present the summary of changes and the proposed **minor** bump to **1.35.0** (new feature: unified master queue panel + cancellation; behavior change: finished rows persist). Do not proceed without explicit confirmation of both the changes and the level.

- [ ] **Step 2: Add the CHANGELOG entry** (top of `CHANGELOG.md`, matching the repo's format):

```markdown
## [1.35.0] — 2026-07-06 — Master queue: unified operations panel with cancellation

Phase 1 of the master-queue unification (docs/intent/master-queue.md): delete and
move/copy operations now share one panel, one store, and one visual language.

- **New:** unified MasterQueue panel replaces the separate delete/move panels; one
  row per operation with progress, error details, and controls.
- **New:** delete, move, and copy operations can now be cancelled mid-run. Cancellation
  is cooperative: work already in flight completes ("Cancel stops at the next batch"),
  and the row reports exactly how much was done, e.g. "Cancelled — deleted 3,000 of 18,400".
- **New:** "Dismiss all finished" bulk action when two or more operations have settled.
- **Changed:** finished operation rows now persist until dismissed instead of
  disappearing after 3 seconds — a delete result is evidence, not a notification.
  Success toasts are unchanged.
- **Fixed (hardening):** a cancelled folder delete/move can no longer report the
  folder as fully completed — completion now requires every key confirmed
  deleted/moved, not merely "no errors".
- Internal: new module-level task store (RAF-batched updates) that Phase 2
  (version purge, duplicate deletion) and Phase 3 (uploads) will build on;
  delete confirmation extracted to a pre-queue modal; ~80 lines of duplicated
  panel CSS/JSX removed.
```

- [ ] **Step 3: Bump `package.json`** `"version"` to `"1.35.0"`.

- [ ] **Step 4: Rebuild and re-run everything** (build asserts CHANGELOG top entry matches package.json):

`npm run build` → `npm test` → `npm run test:ui` → e2e (same command as Task 7)
Expected: all PASS

- [ ] **Step 5: STOP — ask the operator before committing/pushing.** On approval, single commit:

```bash
git add -A
git commit -m "feat: unified master queue panel with cooperative cancellation (v1.35.0)

Phase 1 of docs/intent/master-queue.md: module-level task store, MasterQueue
panel replacing DeleteQueue/MoveQueue, pre-queue delete confirmation, cooperative
cancel for delete/move/copy, finished rows persist until dismissed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Push only on explicit operator approval (pre-push hook runs build + tests + e2e and auto-tags v1.35.0).

---

## Self-Review Notes

- **Spec coverage:** store (§5.2) → Task 1; task shape/adapters (§5.1) → Task 2; cancellation (§5.4) → Tasks 3–4; confirm extraction (§5.1) → Task 5 + Task 7; unified panel + retention (§5.3) → Task 6 + Task 7; CSS dedup (§1) → Task 6. Status chip and activity log are Phase 3/4 — intentionally absent.
- **Known deviation:** Task 4 Step 1 asks the implementer to materialize mock arrangements from the file's existing helper rather than pasting them blind — `test/move-queue.test.js`'s helper was not read while planning; the assertions (the actual contract) are verbatim. Read that file's top before writing the tests.
- **Type consistency check:** `engineUpdateToPatch(update, countField)` used in Tasks 2 and 7 with `'deleted'`/`'moved'`; task fields `current/total/status/subPhase/subject/errors/collapsed/cancelRequested` consistent across Tasks 2, 6, 7; store API `add/update/remove/requestCancel/isCancelRequested/subscribe/get/flush` consistent across Tasks 1, 6, 7.
- **Trap documented:** do not inject a synchronous `scheduleFlush` into `createUpdateBatcher` (handle-overwrite deadlock); tests use `setTimeout` scheduling + urgent updates instead.
