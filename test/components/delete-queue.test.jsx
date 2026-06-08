// Tests for DeleteQueue.
// Covers: empty state, confirm dialog titles and content, provider-specific
// versioning caveats, active operation states (discovering/deleting/done/errors),
// and all user interaction callbacks. The confirm dialog and versioning caveats
// are the highest-risk areas — wrong text could mislead users into thinking a
// deletion is reversible when it isn't (or vice versa).
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { DeleteQueue } from '../../src/components/DeleteQueue.jsx';

function makeOp(overrides = {}) {
  return {
    id: 'op-1',
    phase: 'confirm',
    files: ['folder/image.jpg'],
    prefixes: [],
    deleted: 0,
    total: null,
    errors: [],
    collapsed: false,
    bucket: 'my-bucket',
    capturedPrefix: '',
    ...overrides,
  };
}

const NO_CALLBACKS = { onConfirm: () => {}, onDismiss: () => {}, onCollapse: () => {} };

describe('DeleteQueue — empty state', () => {
  test('renders nothing (null) when ops array is empty', () => {
    const { query, cleanup } = mount(h(DeleteQueue, { ops: [], provider: 'r2', ...NO_CALLBACKS }));
    assert.equal(query('.delete-queue'), null, 'no delete-queue element should render with empty ops');
    assert.equal(query('.modal-overlay'), null, 'no modal-overlay should render with empty ops');
    cleanup();
  });
});

describe('DeleteQueue — confirm dialog titles', () => {
  test('singular: "Delete 1 file?" for one file', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ files: ['a.txt'], prefixes: [] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 1 file?'));
    assert.ok(!text().includes('files?'), 'plural "files?" must not appear for a single file');
    cleanup();
  });

  test('plural: "Delete 3 files?" for multiple files', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ files: ['a.txt', 'b.txt', 'c.txt'], prefixes: [] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 3 files?'));
    cleanup();
  });

  test('folder title: "Delete 1 folder?" for one folder', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ files: [], prefixes: ['photos/'] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 1 folder?'));
    cleanup();
  });

  test('mixed title: "Delete N files and M folders?" for mixed selection', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ files: ['a.txt', 'b.txt'], prefixes: ['photos/', 'docs/'] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 2 files and 2 folders?'));
    cleanup();
  });

  test('shows the filename when exactly one file is selected', () => {
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ files: ['folder/my-document.pdf'], prefixes: [] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(query('.modal-filename'), '.modal-filename element must appear for a single file');
    assert.ok(query('.modal-filename').textContent.includes('my-document.pdf'));
    cleanup();
  });

  test('does NOT show a modal-filename element when multiple files are selected', () => {
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ files: ['a.txt', 'b.txt'], prefixes: [] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.equal(query('.modal-filename'), null, 'no single-file filename display for multi-file selection');
    cleanup();
  });
});

describe('DeleteQueue — versioning caveats', () => {
  test('B2: shows Backblaze-specific versioning caveat', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp()], provider: 'b2', ...NO_CALLBACKS,
    }));
    assert.ok(
      text().includes('Backblaze B2') || text().includes('B2'),
      'B2 caveat must mention Backblaze B2'
    );
    assert.ok(text().toLowerCase().includes('retain') || text().toLowerCase().includes('older versions'));
    cleanup();
  });

  test('Wasabi: shows the 90-day minimum retention caveat', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp()], provider: 'wasabi', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('90'), 'Wasabi caveat must mention the 90-day retention period');
    assert.ok(text().toLowerCase().includes('wasabi'));
    cleanup();
  });

  test('generic: shows the generic versioning caveat (not B2 or Wasabi specific)', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp()], provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(!text().includes('90'), 'Generic caveat must not mention 90 days');
    assert.ok(!text().includes('Backblaze'), 'Generic caveat must not mention Backblaze');
    assert.ok(text().toLowerCase().includes('delete marker') || text().toLowerCase().includes('versioning'));
    cleanup();
  });

  test('B2 caveat does NOT show the Wasabi 90-day message', () => {
    const { text, cleanup } = mount(h(DeleteQueue, { ops: [makeOp()], provider: 'b2', ...NO_CALLBACKS }));
    assert.ok(!text().includes('90'), 'B2 must not show the Wasabi 90-day retention message');
    cleanup();
  });
});

