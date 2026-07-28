// Vault crypto. Node ships WebCrypto, so this runs in the plain unit layer with
// no jsdom and no browser. `subtle` is injected rather than read from a global.

// The record-layer functions below read localStorage as a bare global at call
// time (not import time), so an in-memory store just needs to exist before any
// function runs — placed above the imports for that reason.
const ls = {};
global.localStorage = {
  getItem:    k     => Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null,
  setItem:    (k,v) => { ls[k] = String(v); },
  removeItem: k     => { delete ls[k]; },
};

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  VAULT_VERSION, PBKDF2_ITERATIONS, CHECK_PLAINTEXT,
  deriveVaultKey, wrapSecret, unwrapSecret, newSalt,
  loadVaultRecord, vaultExists, saveVaultRecord, deleteVaultRecord,
  getVaultEntry, setVaultEntry, deleteVaultEntry, clearVaultEntries,
} from '../src/lib/vault.js';

const subtle = webcrypto.subtle;
const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);

// 600k PBKDF2 rounds take roughly a second; derive once and share across tests
// that do not specifically exercise derivation.
const SALT = newSalt(getRandomValues);
let KEY;
async function key() { KEY ??= await deriveVaultKey('correct horse', SALT, PBKDF2_ITERATIONS, subtle); return KEY; }

describe('vault parameters', () => {
  test('iteration count is 600,000', () => {
    assert.equal(PBKDF2_ITERATIONS, 600_000);
  });

  test('salt is 16 random bytes', () => {
    const a = newSalt(getRandomValues);
    const b = newSalt(getRandomValues);
    assert.equal(a.length, 16);
    assert.notDeepEqual([...a], [...b], 'each salt must be independently random');
  });
});

describe('wrap / unwrap', () => {
  test('round-trips a secret', async () => {
    const k = await key();
    const wrapped = await wrapSecret(k, 'SUPER/SECRET+key==', subtle);
    assert.equal(await unwrapSecret(k, wrapped, subtle), 'SUPER/SECRET+key==');
  });

  test('the ciphertext does not contain the plaintext', async () => {
    const k = await key();
    const wrapped = await wrapSecret(k, 'PLAINTEXTMARKER', subtle);
    assert.equal(JSON.stringify(wrapped).includes('PLAINTEXTMARKER'), false);
  });

  test('a fresh IV is used for every wrap', async () => {
    const k = await key();
    const a = await wrapSecret(k, 'same', subtle);
    const b = await wrapSecret(k, 'same', subtle);
    assert.notEqual(a.iv, b.iv, 'IV reuse under AES-GCM is a break, not a nit');
    assert.notEqual(a.ct, b.ct);
  });

  test('unwrapping with the wrong key rejects', async () => {
    const k = await key();
    const wrong = await deriveVaultKey('wrong passphrase', SALT, PBKDF2_ITERATIONS, subtle);
    const wrapped = await wrapSecret(k, 'secret', subtle);
    await assert.rejects(() => unwrapSecret(wrong, wrapped, subtle));
  });

  test('unwrapping tampered ciphertext rejects', async () => {
    const k = await key();
    const wrapped = await wrapSecret(k, 'secret', subtle);
    const flipped = wrapped.ct.slice(0, -2) + (wrapped.ct.endsWith('A') ? 'B' : 'A') + wrapped.ct.slice(-1);
    await assert.rejects(() => unwrapSecret(k, { iv: wrapped.iv, ct: flipped }, subtle));
  });

  test('an empty secret round-trips', async () => {
    const k = await key();
    assert.equal(await unwrapSecret(k, await wrapSecret(k, '', subtle), subtle), '');
  });

  test('a non-ASCII secret round-trips', async () => {
    const k = await key();
    const s = 'sécret—ключ🔑';
    assert.equal(await unwrapSecret(k, await wrapSecret(k, s, subtle), subtle), s);
  });
});

