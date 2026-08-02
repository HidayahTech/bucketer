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
// The crypto core above is pure. Below it is the record layer: reading and
// writing the wrapped ciphertexts to localStorage under one key
// (s3b_vault), keyed internally by credential id — the secret belongs to the
// credential (connections.js), not to any one connection that uses it, so
// connections sharing a credential share one ciphertext. Like connections.js,
// this reads the `localStorage` global at call time, not at import time.
// This module imports nothing — connections.js imports this one, never the
// reverse.

// Kill switch. The vault's creation flow (the post-connect offer) failed its
// design review — 2 Critical + 5 Important, all in the accept flow: a typo at
// setup locks the user out of the whole app (no escape hatch), and the accepted
// secret is wrapped under a credential no connection points at. See
// docs/superpowers/HANDOFF-2026-07-28-vault-phase2.md and the draft redesign in
// docs/superpowers/specs/2026-07-28-vault-creation-flow-design.md. Until that
// redesign is approved and implemented, App.jsx gates every user-reachable
// entry point on this flag: the offer never shows, the lock screen never
// mounts, auto-connect never fires. The crypto and record layers below stay
// live (unit-tested, and they keep honoring a pre-existing vault's cascade).
// Flip to true only as part of the redesign work — the skipped Task 6 suites
// in test/components/app.test.jsx re-arm automatically when it flips.
export const VAULT_ENABLED = false;

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

const LS_KEY_VAULT = 's3b_vault';
export const VAULT_STORAGE_KEYS = [LS_KEY_VAULT];

function safeGetRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeRemoveRaw(key) {
  try { localStorage.removeItem(key); } catch { /* */ }
}

