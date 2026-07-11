// Tests for CredentialForm.
// The credential form is the entry point to the entire application. Tests cover:
// field rendering, loading state, validation errors, provider auto-detection,
// and form submission.
//
// VALIDATION NOTE: credentialErrors() only flags non-empty malformed values
// (spaces, >63 chars). Empty required fields are enforced by HTML 'required'
// attributes in real browsers. jsdom does not enforce HTML required, so empty
// forms appear valid from JavaScript's perspective — the component relies on the
// browser's native form validation for that layer.
//
// CLEANUP DISCIPLINE: all mounts use try/finally to call cleanup() even when
// an assertion fails, preventing orphaned Preact trees from interfering with
// subsequent tests.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { CredentialForm } from '../../src/components/CredentialForm.jsx';

const EMPTY_INITIAL = { endpoint: '', bucket: '', keyId: '', secretKey: '', provider: null, regionOverride: '' };

const B2_INITIAL = {
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  bucket: 'my-bucket',
  keyId: 'keyabc',
  secretKey: 'secret',
  provider: 'b2',
  regionOverride: 'us-west-002',
};

// A valid bucket with a space — triggers credentialErrors.bucket
const INVALID_BUCKET = 'my bucket';

function defaultProps(overrides = {}) {
  return { initial: EMPTY_INITIAL, onSave: () => {}, onFormChange: () => {}, loading: false, ...overrides };
}

describe('CredentialForm — field rendering', () => {
  test('renders the Endpoint URL input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try { assert.ok(query('#cred-endpoint'), 'endpoint input must be present'); }
    finally { cleanup(); }
  });

  test('renders the Bucket Name input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try { assert.ok(query('#cred-bucket'), 'bucket input must be present'); }
    finally { cleanup(); }
  });

  test('renders the Key ID input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try { assert.ok(query('#cred-keyid'), 'key ID input must be present'); }
    finally { cleanup(); }
  });

  test('renders the Secret Key input as type="password"', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const input = query('#cred-secretkey');
      assert.ok(input, 'secret key input must be present');
      assert.equal(input.type, 'password', 'secret key must be a password field');
    } finally { cleanup(); }
  });

  test('renders the Provider Override select', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try { assert.ok(query('#cred-provider'), 'provider override select must be present'); }
    finally { cleanup(); }
  });

  test('renders the Region input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try { assert.ok(query('#cred-region'), 'region input must be present'); }
    finally { cleanup(); }
  });

  test('renders the Connect submit button', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const btn = query('button[type="submit"]');
      assert.ok(btn, 'submit button must be present');
      assert.ok(btn.textContent.includes('Connect'));
    } finally { cleanup(); }
  });

  test('shows the sessionStorage security hint for the secret key field', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps()));
    try { assert.ok(text().includes('sessionStorage')); }
    finally { cleanup(); }
  });

  test('required attribute is present on endpoint, bucket, keyId, and secretKey fields', () => {
    // HTML required is the guard for empty fields in real browsers (not jsdom).
    // This test verifies the attribute is present so the browser enforces it.
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(query('#cred-endpoint').required, 'endpoint must be required');
      assert.ok(query('#cred-bucket').required, 'bucket must be required');
      assert.ok(query('#cred-keyid').required, 'keyId must be required');
      assert.ok(query('#cred-secretkey').required, 'secretKey must be required');
    } finally { cleanup(); }
  });
});

describe('CredentialForm — loading state', () => {
  test('shows "Connecting…" text when loading=true', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ loading: true })));
    try { assert.ok(query('button[type="submit"]').textContent.includes('Connecting')); }
    finally { cleanup(); }
  });

  test('Connect button is disabled when loading=true', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ loading: true })));
    try { assert.ok(query('button[type="submit"]').disabled, 'submit must be disabled while loading'); }
    finally { cleanup(); }
  });

  test('shows "Connect" (not "Connecting…") when loading=false', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ loading: false })));
    try {
      const text = query('button[type="submit"]').textContent;
      assert.ok(text.includes('Connect'));
      assert.ok(!text.includes('Connecting'));
    } finally { cleanup(); }
  });
});

describe('CredentialForm — validation', () => {
  test('Connect button is enabled when the form is empty (empty fields use HTML required, not JS validation)', () => {
    // credentialErrors() only flags non-empty malformed values. Empty fields rely on
    // browser-native required attribute validation (not tested in jsdom).
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ initial: EMPTY_INITIAL })));
    try { assert.ok(!query('button[type="submit"]').disabled, 'submit is enabled for an empty form — JS validation only fires for malformed, non-empty values'); }
    finally { cleanup(); }
  });

  test('Connect button is enabled when all required fields are validly filled', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ initial: B2_INITIAL })));
    try { assert.ok(!query('button[type="submit"]').disabled, 'submit must be enabled when all required fields are filled'); }
    finally { cleanup(); }
  });

  test('shows a bucket field error when bucket contains spaces', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: { ...B2_INITIAL, bucket: INVALID_BUCKET },
    })));
    try {
      const bucketError = query('.field-error');
      assert.ok(bucketError, 'a .field-error element must appear for a bucket with spaces');
      assert.ok(bucketError.textContent.toLowerCase().includes('space') || bucketError.textContent.toLowerCase().includes('bucket'));
    } finally { cleanup(); }
  });

  test('Connect button is disabled when bucket contains a space', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: { ...B2_INITIAL, bucket: INVALID_BUCKET },
    })));
    try { assert.ok(query('button[type="submit"]').disabled, 'submit must be disabled when bucket has spaces'); }
    finally { cleanup(); }
  });

  test('shows a keyId error when keyId contains spaces', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: { ...B2_INITIAL, keyId: 'AK ID 123' },
    })));
    try {
      const err = query('.field-error');
      assert.ok(err, 'a field-error must appear for a keyId with spaces');
    } finally { cleanup(); }
  });
});

