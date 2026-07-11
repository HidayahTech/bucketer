// Tests for App.jsx — session state machine.
// Tests the disconnected state (no credentials in localStorage) which is the
// initial experience for new users. The connected and connecting states require
// a real S3 probe, so they are covered by E2E tests, not here.
//
// App.jsx reads credentials from localStorage on mount and automatically starts
// connecting if valid credentials are found. These tests clear localStorage before
// mounting to ensure the disconnected state renders predictably.
import '../helpers/with-dom.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { App } from '../../src/components/App.jsx';

const CRED_KEYS = [
  's3b_endpoint', 's3b_bucket', 's3b_key_id', 's3b_provider',
  's3b_region_override', 's3b_capabilities', 's3b_profiles',
  's3b_last_profile_id',
];

function clearAppStorage() {
  CRED_KEYS.forEach(k => localStorage.removeItem(k));
  sessionStorage.removeItem('s3b_secret_key');
}

describe('App — disconnected state', () => {
  before(() => clearAppStorage());

  test('renders without throwing when no credentials are stored', () => {
    clearAppStorage();
    assert.doesNotThrow(() => {
      const { cleanup } = mount(h(App, {}));
      cleanup();
    });
  });

  test('shows the credential form (splash screen) when no credentials are stored', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    // The credential form is shown in the disconnected state
    const form = query('form') || query('.cred-form') || query('[id="cred-endpoint"]');
    assert.ok(form, 'credential form must be shown when no credentials are stored');
    cleanup();
    clearAppStorage();
  });

  test('does NOT show the Browser file listing when disconnected', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    assert.equal(query('.browser-table') || query('.file-table'), null, 'file browser must not render in disconnected state');
    cleanup();
    clearAppStorage();
  });

  test('shows the Connect button in the credential form', () => {
    clearAppStorage();
    const { cleanup } = mount(h(App, {}));
    const submitBtn = document.querySelector('button[type="submit"]');
    assert.ok(submitBtn, 'Connect submit button must be present in disconnected state');
    assert.ok(submitBtn.textContent.includes('Connect'), 'submit button must say "Connect"');
    cleanup();
    clearAppStorage();
  });
});

describe('App — shared-link pre-fill banner', () => {
  test('with a key ID in the URL, banner prompts for only the Secret Key', () => {
    clearAppStorage();
    window.location.hash = '#endpoint=https%3A%2F%2Fs3.example.com&bucket=my-bucket&keyId=AKID999';
    const { text, cleanup } = mount(h(App, {}));
    try {
      assert.ok(text().includes('enter your Secret Key to connect'),
        'banner must prompt for only the Secret Key when the link supplied a key ID');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });

  test('without a key ID in the URL, banner prompts for Key ID and Secret Key', () => {
    clearAppStorage();
    window.location.hash = '#endpoint=https%3A%2F%2Fs3.example.com&bucket=my-bucket';
    const { text, cleanup } = mount(h(App, {}));
    try {
      assert.ok(text().includes('enter your Key ID and Secret Key'),
        'banner must prompt for both fields when the link omitted the key ID');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });
});
