// Tests for VaultUnlock — the passphrase-vault login screen.
//
// PASSWORD-MANAGER REQUIREMENTS UNDER TEST: a visible readonly username field
// carrying the exact constant 'Bucketer vault (this device)' with
// autocomplete="username"; a password-type passphrase field with
// autocomplete="current-password"; a stable `name` on every input. These are
// not stylistic — see the design doc's Password-manager interaction section.
//
// REAL CRYPTO, NOT MOCKED: jsdom's window.crypto has no `subtle`
// (verified empirically — window.crypto.subtle is undefined under jsdom), so
// this file patches it with Node's own WebCrypto (`node:crypto`'s `webcrypto`),
// the same implementation `test/vault.test.js` uses for the pure-Node vault
// tests. VaultUnlock calls the real unlockVault/resetVault from src/lib/vault.js
// (no injectable seams for them — the brief's Props are fixed at
// { connections, onUnlock, onReset }), so wrong-passphrase/corrupt scenarios
// are exercised against a real vault record built with createVault(), matching
// the technique test/vault.test.js already uses to distinguish the two. A real
// PBKDF2-600k derivation measures ~74ms in this environment (see
// task-4-report.md), so this adds real wall-clock time but stays fast.
//
// CLEANUP DISCIPLINE: all mounts use try/finally to call cleanup() even when
// an assertion fails, preventing orphaned Preact trees from interfering with
// subsequent tests. localStorage/sessionStorage are cleared in beforeEach so
// no vault leaks between tests.
import '../helpers/with-dom.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { VaultUnlock } from '../../src/components/VaultUnlock.jsx';
import { createVault, loadVaultRecord, saveVaultRecord } from '../../src/lib/vault.js';

// jsdom does not implement SubtleCrypto — patch in Node's real WebCrypto so the
// component's real unlockVault()/createVault() calls work end to end.
window.crypto.subtle = webcrypto.subtle;
const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);

const VAULT_USERNAME = 'Bucketer vault (this device)';
const PASSPHRASE = 'correct horse battery staple';

const CONN_A = { id: 'c1', name: 'Family photos (R/O)', bucket: 'family-photos', provider: 'b2', credentialId: 'cred1' };
const CONN_B = { id: 'c2', name: 'Site backups', bucket: 'site-backups', provider: 'b2', credentialId: 'cred2' };

