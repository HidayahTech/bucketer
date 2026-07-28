# Passphrase Vault (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user encrypt their S3 secret keys behind one passphrase, so returning to Bucketer becomes "enter a passphrase" instead of "retype a 40-character secret."

**Architecture:** A new pure module `src/lib/vault.js` owns all crypto and the `s3b_vault` record: PBKDF2-SHA-256 → AES-256-GCM, entries keyed by `credentialId`. `connections.js` gains a cascade so deleting a credential deletes its ciphertext. `App.jsx` gains a `locked` session state and an unlock screen; the derived key lives in `sessionStorage` for the session's lifetime.

**Tech Stack:** Preact, esbuild, WebCrypto (`crypto.subtle` — built into Node, so vault tests run in the plain `node --test` layer with no jsdom). No new dependencies.

---

## ⚠️ How this plan differs from the Phase 1 plan — read this first

The Phase 1 plan handed implementers complete, ready-to-paste implementation code. **Seven of those code blocks contained defects**, every one was transcribed faithfully into a commit, and every one was caught only by review — including a Critical that silently resurrected deleted connections. The implementers were not at fault; a plan that dictates code transfers its author's mistakes directly into the codebase, because there is no reason for an implementer to doubt it.

So this plan is written differently, on purpose:

- **Tests are given in full and verbatim.** They are the specification. Write them exactly as shown.
- **Interfaces, signatures, constants and storage shapes are given exactly.** Do not invent your own.
- **Implementation bodies are described by contract, not dictated.** Derive them from the tests.

One exception, deliberate: **Tasks 5-7 describe their assertions rather than giving test code.** Those are component tests against components that do not exist yet, so exact selectors would be dictating the markup — the very thing this plan avoids. Each assertion is still named precisely; you choose how to reach it. Everything in Tasks 1-4 is verbatim.

If a described contract seems wrong, or the tests seem to demand something contradictory, **stop and say so** rather than implementing around it. That is the single most valuable thing you can do here.

Consult `BUG-LOG.md` before writing tests — particularly `BUG-045` (a sentinel derived from mutable state), which is the mistake this codebase has most recently paid for.

---

## Global Constraints

