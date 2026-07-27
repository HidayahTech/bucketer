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
import { mount, fire, setInput } from '../helpers/render.js';
import { App } from '../../src/components/App.jsx';
import { saveConnectionCapabilities } from '../../src/lib/connections.js';

const CRED_KEYS = [
  's3b_endpoint', 's3b_bucket', 's3b_key_id', 's3b_provider',
  's3b_region_override', 's3b_capabilities', 's3b_profiles',
  's3b_last_profile_id', 's3b_connections', 's3b_credentials',
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

// Task 5 code review finding: handleSaveProfile read liveFormData.bucket/keyId raw
// instead of trimming them (as the old saveProfile path did), so a bucket or key ID
// picked up via ProfilePicker's inline "Save as profile…" — which writes straight
// from CredentialForm's onFormChange, bypassing credentialErrors()/handleSubmit's
// trim — could persist with stray whitespace and silently fail to reconnect later.
describe('App — saving a profile trims whitespace-padded fields', () => {
  test('bucket and key ID are trimmed before being persisted to s3b_connections/s3b_credentials', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-endpoint'), 'https://s3.us-east-1.amazonaws.com');
      setInput(query('#cred-bucket'), '  test-bucket  ');
      setInput(query('#cred-keyid'), '  AKIDEXAMPLE1234  ');

      const saveTrigger = query('.profile-save-trigger');
      assert.ok(saveTrigger, '"Save as profile…" trigger must be present');
      assert.ok(!saveTrigger.disabled, 'trigger must be enabled once endpoint/bucket/keyId are valid (trimmed)');
      fire(saveTrigger, 'click');

      const submitBtn = query('.profile-save-form button[type="submit"]');
      assert.ok(submitBtn, 'save-form submit button must appear after clicking the trigger');
      fire(submitBtn, 'click');

      const { connections } = JSON.parse(localStorage.getItem('s3b_connections') || '{}');
      const { credentials } = JSON.parse(localStorage.getItem('s3b_credentials') || '{}');
      assert.equal(connections?.length, 1, 'exactly one connection must be persisted');
      assert.equal(credentials?.length, 1, 'exactly one credential must be persisted');
      assert.equal(connections[0].bucket, 'test-bucket', 'bucket must be trimmed before persisting');
      assert.equal(credentials[0].keyId, 'AKIDEXAMPLE1234', 'key ID must be trimmed before persisting');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Task 5 code review finding: handleSaveProfile read capabilities off App's `connections`
// React state, which is only refreshed by the mount effect and by handleSaveProfile/
// handleDeleteProfile themselves. handleCapabilityChange and handleRefreshPermissions write
// straight to localStorage without ever updating that state array. So an update to an
// already-selected connection (e.g. renaming it) could read a stale, pre-capability-change
// snapshot and write it back, silently reverting whatever had just been learned.
describe('App — saving a profile does not clobber capabilities written directly to storage', () => {
  test('renaming an existing connection preserves capabilities saved via saveConnectionCapabilities', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    try {
      // Create one connection first, exactly as in the trim regression test above.
      setInput(query('#cred-endpoint'), 'https://s3.us-east-1.amazonaws.com');
      setInput(query('#cred-bucket'), 'test-bucket');
      setInput(query('#cred-keyid'), 'AKIDEXAMPLE1234');
      fire(query('.profile-save-trigger'), 'click');
      fire(query('.profile-save-form button[type="submit"]'), 'click');

      const beforeId = JSON.parse(localStorage.getItem('s3b_connections')).connections[0].id;

      // Simulate a capability learned during a session (e.g. a failed delete flips
      // 'delete' to 'denied'). In the real app this is written by handleCapabilityChange
      // / handleRefreshPermissions directly to localStorage — App's `connections` state
      // is never refreshed as a side effect of that write, so it still holds the
      // pre-change (capabilities: null) snapshot captured at the save above.
      const learned = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'denied' };
      saveConnectionCapabilities(beforeId, learned);

      // Now save again against the same still-selected connection (e.g. a rename).
      // The button now reads "Update profile…" because a connection is selected.
      fire(query('.profile-save-trigger'), 'click');
      setInput(query('.profile-save-form input[type="text"]'), 'Renamed connection');
      fire(query('.profile-save-form button[type="submit"]'), 'click');

      const after = JSON.parse(localStorage.getItem('s3b_connections'));
      const conn = after.connections.find(c => c.id === beforeId);
      assert.equal(after.connections.length, 1, 'the rename must update in place, not create a second connection');
      assert.equal(conn.name, 'Renamed connection', 'the rename must still take effect');
      assert.deepEqual(
        conn.capabilities,
        learned,
        'capabilities written directly to storage must survive a later profile save'
      );
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});
