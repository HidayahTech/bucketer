// Copyright (C) 2026 HidayahTech, LLC
import { useState, useRef } from 'preact/hooks';
import { unlockVault, resetVault } from '../lib/vault.js';
import { PROVIDER_LABELS } from '../lib/provider.js';

// This unlock is device-local, not an account — the vault has no invented human
// username. The constant below exists solely so password managers (KeePassXC,
// Bitwarden, browser-native) have something to key an (origin, username) entry
// on that cannot collide with a real S3 key ID (opaque alphanumerics like
// `AKIA…`/`0057…` — this string's spaces and parentheses rule that out). See
// the design doc's "Password-manager interaction" section.
export const VAULT_USERNAME = 'Bucketer vault (this device)';

function connectionHint(conn) {
  const parts = [];
  if (conn.provider) parts.push(PROVIDER_LABELS[conn.provider] || conn.provider.toUpperCase());
  if (conn.bucket) parts.push(conn.bucket);
  return parts.join(' · ');
}

// 'wrong-passphrase' vs 'corrupt' vs 'no-vault' get different copy, and only
// 'corrupt' is allowed to offer the destructive reset — see the module doc in
// vault.js for why the crypto layer cannot tell "wrong key" apart from a
// tampered ciphertext, and why that split is delegated to this UI layer instead.
const ERROR_TEXT = {
  'wrong-passphrase': 'Wrong passphrase — try again.',
  'corrupt':           "This vault's data is corrupt and can't be unlocked with any passphrase.",
  'no-vault':          'No vault was found on this device.',
};

export function VaultUnlock({ connections = [], onUnlock, onReset }) {
  const [passphrase, setPassphrase] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState(null); // 'wrong-passphrase' | 'corrupt' | 'no-vault' | null
  const [confirmingReset, setConfirmingReset] = useState(false);
  const passphraseRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (unlocking) return;
    setUnlocking(true);
    setError(null);
    const result = await unlockVault(passphrase, window.crypto.subtle);
    setUnlocking(false);
    if (result.ok) {
      // Clear the passphrase from our own state — and thus the rendered input —
      // before handing control to the parent via onUnlock(). unlockVault() has
      // already derived the session key and persisted it; nothing downstream
      // needs the passphrase itself, and unlike that single-purpose derived key,
      // a passphrase is often reused across services, so it is the more
      // sensitive of the two things left in memory once unlock succeeds. Clearing
      // first (not after) means there is no window in which a re-render —
      // whether triggered by our own state or provoked by onUnlock() itself —
      // could still show it.
      setPassphrase('');
      onUnlock();
    } else {
      setError(result.reason);
      setConfirmingReset(false);
    }
  }

  function handleReset() {
    resetVault();
    setConfirmingReset(false);
    setError(null);
    setPassphrase('');
    onReset();
  }

  return (
    <>
      {connections.length > 0 && (
        <div class="profile-picker">
          <div class="profile-picker-heading">Your buckets</div>
          <ul class="profile-list">
            {connections.map(c => (
              <li key={c.id} class="profile-row" onClick={() => passphraseRef.current?.focus()}>
                <span aria-hidden="true">🔒</span>
                <span class="profile-row-name">{c.name}</span>
                <span class="profile-row-hint">{connectionHint(c)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form class="cred-panel" onSubmit={handleSubmit}>
        <div class="form-group">
          <label htmlFor="vault-username">Account</label>
          <input
            id="vault-username"
            name="vault-username"
            type="text"
            value={VAULT_USERNAME}
            readOnly
            autocomplete="username"
          />
        </div>

        <div class="form-group">
          <label htmlFor="vault-passphrase">Passphrase</label>
          <input
            id="vault-passphrase"
            name="vault-passphrase"
            ref={passphraseRef}
            type="password"
            value={passphrase}
            onInput={e => setPassphrase(e.target.value)}
            autocomplete="current-password"
            required
          />
          {error && <span class="field-error">{ERROR_TEXT[error] || 'Could not unlock the vault.'}</span>}
        </div>

        <div class="btn-row">
          <button type="submit" class="btn btn-primary" disabled={unlocking}>
            {unlocking ? <><span class="spinner" /> Unlocking…</> : 'Unlock'}
          </button>
        </div>

        {error === 'corrupt' && (
          confirmingReset ? (
            <div class="form-group">
              <span class="hint" style={{ color: 'var(--text-warn)' }}>
                Resetting destroys every stored secret permanently. Your connections are kept.
              </span>
              <div class="btn-row">
                <button type="button" class="btn btn-danger btn-sm" onClick={handleReset}>
                  Yes, reset vault
                </button>
                <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirmingReset(true)}>
              Reset vault…
            </button>
          )
        )}
      </form>
    </>
  );
}