describe('CredentialForm — provider auto-detection', () => {
  test('shows "Detected: Backblaze B2" hint when a B2 endpoint is pre-filled', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps({ initial: B2_INITIAL })));
    try {
      assert.ok(
        text().includes('Detected') && (text().includes('Backblaze') || text().includes('B2')),
        'provider detection hint must appear for a known B2 endpoint'
      );
    } finally { cleanup(); }
  });

  test('typing a B2 endpoint shows the B2 detection hint', () => {
    const { query, text, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const endpointInput = query('#cred-endpoint');
      assert.ok(endpointInput, '#cred-endpoint input must be present');
      setInput(endpointInput, 'https://s3.us-west-002.backblazeb2.com');
      assert.ok(
        text().includes('Detected') || text().includes('Backblaze') || text().includes('B2'),
        'provider detection hint must appear after typing a B2 endpoint'
      );
    } finally { cleanup(); }
  });

  test('shows the B2 master-key warning when B2 is the detected provider', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps({ initial: B2_INITIAL })));
    try {
      assert.ok(
        text().includes('B2') && text().toLowerCase().includes('master'),
        'B2 master key warning must appear when B2 is detected'
      );
    } finally { cleanup(); }
  });

  test('auto-fills the region when a B2 endpoint with an embedded region is entered', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: { ...EMPTY_INITIAL, endpoint: 'https://s3.us-west-002.backblazeb2.com' },
    })));
    try {
      const regionInput = query('#cred-region');
      assert.ok(regionInput, '#cred-region input must be present');
      assert.ok(
        regionInput.value.includes('us-west-002'),
        'region must be auto-filled from a B2 endpoint that embeds the region'
      );
    } finally { cleanup(); }
  });

  test('shows "Auto-filled from endpoint URL" hint when region is inferred', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: { ...EMPTY_INITIAL, endpoint: 'https://s3.us-east-1.wasabisys.com' },
    })));
    try {
      assert.ok(
        text().includes('Auto-filled from endpoint'),
        '"Auto-filled from endpoint URL" hint must appear when region is inferred from the endpoint'
      );
    } finally { cleanup(); }
  });
});

describe('CredentialForm — form submission', () => {
  test('calls onSave when submitted with a valid form', () => {
    let saved = null;
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: B2_INITIAL,
      onSave: data => { saved = data; },
    })));
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.ok(saved, 'onSave must be called on submit');
    } finally { cleanup(); }
  });

  test('calls onSave with trimmed endpoint (no trailing slash)', () => {
    let saved = null;
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: { ...B2_INITIAL, endpoint: 'https://s3.us-west-002.backblazeb2.com/' },
      onSave: data => { saved = data; },
    })));
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.ok(saved, 'onSave must be called');
      assert.ok(!saved.endpoint.endsWith('/'), 'trailing slash must be stripped from the endpoint');
    } finally { cleanup(); }
  });

  test('calls onSave with the correct bucket and keyId', () => {
    let saved = null;
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: B2_INITIAL,
      onSave: data => { saved = data; },
    })));
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.equal(saved.bucket, 'my-bucket');
      assert.equal(saved.keyId, 'keyabc');
    } finally { cleanup(); }
  });

  test('does NOT call onSave when the form has JS validation errors (spaces in bucket)', () => {
    let saveCalled = false;
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({
      initial: { ...B2_INITIAL, bucket: INVALID_BUCKET },
      onSave: () => { saveCalled = true; },
    })));
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.ok(!saveCalled, 'onSave must not be called when the form has JS validation errors');
    } finally { cleanup(); }
  });
});

describe('CredentialForm — autofocus secret', () => {
  test('focuses the Secret Key field on mount when autoFocusSecret is set', async () => {
    const initial = { endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'AKID', secretKey: '', provider: null, regionOverride: '' };
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ initial, autoFocusSecret: true })));
    try {
      await new Promise(r => setTimeout(r, 0));
      assert.equal(document.activeElement, query('#cred-secretkey'), 'secret field must be focused');
    } finally { cleanup(); }
  });

  test('does NOT focus the Secret Key field when autoFocusSecret is falsy', async () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      await new Promise(r => setTimeout(r, 0));
      assert.notEqual(document.activeElement, query('#cred-secretkey'), 'secret field must not be auto-focused');
    } finally { cleanup(); }
  });
});
