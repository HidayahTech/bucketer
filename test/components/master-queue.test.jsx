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

describe('MasterQueue — rename', () => {
  test('a running rename task shows "Renaming <old> → <new>"', () => {
    const store = makeStore();
    const id = store.add(createTransferTask({ files: [], prefixes: ['photos/2024/'], renameTo: 'memories', capturedPrefix: 'photos/', bucket: 'b', mode: 'rename' }));
    store.update(id, { subPhase: 'moving', total: 3, current: 1 }, true);
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('Renaming 2024 → memories'), text());
    cleanup();
  });
  test('a done rename task shows "Renamed <old> → <new>"', () => {
    const store = makeStore();
    const id = store.add(createTransferTask({ files: [], prefixes: ['photos/2024/'], renameTo: 'memories', capturedPrefix: 'photos/', bucket: 'b', mode: 'rename' }));
    store.update(id, { status: 'done', subPhase: null }, true);
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('Renamed 2024 → memories'), text());
    cleanup();
  });
});
