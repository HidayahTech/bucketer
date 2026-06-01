// Tests for credential and settings persistence (storage.js).
//
// storage.js accesses localStorage and sessionStorage as bare globals. We set
// up isolated in-memory stores before importing the module. The module reads
// them at call time (not import time), so the globals just need to be present
// on the global object before any function is invoked.

const ls = {};   // localStorage backing store
const ss = {};   // sessionStorage backing store

function makeStore(backing) {
  return {
    getItem:    k     => Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null,
    setItem:    (k,v) => { backing[k] = String(v); },
    removeItem: k     => { delete backing[k]; },
  };
}

global.localStorage   = makeStore(ls);
global.sessionStorage = makeStore(ss);

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCredentials, saveCredentials, clearCredentials,
  loadMaxKeys, saveMaxKeys,
  loadPartConcurrency, savePartConcurrency,
  loadPartSizeMB, savePartSizeMB,
  loadFileConcurrency, saveFileConcurrency,
  loadListingCacheTTL, saveListingCacheTTL,
  loadCapabilities, saveCapabilities, clearCapabilities,
  defaultCapabilities,
} from '../src/lib/storage.js';

// Clear both stores before each test to prevent cross-test contamination.
beforeEach(() => {
  for (const k of Object.keys(ls)) delete ls[k];
  for (const k of Object.keys(ss)) delete ss[k];
});

// ── Credentials ───────────────────────────────────────────────────────────────

describe('saveCredentials / loadCredentials', () => {
  const creds = {
    endpoint: 'https://s3.example.com',
    bucket: 'my-bucket',
    keyId: 'AKID123',
    secretKey: 'supersecret',
    provider: 'b2',
    regionOverride: 'us-west-1',
  };

  test('round-trips all credential fields', () => {
    saveCredentials(creds);
    const loaded = loadCredentials();
    assert.equal(loaded.endpoint,       creds.endpoint);
    assert.equal(loaded.bucket,         creds.bucket);
    assert.equal(loaded.keyId,          creds.keyId);
    assert.equal(loaded.secretKey,      creds.secretKey);
    assert.equal(loaded.provider,       creds.provider);
    assert.equal(loaded.regionOverride, creds.regionOverride);
  });

  // Security invariant: secret key must only go to sessionStorage, never localStorage.
  // If it went to localStorage it would persist across tab close and potentially be
  // written to disk by the browser.
  test('secretKey is stored in sessionStorage, not localStorage', () => {
    saveCredentials(creds);
    const lsValues = Object.values(ls).join(' ');
    assert.ok(!lsValues.includes('supersecret'), 'secretKey must not appear in localStorage');
    assert.ok(Object.values(ss).some(v => v === 'supersecret'), 'secretKey must be in sessionStorage');
  });

  test('non-sensitive fields go to localStorage, not sessionStorage', () => {
    saveCredentials(creds);
    assert.ok(Object.values(ls).some(v => v === creds.endpoint), 'endpoint must be in localStorage');
    assert.ok(Object.values(ls).some(v => v === creds.keyId),    'keyId must be in localStorage');
  });

  test('returns empty strings for unset fields', () => {
    const loaded = loadCredentials();
    assert.equal(loaded.endpoint,  '');
    assert.equal(loaded.secretKey, '');
    assert.equal(loaded.keyId,     '');
  });

  test('provider returns null (not empty string) when not set', () => {
    assert.equal(loadCredentials().provider, null);
  });

  test('provider returns null when saved as empty', () => {
    saveCredentials({ ...creds, provider: '' });
    assert.equal(loadCredentials().provider, null);
  });
});

describe('clearCredentials', () => {
  test('removes all fields from both stores', () => {
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: 'r2', regionOverride: '' });
    clearCredentials();
    const loaded = loadCredentials();
    assert.equal(loaded.endpoint,  '');
    assert.equal(loaded.secretKey, '');
    assert.equal(loaded.keyId,     '');
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe('saveMaxKeys / loadMaxKeys', () => {
  test('round-trips a number', () => {
    saveMaxKeys(200);
    assert.equal(loadMaxKeys(), 200);
  });

  test('returns null when not set', () => {
    assert.equal(loadMaxKeys(), null);
  });
});

describe('savePartConcurrency / loadPartConcurrency', () => {
  test('round-trips a number', () => {
    savePartConcurrency(4);
    assert.equal(loadPartConcurrency(), 4);
  });

  test('returns null when not set', () => {
    assert.equal(loadPartConcurrency(), null);
  });
});

describe('savePartSizeMB / loadPartSizeMB', () => {
  test('round-trips a number', () => {
    savePartSizeMB(64);
    assert.equal(loadPartSizeMB(), 64);
  });

  test('returns null when not set', () => {
    assert.equal(loadPartSizeMB(), null);
  });
});

describe('saveFileConcurrency / loadFileConcurrency', () => {
  test('round-trips a number', () => {
    saveFileConcurrency(3);
    assert.equal(loadFileConcurrency(), 3);
  });

  test('returns null when not set', () => {
    assert.equal(loadFileConcurrency(), null);
  });
});

describe('saveListingCacheTTL / loadListingCacheTTL', () => {
  test('round-trips a non-zero number', () => {
    saveListingCacheTTL(120);
    assert.equal(loadListingCacheTTL(), 120);
  });

  // 0 is a valid value meaning "disable cache". It must not be treated as falsy.
  test('0 round-trips correctly — cache disabled', () => {
    saveListingCacheTTL(0);
    assert.equal(loadListingCacheTTL(), 0);
  });

  test('returns null when not set', () => {
    assert.equal(loadListingCacheTTL(), null);
  });
});

// ── Capabilities ──────────────────────────────────────────────────────────────

describe('defaultCapabilities', () => {
  test('all four operations start as unknown', () => {
    const caps = defaultCapabilities();
    assert.equal(caps.list,     'unknown');
    assert.equal(caps.download, 'unknown');
    assert.equal(caps.upload,   'unknown');
    assert.equal(caps.delete,   'unknown');
  });
});

describe('saveCapabilities / loadCapabilities', () => {
  test('round-trips a capabilities object', () => {
    const caps = { list: 'unknown', download: 'denied', upload: 'unknown', delete: 'denied' };
    saveCapabilities(caps);
    assert.deepEqual(loadCapabilities(), caps);
  });

  test('returns default capabilities when not set', () => {
    assert.deepEqual(loadCapabilities(), defaultCapabilities());
  });

  test('returns default capabilities when stored value is corrupted JSON', () => {
    ls['s3b_capabilities'] = '{bad json';
    assert.deepEqual(loadCapabilities(), defaultCapabilities());
  });
});

describe('clearCapabilities', () => {
  test('resets to defaults after clear', () => {
    saveCapabilities({ list: 'denied', download: 'denied', upload: 'denied', delete: 'denied' });
    clearCapabilities();
    assert.deepEqual(loadCapabilities(), defaultCapabilities());
  });
});
