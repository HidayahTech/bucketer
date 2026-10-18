// Tests for ChangelogModal.
// Covers: changelog content renders, current-version badge, close mechanisms
// (backdrop, Escape, Close button, dialog click stops propagation), and the
// upstream check button in idle state.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { ChangelogModal } from '../../src/components/ChangelogModal.jsx';
import { CHANGELOG, CURRENT_VERSION } from '../../src/lib/changelog.js';

describe('ChangelogModal — content', () => {
  test('renders the "What\'s new" title', () => {
    const { text, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    assert.ok(text().toLowerCase().includes("what's new"), 'modal title must include "What\'s new"');
    cleanup();
  });

  test('renders at least one changelog entry', () => {
    const { queryAll, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    assert.ok(queryAll('.changelog-entry').length > 0, 'at least one changelog entry must render');
    cleanup();
  });

  test('shows the current version number in a badge', () => {
    const { query, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    const badge = query('.changelog-current-badge');
    assert.ok(badge, '.changelog-current-badge must be present for the current version');
    assert.ok(badge.textContent.toLowerCase().includes('current'), 'badge must say "current"');
    cleanup();
  });

  test('current version entry is present in the changelog', () => {
    const { text, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    assert.ok(text().includes(CURRENT_VERSION), 'current version number must appear in the changelog');
    cleanup();
  });

  // BUG-084: prose entries (v1.45.0 onward) rendered as a bare title.
  test("renders each entry's prose paragraphs, not just its title", () => {
    const { queryAll, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    const paras = queryAll('.changelog-para').map((p) => p.textContent);
    const expected = CHANGELOG.flatMap((e) => e.changes.filter((c) => c.para !== undefined).map((c) => c.para));
    assert.ok(expected.length > 0, 'the in-app changelog must contain prose paragraphs');
    assert.deepEqual(paras, expected, 'every paragraph renders, in order');
    cleanup();
  });

  test('links to the full changelog on GitLab', () => {
    const { query, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    const link = query('.changelog-full-link');
    assert.ok(link, 'full-changelog link must render');
    // Modal focuses the first focusable element on open; inside the scrolling
    // list, that scrolled the dialog to its last entry.
    assert.equal(link.closest('.changelog-body'), null, 'link must sit outside the scrolling list');
    assert.equal(link.getAttribute('href'), 'https://gitlab.com/hidayahtech/bucketer/-/blob/main/CHANGELOG.md');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.ok(link.getAttribute('rel').includes('noopener'), 'link must not hand the app window to GitLab');
    cleanup();
  });

  test('shows "Check for upstream release" button in initial idle state', () => {
    const { text, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    assert.ok(text().includes('Check for upstream release'), '"Check for upstream release" button must be present');
    cleanup();
  });

  test('shows the build-integrity verify button (pre-auth surface)', () => {
    // The integrity check lives in ChangelogModal so it is reachable from the
    // header version button before the user enters any credentials. Anywhere
    // gated behind authentication would defeat the point — you want to verify
    // the running build BEFORE you trust it with your secret key.
    const { queryAll, cleanup } = mount(h(ChangelogModal, { onClose: () => {} }));
    const verifyBtn = queryAll('button').find((b) => /verify build integrity/i.test(b.textContent));
    assert.ok(verifyBtn, 'IntegrityCheck button must render inside ChangelogModal');
    cleanup();
  });
});

describe('ChangelogModal — close mechanisms', () => {
  test('Close button calls onClose', () => {
    let closed = false;
    const { cleanup } = mount(
      h(ChangelogModal, {
        onClose: () => {
          closed = true;
        },
      }),
    );
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close');
    assert.ok(btn, 'Close button must be present');
    fire(btn, 'click');
    assert.ok(closed, 'onClose must be called when Close is clicked');
    cleanup();
  });

  test('clicking the backdrop overlay calls onClose', () => {
    let closed = false;
    const { query, cleanup } = mount(
      h(ChangelogModal, {
        onClose: () => {
          closed = true;
        },
      }),
    );
    fire(query('.modal-overlay'), 'click');
    assert.ok(closed, 'backdrop click must call onClose');
    cleanup();
  });

  test('clicking inside the dialog does NOT call onClose', () => {
    let closed = false;
    const { query, cleanup } = mount(
      h(ChangelogModal, {
        onClose: () => {
          closed = true;
        },
      }),
    );
    fire(query('.modal-dialog'), 'click');
    assert.ok(!closed, 'clicking inside the dialog must not close it (stopPropagation)');
    cleanup();
  });

  test('pressing Escape calls onClose', () => {
    let closed = false;
    const { cleanup } = mount(
      h(ChangelogModal, {
        onClose: () => {
          closed = true;
        },
      }),
    );
    fire(document, 'keydown', { key: 'Escape' });
    assert.ok(closed, 'Escape key must call onClose');
    cleanup();
  });

  test('pressing a non-Escape key does NOT call onClose', () => {
    let closed = false;
    const { cleanup } = mount(
      h(ChangelogModal, {
        onClose: () => {
          closed = true;
        },
      }),
    );
    fire(document, 'keydown', { key: 'Enter' });
    assert.ok(!closed, 'non-Escape key must not close the modal');
    cleanup();
  });

  test('unmounting removes the Escape key listener', () => {
    let closedAfterUnmount = false;
    const { cleanup } = mount(
      h(ChangelogModal, {
        onClose: () => {
          closedAfterUnmount = true;
        },
      }),
    );
    cleanup();
    fire(document, 'keydown', { key: 'Escape' });
    assert.ok(!closedAfterUnmount, 'Escape must not fire after modal is unmounted');
  });
});
