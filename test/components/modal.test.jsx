import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { Modal } from '../../src/components/Modal.jsx';

describe('Modal', () => {
  test('renders children inside the dialog', () => {
    const { query, cleanup } = mount(
      <Modal onClose={() => {}}>
        <span id="child">hello</span>
      </Modal>
    );
    assert.ok(query('#child'), 'child content must be rendered');
    cleanup();
  });

  test('overlay has modal-overlay class', () => {
    const { query, cleanup } = mount(<Modal onClose={() => {}} />);
    assert.ok(query('.modal-overlay'), 'wrapper must have modal-overlay class');
    cleanup();
  });

  test('dialog has modal-dialog class', () => {
    const { query, cleanup } = mount(<Modal onClose={() => {}} />);
    assert.ok(query('.modal-dialog'), 'dialog must have modal-dialog class');
    cleanup();
  });

  test('applies extra class to dialog element', () => {
    const { query, cleanup } = mount(<Modal onClose={() => {}} class="storage-dialog" />);
    assert.ok(query('.modal-dialog.storage-dialog'), 'dialog must carry the extra class');
    cleanup();
  });

  test('calls onClose when overlay is clicked', () => {
    let called = false;
    const { query, cleanup } = mount(<Modal onClose={() => { called = true; }} />);
    fire(query('.modal-overlay'), 'click');
    assert.ok(called, 'onClose must fire when overlay is clicked');
    cleanup();
  });

  test('does not call onClose when dialog is clicked', () => {
    let called = false;
    const { query, cleanup } = mount(<Modal onClose={() => { called = true; }} />);
    fire(query('.modal-dialog'), 'click');
    assert.equal(called, false, 'clicking the dialog must not bubble to the overlay');
    cleanup();
  });
});
