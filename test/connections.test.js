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
  migrateProfilesToConnections, deleteAllConnectionData, hasMigratedConnections,
  defaultCapabilities, loadConnectionCapabilities, saveConnectionCapabilities, clearAllConnectionCapabilities,
  repairCredentialProviders,
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

  test('does not collide when a field contains an internal space', () => {
    const a = credentialFingerprint({ endpoint: 'a',   keyId: 'b c', provider: '', regionOverride: '' });
    const b = credentialFingerprint({ endpoint: 'a b', keyId: 'c',   provider: '', regionOverride: '' });
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

  test('a null profile does not stop the profiles after it from migrating', () => {
    writeProfiles([
      { id: 1, name: 'A', endpoint: 'e', bucket: 'b1', keyId: 'k1', provider: 'b2', regionOverride: '' },
      null,
      { id: 3, name: 'C', endpoint: 'e', bucket: 'b3', keyId: 'k1', provider: 'b2', regionOverride: '' },
    ]);
    migrateProfilesToConnections();
    assert.deepEqual(loadConnectionRecords().connections.map(c => c.id), [1, 3]);
  });

  test('a profile with a non-string endpoint is skipped, not fatal', () => {
    writeProfiles([
      { id: 1, name: 'A', endpoint: 42, bucket: 'b1', keyId: 'k1', provider: 'b2', regionOverride: '' },
      { id: 2, name: 'B', endpoint: 'e', bucket: 'b2', keyId: 'k1', provider: 'b2', regionOverride: '' },
    ]);
    migrateProfilesToConnections();
    assert.deepEqual(loadConnectionRecords().connections.map(c => c.id), [2]);
  });

  test('falls back to a generated name when the profile has none', () => {
    writeProfiles([{ id: 1, endpoint: 'e', bucket: 'photos', keyId: 'k1', provider: 'b2', regionOverride: '' }]);
    migrateProfilesToConnections();
    assert.equal(loadConnectionRecords().connections[0].name, 'Backblaze B2 — photos');
  });
});

// Whole-branch review (2026-07-26), Finding 1 — CRITICAL: migrateProfilesToConnections()
// used "connections.length > 0" as its already-migrated sentinel. deleteConnectionRecord
// can empty that list, and s3b_profiles is deliberately never deleted, so the next call
// saw an empty list, treated it as "not yet migrated," and rebuilt every deleted
// connection with its original id and name — deletes did not stick. This is a sequence
// bug: no single-function unit test of migrateProfilesToConnections or
// deleteConnectionRecord alone can see it.
describe('migrateProfilesToConnections — the sentinel survives deleting every connection (Finding 1)', () => {
  function writeProfiles(profiles) {
    ls['s3b_profiles'] = JSON.stringify({ version: 1, profiles });
  }

  test('migrate, delete every connection, migrate again: the deletions must stick', () => {
    writeProfiles([
      { id: 1, name: 'Photos',  endpoint: 'e', bucket: 'photos',  keyId: 'k1', provider: 'b2', regionOverride: '' },
      { id: 2, name: 'Backups', endpoint: 'e', bucket: 'backups', keyId: 'k2', provider: 'b2', regionOverride: '' },
    ]);

    migrateProfilesToConnections();
    assert.equal(loadConnectionRecords().connections.length, 2, 'sanity: migration created both connections');

    for (const { id } of loadConnectionRecords().connections) deleteConnectionRecord(id);
    assert.deepEqual(loadConnectionRecords().connections, [], 'sanity: both connections were deleted');

    migrateProfilesToConnections();
    assert.deepEqual(loadConnectionRecords().connections, [],
      'deleted connections must stay deleted — they must not be resurrected from s3b_profiles');
  });
});

// Finding 3 — IMPORTANT: deleteConnectionRecord only removed the connection row,
// leaving its credential (endpoint, key ID, provider, region) in s3b_credentials
// forever with no UI able to remove it — even though deleteCredentialRecord (built and
// tested in Task 1) already existed and refuses to delete a still-referenced credential.
describe('deleteConnectionRecord garbage-collects its credential (Finding 3)', () => {
  test('a credential shared by two connections survives until the last one is deleted', () => {
    const cred = findOrCreateCredential({ endpoint: 'e', keyId: 'k1', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'Photos (R/O)',   credentialId: cred.id, bucket: 'photos', capabilities: null });
    saveConnectionRecord({ id: 2, name: 'Photos (admin)', credentialId: cred.id, bucket: 'photos', capabilities: null });

    deleteConnectionRecord(1);
    assert.ok(loadCredentialRecords().credentials.some(c => c.id === cred.id),
      'credential must survive while connection 2 still references it');

    deleteConnectionRecord(2);
    assert.ok(!loadCredentialRecords().credentials.some(c => c.id === cred.id),
      'credential must be removed once nothing references it any more');
  });

  test('deleting a connection with no shared reference removes its credential outright', () => {
    const cred = findOrCreateCredential({ endpoint: 'e', keyId: 'k1', provider: 'b2', regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'Photos', credentialId: cred.id, bucket: 'photos', capabilities: null });
    deleteConnectionRecord(1);
    assert.deepEqual(loadCredentialRecords().credentials, []);
  });
});

