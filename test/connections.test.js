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
  credentialFingerprint, findOrCreateCredential, defaultCredentialLabel,
  defaultConnectionName, resolveConnection, listResolvedConnections,
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
    assert.equal(cred.label, 'Backblaze B2 — k1');
  });

  test('respects an explicit label', () => {
    const cred = findOrCreateCredential({ ...fields, label: 'Work account' });
    assert.equal(cred.label, 'Work account');
  });
});

describe('defaultCredentialLabel', () => {
  test('truncates long key IDs to six characters', () => {
    assert.equal(defaultCredentialLabel({ provider: 'b2', keyId: '0057abcdef0123456789' }), 'Backblaze B2 — 0057ab…');
  });

  test('keeps short key IDs whole', () => {
    assert.equal(defaultCredentialLabel({ provider: 'b2', keyId: 'k1' }), 'Backblaze B2 — k1');
  });

  test('falls back to the key ID alone when the provider is unknown', () => {
    assert.equal(defaultCredentialLabel({ provider: null, keyId: 'k1' }), 'k1');
  });
});

describe('defaultConnectionName', () => {
  test('combines provider and bucket', () => {
    assert.equal(defaultConnectionName({ provider: 'b2', bucket: 'photos' }), 'Backblaze B2 — photos');
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
