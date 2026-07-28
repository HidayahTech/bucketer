// Copyright (C) 2026 HidayahTech, LLC
// Passphrase-vault crypto core.
//
// Wraps and unwraps small secrets (S3 access keys) behind one passphrase so
// credentials can be encrypted at rest between browser sessions instead of
// re-typed every time a tab opens.
//
// Threat model — important:
//   - PROTECTS: a credential sitting in plaintext on disk between sessions.
//     Recovering a stolen record requires the passphrase, and PBKDF2 at
//     600,000 rounds makes offline brute-forcing of that record expensive.
//   - DOES NOT PROTECT: against XSS. The derived key is deliberately
//     extractable so a later task can export it into sessionStorage — a page
//     reload should not force re-entering the passphrase. That means any
//     script that can read sessionStorage in this origin reaches the key and,
//     through it, every wrapped credential. That is an accepted trade-off,
//     not an oversight: this vault is a barrier against secrets left behind,
//     not against a compromised page.
//
// `subtle` is injected rather than read from a global so the derivation and
// wrap/unwrap paths are exercised identically under plain Node (`node --test`,
// no jsdom) and in the browser bundle. In the browser, the caller passes:
//   subtle = window.crypto.subtle
// IV bytes come from the global `crypto` object directly (same convention as
// file-identity.js's use of `crypto.subtle`) since Node ships WebCrypto as a
// global and the interface here has no separate slot for an injected RNG.
//
// This module is pure: no DOM, no storage, no record shape. It imports
// nothing.

export const VAULT_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const CHECK_PLAINTEXT = 'bucketer-vault-check-v1';

const SALT_BYTES = 16;
const IV_BYTES = 12;

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function newSalt(getRandomValues) {
  return getRandomValues(new Uint8Array(SALT_BYTES));
}

// PBKDF2-SHA256 stretches the passphrase into AES-GCM key material. The key is
// extractable by design — see the threat model above.
export async function deriveVaultKey(passphrase, saltBytes, iterations, subtle) {
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

// A fresh 12-byte IV every call. IV reuse under AES-GCM is a catastrophic
// break, not a style preference.
export async function wrapSecret(key, plaintext, subtle) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

// AES-GCM's authentication tag makes decrypt reject on a wrong key or tampered
// ciphertext instead of returning garbage — that rejection is the contract,
// so it is left to propagate rather than caught here.
export async function unwrapSecret(key, { iv, ct }, subtle) {
  const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(ct));
  return new TextDecoder().decode(plainBuf);
}
