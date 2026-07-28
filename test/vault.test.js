// Vault crypto. Node ships WebCrypto, so this runs in the plain unit layer with
// no jsdom and no browser. `subtle` is injected rather than read from a global.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  VAULT_VERSION, PBKDF2_ITERATIONS, CHECK_PLAINTEXT,
  deriveVaultKey, wrapSecret, unwrapSecret, newSalt,
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
