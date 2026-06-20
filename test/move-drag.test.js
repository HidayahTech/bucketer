import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dragPayload, dropAccepted } from '../src/lib/move-drag.js';

// Pure decision logic for drag-and-drop moves. The full drag gesture can't run under
// node/jsdom (no DragEvent/DataTransfer), so the behavior that matters — what a drag of a
// given row should move, and whether a drop target is acceptable — lives here and is
// tested directly. The Browser wiring is a thin shell over these.

const selection = {
  files: [{ key: 'reports/a.txt', size: 10 }, { key: 'reports/b.txt', size: 20 }],
  prefixes: ['photos/2024/'],
};

describe('dragPayload — dragging a row that IS part of the selection', () => {
  test('dragging a selected file moves the whole selection', () => {
    const p = dragPayload({ fileKey: 'reports/a.txt', fileSize: 10 }, selection);
    assert.deepEqual(p.files, selection.files);
    assert.deepEqual(p.prefixes, selection.prefixes);
    assert.equal(p.fromSelection, true);
  });

  test('dragging a selected folder moves the whole selection', () => {
    const p = dragPayload({ prefix: 'photos/2024/' }, selection);
    assert.deepEqual(p.files, selection.files);
    assert.deepEqual(p.prefixes, selection.prefixes);
    assert.equal(p.fromSelection, true);
  });
});

describe('dragPayload — dragging a row that is NOT in the selection', () => {
  test('dragging an unselected file moves only that file', () => {
    const p = dragPayload({ fileKey: 'other/c.txt', fileSize: 5 }, selection);
    assert.deepEqual(p.files, [{ key: 'other/c.txt', size: 5 }]);
    assert.deepEqual(p.prefixes, []);
    assert.equal(p.fromSelection, false);
  });

  test('dragging an unselected folder moves only that folder', () => {
    const p = dragPayload({ prefix: 'docs/' }, selection);
    assert.deepEqual(p.files, []);
    assert.deepEqual(p.prefixes, ['docs/']);
    assert.equal(p.fromSelection, false);
  });

  test('an unselected file with no size defaults to 0', () => {
    const p = dragPayload({ fileKey: 'x.txt' }, { files: [], prefixes: [] });
    assert.deepEqual(p.files, [{ key: 'x.txt', size: 0 }]);
    assert.equal(p.fromSelection, false);
  });
});

describe('dropAccepted', () => {
  test('accepts a valid move (file to an unrelated folder)', () => {
    const payload = { files: [{ key: 'reports/a.txt', size: 1 }], prefixes: [] };
    assert.equal(dropAccepted(payload, 'archive/'), true);
  });

  test('rejects dropping a folder into itself or a descendant', () => {
    const payload = { files: [], prefixes: ['photos/'] };
    assert.equal(dropAccepted(payload, 'photos/'), false);
    assert.equal(dropAccepted(payload, 'photos/2024/'), false);
  });

  test('rejects a no-op (file already in the destination prefix)', () => {
    const payload = { files: [{ key: 'reports/a.txt', size: 1 }], prefixes: [] };
    assert.equal(dropAccepted(payload, 'reports/'), false);
  });
});
