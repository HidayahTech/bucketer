// Tests for MoveQueue — the in-progress / recently-completed move operations panel.
// The MovePickerModal is the confirmation step, so MoveQueue has no confirm dialog: it
// renders active (discovering/checking/moving) and done entries. The highest-risk area is
// that collisions (items deliberately skipped, never overwritten) are shown DISTINCTLY
// from genuine failures, so a user understands what actually moved.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { MoveQueue } from '../../src/components/MoveQueue.jsx';

function makeOp(o = {}) {
  return {
    id: 'm1', phase: 'moving', files: ['a.txt'], prefixes: [], dest: 'archive/',
    moved: 0, total: 1, errors: [], collapsed: false, ...o,
  };
}

const NO_CALLBACKS = { onDismiss: () => {}, onCollapse: () => {} };

describe('MoveQueue — empty state', () => {
  test('renders nothing when ops is empty', () => {
    const { query, cleanup } = mount(h(MoveQueue, { ops: [], provider: 'r2', ...NO_CALLBACKS }));
    assert.equal(query('.move-queue'), null);
    cleanup();
  });
});

describe('MoveQueue — active states', () => {
  test('discovering phase shows "Listing folder contents"', () => {
    const { text, cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({ phase: 'discovering', files: [], prefixes: ['docs/'] })], provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Listing folder'));
    cleanup();
  });

  test('checking phase shows a destination-check message', () => {
    const { text, cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({ phase: 'checking' })], provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(/check/i.test(text()), 'checking phase must indicate the destination is being checked');
    cleanup();
  });

  test('moving phase shows "Moving" with progress', () => {
    const { text, cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({ phase: 'moving', files: ['a.txt', 'b.txt'], moved: 1, total: 2 })], provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Moving'));
    assert.ok(text().includes('1') && text().includes('2'), 'progress moved/total must appear');
    cleanup();
  });
});

describe('MoveQueue — done states', () => {
  test('done with no errors shows ✓ and "Moved"', () => {
    const { query, text, cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({ phase: 'done', moved: 1, total: 1 })], provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(query('.move-op-ok'), 'success icon must appear when done with no errors');
    assert.ok(text().includes('Moved'));
    cleanup();
  });

  test('done with a hard failure shows ✕ error icon', () => {
    const { query, cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({ phase: 'done', moved: 0, total: 1, errors: [{ key: 'a.txt', message: 'AccessDenied' }] })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(query('.move-op-err'), 'error icon must appear when a move genuinely failed');
    cleanup();
  });

  test('collisions are surfaced as "skipped", distinct from failures, without an error icon', () => {
    const { query, text, cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({
        phase: 'done', moved: 0, total: 1,
        errors: [{ key: 'reports/q1.pdf', message: 'An object already exists at the destination — skipped.', skipped: true }],
      })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(/skipped/i.test(text()), 'skipped count must appear in the summary');
    assert.ok(query('.move-op-ok'), 'a skip-only result is not a failure — it must show the success icon, not ✕');
    assert.equal(query('.move-op-err'), null, 'a collision must not be rendered as a hard failure');
    cleanup();
  });

  test('mixed skipped + failed shows both counts and the error icon', () => {
    const { query, text, cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({
        phase: 'done', moved: 1, total: 3,
        errors: [
          { key: 'x', message: 'already exists — skipped.', skipped: true },
          { key: 'y', message: 'AccessDenied' },
        ],
      })],
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(/skipped/i.test(text()), 'must report skipped count');
    assert.ok(/error/i.test(text()), 'must report failure count');
    assert.ok(query('.move-op-err'), 'a hard failure present → error icon');
    cleanup();
  });
});

describe('MoveQueue — interactions', () => {
  test('Dismiss calls onDismiss with the op id', () => {
    let dismissed = null;
    const { cleanup } = mount(h(MoveQueue, {
      ops: [makeOp({ id: 'op-9', phase: 'done', moved: 1, total: 1 })],
      provider: 'r2', onDismiss: (id) => { dismissed = id; }, onCollapse: () => {},
    }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Dismiss');
    fire(btn, 'click');
    assert.equal(dismissed, 'op-9');
    cleanup();
  });
});
