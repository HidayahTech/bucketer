# Connection Model (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `s3b_profiles` record with a bipartite credential/connection model, migrate existing data with credential deduplication, and move capability state onto the connection — with no visible change to the UI.

**Architecture:** A new pure module `src/lib/connections.js` owns two localStorage records (`s3b_credentials`, `s3b_connections`) and exposes a *resolved* view that joins a connection to its credential. The resolved shape is deliberately field-compatible with today's profile object, so `ProfilePicker.jsx` needs no changes and `App.jsx` changes are limited to imports, state names, and capability keying. Migration reads `s3b_profiles`, dedupes credentials on `(endpoint, keyId, provider, regionOverride)`, and preserves profile ids as connection ids so the existing `s3b_last_profile_id` pointer stays valid.

**Tech Stack:** Preact, esbuild, `node --test` (no framework), jsdom for component tests. No new dependencies.

## Global Constraints

- **No new runtime dependencies.** `package.json` must not gain any.
- **`@anthropic-ai/claude-code` must never appear** in `package.json` or `package-lock.json`.
- **Phase 1 is invisible.** No user-facing UI change except the storage inspector in `StorageModal`, which must stay truthful about which keys exist.
- **`s3b_profiles` is read but never deleted** in this phase. It is the rollback path and is removed in a later release.
- **Connection ids reuse the old profile ids.** `s3b_last_profile_id` continues to work untouched; renaming that key is deferred to Phase 3.
- **No `crypto.randomUUID`.** It requires a secure context and Bucketer supports `file://` usage (see `FileBanner.jsx`). Use the sequence-based `newId` helper defined in Task 1.
- **Storage access goes through try/catch wrappers.** Private browsing throws on every read and write; the app degrades rather than crashing, matching `storage.js:52-60`.
- **Corrupt records return a safe empty envelope**, never throw — matching `loadProfiles` (`storage.js:266-272`).
- **One version bump for the whole phase, in Task 7.** Operator decision, 2026-07-26: the house rule that every source commit carries a bump governs what reaches `main`, not intermediate commits on a feature branch. Tasks 1-6 commit with no bump and no `CHANGELOG.md` entry; Task 7 bumps to 1.39.0 with a single entry covering the phase. Leave `package.json` and `CHANGELOG.md` alone until then — they agree at the current version, so the build's changelog assertion keeps passing throughout.
- **Ask the operator before every commit**, per house policy.
- Run `npm test` (unit + structural + build) and `npm run test:ui` (component) before any commit.

> **Task order note.** Tasks execute by number. Task 7 appears *before* Tasks 5 and 6 in this file — an artifact of a post-review reorder that put the `storage.js` export removal last so that every intermediate commit builds. Extract each task by its number, not by its position in the file.

---

### Task 1: Store primitives in `connections.js`

**Files:**
- Create: `src/lib/connections.js`
- Test: `test/connections.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `newId(prefix: string) → string`
  - `loadCredentialRecords() → { version: 1, credentials: Array<CredentialRecord> }`
  - `saveCredentialRecord(cred: CredentialRecord) → void` (upsert by `id`)
  - `deleteCredentialRecord(id: string) → void`
  - `loadConnectionRecords() → { version: 2, connections: Array<ConnectionRecord> }`
  - `saveConnectionRecord(conn: ConnectionRecord) → void` (upsert by `id`)
  - `deleteConnectionRecord(id: string|number) → void`
  - `CredentialRecord = { id, label, endpoint, keyId, provider, regionOverride }`
  - `ConnectionRecord = { id, name, credentialId, bucket, capabilities }`

- [ ] **Step 1: Write the failing test**

Create `test/connections.test.js`:

```js
// Tests for the credential/connection model (connections.js).
//
// connections.js reads localStorage as a bare global at call time (not import
// time), so an in-memory store just needs to exist before any function runs.
// Mirrors the setup in storage.test.js.

const ls = {};

function makeStore(backing) {
  return {
    getItem:    k     => Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null,
    setItem:    (k,v) => { backing[k] = String(v); },
    removeItem: k     => { delete backing[k]; },
  };
}

global.localStorage = makeStore(ls);

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  newId,
  loadCredentialRecords, saveCredentialRecord, deleteCredentialRecord,
  loadConnectionRecords, saveConnectionRecord, deleteConnectionRecord,
} from '../src/lib/connections.js';

beforeEach(() => { for (const k of Object.keys(ls)) delete ls[k]; });

describe('newId', () => {
  test('generates unique ids within the same millisecond', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(newId('c'));
    assert.equal(ids.size, 100);
  });

  test('applies the given prefix', () => {
    assert.ok(newId('cred').startsWith('cred'));
  });
});

