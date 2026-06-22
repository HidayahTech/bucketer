// #16 — browser keyboard shortcuts. resolveShortcut maps a keydown event +
// context to an action string (or null). Pure, so it tests without a DOM.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShortcut, isEditableTarget } from '../src/lib/keyboard-shortcuts.js';

const ctx = (over = {}) => ({ inTextField: false, hasSelection: false, previewOpen: false, ...over });

describe('resolveShortcut (#16)', () => {
  test('"/" focuses the filter', () => {
    assert.equal(resolveShortcut({ key: '/' }, ctx()), 'focus-filter');
  });

  test('Ctrl+A and Cmd+A select all (either case)', () => {
    assert.equal(resolveShortcut({ key: 'a', ctrlKey: true }, ctx()), 'select-all');
    assert.equal(resolveShortcut({ key: 'A', metaKey: true }, ctx()), 'select-all');
  });

  test('Delete deletes when there is a selection', () => {
    assert.equal(resolveShortcut({ key: 'Delete' }, ctx({ hasSelection: true })), 'delete');
  });

  test('Delete does nothing without a selection', () => {
    assert.equal(resolveShortcut({ key: 'Delete' }, ctx({ hasSelection: false })), null);
  });

  test('Backspace never deletes (avoids accidental data loss)', () => {
    assert.equal(resolveShortcut({ key: 'Backspace' }, ctx({ hasSelection: true })), null);
  });

  test('no shortcut fires while typing in a text field', () => {
    assert.equal(resolveShortcut({ key: '/' }, ctx({ inTextField: true })), null);
    assert.equal(resolveShortcut({ key: 'a', ctrlKey: true }, ctx({ inTextField: true })), null);
    assert.equal(resolveShortcut({ key: 'Delete' }, ctx({ inTextField: true, hasSelection: true })), null);
  });

  test('no shortcut fires while the preview is open (it owns Esc/arrows)', () => {
    assert.equal(resolveShortcut({ key: '/' }, ctx({ previewOpen: true })), null);
    assert.equal(resolveShortcut({ key: 'Delete' }, ctx({ previewOpen: true, hasSelection: true })), null);
  });

  test('plain unmodified letters and other modifier combos are ignored', () => {
    assert.equal(resolveShortcut({ key: 'a' }, ctx()), null);
    assert.equal(resolveShortcut({ key: 'x', ctrlKey: true }, ctx()), null);
  });
});

describe('isEditableTarget (#16)', () => {
  test('inputs, textareas, selects, and contentEditable are editable', () => {
    assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
    assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
    assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  });

  test('non-editable elements and null are not editable', () => {
    assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
    assert.equal(isEditableTarget(null), false);
  });
});
