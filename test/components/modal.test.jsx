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
      </Modal>,
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
    const { query, cleanup } = mount(
      <Modal
        onClose={() => {
          called = true;
        }}
      />,
    );
    fire(query('.modal-overlay'), 'click');
    assert.ok(called, 'onClose must fire when overlay is clicked');
    cleanup();
  });

  test('does not call onClose when dialog is clicked', () => {
    let called = false;
    const { query, cleanup } = mount(
      <Modal
        onClose={() => {
          called = true;
        }}
      />,
    );
    fire(query('.modal-dialog'), 'click');
    assert.equal(called, false, 'clicking the dialog must not bubble to the overlay');
    cleanup();
  });

  // R07 / K2: the shared modal must behave as a dialog for keyboard and AT users.
  test('dialog has role=dialog, aria-modal, and is labelled by its .modal-title', () => {
    const { query, cleanup } = mount(
      <Modal onClose={() => {}}>
        <div class="modal-title">Delete files</div>
      </Modal>,
    );
    const dialog = query('.modal-dialog');
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    assert.ok(labelId, 'dialog must reference its title');
    assert.equal(document.getElementById(labelId)?.textContent, 'Delete files');
    cleanup();
  });

  test('moves focus into the dialog on open', () => {
    const { query, cleanup } = mount(
      <Modal onClose={() => {}}>
        <button id="first">OK</button>
      </Modal>,
    );
    assert.ok(query('.modal-dialog').contains(document.activeElement), 'focus must be inside the dialog');
    cleanup();
  });

  test('keeps focus on an element the content already focused (autoFocus)', () => {
    function Content() {
      return (
        <>
          <button id="first">OK</button>
          <input id="name" ref={(el) => el && el.focus()} />
        </>
      );
    }
    const { query, cleanup } = mount(
      <Modal onClose={() => {}}>
        <Content />
      </Modal>,
    );
    assert.equal(document.activeElement, query('#name'));
    cleanup();
  });

  test('Escape closes the dialog and does not reach document listeners', () => {
    let called = 0;
    let docSaw = false;
    const docHandler = (e) => {
      if (e.key === 'Escape') docSaw = true;
    };
    document.addEventListener('keydown', docHandler);
    const { query, cleanup } = mount(
      <Modal onClose={() => called++}>
        <button id="first">OK</button>
      </Modal>,
    );
    fire(query('#first'), 'keydown', { key: 'Escape' });
    document.removeEventListener('keydown', docHandler);
    assert.equal(called, 1, 'Escape must call onClose once');
    assert.equal(docSaw, false, 'Escape must not also close things behind the dialog (e.g. the sidebar)');
    cleanup();
  });

  test('Tab from the last control wraps to the first, Shift+Tab from the first wraps to the last', () => {
    const { query, cleanup } = mount(
      <Modal onClose={() => {}}>
        <button id="first">A</button>
        <button id="last">B</button>
      </Modal>,
    );
    query('#last').focus();
    fire(query('#last'), 'keydown', { key: 'Tab' });
    assert.equal(document.activeElement, query('#first'));
    fire(query('#first'), 'keydown', { key: 'Tab', shiftKey: true });
    assert.equal(document.activeElement, query('#last'));
    cleanup();
  });

  test('returns focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { cleanup } = mount(
      <Modal onClose={() => {}}>
        <button>OK</button>
      </Modal>,
    );
    assert.notEqual(document.activeElement, opener);
    cleanup();
    assert.equal(document.activeElement, opener, 'focus must return to the element that opened the dialog');
    opener.remove();
  });
});
