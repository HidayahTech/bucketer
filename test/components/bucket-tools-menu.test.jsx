// Bucket tools ▾ (layout A, v1.67.0): duplicates, incomplete uploads and hidden versions behind
// one header disclosure instead of a row of always-visible buttons.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { BucketToolsMenu } from '../../src/components/BucketToolsMenu.jsx';

function setup() {
  const calls = [];
  const m = mount(
    h(BucketToolsMenu, {
      onFindDuplicates: () => calls.push('dups'),
      onIncompleteUploads: () => calls.push('incomplete'),
      onHiddenVersions: () => calls.push('hidden'),
    }),
  );
  return { ...m, calls, button: () => m.query('.bucket-tools-btn') };
}

describe('BucketToolsMenu', () => {
  test('starts closed, with aria-expanded=false and no items in the DOM', () => {
    const { query, button, cleanup } = setup();
    assert.equal(button().getAttribute('aria-expanded'), 'false');
    assert.equal(query('.bucket-tools-menu'), null);
    cleanup();
  });

  test('opening lists the three tools; each one runs its action and closes the menu', () => {
    for (const [label, expected] of [
      ['Find duplicate files…', 'dups'],
      ['Incomplete uploads…', 'incomplete'],
      ['Hidden versions and deleted files…', 'hidden'],
    ]) {
      const { queryAll, query, button, calls, cleanup } = setup();
      fire(button(), 'click');
      assert.equal(button().getAttribute('aria-expanded'), 'true');
      const item = queryAll('.bucket-tools-menu button').find((b) => b.textContent === label);
      assert.ok(item, `"${label}" is listed`);
      fire(item, 'click');
      assert.deepEqual(calls, [expected]);
      assert.equal(query('.bucket-tools-menu'), null, 'the menu closes after a pick');
      cleanup();
    }
  });

  test('Escape closes the menu and returns focus to the button', () => {
    const { query, button, cleanup } = setup();
    fire(button(), 'click');
    fire(document, 'keydown', { key: 'Escape' });
    assert.equal(query('.bucket-tools-menu'), null);
    assert.equal(document.activeElement, button());
    cleanup();
  });

  test('the incomplete-uploads item keeps its test id', () => {
    const { query, button, cleanup } = setup();
    fire(button(), 'click');
    assert.ok(query('[data-testid="open-incomplete-uploads"]'));
    cleanup();
  });
});