describe('key derivation', () => {
  test('the same passphrase and salt derive the same key', async () => {
    const a = await deriveVaultKey('pass', SALT, PBKDF2_ITERATIONS, subtle);
    const b = await deriveVaultKey('pass', SALT, PBKDF2_ITERATIONS, subtle);
    const wrapped = await wrapSecret(a, 'x', subtle);
    assert.equal(await unwrapSecret(b, wrapped, subtle), 'x');
  });

  test('a different salt derives a different key', async () => {
    const a = await deriveVaultKey('pass', SALT, PBKDF2_ITERATIONS, subtle);
    const b = await deriveVaultKey('pass', newSalt(getRandomValues), PBKDF2_ITERATIONS, subtle);
    const wrapped = await wrapSecret(a, 'x', subtle);
    await assert.rejects(() => unwrapSecret(b, wrapped, subtle));
  });

  test('the derived key is extractable — sessionStorage handoff depends on it', async () => {
    const k = await deriveVaultKey('pass', SALT, PBKDF2_ITERATIONS, subtle);
    assert.equal(k.extractable, true);
    await assert.doesNotReject(() => subtle.exportKey('raw', k));
  });
});

describe('vault record', () => {
  beforeEach(() => { for (const k of Object.keys(ls)) delete ls[k]; });

  test('absent vault reads as null and does not exist', () => {
    assert.equal(loadVaultRecord(), null);
    assert.equal(vaultExists(), false);
  });

  test('corrupt vault reads as null rather than throwing', () => {
    ls['s3b_vault'] = '{not json';
    assert.equal(loadVaultRecord(), null);
    assert.equal(vaultExists(), false);
  });

  test('saves and reads back a record', () => {
    const rec = { version: VAULT_VERSION, salt: 'c2FsdA==', iterations: PBKDF2_ITERATIONS, check: { iv: 'aXY=', ct: 'Y3Q=' }, entries: {} };
    assert.equal(saveVaultRecord(rec), true);
    assert.equal(vaultExists(), true);
    assert.deepEqual(loadVaultRecord(), rec);
  });

  test('reports failure when the write does not land', () => {
    const original = global.localStorage.setItem;
    global.localStorage.setItem = () => { throw new Error('quota'); };
    try {
      assert.equal(saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: 1, check: {}, entries: {} }), false,
        'a vault that did not persist must not report success');
    } finally { global.localStorage.setItem = original; }
  });

  test('entries round-trip by credential id', () => {
    saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: PBKDF2_ITERATIONS, check: {}, entries: {} });
    assert.equal(getVaultEntry('cred1'), null);
    setVaultEntry('cred1', { iv: 'aXY=', ct: 'Y3Q=' });
    assert.deepEqual(getVaultEntry('cred1'), { iv: 'aXY=', ct: 'Y3Q=' });
    deleteVaultEntry('cred1');
    assert.equal(getVaultEntry('cred1'), null);
  });

  test('deleting an entry that does not exist is a no-op', () => {
    saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: PBKDF2_ITERATIONS, check: {}, entries: {} });
    assert.doesNotThrow(() => deleteVaultEntry('never-existed'));
  });

  test('setEntry on an absent vault does not create a headless record', () => {
    assert.equal(setVaultEntry('cred1', { iv: 'a', ct: 'b' }), false,
      'entries without a salt and check value would be undecryptable');
    assert.equal(vaultExists(), false);
  });

  test('deleteVaultRecord removes everything', () => {
    saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: PBKDF2_ITERATIONS, check: {}, entries: { a: { iv: 'i', ct: 'c' } } });
    deleteVaultRecord();
    assert.equal(vaultExists(), false);
    assert.equal(ls['s3b_vault'], undefined);
  });

  // deleteAllProfiles() (storage.js) bulk-removes every credential without going
  // through deleteCredentialRecord's one-at-a-time cascade, so it needs a way to
  // drop every now-orphaned entry without touching the passphrase itself (salt,
  // iterations, check) — the user did not ask to re-choose a passphrase by
  // deleting their profiles.
  test('clearVaultEntries empties entries but keeps the vault record', () => {
    saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: PBKDF2_ITERATIONS, check: { iv: 'i', ct: 'c' }, entries: { a: { iv: 'i', ct: 'c' } } });
    clearVaultEntries();
    assert.equal(vaultExists(), true);
    const record = loadVaultRecord();
    assert.deepEqual(record.entries, {});
    assert.equal(record.salt, 's');
    assert.deepEqual(record.check, { iv: 'i', ct: 'c' });
  });

  test('clearVaultEntries is a no-op when no vault exists — it must not create one', () => {
    clearVaultEntries();
    assert.equal(vaultExists(), false);
    assert.equal(ls['s3b_vault'], undefined);
  });
});
