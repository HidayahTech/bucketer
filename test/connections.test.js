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
