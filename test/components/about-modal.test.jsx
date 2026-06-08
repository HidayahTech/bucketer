// Tests for AboutModal.
// Three close mechanisms must all work: backdrop click, Escape key, and the
// dialog's internal close button. The dialog click propagation guard must also
// work — clicking inside the dialog must NOT close it. These are important
// because users who accidentally click inside a modal should not lose context.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { AboutModal } from '../../src/components/AboutModal.jsx';

describe('AboutModal — content', () => {
  test('renders the "About Bucketer" title', () => {
    const { text, cleanup } = mount(h(AboutModal, { onClose: () => {} }));
    assert.ok(text().includes('About Bucketer'));
    cleanup();
  });

  test('mentions sessionStorage security (core trust model)', () => {
    const { text, cleanup } = mount(h(AboutModal, { onClose: () => {} }));
    assert.ok(
      text().includes('sessionStorage'),
      'About page must mention sessionStorage as the security model for the secret key'
    );
    cleanup();
  });

  test('renders a modal-overlay element', () => {
    const { query, cleanup } = mount(h(AboutModal, { onClose: () => {} }));
    assert.ok(query('.modal-overlay'), 'modal-overlay must be present');
    cleanup();
  });
});

describe('AboutModal — close mechanisms', () => {
  test('clicking the backdrop overlay calls onClose', () => {
    let closed = false;
    const { query, cleanup } = mount(h(AboutModal, { onClose: () => { closed = true; } }));
    fire(query('.modal-overlay'), 'click');
    assert.ok(closed, 'backdrop click must call onClose');
    cleanup();
  });

  test('clicking inside the dialog does NOT call onClose', () => {
    let closed = false;
    const { query, cleanup } = mount(h(AboutModal, { onClose: () => { closed = true; } }));
    fire(query('.modal-dialog'), 'click');
    assert.ok(!closed, 'clicking inside the dialog must NOT call onClose (stopPropagation)');
    cleanup();
  });

  test('pressing Escape calls onClose', () => {
    let closed = false;
    const { cleanup } = mount(h(AboutModal, { onClose: () => { closed = true; } }));
    fire(document, 'keydown', { key: 'Escape' });
    assert.ok(closed, 'Escape key must call onClose');
    cleanup();
  });

  test('pressing a non-Escape key does NOT call onClose', () => {
    let closed = false;
    const { cleanup } = mount(h(AboutModal, { onClose: () => { closed = true; } }));
    fire(document, 'keydown', { key: 'Enter' });
    fire(document, 'keydown', { key: 'Tab' });
    assert.ok(!closed, 'non-Escape keys must not close the modal');
    cleanup();
  });

  test('cleanup removes the Escape key listener (no ghost listener after unmount)', () => {
    let closedAfterUnmount = false;
    const { cleanup } = mount(h(AboutModal, { onClose: () => { closedAfterUnmount = true; } }));
    cleanup(); // unmount — should remove the keydown listener
    fire(document, 'keydown', { key: 'Escape' });
    assert.ok(!closedAfterUnmount, 'Escape key must not fire after the modal is unmounted');
  });
});