// null on absent OR corrupt — never throws. Mirrors loadCredentialRecords'
// empty-envelope discipline in connections.js.
export function loadVaultRecord() {
  try {
    const raw = safeGetRaw(LS_KEY_VAULT);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function vaultExists() {
  return loadVaultRecord() !== null;
}

// Returns whether the write actually landed: private browsing swallows
// localStorage.setItem by design, and a vault that silently did not persist
// would report success while storing nothing. So this does not trust the
// absence of a thrown error — it reads the value back and compares.
export function saveVaultRecord(record) {
  const json = JSON.stringify(record);
  try { localStorage.setItem(LS_KEY_VAULT, json); } catch { /* checked below */ }
  return safeGetRaw(LS_KEY_VAULT) === json;
}

export function deleteVaultRecord() {
  safeRemoveRaw(LS_KEY_VAULT);
}

export function getVaultEntry(credentialId) {
  const record = loadVaultRecord();
  if (!record) return null;
  return record.entries[credentialId] ?? null;
}

// false when there is no vault to add to yet — an entry without the salt and
// check value it would need to be decrypted later is worse than useless, so
// this refuses to conjure a headless record just to hold it.
export function setVaultEntry(credentialId, wrapped) {
  const record = loadVaultRecord();
  if (!record) return false;
  record.entries[credentialId] = wrapped;
  return saveVaultRecord(record);
}

// Safe to call for an id with no entry — a no-op, not an error.
export function deleteVaultEntry(credentialId) {
  const record = loadVaultRecord();
  if (!record || !(credentialId in record.entries)) return;
  delete record.entries[credentialId];
  saveVaultRecord(record);
}

// Empties every entry but keeps the vault record itself — for bulk credential
// deletion (deleteAllProfiles in storage.js) that removes credentials by raw
// key rather than one at a time through deleteCredentialRecord, and so cannot
// rely on that function's cascade to drop the now-orphaned ciphertexts. The
// vault's salt/iterations/check are the user's passphrase, not their
// credentials, and must survive. No-op when there is no vault — must not
// create one.
export function clearVaultEntries() {
  const record = loadVaultRecord();
  if (!record) return;
  record.entries = {};
  saveVaultRecord(record);
}

// The unlock lifecycle: deriving the key is the expensive, deliberate part
// (600,000 PBKDF2 rounds); everything below holds onto that result for the
// session rather than re-deriving it on every read.
//
// The derived key is exported raw and kept in sessionStorage, not a module
// variable — see the threat-model note at the top of this file. That choice
// also makes isUnlocked() correct across a reload: module state resets on
// reload but sessionStorage does not, so isUnlocked() must read the same
// storage the key actually lives in, or a reload would show "locked" while
// an unlocked key sits right there.
export const SS_KEY_VAULT_KEY = 's3b_vault_key';

function safeGetSession(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function safeSetSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* private mode — session ends unlocked-in-memory only */ }
}
function safeRemoveSession(key) {
  try { sessionStorage.removeItem(key); } catch { /* */ }
}

async function storeSessionKey(key, subtle) {
  const raw = await subtle.exportKey('raw', key);
  safeSetSession(SS_KEY_VAULT_KEY, toBase64(new Uint8Array(raw)));
}

// null when locked. Re-imports on every call rather than caching a CryptoKey
// in a module variable, for the same reload reason isUnlocked() reads storage.
async function importSessionKey(subtle) {
  const raw = safeGetSession(SS_KEY_VAULT_KEY);
  if (raw === null) return null;
  return subtle.importKey('raw', fromBase64(raw), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export function isUnlocked() {
  return safeGetSession(SS_KEY_VAULT_KEY) !== null;
}

export function lockVault() {
  safeRemoveSession(SS_KEY_VAULT_KEY);
}

// Destroys the ciphertexts (and the passphrase's salt/check with them) and
// forgets the session key. Only ever touches the vault's own storage key —
// connections.js's credentials and connections are a different record and
// must survive a reset untouched.
export function resetVault() {
  deleteVaultRecord();
  lockVault();
}

// Generates a salt, derives a key, wraps CHECK_PLAINTEXT as `check`, and
// persists the record. Returns { ok: false } — never throws, never appears
// unlocked — when the record did not actually land (private browsing).
export async function createVault(passphrase, subtle, getRandomValues) {
  const salt = newSalt(getRandomValues);
  const key = await deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS, subtle);
  const check = await wrapSecret(key, CHECK_PLAINTEXT, subtle);
  const record = {
    version: VAULT_VERSION,
    salt: toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    check,
    entries: {},
  };
  if (!saveVaultRecord(record)) return { ok: false };
  await storeSessionKey(key, subtle);
  return { ok: true };
}

// Derives from the stored salt and iterations, then verifies the passphrase
// by unwrapping `check` and comparing to CHECK_PLAINTEXT — this works even
// when the vault holds no entries, which is why `check` exists at all.
//
// 'wrong-passphrase' vs 'corrupt': AES-GCM's auth tag cannot cryptographically
// tell "wrong key" apart from "tampered ciphertext of the same shape" — both
// surface from subtle.decrypt as the same OperationError. Only unambiguous
// structural breakage (malformed base64, a record subtle.decrypt never even
// gets to run against) is reported as 'corrupt'; an OperationError defaults to
// 'wrong-passphrase', the non-destructive bucket, since the UI offers a
// destructive reset only for 'corrupt'.
export async function unlockVault(passphrase, subtle) {
  const record = loadVaultRecord();
  if (!record) return { ok: false, reason: 'no-vault' };

  let key;
  try {
    const salt = fromBase64(record.salt);
    key = await deriveVaultKey(passphrase, salt, record.iterations, subtle);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }

  let checked;
  try {
    checked = await unwrapSecret(key, record.check, subtle);
  } catch (err) {
    return { ok: false, reason: err && err.name === 'OperationError' ? 'wrong-passphrase' : 'corrupt' };
  }
  if (checked !== CHECK_PLAINTEXT) return { ok: false, reason: 'corrupt' };

  await storeSessionKey(key, subtle);
  return { ok: true };
}

// No-op (false) while locked — there is no session key to wrap with.
export async function rememberSecret(credentialId, secret, subtle) {
  const key = await importSessionKey(subtle);
  if (!key) return false;
  const wrapped = await wrapSecret(key, secret, subtle);
  return setVaultEntry(credentialId, wrapped);
}

// null while locked, and null (not a throw) for a credential with no entry —
// that is the ordinary case for a connection the user never chose to remember.
export async function recallSecret(credentialId, subtle) {
  const key = await importSessionKey(subtle);
  if (!key) return null;
  const wrapped = getVaultEntry(credentialId);
  if (!wrapped) return null;
  return unwrapSecret(key, wrapped, subtle);
}
