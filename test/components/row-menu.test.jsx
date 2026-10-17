// Row ⋯ menu (layout A, slice 4b): every row action except Download, labelled in words, behind
// one disclosure per row.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { RowMenu } from '../../src/components/RowMenu.jsx';

function setup(props = {}) {
  const calls = [];
  const m = mount(
    h(RowMenu, {
      name: 'notes.txt',
      items: [
        { label: 'Rename', icon: 'pencil', onSelect: () => calls.push('rename') },
        { label: 'Move to…', icon: 'move', onSelect: () => calls.push('move'), disabled: true, title: 'not permitted' },
        { label: 'Delete…', icon: 'trash', onSelect: () => calls.push('delete'), danger: true, separator: true },
      ],
      ...props,
    }),
  );
  return { ...m, calls, button: () => m.query('.row-menu-btn'), items: () => m.queryAll('.row-menu-item') };
}

describe('RowMenu', () => {
  test('starts closed; the button is named for the row', () => {
    const { query, button, cleanup } = setup();
    assert.equal(button().getAttribute('aria-expanded'), 'false');
    assert.equal(button().getAttribute('aria-label'), 'More actions for notes.txt');
    assert.equal(query('.row-menu'), null);
    cleanup();
  });

  test('opening shows the row name and the labelled items; a pick runs it and closes', () => {
    const { query, button, items, calls, cleanup } = setup();
    fire(button(), 'click');
    assert.equal(button().getAttribute('aria-expanded'), 'true');
    assert.equal(query('.row-menu-label').textContent, 'notes.txt');
    assert.deepEqual(
      items().map((b) => b.textContent.trim()),
      ['Rename', 'Move to…', 'Delete…'],
    );
    fire(items()[0], 'click');
    assert.deepEqual(calls, ['rename']);
    assert.equal(query('.row-menu'), null);
    cleanup();
  });

  test('a disabled item stays listed with its reason, and Delete sits apart in danger style', () => {
    const { query, button, items, cleanup } = setup();
    fire(button(), 'click');
    const [, move, del] = items();
    assert.equal(move.disabled, true);
    assert.equal(move.title, 'not permitted');
    assert.ok(del.classList.contains('row-menu-danger'));
    assert.ok(query('.row-menu-sep'), 'a rule separates Delete');
    cleanup();
  });

  test('Escape closes and returns focus to ⋯; a click outside closes', () => {
    const { query, button, cleanup } = setup();
    fire(button(), 'click');
    fire(document, 'keydown', { key: 'Escape' });
    assert.equal(query('.row-menu'), null);
    assert.equal(document.activeElement, button());
    fire(button(), 'click');
    fire(document.body, 'mousedown');
    assert.equal(query('.row-menu'), null);
    cleanup();
  });

  test('Cancel (shown on phones) closes the menu and returns focus to ⋯', () => {
    const { query, button, calls, cleanup } = setup();
    fire(button(), 'click');
    fire(query('.row-menu-cancel'), 'click');
    assert.equal(query('.row-menu'), null);
    assert.equal(document.activeElement, button());
    assert.deepEqual(calls, []);
    cleanup();
  });

  test('a row near the bottom of the view opens its menu upward (ux-review 4b M1)', () => {
    const { query, button, cleanup } = setup();
    const orig = button().getBoundingClientRect;
    button().getBoundingClientRect = () => ({ top: window.innerHeight - 40, bottom: window.innerHeight - 4 });
    fire(button(), 'click');
    assert.ok(query('.row-menu').classList.contains('copy-link-popover--up'));
    button().getBoundingClientRect = orig;
    cleanup();
  });

  test('done swaps the icon to a check and the name to doneLabel', () => {
    const { button, cleanup } = setup({ done: true, doneLabel: 'Link copied for notes.txt' });
    assert.equal(button().getAttribute('aria-label'), 'Link copied for notes.txt');
    assert.ok(button().querySelector('[data-icon="check"]'));
    cleanup();
  });

  test('clicks inside the menu do not reach the row (rows navigate or preview on click)', () => {
    let rowClicks = 0;
    const m = mount(
      h(
        'div',
        { onClick: () => rowClicks++ },
        h(RowMenu, { name: 'x', items: [{ label: 'A', icon: 'info', onSelect() {} }] }),
      ),
    );
    fire(m.query('.row-menu-btn'), 'click');
    fire(m.query('.row-menu-item'), 'click');
    assert.equal(rowClicks, 0);
    m.cleanup();
  });
});
