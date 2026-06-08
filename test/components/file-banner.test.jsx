// Tests for FileBanner.
// FileBanner renders only when window.location.protocol === 'file:'. The jsdom test
// environment starts at http://localhost, and window.location.protocol is
// non-configurable in jsdom (cannot be overridden with Object.defineProperty).
//
// Testable in jsdom:
//   - Returns null for http: protocol (the normal, non-file case)
//   - Component mounts without throwing
//
// Not testable in jsdom without further infrastructure:
//   - Banner content when running from file:// (requires E2E test or jsdom reconfigure)
//   - Dismiss flow (requires file:// state)
//
// The http: null-render is the most important case: it ensures FileBanner never
// renders noise on the normal serve path.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { FileBanner } from '../../src/components/FileBanner.jsx';

describe('FileBanner — http protocol (default)', () => {
  test('renders nothing when protocol is http:', () => {
    // jsdom starts at http://localhost:3000/ — FileBanner must return null
    const { query, cleanup } = mount(h(FileBanner, {}));
    assert.equal(query('.banner'), null, 'FileBanner must not render on http:');
    cleanup();
  });

  test('mounts without throwing on http: protocol', () => {
    assert.doesNotThrow(() => {
      const { cleanup } = mount(h(FileBanner, {}));
      cleanup();
    });
  });
});