// Finding 1, critical detail — the migration marker must be one of the keys a wipe
// removes, or migration can never run again for that user. This does not reproduce a
// bug in the pre-fix code (which has no marker concept at all, so this passes
// trivially against it); it guards the specific hazard the fix introduces: forgetting
// to register the new key wherever CONNECTION_STORAGE_KEYS is enumerated.
describe('wiping connection data clears the migration marker', () => {
  test('deleteAllConnectionData clears the marker so migration can run again', () => {
    ls['s3b_profiles'] = JSON.stringify({
      version: 1,
      profiles: [{ id: 1, name: 'Photos', endpoint: 'e', bucket: 'photos', keyId: 'k1', provider: 'b2', regionOverride: '' }],
    });
    migrateProfilesToConnections();
    assert.equal(loadConnectionRecords().connections.length, 1, 'sanity: migration ran once');

    deleteAllConnectionData();
    assert.deepEqual(loadConnectionRecords().connections, [], 'sanity: wipe cleared connections');
    assert.deepEqual(loadCredentialRecords().credentials, [], 'sanity: wipe cleared credentials');

    migrateProfilesToConnections();
    assert.equal(loadConnectionRecords().connections.length, 1,
      'migration must be able to run again after a wipe — the marker must not survive deleteAllConnectionData');
  });
});

// Round 4 of the whole-branch review's Finding A: hasMigratedConnections() had no
// direct unit test at all through three rounds of a failing predicate. Covers both
// arms independently, plus the raw-vs-resolved distinction the reviewer asked to
// have characterized explicitly.
describe('hasMigratedConnections', () => {
  test('true when the marker is set, even with zero connections', () => {
    ls['s3b_connections_migrated'] = '1';
    assert.equal(loadConnectionRecords().connections.length, 0, 'sanity: no connections exist');
    assert.equal(hasMigratedConnections(), true);
  });

  test('true when a connection exists, even with the marker absent', () => {
    const cred = findOrCreateCredential({ endpoint: 'e', keyId: 'k', provider: null, regionOverride: '' });
    saveConnectionRecord({ id: 1, name: 'A', credentialId: cred.id, bucket: 'b', capabilities: null });
    // saveConnectionRecord() itself now sets the marker as its primary effect (the
    // round-4 fix) — clear it here to isolate the fallback arm being tested, i.e.
    // to simulate a connection written by a build that predates that fix.
    delete ls['s3b_connections_migrated'];
    assert.equal(hasMigratedConnections(), true);
  });

  test('false when neither the marker nor any connection exists', () => {
    assert.equal(hasMigratedConnections(), false);
  });

  // resolveConnection()/listResolvedConnections() drop a connection whose
  // credentialId does not resolve (see "returns null when the credential is
  // orphaned" above) — but hasMigratedConnections() reads the raw connection
  // list, so an orphaned connection still counts here. I believe this is the
  // correct behaviour, not an oversight: the raw record's mere presence is
  // evidence the user was on the connection model at some point, and letting the
  // legacy flat-key chain run because the *resolved* view is empty would layer a
  // phantom profile on top of already-corrupt data instead of leaving it alone.
  test('an orphaned connection (unresolvable credentialId) still counts, though the resolved view drops it', () => {
    saveConnectionRecord({ id: 1, name: 'Orphan', credentialId: 'missing', bucket: 'b', capabilities: null });
    delete ls['s3b_connections_migrated']; // isolate the fallback arm, as above
    assert.equal(listResolvedConnections().length, 0, 'sanity: the resolved view filters the orphan out');
    assert.equal(hasMigratedConnections(), true, 'the raw connection record still counts for this predicate');
  });
});

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

// repairCredentialProviders takes the validity rule as a parameter rather than
// importing it — the rule (isValidProvider) lives in storage.js, so this keeps
// it encoded in exactly one place. Tests here stand in a minimal equivalent.
describe('repairCredentialProviders', () => {
  const isValidProvider = p => typeof p === 'string' && p.length <= 20 && !/\s/.test(p);

  test('clears provider fields that fail the validity check', () => {
    saveCredentialRecord({ id: 'c1', provider: 'b2Key ID: 000a8794834eb7c000000001cSecret Key: abc', endpoint: 'e', keyId: 'k' });
    repairCredentialProviders(isValidProvider);
    assert.equal(loadCredentialRecords().credentials[0].provider, null);
  });

  test('leaves valid providers untouched', () => {
    saveCredentialRecord({ id: 'c1', provider: 'b2', endpoint: 'e', keyId: 'k' });
    repairCredentialProviders(isValidProvider);
    assert.equal(loadCredentialRecords().credentials[0].provider, 'b2');
  });

  test('is a no-op when there are no credentials', () => {
    repairCredentialProviders(isValidProvider); // should not throw
    assert.deepEqual(loadCredentialRecords().credentials, []);
  });
});

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