describe('DeleteQueue — confirm dialog interactions', () => {
  test('Delete button calls onConfirm with the op id', () => {
    let confirmedId = null;
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ id: 'op-abc' })],
      provider: 'r2',
      onConfirm: id => { confirmedId = id; },
      onDismiss: () => {}, onCollapse: () => {},
    }));
    fire(query('.btn-danger'), 'click');
    assert.equal(confirmedId, 'op-abc');
    cleanup();
  });

  test('Cancel button calls onDismiss with the op id', () => {
    let dismissedId = null;
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ id: 'op-abc' })],
      provider: 'r2',
      onDismiss: id => { dismissedId = id; },
      onConfirm: () => {}, onCollapse: () => {},
    }));
    fire(query('.btn-ghost'), 'click');
    assert.equal(dismissedId, 'op-abc');
    cleanup();
  });

  test('clicking the backdrop overlay calls onDismiss', () => {
    let dismissCalled = false;
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp()], provider: 'r2',
      onDismiss: () => { dismissCalled = true; },
      onConfirm: () => {}, onCollapse: () => {},
    }));
    fire(query('.modal-overlay'), 'click');
    assert.ok(dismissCalled, 'backdrop click must call onDismiss');
    cleanup();
  });

  test('clicking the modal dialog itself does NOT call onDismiss (stops propagation)', () => {
    let dismissCalled = false;
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp()], provider: 'r2',
      onDismiss: () => { dismissCalled = true; },
      onConfirm: () => {}, onCollapse: () => {},
    }));
    fire(query('.modal-dialog'), 'click');
    assert.ok(!dismissCalled, 'clicking inside the dialog must NOT dismiss it');
    cleanup();
  });
});

describe('DeleteQueue — active operation states', () => {
  test('discovering phase shows "Listing folder contents"', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ phase: 'discovering', files: [], prefixes: ['docs/'] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Listing folder'), '"Listing folder contents" must appear during discovering phase');
    cleanup();
  });

  test('deleting phase shows "Deleting" with file/folder count', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ phase: 'deleting', files: ['a.txt', 'b.txt'], prefixes: [] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Deleting'), '"Deleting" must appear during the deleting phase');
    assert.ok(text().includes('2 files'), 'file count must appear in the summary');
    cleanup();
  });

  test('deleting phase shows progress when total is known', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ phase: 'deleting', files: ['a.txt', 'b.txt', 'c.txt'], prefixes: [], deleted: 1, total: 3 })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('1') && text().includes('3'), 'progress (deleted / total) must appear');
    cleanup();
  });

  test('done phase shows ✓ success icon and "Deleted" summary', () => {
    const { query, text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ phase: 'done', files: ['a.txt'], prefixes: [] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(query('.delete-op-ok'), 'success (✓) icon must appear when done with no errors');
    assert.ok(text().includes('Deleted'), '"Deleted" summary must appear when done');
    cleanup();
  });

  test('done with errors: shows ✕ error icon', () => {
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ phase: 'done', files: ['a.txt'], prefixes: [], errors: [{ key: 'a.txt', message: 'Access Denied' }] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(query('.delete-op-err'), 'error (✕) icon must appear when done with errors');
    cleanup();
  });

  test('done phase shows Dismiss button', () => {
    const { text, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ phase: 'done', files: ['a.txt'], prefixes: [] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Dismiss'), 'Dismiss button must appear when operation is done');
    cleanup();
  });

  test('Dismiss button calls onDismiss', () => {
    let dismissCalled = false;
    const { query, cleanup } = mount(h(DeleteQueue, {
      ops: [makeOp({ id: 'op-done', phase: 'done', files: ['a.txt'], prefixes: [] })],
      provider: 'r2',
      onDismiss: () => { dismissCalled = true; },
      onConfirm: () => {}, onCollapse: () => {},
    }));
    const buttons = [...document.querySelectorAll('button')];
    const dismissBtn = buttons.find(b => b.textContent.trim() === 'Dismiss');
    fire(dismissBtn, 'click');
    assert.ok(dismissCalled, 'onDismiss must be called when Dismiss is clicked');
    cleanup();
  });
});