- **No new runtime dependencies.** `package.json` must not gain any. WebCrypto is a platform API.
- **`@anthropic-ai/claude-code` must never appear** in `package.json` or `package-lock.json`.
- **Secret keys must never be written to `localStorage` in plaintext.** Only ciphertext, ever. `saveConnectionRecord` and `saveCredentialRecord` already strip `secretKey` defensively; do not weaken that.
- **The vault is opt-in.** A user who never sets a passphrase must see behaviour identical to v1.39.1 in every respect.
- **No passphrase recovery.** Reset destroys ciphertexts only; connections keep endpoint, bucket, key ID.
- **Crypto parameters, exactly:** PBKDF2-SHA-256, **600,000** iterations, 16-byte random per-vault salt, AES-256-GCM with a **fresh 12-byte IV per entry**. `iterations` is stored in the record so it can be raised later.
- **Storage access goes through try/catch wrappers** — private browsing throws on every read and write. Follow the existing `safeGetRaw`/`safeSetRaw` pattern in `connections.js`.
- **A vault that cannot be persisted must fail loudly at creation**, not silently appear to save. This is the one place the app must not degrade quietly.
- **One version bump for the whole phase**, in the final task. Leave `package.json` and `CHANGELOG.md` alone until then.
- **Ask the operator before every commit**, per house policy.
- Run `npm test` and `npm run test:ui` before any commit. `npm run serve` overwrites `dist/index.html` with a dev build — if you serve anything, `npm run build` afterwards and confirm `git status` is clean.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/vault.js` (new) | All crypto and the `s3b_vault` record. Pure — no DOM, no Preact. Depends on nothing. |
| `src/lib/connections.js` (modify) | Cascade: deleting a credential deletes its vault entry. Re-key: changing a connection's credential collects the old one. |
| `src/components/VaultUnlock.jsx` (new) | The unlock screen. Passphrase field, readonly manager username, reset affordance. |
| `src/components/App.jsx` (modify) | `locked` session state, unlock gate, post-connect offer, re-wrap on save. |
| `src/components/StorageModal.jsx` (modify) | Report `s3b_vault` truthfully. |

Layering is one-way: `storage.js` → `connections.js` → `vault.js` → nothing. Do not import upward.

---

### Task 1: Collect the superseded credential when a connection is re-pointed (#53)

Do this first and on its own. It is small, independently testable, and it stops the orphan class growing *before* secrets are attached to it.

**Files:**
- Modify: `src/lib/connections.js` — `saveConnectionRecord`
- Test: `test/connections.test.js`

**Interfaces:**
- Consumes: `deleteCredentialRecord(id) → boolean` (already exists; returns `false` when another connection still references the credential).
- Produces: no signature change. `saveConnectionRecord(conn)` gains a side effect.

**Contract.** When `saveConnectionRecord` updates an *existing* connection and the incoming `credentialId` differs from the stored one, the previous credential must be garbage-collected — the same treatment `deleteConnectionRecord` already gives on delete. `deleteCredentialRecord` already refuses while any other connection references it, so no extra guard is needed. Creating a new connection, or updating one without changing its credential, must not delete anything.

- [ ] **Step 1: Write the failing tests**

Append to `test/connections.test.js`, adding any new imports to the existing import block:

```js
describe('saveConnectionRecord collects a superseded credential (#53)', () => {
  test('re-pointing a connection at new credentials deletes the old credential', () => {
    const a = findOrCreateCredential({ endpoint: 'https://a.example.com', keyId: 'k1', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'C', credentialId: a.id, bucket: 'b', capabilities: null });
    assert.equal(loadCredentialRecords().credentials.length, 1);

    const b = findOrCreateCredential({ endpoint: 'https://b.example.com', keyId: 'k2', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'C', credentialId: b.id, bucket: 'b' });

    const { credentials } = loadCredentialRecords();
    assert.deepEqual(credentials.map(c => c.id), [b.id],
      'the superseded credential must not linger with nothing referencing it');
  });

  test('a credential still used by another connection survives', () => {
    const a = findOrCreateCredential({ endpoint: 'https://a.example.com', keyId: 'k1', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'C1', credentialId: a.id, bucket: 'b1', capabilities: null });
    saveConnectionRecord({ id: 2, name: 'C2', credentialId: a.id, bucket: 'b2', capabilities: null });

    const b = findOrCreateCredential({ endpoint: 'https://b.example.com', keyId: 'k2', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'C1', credentialId: b.id, bucket: 'b1' });

    const ids = loadCredentialRecords().credentials.map(c => c.id).sort();
    assert.deepEqual(ids, [a.id, b.id].sort(), 'connection 2 still uses credential a');
  });

  test('creating a connection deletes nothing', () => {
    const a = findOrCreateCredential({ endpoint: 'https://a.example.com', keyId: 'k1', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'C', credentialId: a.id, bucket: 'b', capabilities: null });
    assert.equal(loadCredentialRecords().credentials.length, 1);
  });

  test('updating a connection without changing its credential deletes nothing', () => {
    const a = findOrCreateCredential({ endpoint: 'https://a.example.com', keyId: 'k1', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'C', credentialId: a.id, bucket: 'b', capabilities: null });
    saveConnectionRecord({ id: 1, name: 'Renamed', credentialId: a.id, bucket: 'b' });
    assert.equal(loadCredentialRecords().credentials.length, 1);
    assert.equal(loadConnectionRecords().connections[0].name, 'Renamed');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/connections.test.js`
Expected: the first test FAILS — the superseded credential is still present. The other three pass already; they are guards against the fix over-reaching, not reproductions.

Say so in your report rather than presenting all four as RED.

- [ ] **Step 3: Implement**

Modify `saveConnectionRecord` per the contract above. Read the existing function first — it already has the previous record in hand on the update path, and already records the migration marker. Order matters: the new record must be persisted before the old credential is collected, or `deleteCredentialRecord`'s reference check will still see the old link and refuse.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/connections.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test` and `npm run test:ui`. Both must pass.

Commit as: `fix: collect the superseded credential when a connection is re-pointed (#53)`

Use `Addresses #53` in the body, not `Closes` — house policy is that reference fixes do not auto-close.

---

### Task 2: `vault.js` — crypto core

**Files:**
- Create: `src/lib/vault.js`
- Test: `test/vault.test.js`

**Interfaces produced:**

```js
export const VAULT_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const CHECK_PLAINTEXT = 'bucketer-vault-check-v1';

// All async. `subtle` is injectable so tests never touch globals.
export async function deriveVaultKey(passphrase, saltBytes, iterations, subtle) → CryptoKey
export async function wrapSecret(key, plaintext, subtle) → { iv: string, ct: string }   // base64
export async function unwrapSecret(key, { iv, ct }, subtle) → string
export function newSalt(getRandomValues) → Uint8Array   // 16 bytes
```

`deriveVaultKey` must produce an **extractable** AES-GCM key — Task 4 exports it into `sessionStorage`, and a non-extractable key cannot survive a reload. The spec accepts that trade-off explicitly.

`wrapSecret` uses a **fresh 12-byte IV per call**. Reusing an IV under AES-GCM is a catastrophic break, not a style preference.

**Contract.** `unwrapSecret` must reject rather than return garbage when the key is wrong — AES-GCM's authentication tag gives you this for free; do not catch and swallow it. Base64 encoding of `iv`/`ct` keeps the record JSON-safe.

- [ ] **Step 1: Write the failing tests**

Create `test/vault.test.js`:

```js
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
    await assert.rejects(() => unwrapSecret(b, await wrapSecret(a, 'x', subtle), subtle));
  });

  test('the derived key is extractable — sessionStorage handoff depends on it', async () => {
    const k = await deriveVaultKey('pass', SALT, PBKDF2_ITERATIONS, subtle);
    assert.equal(k.extractable, true);
    await assert.doesNotReject(() => subtle.exportKey('raw', k));
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/vault.test.js`
Expected: FAIL — `Cannot find module '../src/lib/vault.js'`.

- [ ] **Step 3: Implement `src/lib/vault.js`**

Write the module to satisfy the tests and the Global Constraints. Head the file with a comment explaining the threat model in the same register as `src/lib/integrity.js`: what the vault protects against (a secret sitting in plaintext on disk between sessions) and what it does not (an XSS with the derived key in `sessionStorage` reaches every credential, which the spec accepts deliberately).

This task is crypto only — no storage, no record shape. Those are Task 3.

- [ ] **Step 4: Run and confirm passing**

Run: `node --test test/vault.test.js`
Expected: PASS. Note the wall-clock time in your report — 600k iterations is deliberately slow, and if the suite takes more than a few seconds you may have derived more keys than necessary.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`. Commit as: `feat: vault crypto core (PBKDF2 + AES-GCM)`

---

### Task 3: `vault.js` — the record, and the cascade

**Files:**
- Modify: `src/lib/vault.js`
- Modify: `src/lib/connections.js` — `deleteCredentialRecord`
- Test: `test/vault.test.js`, `test/connections.test.js`

**Interfaces produced:**

```js
// s3b_vault: { version, salt, iterations, check: { iv, ct }, entries: { [credentialId]: { iv, ct } } }
export function loadVaultRecord() → record | null      // null when absent or corrupt
export function vaultExists() → boolean
export function saveVaultRecord(record) → boolean      // false when the write did not land
export function deleteVaultRecord() → void
export function getVaultEntry(credentialId) → { iv, ct } | null
export function setVaultEntry(credentialId, wrapped) → boolean
export function deleteVaultEntry(credentialId) → void
export const VAULT_STORAGE_KEYS = ['s3b_vault']
```

**Contract.**

`saveVaultRecord` returns whether the write actually landed — read it back and compare. This is the "fail loudly at creation" constraint: in private browsing every write is swallowed, and a vault that silently did not persist would lose the user's secrets with a success message.

`loadVaultRecord` returns `null` on absent *or* corrupt, matching `loadCredentialRecords`'s empty-envelope discipline. Never throw.

`deleteVaultEntry` must be safe to call for an id with no entry.

**The cascade:** `deleteCredentialRecord` in `connections.js` must delete the credential's vault entry **when, and only when, it actually deletes the credential** — it returns `false` and deletes nothing while another connection still references it, and the ciphertext must survive that case. Import `deleteVaultEntry` from `vault.js`; the layering is `connections.js → vault.js`, never the reverse.

- [ ] **Step 1: Write the failing tests**

Append to `test/vault.test.js`. This file has no `localStorage`; add the same in-memory mock the other suites use, **above the imports**, since the module reads the global at call time:

```js
// (place at the very top of test/vault.test.js, before any import of vault.js)
const ls = {};
global.localStorage = {
  getItem:    k     => Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null,
  setItem:    (k,v) => { ls[k] = String(v); },
  removeItem: k     => { delete ls[k]; },
};
```

```js
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
});
```

Append to `test/connections.test.js`, adding `saveVaultRecord`, `setVaultEntry`, `getVaultEntry`, `VAULT_VERSION` and `PBKDF2_ITERATIONS` to its import block from `../src/lib/vault.js`:

```js
describe('deleting a credential cascades to its vault entry', () => {
  test('the ciphertext goes when the credential goes', () => {
    saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: PBKDF2_ITERATIONS, check: {}, entries: {} });
    const c = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: 'b2', regionOverride: '' });
    setVaultEntry(c.id, { iv: 'aXY=', ct: 'Y3Q=' });

    assert.equal(deleteCredentialRecord(c.id), true);
    assert.equal(getVaultEntry(c.id), null, 'a ciphertext under a deleted id is unreachable forever');
  });

  test('a refused deletion leaves the ciphertext alone', () => {
    saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: PBKDF2_ITERATIONS, check: {}, entries: {} });
    const c = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: 'b2', regionOverride: '' });
    setVaultEntry(c.id, { iv: 'aXY=', ct: 'Y3Q=' });
    saveConnectionRecord({ id: 1, name: 'C', credentialId: c.id, bucket: 'b', capabilities: null });

    assert.equal(deleteCredentialRecord(c.id), false, 'still referenced');
    assert.deepEqual(getVaultEntry(c.id), { iv: 'aXY=', ct: 'Y3Q=' },
      'the credential survived, so its secret must too');
  });

  test('deleting the last connection cascades all the way to the ciphertext', () => {
    saveVaultRecord({ version: VAULT_VERSION, salt: 's', iterations: PBKDF2_ITERATIONS, check: {}, entries: {} });
    const c = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: 'b2', regionOverride: '' });
    setVaultEntry(c.id, { iv: 'aXY=', ct: 'Y3Q=' });
    saveConnectionRecord({ id: 1, name: 'C', credentialId: c.id, bucket: 'b', capabilities: null });

    deleteConnectionRecord(1);
    assert.equal(loadCredentialRecords().credentials.length, 0);
    assert.equal(getVaultEntry(c.id), null);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/vault.test.js test/connections.test.js`
Expected: FAIL on the new record functions and on the cascade.

- [ ] **Step 3: Implement**

Add the record layer to `vault.js` per the contract, then wire the cascade into `deleteCredentialRecord`. Note the ordering constraint: the cascade fires only on the `true` return path.

Add `VAULT_STORAGE_KEYS` to `wipeAllAppData()`'s key list in `storage.js` and to the storage inspector's enumeration — a wipe that leaves ciphertexts behind is a privacy defect, and it is exactly the shape of the bug this codebase already logged as part of v1.39.0.

- [ ] **Step 4: Run and confirm passing**

Run: `node --test test/vault.test.js test/connections.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test` and `npm run test:ui`. Commit as: `feat: vault record store and credential cascade`

---

### Task 4: Session key handling and the unlock/create flow

**Files:**
- Modify: `src/lib/vault.js`
- Test: `test/vault.test.js`

**Interfaces produced:**

```js
export async function createVault(passphrase, subtle, getRandomValues) → { ok: boolean, reason?: string }
export async function unlockVault(passphrase, subtle) → { ok: boolean, reason?: 'no-vault' | 'wrong-passphrase' | 'corrupt' }
export function isUnlocked() → boolean
export function lockVault() → void          // forgets the session key; ciphertexts untouched
export function resetVault() → void         // destroys ciphertexts; connections untouched
export async function rememberSecret(credentialId, secret, subtle) → boolean
export async function recallSecret(credentialId, subtle) → string | null
export const SS_KEY_VAULT_KEY = 's3b_vault_key'
```

**Contract.**

`createVault` generates a salt, derives a key, wraps `CHECK_PLAINTEXT` into `check`, persists the record, and holds the derived key for the session. It must return `{ ok: false }` when the record did not persist.

`unlockVault` derives from the stored salt and iterations, then verifies by unwrapping `check` and comparing to `CHECK_PLAINTEXT`. This is why `check` exists: it verifies a passphrase without touching a real secret, and works when the vault holds no entries. Distinguish `wrong-passphrase` from `corrupt` — the spec requires the UI to offer reset only for the latter.

The derived key is exported raw and stored in `sessionStorage` under `SS_KEY_VAULT_KEY`, so it survives a reload but not a tab close — the same lifetime and exposure class as today's plaintext secret. `isUnlocked` reflects that storage, not a module variable, or a reload would appear locked while the key is right there.

`rememberSecret` and `recallSecret` are no-ops returning `false`/`null` when locked. `recallSecret` returns `null` — not a throw — for a credential with no entry, since that is the ordinary case for a connection the user never chose to remember.

- [ ] **Step 1: Write the failing tests**

Append to `test/vault.test.js`. Add a `sessionStorage` mock beside the `localStorage` one at the top of the file, and clear both in `beforeEach`.

```js
describe('unlock lifecycle', () => {
  beforeEach(() => {
    for (const k of Object.keys(ls)) delete ls[k];
    for (const k of Object.keys(ss)) delete ss[k];
  });

  test('a fresh vault can be created and is then unlocked', async () => {
    const r = await createVault('hunter2', subtle, getRandomValues);
    assert.equal(r.ok, true);
    assert.equal(vaultExists(), true);
    assert.equal(isUnlocked(), true);
  });

  test('creation fails loudly when the record cannot persist', async () => {
    const original = global.localStorage.setItem;
    global.localStorage.setItem = () => { throw new Error('private browsing'); };
    try {
      const r = await createVault('hunter2', subtle, getRandomValues);
      assert.equal(r.ok, false, 'a vault that did not persist must never report success');
      assert.equal(isUnlocked(), false, 'and must not appear unlocked');
    } finally { global.localStorage.setItem = original; }
  });

  test('the correct passphrase unlocks after a lock', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    lockVault();
    assert.equal(isUnlocked(), false);
    assert.deepEqual(await unlockVault('hunter2', subtle), { ok: true });
    assert.equal(isUnlocked(), true);
  });

  test('a wrong passphrase is rejected and reported as such', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    lockVault();
    const r = await unlockVault('hunter3', subtle);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wrong-passphrase');
    assert.equal(isUnlocked(), false);
  });

  test('unlocking with no vault reports no-vault, not a wrong passphrase', async () => {
    const r = await unlockVault('anything', subtle);
    assert.equal(r.reason, 'no-vault');
  });

  test('a corrupt vault is distinguished from a wrong passphrase', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    lockVault();
    const rec = loadVaultRecord();
    rec.check = { iv: 'not', ct: 'valid' };
    saveVaultRecord(rec);
    const r = await unlockVault('hunter2', subtle);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'corrupt', 'the UI offers reset for corrupt, not for a typo');
  });

  test('the session key survives a simulated reload', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    await rememberSecret('cred1', 'SECRET', subtle);
    // A reload clears module state but not sessionStorage.
    assert.ok(ss[SS_KEY_VAULT_KEY], 'the derived key must be in sessionStorage');
    assert.equal(isUnlocked(), true);
    assert.equal(await recallSecret('cred1', subtle), 'SECRET');
  });

  test('lockVault forgets the key but keeps the ciphertexts', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    await rememberSecret('cred1', 'SECRET', subtle);
    lockVault();
    assert.equal(isUnlocked(), false);
    assert.equal(ss[SS_KEY_VAULT_KEY], undefined);
    assert.ok(getVaultEntry('cred1'), 'locking must not destroy anything');
    await unlockVault('hunter2', subtle);
    assert.equal(await recallSecret('cred1', subtle), 'SECRET');
  });

  test('resetVault destroys ciphertexts and leaves connections alone', async () => {
    const c = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'C', credentialId: c.id, bucket: 'b', capabilities: null });
    await createVault('hunter2', subtle, getRandomValues);
    await rememberSecret(c.id, 'SECRET', subtle);

    resetVault();
    assert.equal(vaultExists(), false);
    assert.equal(isUnlocked(), false);
    assert.equal(loadConnectionRecords().connections.length, 1, 'connections survive a vault reset');
    assert.equal(loadCredentialRecords().credentials.length, 1);
  });
});