function defaultProps(overrides = {}) {
  return { connections: [], onUnlock: () => {}, onReset: () => {}, ...overrides };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

// Bounded poll for the async unlock/reset chain (real PBKDF2, not a microtask) —
// mirrors the pattern in test/components/app.test.jsx rather than a fixed sleep.
async function waitFor(condition, { tries = 60, intervalMs = 10 } = {}) {
  for (let i = 0; i < tries && !condition(); i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return condition();
}

// Whether ANY reset-activating control is present — not just the confirm-step
// .btn-danger, which never renders until the ghost "Reset vault…" trigger
// beneath it has already been clicked. Checking .btn-danger alone would pass
// even if the trigger were wrongly shown for a non-'corrupt' reason, since the
// test never clicks through to the second step. Text-based rather than a CSS
// class, matching the "no dictated selectors" scope of this task.
function hasResetTrigger(form) {
  return [...form.querySelectorAll('button')].some(b => /reset/i.test(b.textContent));
}

describe('VaultUnlock — password-manager fields', () => {
  test('the username field is readonly and carries the exact vault constant', () => {
    const { query, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      const input = query('input[autocomplete="username"]');
      assert.ok(input, 'a username-autocomplete input must be present');
      assert.equal(input.value, VAULT_USERNAME, 'username value must be the exact constant, character for character');
      assert.equal(input.readOnly, true, 'username field must be readonly');
    } finally { cleanup(); }
  });

  test('the passphrase field is type="password" with autocomplete="current-password"', () => {
    const { query, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      const input = query('input[autocomplete="current-password"]');
      assert.ok(input, 'a current-password-autocomplete input must be present');
      assert.equal(input.type, 'password', 'passphrase field must be type="password"');
    } finally { cleanup(); }
  });

  test('every input has a non-empty name attribute', () => {
    const { queryAll, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      const inputs = queryAll('input');
      assert.ok(inputs.length >= 2, 'expected at least the username and passphrase inputs');
      for (const input of inputs) {
        assert.ok(input.getAttribute('name'), `input#${input.id || '(no id)'} must have a name attribute`);
      }
    } finally { cleanup(); }
  });
});

describe('VaultUnlock — connection list', () => {
  test('renders connection names', () => {
    const { text, cleanup } = mount(h(VaultUnlock, defaultProps({ connections: [CONN_A, CONN_B] })));
    try {
      assert.ok(text().includes('Family photos (R/O)'));
      assert.ok(text().includes('Site backups'));
    } finally { cleanup(); }
  });

  test('clicking a connection focuses the passphrase field', () => {
    const { query, queryAll, cleanup } = mount(h(VaultUnlock, defaultProps({ connections: [CONN_A, CONN_B] })));
    try {
      const rows = queryAll('.profile-row');
      assert.equal(rows.length, 2, 'expected one row per connection');
      fire(rows[1], 'click');
      assert.equal(document.activeElement, query('input[autocomplete="current-password"]'),
        'clicking a connection row must focus the passphrase field');
    } finally { cleanup(); }
  });
});

describe('VaultUnlock — unlock submission', () => {
  // Round-2 review: the original brief mandated onUnlock(passphrase), but the
  // passphrase has no use once unlockVault() has already derived and persisted
  // the session key — and unlike that single-purpose key, passphrases are
  // reused across services, so retaining it is the more sensitive leak of the
  // two. onUnlock is now called with no argument.
  test('submitting calls onUnlock with no argument', async () => {
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    // createVault leaves the vault unlocked (session key set) — clear that so
    // this test exercises the actual unlock submission, not an already-open vault.
    sessionStorage.clear();

    let calls = null;
    const { query, cleanup } = mount(h(VaultUnlock, defaultProps({
      onUnlock: (...args) => { calls = args; },
    })));
    try {
      setInput(query('input[autocomplete="current-password"]'), PASSPHRASE);
      fire(query('form'), 'submit');
      const ok = await waitFor(() => calls !== null);
      assert.ok(ok, 'onUnlock must be called after a correct passphrase is submitted');
      assert.deepEqual(calls, [], 'onUnlock must be called with no argument — the passphrase has already done its job by the time unlockVault resolves');
    } finally { cleanup(); }
  });

  test('the passphrase input is cleared after a successful unlock', async () => {
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.clear();

    const { query, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      const input = query('input[autocomplete="current-password"]');
      setInput(input, PASSPHRASE);
      fire(query('form'), 'submit');
      const cleared = await waitFor(() => input.value === '');
      assert.ok(cleared, 'the passphrase field must be cleared once unlock succeeds — it must not linger in the DOM or component state');
    } finally { cleanup(); }
  });

  test('the submit button disables and shows the spinner while unlocking is in flight', async () => {
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.clear();

    const { query, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      setInput(query('input[autocomplete="current-password"]'), PASSPHRASE);
      fire(query('form'), 'submit');
      // Checked immediately after submit, before the real PBKDF2 derivation
      // (~74ms in this environment) has any chance to resolve.
      const btn = query('button[type="submit"]');
      assert.ok(btn.disabled, 'submit button must disable the instant submission starts');
      assert.ok(query('.spinner'), 'the existing .spinner element must render while unlocking');
      // Let the real derivation finish so it doesn't bleed into the next test.
      await waitFor(() => !query('button[type="submit"]').disabled);
    } finally { cleanup(); }
  });
});

describe('VaultUnlock — wrong passphrase vs corrupt vault', () => {
  test('a wrong-passphrase result shows an error and renders no reset control', async () => {
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.clear();

    const { query, text, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      setInput(query('input[autocomplete="current-password"]'), 'definitely wrong');
      fire(query('form'), 'submit');
      const shown = await waitFor(() => /wrong/i.test(text()));
      assert.ok(shown, 'a wrong-passphrase error must be shown');
      assert.equal(query('.btn-danger'), null, 'a wrong passphrase must NOT offer a reset control');
      assert.ok(!hasResetTrigger(query('form')),
        'a wrong passphrase must NOT show even the first-step "Reset vault…" trigger');
    } finally { cleanup(); }
  });

  test('a corrupt vault shows an error and does render a reset control', async () => {
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.clear();
    // Corrupt the stored record the same way test/vault.test.js does: a 'check'
    // ciphertext whose length atob() rejects outright, so unlockVault's decode
    // fails before subtle.decrypt ever runs and is classified 'corrupt', not
    // 'wrong-passphrase' (see vault.js's unlockVault doc comment).
    const record = loadVaultRecord();
    record.check = { ...record.check, ct: 'valid' };
    saveVaultRecord(record);

    const { query, text, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      setInput(query('input[autocomplete="current-password"]'), PASSPHRASE);
      fire(query('form'), 'submit');
      const shown = await waitFor(() => /corrupt/i.test(text()));
      assert.ok(shown, 'a corrupt-vault error must be shown');
      assert.ok(hasResetTrigger(query('form')), 'a corrupt vault must offer a reset control');
    } finally { cleanup(); }
  });

  // Real-crypto fixtures naturally cover the states createVault() produces
  // (wrong-passphrase, corrupt) and can quietly skip ones that don't — this
  // exercises 'no-vault' by simply never calling createVault(). Only 'corrupt'
  // is allowed to offer reset; this pins that 'no-vault' does not, since it is
  // a distinct, non-destructive reason.
  test('a no-vault result shows an error and renders no reset control', async () => {
    // beforeEach already clears localStorage — no vault exists.
    const { query, text, cleanup } = mount(h(VaultUnlock, defaultProps()));
    try {
      setInput(query('input[autocomplete="current-password"]'), PASSPHRASE);
      fire(query('form'), 'submit');
      const shown = await waitFor(() => /no vault/i.test(text()));
      assert.ok(shown, 'a no-vault error must be shown');
      assert.equal(query('.btn-danger'), null, 'a no-vault result must NOT offer a reset control');
      assert.ok(!hasResetTrigger(query('form')),
        'a no-vault result must NOT show even the first-step "Reset vault…" trigger');
    } finally { cleanup(); }
  });
});

describe('VaultUnlock — reset confirmation', () => {
  async function mountCorrupted(props = {}) {
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.clear();
    const record = loadVaultRecord();
    record.check = { ...record.check, ct: 'valid' };
    saveVaultRecord(record);

    const helpers = mount(h(VaultUnlock, defaultProps(props)));
    setInput(helpers.query('input[autocomplete="current-password"]'), PASSPHRASE);
    fire(helpers.query('form'), 'submit');
    await waitFor(() => /corrupt/i.test(helpers.text()));
    return helpers;
  }

  test('activating the reset control does NOT call onReset before confirmation', async () => {
    let resetCalled = false;
    const { query, cleanup } = await mountCorrupted({ onReset: () => { resetCalled = true; } });
    try {
      const trigger = query('.reset-vault-trigger') || query('button.btn-danger') || [...query('form').querySelectorAll('button')].find(b => /reset/i.test(b.textContent));
      assert.ok(trigger, 'a reset-activating control must be present for a corrupt vault');
      fire(trigger, 'click');
      assert.ok(!resetCalled, 'onReset must not fire from the first click — a confirmation step must come first');
    } finally { cleanup(); }
  });

  test('confirming reset calls onReset', async () => {
    let resetCalled = false;
    const { query, cleanup } = await mountCorrupted({ onReset: () => { resetCalled = true; } });
    try {
      const trigger = [...query('form').querySelectorAll('button')].find(b => /reset/i.test(b.textContent));
      fire(trigger, 'click');
      const confirmBtn = [...query('form').querySelectorAll('button')].find(b => /yes|confirm/i.test(b.textContent));
      assert.ok(confirmBtn, 'a confirmation button must appear after activating reset');
      fire(confirmBtn, 'click');
      assert.ok(resetCalled, 'onReset must be called once the destructive action is confirmed');
    } finally { cleanup(); }
  });
});