describe('credential records', () => {
  test('empty store returns an empty envelope', () => {
    assert.deepEqual(loadCredentialRecords(), { version: 1, credentials: [] });
  });

  test('corrupt JSON returns an empty envelope rather than throwing', () => {
    ls['s3b_credentials'] = '{not json';
    assert.deepEqual(loadCredentialRecords(), { version: 1, credentials: [] });
  });

  test('a record whose credentials field is not an array returns an empty envelope', () => {
    ls['s3b_credentials'] = JSON.stringify({ version: 1, credentials: 'nope' });
    assert.deepEqual(loadCredentialRecords(), { version: 1, credentials: [] });
  });

  test('saves and reads back a credential', () => {
    saveCredentialRecord({ id: 'c1', label: 'B2 — 0057ab', endpoint: 'https://s3.example.com', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' });
    const { credentials } = loadCredentialRecords();
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].keyId, 'k1');
  });

  test('upserts by id rather than appending a duplicate', () => {
    saveCredentialRecord({ id: 'c1', label: 'A', endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    saveCredentialRecord({ id: 'c1', label: 'B', endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    const { credentials } = loadCredentialRecords();
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].label, 'B');
  });

  test('never persists a secretKey even when one is passed in', () => {
    saveCredentialRecord({ id: 'c1', label: 'A', endpoint: 'e', keyId: 'k', provider: null, regionOverride: '', secretKey: 'leaked' });
    assert.equal(ls['s3b_credentials'].includes('leaked'), false);
  });

  test('deletes by id when nothing references it', () => {
    saveCredentialRecord({ id: 'c1', label: 'A', endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    saveCredentialRecord({ id: 'c2', label: 'B', endpoint: 'e2', keyId: 'k2', provider: null, regionOverride: '' });
    assert.equal(deleteCredentialRecord('c1'), true);
    const { credentials } = loadCredentialRecords();
    assert.deepEqual(credentials.map(c => c.id), ['c2']);
  });

  test('refuses to delete a credential a connection still references', () => {
    saveCredentialRecord({ id: 'c1', label: 'A', endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'Photos', credentialId: 'c1', bucket: 'photos', capabilities: null });
    assert.equal(deleteCredentialRecord('c1'), false);
    assert.equal(loadCredentialRecords().credentials.length, 1);
  });
});

describe('connection records', () => {
  test('empty store returns an empty envelope', () => {
    assert.deepEqual(loadConnectionRecords(), { version: 2, connections: [] });
  });

  test('corrupt JSON returns an empty envelope rather than throwing', () => {
    ls['s3b_connections'] = 'garbage';
    assert.deepEqual(loadConnectionRecords(), { version: 2, connections: [] });
  });

  test('saves, upserts, and deletes', () => {
    saveConnectionRecord({ id: 1, name: 'Photos', credentialId: 'c1', bucket: 'photos', capabilities: null });
    saveConnectionRecord({ id: 1, name: 'Photos (renamed)', credentialId: 'c1', bucket: 'photos', capabilities: null });
    assert.equal(loadConnectionRecords().connections.length, 1);
    assert.equal(loadConnectionRecords().connections[0].name, 'Photos (renamed)');
    deleteConnectionRecord(1);
    assert.deepEqual(loadConnectionRecords().connections, []);
  });

  test('never persists a secretKey even when one is passed in', () => {
    saveConnectionRecord({ id: 1, name: 'A', credentialId: 'c1', bucket: 'b', capabilities: null, secretKey: 'leaked' });
    assert.equal(ls['s3b_connections'].includes('leaked'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connections.test.js`
Expected: FAIL — `Cannot find module '../src/lib/connections.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/connections.js`:

```js
// Copyright (C) 2026 HidayahTech, LLC
// Credential and connection persistence — the bipartite model that replaces the
// flat profile record.
//
// WHY TWO RECORDS: a credential (endpoint + key ID + provider + region) can
// reach many buckets, and a bucket can be reached by many credentials — a
// read-only key for browsing and a read-write key for changes are two distinct,
// separately-named things pointing at the same bucket. A single flat record
// cannot express that without duplicating the credential.
//
// The nameable unit the user clicks is the CONNECTION — the (credential, bucket)
// pairing. That is what today's profile already is, so resolveConnection()
// projects a connection back into a profile-shaped object and existing UI keeps
// working unchanged.
//
// Secret keys are NEVER stored here. They live in sessionStorage (storage.js)
// and, from Phase 2, encrypted in the vault keyed by credential id.
//
// All storage access goes through safe wrappers — private browsing throws on
// every read and write, and the app must degrade rather than crash.

const LS_KEY_CREDENTIALS = 's3b_credentials';
const LS_KEY_CONNECTIONS = 's3b_connections';

const CREDENTIALS_VERSION = 1;
const CONNECTIONS_VERSION = 2;

function safeGetRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSetRaw(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode — in-memory state continues */ }
}
function safeRemoveRaw(key) {
  try { localStorage.removeItem(key); } catch { /* */ }
}

// Monotonic id generator. Deliberately NOT crypto.randomUUID(): that requires a
// secure context, and Bucketer supports being opened from file:// (see
// FileBanner.jsx). The sequence counter guarantees uniqueness even when several
// ids are minted inside the same millisecond, which migration does.
let _seq = 0;
export function newId(prefix) {
  _seq += 1;
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

function emptyCredentials() {
  return { version: CREDENTIALS_VERSION, credentials: [] };
}
function emptyConnections() {
  return { version: CONNECTIONS_VERSION, connections: [] };
}

export function loadCredentialRecords() {
  try {
    const raw = safeGetRaw(LS_KEY_CREDENTIALS);
    if (!raw) return emptyCredentials();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.credentials)) return emptyCredentials();
    return parsed;
  } catch {
    return emptyCredentials();
  }
}

export function loadConnectionRecords() {
  try {
    const raw = safeGetRaw(LS_KEY_CONNECTIONS);
    if (!raw) return emptyConnections();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.connections)) return emptyConnections();
    return parsed;
  } catch {
    return emptyConnections();
  }
}

function saveCredentialData(data) {
  safeSetRaw(LS_KEY_CREDENTIALS, JSON.stringify(data));
}
function saveConnectionData(data) {
  safeSetRaw(LS_KEY_CONNECTIONS, JSON.stringify(data));
}

// secretKey is stripped defensively — callers pass whole form objects, and a
// secret must never reach localStorage. Mirrors saveProfile in storage.js.
export function saveCredentialRecord(cred) {
  // eslint-disable-next-line no-unused-vars
  const { secretKey: _dropped, ...safeCred } = cred;
  const data = loadCredentialRecords();
  const idx = data.credentials.findIndex(c => c.id === safeCred.id);
  if (idx >= 0) data.credentials[idx] = { ...data.credentials[idx], ...safeCred };
  else data.credentials.push({ ...safeCred });
  saveCredentialData(data);
}

// Refuses to delete a credential that connections still reference. An orphaned
// credentialId is a corruption class nothing can repair — the endpoint and key
// ID are gone — so it must never be created in the first place.
// Returns true when the deletion happened, false when it was refused.
export function deleteCredentialRecord(id) {
  const { connections } = loadConnectionRecords();
  if (connections.some(c => c.credentialId === id)) return false;
  const data = loadCredentialRecords();
  data.credentials = data.credentials.filter(c => c.id !== id);
  saveCredentialData(data);
  return true;
}

export function saveConnectionRecord(conn) {
  // eslint-disable-next-line no-unused-vars
  const { secretKey: _dropped, ...safeConn } = conn;
  const data = loadConnectionRecords();
  const idx = data.connections.findIndex(c => c.id === safeConn.id);
  if (idx >= 0) data.connections[idx] = { ...data.connections[idx], ...safeConn };
  else data.connections.push({ ...safeConn });
  saveConnectionData(data);
}

export function deleteConnectionRecord(id) {
  const data = loadConnectionRecords();
  data.connections = data.connections.filter(c => c.id !== id);
  saveConnectionData(data);
}

// Removes both records outright. Used by wipeAllAppData and the storage inspector.
export function deleteAllConnectionData() {
  safeRemoveRaw(LS_KEY_CREDENTIALS);
  safeRemoveRaw(LS_KEY_CONNECTIONS);
}

export const CONNECTION_STORAGE_KEYS = [LS_KEY_CREDENTIALS, LS_KEY_CONNECTIONS];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/connections.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connections.js test/connections.test.js
git commit -m "feat: credential/connection store primitives (connections.js)"
```

---

### Task 2: Credential dedupe and connection resolution

**Files:**
- Modify: `src/lib/connections.js`
- Test: `test/connections.test.js`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `credentialFingerprint(fields) → string`
  - `findOrCreateCredential({ endpoint, keyId, provider, regionOverride, label? }) → CredentialRecord`
  - `resolveConnection(id) → ResolvedConnection | null`
  - `listResolvedConnections() → Array<ResolvedConnection>`
  - `ResolvedConnection = { id, name, endpoint, bucket, keyId, provider, regionOverride, credentialId, capabilities }` — field-compatible with the old profile shape plus `credentialId` and `capabilities`.
  - `defaultCredentialLabel({ provider, keyId }) → string`
  - `defaultConnectionName({ provider, bucket }) → string`

- [ ] **Step 1: Write the failing test**

Append to `test/connections.test.js` (and add the new names to the existing import block):

```js
describe('credentialFingerprint', () => {
  test('is stable across trailing slashes and surrounding whitespace on endpoint', () => {
    const a = credentialFingerprint({ endpoint: 'https://s3.example.com/', keyId: 'k', provider: 'b2', regionOverride: 'us-west-004' });
    const b = credentialFingerprint({ endpoint: '  https://s3.example.com  ', keyId: 'k', provider: 'b2', regionOverride: 'us-west-004' });
    assert.equal(a, b);
  });

  test('treats null, undefined, and empty-string provider as the same', () => {
    const a = credentialFingerprint({ endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    const b = credentialFingerprint({ endpoint: 'e', keyId: 'k', provider: '', regionOverride: '' });
    const c = credentialFingerprint({ endpoint: 'e', keyId: 'k', regionOverride: '' });
    assert.equal(a, b);
    assert.equal(a, c);
  });

  test('is case-sensitive on keyId — key IDs are case-significant', () => {
    const a = credentialFingerprint({ endpoint: 'e', keyId: 'abc', provider: null, regionOverride: '' });
    const b = credentialFingerprint({ endpoint: 'e', keyId: 'ABC', provider: null, regionOverride: '' });
    assert.notEqual(a, b);
  });

  test('differs when the region differs', () => {
    const a = credentialFingerprint({ endpoint: 'e', keyId: 'k', provider: 'b2', regionOverride: 'us-west-004' });
    const b = credentialFingerprint({ endpoint: 'e', keyId: 'k', provider: 'b2', regionOverride: 'eu-central-003' });
    assert.notEqual(a, b);
  });
});

describe('findOrCreateCredential', () => {
  const fields = { endpoint: 'https://s3.example.com', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' };

  test('creates a credential when none matches', () => {
    const cred = findOrCreateCredential(fields);
    assert.ok(cred.id);
    assert.equal(loadCredentialRecords().credentials.length, 1);
  });

  test('returns the existing credential instead of creating a second', () => {
    const first  = findOrCreateCredential(fields);
    const second = findOrCreateCredential({ ...fields, endpoint: 'https://s3.example.com/' });
    assert.equal(first.id, second.id);
    assert.equal(loadCredentialRecords().credentials.length, 1);
  });

  test('creates a separate credential for a different key on the same endpoint', () => {
    findOrCreateCredential(fields);
    findOrCreateCredential({ ...fields, keyId: 'k2' });
    assert.equal(loadCredentialRecords().credentials.length, 2);
  });

  test('generates a default label when none is given', () => {
    const cred = findOrCreateCredential(fields);
    assert.equal(cred.label, 'B2 — k1');
  });

  test('respects an explicit label', () => {
    const cred = findOrCreateCredential({ ...fields, label: 'Work account' });
    assert.equal(cred.label, 'Work account');
  });
});

describe('defaultCredentialLabel', () => {
  test('truncates long key IDs to six characters', () => {
    assert.equal(defaultCredentialLabel({ provider: 'b2', keyId: '0057abcdef0123456789' }), 'B2 — 0057ab…');
  });

  test('keeps short key IDs whole', () => {
    assert.equal(defaultCredentialLabel({ provider: 'b2', keyId: 'k1' }), 'B2 — k1');
  });

  test('falls back to the key ID alone when the provider is unknown', () => {
    assert.equal(defaultCredentialLabel({ provider: null, keyId: 'k1' }), 'k1');
  });
});

describe('defaultConnectionName', () => {
  test('combines provider and bucket', () => {
    assert.equal(defaultConnectionName({ provider: 'b2', bucket: 'photos' }), 'B2 — photos');
  });

  test('falls back to the bucket alone when the provider is unknown', () => {
    assert.equal(defaultConnectionName({ provider: null, bucket: 'photos' }), 'photos');
  });
});

describe('resolveConnection / listResolvedConnections', () => {
  test('joins a connection to its credential in profile-compatible shape', () => {
    const cred = findOrCreateCredential({ endpoint: 'https://s3.example.com', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' });
    saveConnectionRecord({ id: 1, name: 'Photos', credentialId: cred.id, bucket: 'photos', capabilities: null });
    const resolved = resolveConnection(1);
    assert.equal(resolved.id, 1);
    assert.equal(resolved.name, 'Photos');
    assert.equal(resolved.endpoint, 'https://s3.example.com');
    assert.equal(resolved.bucket, 'photos');
    assert.equal(resolved.keyId, 'k1');
    assert.equal(resolved.provider, 'b2');
    assert.equal(resolved.regionOverride, 'us-west-004');
    assert.equal(resolved.credentialId, cred.id);
  });

  test('returns null for an unknown connection id', () => {
    assert.equal(resolveConnection(999), null);
  });

  test('returns null when the credential is orphaned', () => {
    saveConnectionRecord({ id: 1, name: 'Orphan', credentialId: 'missing', bucket: 'b', capabilities: null });
    assert.equal(resolveConnection(1), null);
  });

  test('listResolvedConnections omits orphaned connections rather than throwing', () => {
    const cred = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'Good',   credentialId: cred.id,  bucket: 'b1', capabilities: null });
    saveConnectionRecord({ id: 2, name: 'Orphan', credentialId: 'gone',   bucket: 'b2', capabilities: null });
    const list = listResolvedConnections();
    assert.deepEqual(list.map(c => c.id), [1]);
  });

  test('two connections can share one credential', () => {
    const cred = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'Photos (R/O)', credentialId: cred.id, bucket: 'photos', capabilities: null });
    saveConnectionRecord({ id: 2, name: 'Photos (admin)', credentialId: cred.id, bucket: 'photos', capabilities: null });
    const list = listResolvedConnections();
    assert.equal(list.length, 2);
    assert.equal(list[0].credentialId, list[1].credentialId);
    assert.equal(loadCredentialRecords().credentials.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connections.test.js`
Expected: FAIL — `credentialFingerprint is not defined` (and the other new names).

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/connections.js`, and add the import at the top of the file:

```js
import { PROVIDER_LABELS } from './provider.js';
```

```js
// Normalizes the four fields that identify a credential, so that cosmetic
// differences (a trailing slash, stray whitespace, null vs '' provider) do not
// produce two credentials for what is really one key. Endpoint normalization
// matches what CredentialForm.handleSubmit does before saving.
export function credentialFingerprint({ endpoint, keyId, provider, regionOverride }) {
  const e = (endpoint || '').trim().replace(/\/$/, '');
  const k = keyId || '';
  const p = provider || '';
  const r = (regionOverride || '').trim();
  //   cannot appear in any of these fields, so it is an unambiguous separator.
  return [e, k, p, r].join(' ');
}

const LABEL_KEY_ID_MAX = 6;

export function defaultCredentialLabel({ provider, keyId }) {
  const id = keyId || '';
  const shortId = id.length > LABEL_KEY_ID_MAX ? `${id.slice(0, LABEL_KEY_ID_MAX)}…` : id;
  const label = provider ? (PROVIDER_LABELS[provider] || provider.toUpperCase()) : null;
  return label ? `${label} — ${shortId}` : shortId;
}

export function defaultConnectionName({ provider, bucket }) {
  const label = provider ? (PROVIDER_LABELS[provider] || provider.toUpperCase()) : null;
  return label && bucket ? `${label} — ${bucket}` : (bucket || '');
}

// Returns the existing credential matching these fields, or creates and persists
// a new one. This is what makes N connections on one key store that key once.
export function findOrCreateCredential({ endpoint, keyId, provider, regionOverride, label }) {
  const fingerprint = credentialFingerprint({ endpoint, keyId, provider, regionOverride });
  const { credentials } = loadCredentialRecords();
  const existing = credentials.find(c => credentialFingerprint(c) === fingerprint);
  if (existing) return existing;

  const cred = {
    id:             newId('cred'),
    label:          label || defaultCredentialLabel({ provider, keyId }),
    endpoint:       (endpoint || '').trim().replace(/\/$/, ''),
    keyId:          keyId || '',
    provider:       provider || null,
    regionOverride: (regionOverride || '').trim(),
  };
  saveCredentialRecord(cred);
  return cred;
}

// Joins a connection to its credential. The returned shape is deliberately
// field-compatible with the old profile object so existing UI (ProfilePicker,
// App's connect path) consumes it unchanged.
//
// Returns null when the connection is unknown OR its credential is missing. An
// orphaned credentialId is a corruption class migration cannot repair, so it is
// treated as "not there" rather than surfaced as a half-built object.
export function resolveConnection(id) {
  const { connections } = loadConnectionRecords();
  const conn = connections.find(c => c.id === id);
  if (!conn) return null;
  const { credentials } = loadCredentialRecords();
  const cred = credentials.find(c => c.id === conn.credentialId);
  if (!cred) return null;
  return {
    id:             conn.id,
    name:           conn.name,
    bucket:         conn.bucket,
    capabilities:   conn.capabilities || null,
    credentialId:   cred.id,
    endpoint:       cred.endpoint,
    keyId:          cred.keyId,
    provider:       cred.provider,
    regionOverride: cred.regionOverride,
  };
}

export function listResolvedConnections() {
  const { connections } = loadConnectionRecords();
  return connections
    .map(c => resolveConnection(c.id))
    .filter(Boolean);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/connections.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connections.js test/connections.test.js
git commit -m "feat: credential dedupe and connection resolution"
```

---

### Task 3: Migration from `s3b_profiles`

**Files:**
- Modify: `src/lib/connections.js`
- Test: `test/connections.test.js`

**Interfaces:**
- Consumes: `findOrCreateCredential`, `saveConnectionRecord`, `loadConnectionRecords` (Tasks 1-2).
- Produces: `migrateProfilesToConnections() → void` — idempotent, safe to call on every mount.

- [ ] **Step 1: Write the failing test**

Append to `test/connections.test.js` (add `migrateProfilesToConnections` to the import block):

```js
describe('migrateProfilesToConnections', () => {
  function writeProfiles(profiles) {
    ls['s3b_profiles'] = JSON.stringify({ version: 1, profiles });
  }

  test('does nothing when there are no profiles', () => {
    migrateProfilesToConnections();
    assert.deepEqual(loadConnectionRecords().connections, []);
    assert.deepEqual(loadCredentialRecords().credentials, []);
  });

  test('converts one profile into one credential and one connection', () => {
    writeProfiles([{ id: 1, name: 'Photos', endpoint: 'https://s3.example.com', bucket: 'photos', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' }]);
    migrateProfilesToConnections();
    assert.equal(loadCredentialRecords().credentials.length, 1);
    const { connections } = loadConnectionRecords();
    assert.equal(connections.length, 1);
    assert.equal(connections[0].name, 'Photos');
    assert.equal(connections[0].bucket, 'photos');
  });

  test('preserves the profile id as the connection id so s3b_last_profile_id stays valid', () => {
    writeProfiles([{ id: 12345, name: 'Photos', endpoint: 'e', bucket: 'photos', keyId: 'k1', provider: 'b2', regionOverride: '' }]);
    migrateProfilesToConnections();
    assert.equal(loadConnectionRecords().connections[0].id, 12345);
  });

  test('dedupes credentials across profiles sharing one key', () => {
    writeProfiles([
      { id: 1, name: 'A', endpoint: 'https://s3.example.com', bucket: 'b1', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' },
      { id: 2, name: 'B', endpoint: 'https://s3.example.com', bucket: 'b2', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' },
      { id: 3, name: 'C', endpoint: 'https://s3.example.com/', bucket: 'b3', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' },
    ]);
    migrateProfilesToConnections();
    assert.equal(loadCredentialRecords().credentials.length, 1);
    assert.equal(loadConnectionRecords().connections.length, 3);
  });

  test('keeps credentials separate when the key differs on the same bucket', () => {
    writeProfiles([
      { id: 1, name: 'Photos (R/O)',   endpoint: 'e', bucket: 'photos', keyId: 'ro', provider: 'b2', regionOverride: '' },
      { id: 2, name: 'Photos (admin)', endpoint: 'e', bucket: 'photos', keyId: 'rw', provider: 'b2', regionOverride: '' },
    ]);
    migrateProfilesToConnections();
    assert.equal(loadCredentialRecords().credentials.length, 2);
    assert.equal(loadConnectionRecords().connections.length, 2);
  });

  test('is idempotent — running twice does not duplicate', () => {
    writeProfiles([{ id: 1, name: 'Photos', endpoint: 'e', bucket: 'photos', keyId: 'k1', provider: 'b2', regionOverride: '' }]);
    migrateProfilesToConnections();
    migrateProfilesToConnections();
    assert.equal(loadConnectionRecords().connections.length, 1);
    assert.equal(loadCredentialRecords().credentials.length, 1);
  });

  test('leaves s3b_profiles in place as a rollback path', () => {
    writeProfiles([{ id: 1, name: 'Photos', endpoint: 'e', bucket: 'photos', keyId: 'k1', provider: 'b2', regionOverride: '' }]);
    migrateProfilesToConnections();
    assert.ok(ls['s3b_profiles']);
  });

  test('skips a profile with no bucket rather than creating a broken connection', () => {
    writeProfiles([{ id: 1, name: 'Broken', endpoint: 'e', bucket: '', keyId: 'k1', provider: 'b2', regionOverride: '' }]);
    migrateProfilesToConnections();
    assert.deepEqual(loadConnectionRecords().connections, []);
  });

  test('tolerates a corrupt s3b_profiles record', () => {
    ls['s3b_profiles'] = '{not json';
    migrateProfilesToConnections();
    assert.deepEqual(loadConnectionRecords().connections, []);
  });

  test('does not run when connections already exist', () => {
    const cred = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    saveConnectionRecord({ id: 99, name: 'Existing', credentialId: cred.id, bucket: 'b', capabilities: null });
    writeProfiles([{ id: 1, name: 'Photos', endpoint: 'e2', bucket: 'photos', keyId: 'k9', provider: 'b2', regionOverride: '' }]);
    migrateProfilesToConnections();
    assert.equal(loadConnectionRecords().connections.length, 1);
    assert.equal(loadConnectionRecords().connections[0].id, 99);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connections.test.js`
Expected: FAIL — `migrateProfilesToConnections is not defined`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/connections.js`:

```js
const LS_KEY_PROFILES = 's3b_profiles';

// Idempotent — converts the legacy flat profile record into credentials +
// connections. Safe to call on every mount; returns immediately once any
// connection exists.
//
// s3b_profiles is READ but deliberately NOT deleted: it is the rollback path for
// one release. A later release removes it.
//
// Profile ids become connection ids so the existing s3b_last_profile_id pointer
// keeps resolving without a second migration.
export function migrateProfilesToConnections() {
  if (loadConnectionRecords().connections.length > 0) return; // already migrated

  let profiles = [];
  try {
    const raw = safeGetRaw(LS_KEY_PROFILES);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) return;
    profiles = parsed.profiles;
  } catch {
    return; // corrupt legacy record — nothing to migrate
  }

  for (const profile of profiles) {
    // A profile without a bucket cannot become a usable connection. Skipping is
    // preferable to creating a row that fails the moment it is clicked.
    if (!profile.bucket) continue;

    const cred = findOrCreateCredential({
      endpoint:       profile.endpoint,
      keyId:          profile.keyId,
      provider:       profile.provider,
      regionOverride: profile.regionOverride,
    });

    saveConnectionRecord({
      id:           profile.id,
      name:         profile.name || defaultConnectionName({ provider: profile.provider, bucket: profile.bucket }),
      credentialId: cred.id,
      bucket:       profile.bucket,
      capabilities: null,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/connections.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connections.js test/connections.test.js
git commit -m "feat: migrate s3b_profiles to the connection model"
```

---

### Task 4: Per-connection capabilities

**Files:**
- Modify: `src/lib/connections.js`
- Test: `test/connections.test.js`

**Interfaces:**
- Consumes: `loadConnectionRecords`, `saveConnectionRecord` (Task 1).
- Produces:
  - `defaultCapabilities() → { list, download, upload, delete }` — all `'unknown'`
  - `loadConnectionCapabilities(id) → capabilities`
  - `saveConnectionCapabilities(id, caps) → void`
  - `clearAllConnectionCapabilities() → void`

**Why this exists:** `s3b_capabilities` is a single global key today (`storage.js:47`). With more than one bucket in play, state learned against bucket A is applied to bucket B. Moving it onto the connection is a correctness fix. Behaviour is unchanged — capabilities are still learned from real operation failures, never probed and never declared.

- [ ] **Step 1: Write the failing test**

Append to `test/connections.test.js` (add the four new names to the import block):

```js
describe('per-connection capabilities', () => {
  function makeConnection(id) {
    const cred = findOrCreateCredential({ endpoint: 'e', keyId: `k${id}`, provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id, name: `C${id}`, credentialId: cred.id, bucket: `b${id}`, capabilities: null });
  }

  test('defaultCapabilities are all unknown', () => {
    assert.deepEqual(defaultCapabilities(), { list: 'unknown', download: 'unknown', upload: 'unknown', delete: 'unknown' });
  });

  test('an unsaved connection reads back defaults', () => {
    makeConnection(1);
    assert.deepEqual(loadConnectionCapabilities(1), defaultCapabilities());
  });

  test('an unknown connection id reads back defaults rather than throwing', () => {
    assert.deepEqual(loadConnectionCapabilities(999), defaultCapabilities());
  });

  test('saves and reads back capabilities for one connection', () => {
    makeConnection(1);
    saveConnectionCapabilities(1, { ...defaultCapabilities(), delete: 'denied' });
    assert.equal(loadConnectionCapabilities(1).delete, 'denied');
  });

  test('capabilities learned on one connection do not leak to another', () => {
    makeConnection(1);
    makeConnection(2);
    saveConnectionCapabilities(1, { ...defaultCapabilities(), delete: 'denied' });
    assert.equal(loadConnectionCapabilities(2).delete, 'unknown');
  });

  test('saving capabilities for an unknown connection is a no-op, not a crash', () => {
    saveConnectionCapabilities(999, { ...defaultCapabilities(), delete: 'denied' });
    assert.deepEqual(loadConnectionRecords().connections, []);
  });

  test('a corrupt capabilities value falls back to defaults', () => {
    makeConnection(1);
    const data = loadConnectionRecords();
    data.connections[0].capabilities = 'nonsense';
    ls['s3b_connections'] = JSON.stringify(data);
    assert.deepEqual(loadConnectionCapabilities(1), defaultCapabilities());
  });

  test('clearAllConnectionCapabilities resets every connection', () => {
    makeConnection(1);
    makeConnection(2);
    saveConnectionCapabilities(1, { ...defaultCapabilities(), delete: 'denied' });
    saveConnectionCapabilities(2, { ...defaultCapabilities(), upload: 'denied' });
    clearAllConnectionCapabilities();
    assert.deepEqual(loadConnectionCapabilities(1), defaultCapabilities());
    assert.deepEqual(loadConnectionCapabilities(2), defaultCapabilities());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connections.test.js`
Expected: FAIL — `defaultCapabilities is not defined`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/connections.js`:

```js
const CAPABILITY_OPS = ['list', 'download', 'upload', 'delete'];

export function defaultCapabilities() {
  return { list: 'unknown', download: 'unknown', upload: 'unknown', delete: 'unknown' };
}

function isValidCapabilities(caps) {
  if (!caps || typeof caps !== 'object') return false;
  return CAPABILITY_OPS.every(op => typeof caps[op] === 'string');
}

// Capabilities live on the connection record rather than in one global key, so
// that state learned against one bucket is never applied to another.
//
// An unknown connection id returns defaults rather than throwing: ad-hoc
// credentials with no saved connection are a supported case, and the caller
// holds their capabilities in memory for the session only.
export function loadConnectionCapabilities(id) {
  const { connections } = loadConnectionRecords();
  const conn = connections.find(c => c.id === id);
  if (!conn || !isValidCapabilities(conn.capabilities)) return defaultCapabilities();
  return { ...defaultCapabilities(), ...conn.capabilities };
}

export function saveConnectionCapabilities(id, caps) {
  const data = loadConnectionRecords();
  const idx = data.connections.findIndex(c => c.id === id);
  if (idx < 0) return; // ad-hoc connection — nothing to persist against
  data.connections[idx] = { ...data.connections[idx], capabilities: { ...caps } };
  saveConnectionData(data);
}

export function clearAllConnectionCapabilities() {
  const data = loadConnectionRecords();
  if (!data.connections.length) return;
  data.connections = data.connections.map(c => ({ ...c, capabilities: null }));
  saveConnectionData(data);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/connections.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connections.js test/connections.test.js
git commit -m "feat: per-connection capability state"
```

---

### Task 7: Retire the global capability key, fix storage housekeeping, and release

**Files:**
- Modify: `src/lib/storage.js:47` (drop `capabilities` from `LS_KEYS`), `:191-210` (remove the four capability functions), `:222-241` (`repairStorageInvariants`), `:317-327` (`wipeAllAppData`), `:336-339` (`deleteAllProfiles`)
- Modify: `src/components/StorageModal.jsx:227-229` (delete-all warning text)
- Modify: `test/storage.test.js` (remove capability imports and their describe block)
- Modify: `CHANGELOG.md`, `package.json` (the phase's single version bump)
- Test: `test/storage.test.js`, `test/connections.test.js`

**This is the last task of the phase**, so it also carries the release: the version bump, the changelog entry, and the manual migration verification.

**Interfaces:**
- Consumes: `CONNECTION_STORAGE_KEYS`, `deleteAllConnectionData` (Task 1).
- Produces: `wipeAllAppData()` now removes `s3b_credentials` and `s3b_connections` too. `loadCapabilities`, `saveCapabilities`, `clearCapabilities`, and `defaultCapabilities` **no longer exist in `storage.js`** — importers must take `defaultCapabilities` from `connections.js`.

**Why:** these three functions enumerate keys explicitly. Left alone they silently miss the new records, so "wipe all data" would leave credentials on disk — a privacy bug, not a cosmetic one.

- [ ] **Step 1: Write the failing test**

Append to `test/storage.test.js`:

```js
describe('wipeAllAppData covers the connection model keys', () => {
  test('removes s3b_credentials and s3b_connections', () => {
    ls['s3b_credentials'] = JSON.stringify({ version: 1, credentials: [{ id: 'c1' }] });
    ls['s3b_connections'] = JSON.stringify({ version: 2, connections: [{ id: 1 }] });
    ls['s3b_profiles']    = JSON.stringify({ version: 1, profiles: [{ id: 1 }] });
    wipeAllAppData();
    assert.equal(ls['s3b_credentials'], undefined);
    assert.equal(ls['s3b_connections'], undefined);
    assert.equal(ls['s3b_profiles'], undefined);
  });
});

describe('deleteAllProfiles covers the connection model keys', () => {
  test('removes connection data alongside legacy profiles', () => {
    ls['s3b_credentials'] = JSON.stringify({ version: 1, credentials: [{ id: 'c1' }] });
    ls['s3b_connections'] = JSON.stringify({ version: 2, connections: [{ id: 1 }] });
    ls['s3b_profiles']    = JSON.stringify({ version: 1, profiles: [{ id: 1 }] });
    deleteAllProfiles();
    assert.equal(ls['s3b_credentials'], undefined);
    assert.equal(ls['s3b_connections'], undefined);
    assert.equal(ls['s3b_profiles'], undefined);
  });
});
```

In `test/storage.test.js`, add `wipeAllAppData` and `deleteAllProfiles` to the import block, and **remove** `loadCapabilities, saveCapabilities, clearCapabilities, defaultCapabilities` from it. Delete these three `describe` blocks — that coverage now lives in `test/connections.test.js`:

- `describe('defaultCapabilities', …)` (`test/storage.test.js:263`)
- `describe('saveCapabilities / loadCapabilities', …)` (`:273`)
- `describe('clearCapabilities', …)` (`:290`)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/storage.test.js`
Expected: FAIL — `wipeAllAppData` leaves `s3b_credentials` present.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/storage.js`:

Add the import at the top:

```js
import { CONNECTION_STORAGE_KEYS, deleteAllConnectionData, repairCredentialProviders } from './connections.js';
```

`connections.js` imports only from `provider.js`, so this does not create a cycle.

Change `LS_KEYS` (`:47`) to drop the capabilities entry:

```js
// Convenience: all keyed storage keys. Capability state now lives on the
// connection record (see connections.js) rather than in a global key.
const LS_KEYS = { ...CREDENTIAL_KEYS, ...SETTINGS_KEYS };
```

Delete `loadCapabilities`, `saveCapabilities`, `clearCapabilities`, and `defaultCapabilities` (`:191-210`) entirely, along with the comment block above them.

Update the comment on `clearCredentials` (`:85`) — it references `clearCapabilities()`, which no longer exists:

```js
// Called on disconnect AND on credential change. Only removes credential fields —
// settings survive so the user's preferences are intact after reconnect.
// Capability state lives on the connection record and is not touched here.
```

Update `wipeAllAppData` (`:317`):

```js
export function wipeAllAppData() {
  const allLSKeys = [
    ...Object.values(LS_KEYS),
    LS_KEY_PROFILES,
    LS_KEY_LAST_PROFILE_ID,
    ...CONNECTION_STORAGE_KEYS,
    's3b_capabilities',   // legacy key — removed so an upgrade leaves nothing behind
    's3b_active_uploads',
  ];
  allLSKeys.forEach(k => safeRemove(localStorage, k));
  safeRemove(sessionStorage, SS_KEY_SECRET);
  safeRemove(sessionStorage, 's3b_file_banner_dismissed');
}
```

Update `deleteAllProfiles` (`:336`):

```js
// Removes all saved connections, credentials, legacy profiles, and the
// last-selected pointer in one operation.
export function deleteAllProfiles() {
  safeRemove(localStorage, LS_KEY_PROFILES);
  safeRemove(localStorage, LS_KEY_LAST_PROFILE_ID);
  deleteAllConnectionData();
}
```

`repairStorageInvariants` (`:222`) keeps repairing legacy profiles — migration reads them, so they must be clean first. It also needs to repair credentials, which now hold the provider field that profiles used to.

The write helper `saveCredentialData` is module-private in `connections.js`, so add a narrow repair helper there rather than exporting the raw writer. Append to `src/lib/connections.js`:

```js
// Clears provider fields that failed validation. The validity rule lives in
// storage.js (isValidProvider) and is passed in, so the rule is encoded in
// exactly one place rather than duplicated across both modules.
export function repairCredentialProviders(isValidProvider) {
  const data = loadCredentialRecords();
  let dirty = false;
  for (const cred of data.credentials) {
    if (cred.provider && !isValidProvider(cred.provider)) {
      cred.provider = null;
      dirty = true;
    }
  }
  if (dirty) saveCredentialData(data);
}
```

Then add one line at the end of `repairStorageInvariants` in `storage.js`, after the existing `if (dirty) saveProfilesData(data);`:

```js
  repairCredentialProviders(isValidProvider);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/storage.test.js test/connections.test.js`
Expected: PASS. If `storage.test.js` still fails on missing capability exports, the import block cleanup in Step 1 was incomplete.

- [ ] **Step 5: Correct the delete-all warning text**

`deleteAllProfiles()` now clears credentials and connections too, so the confirmation in `StorageModal.jsx:227-229` understates what it does. Update it to match the behaviour this task just changed:

```jsx
                <ConfirmDialog id="profiles" controller={controller} label="Delete all profiles"
                  warning="All saved profiles and their stored credentials will be removed. Credentials on your storage provider are unaffected."
                  danger />
```

- [ ] **Step 6: Bump the version and write the changelog**

This is the phase's single version bump. Set `version` in `package.json` to `1.39.0` — minor, because the stored data model changed and a key was retired, even though the UI is unchanged.

Add to the top of `CHANGELOG.md`:

```markdown
## [1.39.0] — 2026-07-26 — Connection model

Internal restructuring with no visible UI change. Saved profiles are now stored
as a credential plus a connection, so one key shared across several buckets is
stored once instead of once per bucket. Existing profiles migrate automatically
on first load, and credentials that were duplicated across profiles are merged.

- Split `s3b_profiles` into `s3b_credentials` (endpoint, key ID, provider, region) and `s3b_connections` (name, bucket, credential reference). A credential can serve many connections, and a bucket can be reached by more than one credential — for example a read-only key for browsing and a read-write key for changes.
- Migration preserves profile ids as connection ids, dedupes credentials on endpoint, key ID, provider, and region, and leaves `s3b_profiles` in place as a rollback path for one release.
- Capability state (list/download/upload/delete) moved from the global `s3b_capabilities` key onto each connection. Previously, permissions learned against one bucket were applied to every bucket. Capabilities are still learned only from real operation failures — nothing is probed.
- `wipeAllAppData()` and `deleteAllProfiles()` now clear the new records; previously a wipe would have left credentials on disk.
- Storage inspector updated to name the new keys.
```

- [ ] **Step 7: Verify the full suite and build**

Run: `npm test`
Expected: PASS — including `build.test.js` version consistency, which is what proves the bump and the changelog entry agree.

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 8: Manual verification of the migration**

The migration runs against real user data, so verify it by hand rather than trusting unit tests alone.

1. Run `npm run serve`.
2. In devtools, seed a pre-upgrade state:
   ```js
   localStorage.setItem('s3b_profiles', JSON.stringify({ version: 1, profiles: [
     { id: 1, name: 'Photos',  endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'photos',  keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' },
     { id: 2, name: 'Backups', endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'backups', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004' },
   ]}));
   localStorage.setItem('s3b_last_profile_id', '2');
   ```
3. Reload. Confirm: both profiles still appear in the picker with their names; `s3b_credentials` holds exactly **one** credential; `s3b_connections` holds two; `s3b_profiles` is still present.
4. Confirm the previously selected profile (`Backups`) is still selected and its fields pre-fill the form.
5. Reload again and confirm nothing duplicates.
6. Open the storage modal, click **Reset capabilities**, and confirm no error.

Report the result in your task report. If any step fails, fix before committing.

- [ ] **Step 9: Commit**

Ask the operator to confirm the version bump before committing, per house policy.

```bash
git add src/lib/storage.js src/lib/connections.js src/components/StorageModal.jsx \
        test/storage.test.js test/connections.test.js CHANGELOG.md package.json
git commit -m "feat: connection model phase 1 (v1.39.0)"
```

---

### Task 5: Wire `App.jsx` to the connection model

**Files:**
- Modify: `src/components/App.jsx:30` (capability imports), `:33-34` (profile imports), `:70-95` (state init), `:105-125` (capability handlers), `:127-150` (`handleConnect`), `:155-173` (`handleDisconnect`), `:178-201` (mount effect), `:291-341` (profile handlers), `:421-427` (`ProfilePicker` props)
- Modify: `test/source-invariants.test.js:110-127` (BUG-017 invariant references the old names)
- Test: `test/source-invariants.test.js`, `test/components/app.test.jsx`

**Interfaces:**
- Consumes: `listResolvedConnections`, `resolveConnection`, `findOrCreateCredential`, `saveConnectionRecord`, `deleteConnectionRecord`, `migrateProfilesToConnections`, `defaultCapabilities`, `loadConnectionCapabilities`, `saveConnectionCapabilities`, `newId`, `defaultConnectionName` (Tasks 1-4).
- Produces: no new exports. `ProfilePicker` keeps its current props — resolved connections are field-compatible, so `profileHint` (`ProfilePicker.jsx:106`) reads `provider` and `bucket` unchanged.

**Naming:** rename `profiles` → `connections` and `selectedProfileId` → `selectedConnectionId` throughout `App.jsx`. `loadLastProfileId`/`saveLastProfileId` keep their names and key — connection ids equal the old profile ids, so the pointer is still correct. Renaming that key is Phase 3.

- [ ] **Step 1: Write the failing test**

`test/source-invariants.test.js` currently asserts BUG-017 — that the selected-profile state is declared before `credentials`, because the credentials initializer reads it. Replace that assertion's expected names. In `test/source-invariants.test.js`, update the block at `:110-127`:

```js
// BUG-017: the credentials initializer reads the selected connection to pre-fill
// the form on first load, so that state must be declared BEFORE credentials.
// Declaring it after produces a temporal-dead-zone ReferenceError at mount.
test('selectedConnectionId is declared before credentials in App.jsx', () => {
  const src = readFileSync(new URL('../src/components/App.jsx', import.meta.url), 'utf8');
  const selIdx  = src.indexOf('const [selectedConnectionId');
  const credIdx = src.indexOf('const [credentials');
  assert.ok(selIdx > -1, 'selectedConnectionId state not found in App.jsx');
  assert.ok(credIdx > -1, 'credentials state not found in App.jsx');
  assert.ok(
    selIdx < credIdx,
    'selectedConnectionId must be declared before credentials; its initializer calls ' +
    'loadLastProfileId() to pre-fill from the saved connection'
  );
});
```

Add a new invariant asserting the global capability key is gone:

```js
// The global s3b_capabilities key leaked capability state across buckets.
// Capabilities now live on the connection record (connections.js).
test('App.jsx does not import capability functions from storage.js', () => {
  const src = readFileSync(new URL('../src/components/App.jsx', import.meta.url), 'utf8');
  assert.equal(
    /loadCapabilities|saveCapabilities|clearCapabilities/.test(src),
    false,
    'capability state must come from connections.js, not storage.js'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/source-invariants.test.js`
Expected: FAIL — `selectedConnectionId state not found in App.jsx`.

- [ ] **Step 3: Write minimal implementation**

In `src/components/App.jsx`:

Replace the capability import (`:30`) and profile imports (`:33-34`). Remove `loadCapabilities, saveCapabilities, clearCapabilities, defaultCapabilities` and `loadProfiles, saveProfile, deleteProfile, migrateProfilesFromLegacy` from the `storage.js` import, keeping `loadLastProfileId, saveLastProfileId, repairStorageInvariants`. Add:

```js
import {
  listResolvedConnections, resolveConnection, findOrCreateCredential,
  saveConnectionRecord, deleteConnectionRecord, migrateProfilesToConnections,
  defaultCapabilities, loadConnectionCapabilities, saveConnectionCapabilities,
  defaultConnectionName,
} from '../lib/connections.js';
```

State init (`:70-95`):

```js
  // selectedConnectionId must be declared before credentials so the credentials
  // initializer can pre-fill the form from the saved connection on first load.
  const [selectedConnectionId, setSelectedConnectionId] = useState(() => loadLastProfileId());
  const [credentials, setCredentials] = useState(() => {
    const stored = loadCredentials();
    const fromUrl = readUrlParams();
    const lastId = loadLastProfileId();
    if (lastId) {
      const conn = resolveConnection(lastId);
      if (conn) return { ...conn, secretKey: stored.secretKey || '', ...fromUrl };
    }
    return { ...stored, ...fromUrl };
  });
```

```js
  const [capabilities, setCapabilities] = useState(() => {
    const lastId = loadLastProfileId();
    return lastId ? loadConnectionCapabilities(lastId) : defaultCapabilities();
  });
```

```js
  const [connections, setConnections] = useState(() => listResolvedConnections());
```

Capability handlers (`:105-125`). Persistence is now keyed on the selected connection; ad-hoc credentials keep capabilities in memory for the session only, which is strictly better than the old behaviour of leaking them across buckets via one global key:

```js
  // Capability state is updated reactively as operations fail (§4.12).
  // The idempotency check (prev[op] === state) prevents unnecessary re-renders and
  // storage writes when the same operation fails multiple times in rapid succession.
  //
  // Persisted against the selected connection. With no connection selected the
  // credentials are ad-hoc, and their capabilities are session-only — persisting
  // them to a global key is what let bucket A's state apply to bucket B.
  const handleCapabilityChange = useCallback((op, state) => {
    setCapabilities(prev => {
      if (prev[op] === state) return prev;
      const next = { ...prev, [op]: state };
      if (selectedConnectionId) saveConnectionCapabilities(selectedConnectionId, next);
      return next;
    });
  }, [selectedConnectionId]);

  // Resets all capabilities to 'unknown' and re-mounts Browser to trigger a fresh probe.
  function handleRefreshPermissions() {
    const fresh = defaultCapabilities();
    setCapabilities(fresh);
    if (selectedConnectionId) saveConnectionCapabilities(selectedConnectionId, fresh);
    setBrowserKey(k => k + 1); // re-mount browser → triggers new listing probe
  }
```

In `handleConnect` (`:136-138`), replace the `clearCapabilities()` call:

```js
    saveCredentials(fullCreds);
    setCapabilities(selectedConnectionId
      ? loadConnectionCapabilities(selectedConnectionId)
      : defaultCapabilities());
    setCredentials(fullCreds);
```

In `handleDisconnect` (`:159-171`):

```js
    clearCredentials();
    setCapabilities(defaultCapabilities());
    // Repopulate form from the selected connection (minus secret key) so the user
    // only has to re-enter their secret key to reconnect.
    const conn = selectedConnectionId ? resolveConnection(selectedConnectionId) : null;
    const nextCreds = conn
      ? { ...conn, secretKey: '' }
      : { endpoint: '', bucket: '', keyId: '', secretKey: '', provider: null, regionOverride: '' };
```

Mount effect (`:178-201`):

```js
  useEffect(() => {
    repairStorageInvariants();
    migrateProfilesToConnections();
    const updated = listResolvedConnections();
    setConnections(updated);
    const lastId = loadLastProfileId();
    if (lastId) setSelectedConnectionId(lastId);

    const stored = loadCredentials();
    const fromUrl = readUrlParams();
    const conn = lastId ? updated.find(c => c.id === lastId) : null;
    // Prefer flat credentials (written by saveCredentials on every connect) over
    // connection data, so connecting with modified credentials — without saving —
    // is restored correctly on reload.
    const base = stored.endpoint
      ? stored
      : (conn ? { ...conn, secretKey: stored.secretKey || '' } : stored);
    const merged = { ...base, ...fromUrl };
    if (merged.endpoint && merged.bucket && merged.keyId && merged.secretKey) {
      handleConnect(merged);
    }
  }, []);
```

Handlers (`:291-341`):

```js
  function handleSelectProfile(id) {
    const conn = resolveConnection(id);
    if (!conn) return;
    setSelectedConnectionId(id);
    saveLastProfileId(id);
    setCapabilities(loadConnectionCapabilities(id));
    const creds = { ...conn, secretKey: '' };
    setCredentials(creds);
    setLiveFormData(creds);
  }
```

`handleSaveProfile` keeps its existing provider-resolution logic (`:301-312`) verbatim; only persistence changes. Replace the block from `const existingProfile` through `saveLastProfileId(profile.id)`:

```js
    const existing = selectedConnectionId ? connections.find(c => c.id === selectedConnectionId) : null;
    const id = existing ? existing.id : Date.now();

    const cred = findOrCreateCredential({
      endpoint:       liveFormData.endpoint,
      keyId:          liveFormData.keyId,
      provider,
      regionOverride: liveFormData.regionOverride,
    });

    saveConnectionRecord({
      id,
      name:         name || defaultConnectionName({ provider, bucket: liveFormData.bucket }),
      credentialId: cred.id,
      bucket:       liveFormData.bucket,
      capabilities: existing ? existing.capabilities : null,
    });

    const updated = listResolvedConnections();
    setConnections(updated);
    setSelectedConnectionId(id);
    saveLastProfileId(id);
```

The following line that reconnects with the saved values (`:331`) changes `profile` to the resolved record:

```js
    const saved = updated.find(c => c.id === id);
    const creds = { ...saved, secretKey: liveFormData.secretKey || '' };
```

```js
  function handleDeleteProfile(id) {
    deleteConnectionRecord(id);
    setConnections(listResolvedConnections());
    if (selectedConnectionId === id) {
      setSelectedConnectionId(null);
      saveLastProfileId(null);
    }
  }
```

`ProfilePicker` props (`:421-427`) — the component is unchanged, only what feeds it:

```js
            <ProfilePicker
              profiles={connections}
              selectedId={selectedConnectionId}
              onSelect={handleSelectProfile}
              onDelete={handleDeleteProfile}
              onSave={handleSaveProfile}
              currentFormData={liveFormData}
            />
```

Finally, replace the two remaining `selectedProfileId` reads at `:494-496` (the active-profile name display) and `:439` (`key={selectedProfileId ?? 'manual'}`) with `selectedConnectionId`, and change `profiles.find(...)` there to `connections.find(...)`.

Before moving on, grep for stragglers — the rename must be total or the build will fail on an undefined variable:

```bash
grep -n "selectedProfileId\|setProfiles\|loadProfiles\|migrateProfilesFromLegacy" src/components/App.jsx
```

Expected: no output.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — including `source-invariants.test.js`.

Run: `npm run test:ui`
Expected: PASS — `test/components/app.test.jsx` renders the disconnected state, which now reads connections.

- [ ] **Step 5: Commit**

```bash
git add src/components/App.jsx test/source-invariants.test.js
git commit -m "refactor: wire App to the connection model"
```

---

### Task 6: Storage inspector

**Files:**
- Modify: `src/components/StorageModal.jsx:13-15` (imports), `:79-96` (`load`), `:105-128` (`act`), `:196` (profiles key display), `:219` (per-row delete), `:360` (capabilities key display)
- Test: `test/components/storage-modal.test.jsx`

**Interfaces:**
- Consumes: `listResolvedConnections`, `loadCredentialRecords`, `clearAllConnectionCapabilities`, `defaultCapabilities` (Tasks 1-4).
- Produces: nothing consumed by later tasks.

**Why this is in Phase 1 despite "invisible":** `StorageModal` is a storage inspector. It currently names `s3b_capabilities` as a live key (`:360`). Leaving it would make the inspector lie about where data is, which is the one thing that component exists not to do.

- [ ] **Step 1: Write the failing test**

Append to `test/components/storage-modal.test.jsx`. That file already imports `h`, `mount`, `describe`, and `test`, and defines a `defaultProps()` helper — follow its existing conventions: components are mounted with `h(...)` rather than JSX, and `text` is a **function**, not a property.

```js
describe('connection model in the storage inspector', () => {
  test('names s3b_connections and s3b_credentials, not the retired s3b_capabilities', async () => {
    const { text, cleanup } = mount(h(StorageModal, defaultProps()));

    // load() is async — it awaits IndexedDB reads — and `data` is null until it
    // resolves, so the inspector sections do not exist on synchronous mount.
    // Poll a bounded number of ticks rather than guessing a fixed delay.
    for (let i = 0; i < 20 && text().includes('Loading'); i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const rendered = text();
    assert.ok(rendered.includes('s3b_connections'), 'inspector should name s3b_connections');
    assert.ok(rendered.includes('s3b_credentials'), 'inspector should name s3b_credentials');
    assert.equal(rendered.includes('s3b_capabilities'), false, 's3b_capabilities is retired');
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ui`
Expected: FAIL — `inspector should name s3b_connections`.

- [ ] **Step 3: Write minimal implementation**

In `src/components/StorageModal.jsx`, change the imports (`:13-15`) to drop `loadCapabilities, clearCapabilities, loadProfiles, deleteProfile` from the `storage.js` import and add:

```js
import {
  listResolvedConnections, loadCredentialRecords, deleteConnectionRecord,
  clearAllConnectionCapabilities, defaultCapabilities,
} from '../lib/connections.js';
```

In `load` (`:82,85`), replace the two lines:

```js
    const profiles = listResolvedConnections();
    const { credentials } = loadCredentialRecords();
```

```js
    const caps = profiles.length ? profiles[0].capabilities || defaultCapabilities() : defaultCapabilities();
```

and add `credentials` to the `setData` call (`:95`):

```js
    setData({ creds, secret, profiles, credentials, log, resume, caps, active, settings });
```

In `act` (`:123`):

```js
    else if (action === 'caps')     clearAllConnectionCapabilities();
```

At `:360`, replace the capabilities `StoreLoc` line so the inspector names where capability state actually lives:

```jsx
                <StoreLoc>per connection in <KeyName name="s3b_connections" /> (JSON) · localStorage · values: <KeyName name="'unknown' | 'permitted' | 'denied'" /></StoreLoc>
```

At `:196`, replace the profiles `StoreLoc` so it names the records the data now comes from:

```jsx
                <StoreLoc>localStorage · <KeyName name="s3b_connections" /> (JSON array) · <KeyName name="s3b_credentials" /> ({data.credentials.length} stored) · <KeyName name="s3b_last_profile_id" /> (selected)</StoreLoc>
```

At `:219`, the per-row delete button still calls the legacy `deleteProfile`, which would remove a row from `s3b_profiles` while leaving the connection in place — the row would reappear on reload. Point it at the connection record:

```jsx
                              onClick={async () => { deleteConnectionRecord(p.id); await load(); }}
```

Leave the delete-all `ConfirmDialog` at `:227-229` alone for now. It calls `act('profiles')` → `deleteAllProfiles()`, which does not widen to cover credentials until Task 7; its warning text is updated there, alongside the behaviour change it describes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:ui`
Expected: PASS.

Run: `npm test`
Expected: PASS. `package.json` and `CHANGELOG.md` are untouched in this task, so they still agree and the build's changelog assertion holds.

- [ ] **Step 5: Commit**

```bash
git add src/components/StorageModal.jsx test/components/storage-modal.test.jsx
git commit -m "refactor: storage inspector reads the connection model"
```

---

## Definition of done

- `npm test` and `npm run test:ui` both pass.
- A pre-upgrade `s3b_profiles` record with two profiles sharing one key migrates to one credential and two connections, verified manually in the browser.
- The profile picker, connect, disconnect, save, and delete flows behave exactly as before the change.
- `s3b_capabilities` is no longer written by any code path, and `wipeAllAppData()` removes both new keys.
- `CHANGELOG.md` and `package.json` agree at `1.39.0`.