describe('remember / recall', () => {
  beforeEach(() => {
    for (const k of Object.keys(ls)) delete ls[k];
    for (const k of Object.keys(ss)) delete ss[k];
  });

  test('a remembered secret is recalled verbatim', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    assert.equal(await rememberSecret('cred1', 'aws/secret+KEY==', subtle), true);
    assert.equal(await recallSecret('cred1', subtle), 'aws/secret+KEY==');
  });

  test('a credential with no entry recalls null, not an error', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    assert.equal(await recallSecret('never-remembered', subtle), null);
  });

  test('remember and recall are inert while locked', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    lockVault();
    assert.equal(await rememberSecret('cred1', 'SECRET', subtle), false);
    assert.equal(await recallSecret('cred1', subtle), null);
  });

  test('the plaintext secret never appears in localStorage', async () => {
    await createVault('hunter2', subtle, getRandomValues);
    await rememberSecret('cred1', 'PLAINTEXTMARKER', subtle);
    assert.equal(JSON.stringify(ls).includes('PLAINTEXTMARKER'), false,
      'this is the entire point of the feature');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/vault.test.js`
Expected: FAIL on the new exports.

- [ ] **Step 3: Implement**

Per the contract. Import `findOrCreateCredential`, `saveConnectionRecord` etc. into the *test* file as needed; `vault.js` itself must not import `connections.js` — the layering runs the other way.

- [ ] **Step 4: Run and confirm passing**

Run: `node --test test/vault.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test` and `npm run test:ui`. Commit as: `feat: vault unlock lifecycle and session key handling`

---

### Task 5: `VaultUnlock.jsx`

**Files:**
- Create: `src/components/VaultUnlock.jsx`
- Test: `test/components/vault-unlock.test.jsx`

**Interfaces consumed:** `unlockVault`, `resetVault` from Task 4.

**Props:**

```js
<VaultUnlock connections={resolvedConnections} onUnlock={fn} onReset={fn} />
```

**Contract.** Renders the connection list above a passphrase field, per the approved design — the login and the bucket list are one screen, and clicking a connection focuses the passphrase. Requirements the spec fixes exactly:

- A **visible, readonly** username field with the constant value `Bucketer vault (this device)`, `autocomplete="username"`. Visible rather than hidden because extension-based password managers pick hidden username fields up inconsistently, and it reinforces that the unlock is device-local. The passphrase field is `autocomplete="current-password"`.
- All inputs need stable `name` attributes — KeePassXC's matcher prefers `name` over `id`.
- Unlocking takes roughly a second at 600k iterations. The submit button must disable and show the existing `.spinner` while it runs; an unexplained pause is a bug.
- A wrong passphrase shows an error and **must not** offer reset. A corrupt vault does offer it. Reset must warn that it destroys stored secrets permanently and keeps connections.
- Connection names and providers are visible before unlock. That is not a regression — they are already plaintext — but the lock icon must make clear that what is protected is the key, not the list.

- [ ] **Step 1: Write the failing tests**

Create `test/components/vault-unlock.test.jsx`. Start with `import '../helpers/with-dom.js'` as the very first line, mount with `h(...)`, and use `mount`/`fire`/`setInput` from `../helpers/render.js` — follow the conventions in `test/components/credential-form.test.jsx`.

Cover, one test each: the readonly username field carries the exact constant and `autocomplete="username"`; the passphrase field is `type="password"` with `autocomplete="current-password"`; every input has a `name`; connection names render; submitting calls `onUnlock` with the typed passphrase; the button disables while a submission is in flight; a wrong-passphrase result shows an error and renders no reset control; a corrupt result does render one; activating reset calls `onReset` only after its confirmation step.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:ui`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Follow the existing component idiom — `CredentialForm.jsx` for form structure and hint/error markup, `ProfilePicker.jsx` for the connection list and its confirm-before-destructive pattern. Reuse existing CSS classes; do not invent a parallel styling vocabulary.

- [ ] **Step 4: Run and confirm passing**

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit as: `feat: vault unlock screen`

---

### Task 6: Wire the vault into `App.jsx`

**Files:**
- Modify: `src/components/App.jsx`
- Test: `test/components/app.test.jsx`, `test/source-invariants.test.js`

**Contract.**

1. **A `locked` session state.** On mount, when `vaultExists()` and `!isUnlocked()`, the app renders `VaultUnlock` instead of the connect form. Unlocking transitions to the ordinary disconnected screen with secrets available.
2. **Auto-connect through the vault.** The existing mount-effect auto-connect requires a secret. When the vault is unlocked and the selected connection's credential has an entry, recall it and connect — this is the whole point of the feature.
3. **The post-connect offer.** After the *first* successful connect with no vault present, offer to remember the key. Dismissible, and never shown twice — persist the dismissal. The operator chose this over gating first-run behind a passphrase: nothing is asked for until the app has demonstrated it works.
4. **Re-wrap on credential change.** When `handleSaveProfile` re-points a connection at a new credential while the vault is unlocked and the form holds a secret, wrap that secret under the *new* credential id. Task 1 collects the old credential; without this the user's just-typed secret is silently forgotten, because the entry sits under an id nothing references any more.
5. **Locking on disconnect is out of scope.** Disconnect must not lock the vault — the user is switching connections, not leaving. Only a tab close ends the session.

Ordering hazard, stated explicitly because this file has produced three of them: the `credentials` initializer runs **before** the mount effect, so anything the vault provides is not available to it. Recall belongs in the effect, not the initializer.

- [ ] **Step 1: Write the failing tests**

Add to `test/components/app.test.jsx`, following its existing conventions (`clearAppStorage()`, `h(App, {})`, try/finally, bounded polling for effects). Cover: a vault present and locked renders the unlock screen and not the connect form; no vault renders the connect form exactly as today; unlocking reveals the connect form; a connection whose secret is remembered auto-connects on mount without the user typing anything.

Add a source invariant to `test/source-invariants.test.js` asserting `App.jsx` does not call `recallSecret` from inside a `useState` initializer — the ordering hazard above, mechanically guarded.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:ui` and `node --test test/source-invariants.test.js`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run and confirm passing**

Run: `npm test` and `npm run test:ui`. Both must pass; `npm test` includes the esbuild build, which is what proves the wiring compiles.

- [ ] **Step 5: Commit**

Commit as: `feat: vault-backed unlock and auto-connect`

---

### Task 7: Storage inspector, manual QA, and release

**Files:**
- Modify: `src/components/StorageModal.jsx`
- Modify: `docs/storage-catalog.md`
- Modify: `CHANGELOG.md`, `package.json`
- Test: `test/components/storage-modal.test.jsx`

**Contract.** The inspector must report `s3b_vault` and `s3b_vault_key` truthfully: what they hold, that the first is ciphertext and the second is a derived key, where they are cleared. It must **never** render a decrypted secret. Add both to `docs/storage-catalog.md` in the format established there.

- [ ] **Step 1: Write the failing test**

Extend `test/components/storage-modal.test.jsx` following its existing async-load polling pattern: the inspector names `s3b_vault`, names `s3b_vault_key`, and — seed a vault entry, then assert the rendered text does not contain the plaintext — never displays a secret.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:ui`

- [ ] **Step 3: Implement, including the catalog entries**

- [ ] **Step 4: Manual password-manager QA — required, not optional**

The spec requires this before Phase 2 closes, and it is not unit-testable: manager behaviour is heuristic and differs per implementation. Exercise **save**, **autofill**, and **update** of the vault passphrase against:

- Chrome built-in
- Firefox built-in
- KeePassXC (browser extension)
- Bitwarden or Vaultwarden

For each, record what happened. The specific thing to watch: the vault passphrase and the S3 secret key are two different passwords on one origin, distinguished only by their username fields (`Bucketer vault (this device)` versus the key ID). If any manager conflates them, that is a finding and it blocks the release.

If you cannot run one of these, **say which and why** rather than reporting it as passed.

- [ ] **Step 5: Bump the version and write the changelog**

Set `package.json` to `1.40.0` — minor: a new user-facing feature, backwards-compatible, and a user who never sets a passphrase sees no change.

Write the entry in the register the existing changelog uses: what the user can now do and what it costs them, plainly, without internal vocabulary. It must state that there is **no passphrase recovery** and that a reset destroys stored secrets but keeps connections. Users deserve to know that before they opt in, not after.

- [ ] **Step 6: Verify and commit**

Run: `npm test`, `npm run test:ui`, and `npm run test:e2e:browser`. Confirm `git status` shows no unintended `dist` change.

Ask the operator to confirm the version bump before committing, per house policy.

Commit as: `feat: passphrase vault (v1.40.0)`

---

## Definition of done

- `npm test`, `npm run test:ui`, and the browser e2e suite all pass.
- A user who never sets a passphrase experiences v1.39.1 behaviour exactly.
- A user who sets one: closes the tab, returns, enters the passphrase, and connects without retyping a secret.
- No plaintext secret is ever written to `localStorage` — asserted by test, not by inspection.
- Deleting the last connection using a credential removes its ciphertext.
- Re-pointing a connection at new credentials collects the old credential and re-wraps the secret under the new id.
- `wipeAllAppData()` clears the vault.
- The manual password-manager matrix is recorded, including anything that could not be tested.
- `CHANGELOG.md` and `package.json` agree at `1.40.0`.
