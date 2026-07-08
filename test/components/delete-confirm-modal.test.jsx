// Tests for DeleteConfirmModal — the pre-queue delete confirmation
// (docs/intent/master-queue.md §5.1: tasks enter the queue already authorized).
// Ported from the confirm-dialog sections of the retired delete-queue.test.jsx.
// The versioning caveats are the highest-risk content — wrong text could
// mislead users into thinking a deletion is reversible when it isn't.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { DeleteConfirmModal } from '../../src/components/DeleteConfirmModal.jsx';

const NO_CALLBACKS = { onConfirm: () => {}, onCancel: () => {} };

describe('DeleteConfirmModal — confirm dialog titles', () => {
  test('singular: "Delete 1 file?" for one file', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['a.txt'], prefixes: [] },
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 1 file?'));
    assert.ok(!text().includes('files?'), 'plural "files?" must not appear for a single file');
    cleanup();
  });

  test('plural: "Delete 3 files?" for multiple files', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['a.txt', 'b.txt', 'c.txt'], prefixes: [] },
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 3 files?'));
    cleanup();
  });

  test('folder title: "Delete 1 folder?" for one folder', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: [], prefixes: ['photos/'] },
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 1 folder?'));
    cleanup();
  });

  test('mixed title: "Delete N files and M folders?" for mixed selection', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['a.txt', 'b.txt'], prefixes: ['photos/', 'docs/'] },
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Delete 2 files and 2 folders?'));
    cleanup();
  });

  test('shows the filename when exactly one file is selected', () => {
    const { query, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/my-document.pdf'], prefixes: [] },
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(query('.modal-filename'), '.modal-filename element must appear for a single file');
    assert.ok(query('.modal-filename').textContent.includes('my-document.pdf'));
    cleanup();
  });

  test('does NOT show a modal-filename element when multiple files are selected', () => {
    const { query, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['a.txt', 'b.txt'], prefixes: [] },
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.equal(query('.modal-filename'), null, 'no single-file filename display for multi-file selection');
    cleanup();
  });
});

describe('DeleteConfirmModal — versioning caveats', () => {
  test('B2: shows Backblaze-specific versioning caveat', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] }, provider: 'b2', ...NO_CALLBACKS,
    }));
    assert.ok(
      text().includes('Backblaze B2') || text().includes('B2'),
      'B2 caveat must mention Backblaze B2'
    );
    assert.ok(text().toLowerCase().includes('retain') || text().toLowerCase().includes('older versions'));
    cleanup();
  });

  test('Wasabi: shows the 90-day minimum retention caveat', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] }, provider: 'wasabi', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('90'), 'Wasabi caveat must mention the 90-day retention period');
    assert.ok(text().toLowerCase().includes('wasabi'));
    cleanup();
  });

  test('generic: shows the generic versioning caveat (not B2 or Wasabi specific)', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] }, provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(!text().includes('90'), 'Generic caveat must not mention 90 days');
    assert.ok(!text().includes('Backblaze'), 'Generic caveat must not mention Backblaze');
    assert.ok(text().toLowerCase().includes('delete marker') || text().toLowerCase().includes('versioning'));
    cleanup();
  });

  test('B2 caveat does NOT show the Wasabi 90-day message', () => {
    const { text, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] }, provider: 'b2', ...NO_CALLBACKS,
    }));
    assert.ok(!text().includes('90'), 'B2 must not show the Wasabi 90-day retention message');
    cleanup();
  });
});

describe('DeleteConfirmModal — confirm dialog interactions', () => {
  test('Delete button calls onConfirm', () => {
    let confirmed = false;
    const { query, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] },
      provider: 'r2',
      onConfirm: () => { confirmed = true; },
      onCancel: () => {},
    }));
    fire(query('.btn-danger'), 'click');
    assert.ok(confirmed);
    cleanup();
  });

  test('Cancel button calls onCancel', () => {
    let cancelled = false;
    const { query, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] },
      provider: 'r2',
      onCancel: () => { cancelled = true; },
      onConfirm: () => {},
    }));
    fire(query('.btn-ghost'), 'click');
    assert.ok(cancelled);
    cleanup();
  });

  test('clicking the backdrop overlay calls onCancel', () => {
    let cancelCalled = false;
    const { query, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] }, provider: 'r2',
      onCancel: () => { cancelCalled = true; },
      onConfirm: () => {},
    }));
    fire(query('.modal-overlay'), 'click');
    assert.ok(cancelCalled, 'backdrop click must call onCancel');
    cleanup();
  });

  test('clicking the modal dialog itself does NOT call onCancel (stops propagation)', () => {
    let cancelCalled = false;
    const { query, cleanup } = mount(h(DeleteConfirmModal, {
      request: { files: ['folder/image.jpg'], prefixes: [] }, provider: 'r2',
      onCancel: () => { cancelCalled = true; },
      onConfirm: () => {},
    }));
    fire(query('.modal-dialog'), 'click');
    assert.ok(!cancelCalled, 'clicking inside the dialog must NOT dismiss it');
    cleanup();
  });
});
