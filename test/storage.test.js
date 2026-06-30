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
  repairStorageInvariants,
  loadCredentials, saveCredentials, clearCredentials,
  loadMaxKeys, saveMaxKeys,
  loadPartConcurrency, savePartConcurrency,
  loadPartSizeMB, savePartSizeMB,
  loadUploadMemoryMB, saveUploadMemoryMB,
  loadFileConcurrency, saveFileConcurrency,
  loadListingCacheTTL, saveListingCacheTTL,
  loadCapabilities, saveCapabilities, clearCapabilities,
  defaultCapabilities,
  loadProfiles, saveProfile, deleteProfile,
  loadLastProfileId, saveLastProfileId,
  migrateProfilesFromLegacy,
  loadAdaptiveMode, saveAdaptiveMode,
  loadFileMtimeAutoLoad, saveFileMtimeAutoLoad,
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
  test('removes all credential fields from both stores', () => {
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: 'r2', regionOverride: '' });
    clearCredentials();
    const loaded = loadCredentials();
    assert.equal(loaded.endpoint,  '');
    assert.equal(loaded.secretKey, '');
    assert.equal(loaded.keyId,     '');
  });

  // T2-1: clearCredentials must not wipe settings. A user who clicks "Disconnect"
  // should not silently lose their partSize, concurrency, and other config preferences.
  test('does not erase settings keys (T2-1)', () => {
    savePartSizeMB(50);
    savePartConcurrency(8);
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: null, regionOverride: '' });
    clearCredentials();
    assert.equal(loadPartSizeMB(), 50,
      'clearCredentials must not wipe partSizeMB — user loses config on every disconnect');
    assert.equal(loadPartConcurrency(), 8,
      'clearCredentials must not wipe partConcurrency — user loses config on every disconnect');
  });
});

// ── Provider field validation (BUG-016) ───────────────────────────────────────

describe('saveCredentials — provider write-boundary validation', () => {
  test('writes a valid provider identifier normally', () => {
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: 'b2', regionOverride: '' });
    assert.equal(loadCredentials().provider, 'b2');
  });

  test('writes empty string when provider contains spaces (corrupted paste)', () => {
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: 'b2Key ID: abc Secret Key: xyz', regionOverride: '' });
    assert.equal(ls['s3b_provider'], '');
    assert.equal(loadCredentials().provider, null);
  });

  test('writes empty string when provider exceeds 20 chars', () => {
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: 'a_very_long_provider_identifier', regionOverride: '' });
    assert.equal(ls['s3b_provider'], '');
  });

  test('writes empty string for null/undefined provider', () => {
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: null, regionOverride: '' });
    assert.equal(ls['s3b_provider'], '');
  });
});

describe('loadCredentials — provider read-boundary validation', () => {
  test('returns null when stored provider contains spaces', () => {
    ls['s3b_provider'] = 'b2Key ID: 000a8794834eb7c000000001cSecret Key: [REDACTED]Use the above credentials to login.';
    assert.equal(loadCredentials().provider, null);
  });

  test('returns null when stored provider exceeds 20 chars', () => {
    ls['s3b_provider'] = 'this_provider_name_is_way_too_long';
    assert.equal(loadCredentials().provider, null);
  });

  test('returns the provider when it is a valid short identifier', () => {
    ls['s3b_provider'] = 'do_spaces';
    assert.equal(loadCredentials().provider, 'do_spaces');
  });

  test('returns null when provider is empty', () => {
    ls['s3b_provider'] = '';
    assert.equal(loadCredentials().provider, null);
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

describe('saveUploadMemoryMB / loadUploadMemoryMB', () => {
  test('round-trips a number', () => {
    saveUploadMemoryMB(2048);
    assert.equal(loadUploadMemoryMB(), 2048);
  });

  test('returns null when not set (caller falls back to DEFAULT_UPLOAD_MEMORY_MB)', () => {
    assert.equal(loadUploadMemoryMB(), null);
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

// ── Profiles ──────────────────────────────────────────────────────────────────

describe('repairStorageInvariants', () => {
  test('clears corrupted s3b_provider (contains spaces)', () => {
    ls['s3b_provider'] = 'b2Key ID: 000a8794834eb7c000000001cSecret Key: abc123Use the above credentials to login.';
    repairStorageInvariants();
    assert.equal(safeGetLS('s3b_provider'), '');
  });

  test('leaves valid provider untouched', () => {
    ls['s3b_provider'] = 'b2';
    repairStorageInvariants();
    assert.equal(ls['s3b_provider'], 'b2');
  });

  test('is a no-op when provider is empty', () => {
    repairStorageInvariants(); // should not throw
    assert.ok(!Object.prototype.hasOwnProperty.call(ls, 's3b_provider'));
  });

  test('repairs corrupted provider field inside a stored profile', () => {
    saveProfile({ id: 1, name: 'B2KEY ID: CORRUPTED — my-bucket', endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: 'k', provider: 'b2Key ID: 000a8794834eb7c000000001cSecret Key: abc', regionOverride: '' });
    repairStorageInvariants();
    const { profiles } = loadProfiles();
    assert.equal(profiles[0].provider, null);
    assert.equal(profiles[0].name, 'my-bucket');
  });

  test('leaves profiles with valid provider untouched', () => {
    saveProfile({ id: 1, name: 'B2 — my-bucket', endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: 'k', provider: 'b2', regionOverride: '' });
    repairStorageInvariants();
    const { profiles } = loadProfiles();
    assert.equal(profiles[0].provider, 'b2');
    assert.equal(profiles[0].name, 'B2 — my-bucket');
  });

  test('is idempotent — running twice produces the same result', () => {
    ls['s3b_provider'] = 'b2Key ID: corrupted data here';
    repairStorageInvariants();
    repairStorageInvariants();
    assert.equal(safeGetLS('s3b_provider'), '');
  });
});

// Helper visible only to this describe block
function safeGetLS(key) {
  return Object.prototype.hasOwnProperty.call(ls, key) ? ls[key] : '';
}

describe('loadProfiles', () => {
  test('returns empty profiles array when nothing stored', () => {
    const data = loadProfiles();
    assert.deepEqual(data.profiles, []);
    assert.equal(data.version, 1);
  });

  test('returns safe defaults on corrupt JSON', () => {
    ls['s3b_profiles'] = '{bad json';
    const data = loadProfiles();
    assert.deepEqual(data.profiles, []);
  });

  test('returns safe defaults when profiles field is missing', () => {
    ls['s3b_profiles'] = JSON.stringify({ version: 1 });
    const data = loadProfiles();
    assert.deepEqual(data.profiles, []);
  });
});

describe('saveProfile / loadProfiles (upsert)', () => {
  const profile = { id: 1000, name: 'B2 — test', endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', provider: 'b2', regionOverride: '' };

  test('appends a new profile', () => {
    saveProfile(profile);
    const { profiles } = loadProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, 1000);
    assert.equal(profiles[0].name, 'B2 — test');
  });

  test('updates existing profile by id', () => {
    saveProfile(profile);
    saveProfile({ ...profile, name: 'Updated name' });
    const { profiles } = loadProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, 'Updated name');
  });

  test('preserves unknown fields on round-trip', () => {
    ls['s3b_profiles'] = JSON.stringify({ version: 1, profiles: [{ ...profile, futureField: 'keep-me' }] });
    saveProfile({ ...profile, name: 'Updated' });
    const { profiles } = loadProfiles();
    assert.equal(profiles[0].futureField, 'keep-me');
  });

  test('secret key is never stored in profiles', () => {
    saveProfile({ ...profile, secretKey: 'should-not-persist' });
    const raw = ls['s3b_profiles'];
    assert.ok(!raw.includes('should-not-persist'));
  });
});

describe('deleteProfile', () => {
  test('removes the profile by id', () => {
    saveProfile({ id: 1, name: 'A', endpoint: '', bucket: '', keyId: '', provider: null, regionOverride: '' });
    saveProfile({ id: 2, name: 'B', endpoint: '', bucket: '', keyId: '', provider: null, regionOverride: '' });
    deleteProfile(1);
    const { profiles } = loadProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, 2);
  });

  test('no-op when id does not exist', () => {
    saveProfile({ id: 1, name: 'A', endpoint: '', bucket: '', keyId: '', provider: null, regionOverride: '' });
    deleteProfile(999);
    assert.equal(loadProfiles().profiles.length, 1);
  });
});

describe('clearCredentials does not remove profiles', () => {
  test('profile data survives clearCredentials', () => {
    saveProfile({ id: 1, name: 'A', endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', provider: null, regionOverride: '' });
    saveCredentials({ endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'k', secretKey: 's', provider: null, regionOverride: '' });
    clearCredentials();
    const { profiles } = loadProfiles();
    assert.equal(profiles.length, 1, 'profiles must survive clearCredentials');
  });
});

describe('loadLastProfileId / saveLastProfileId', () => {
  test('round-trips a numeric id', () => {
    saveLastProfileId(42);
    assert.equal(loadLastProfileId(), 42);
  });

  test('returns null when not set', () => {
    assert.equal(loadLastProfileId(), null);
  });

  test('removes the key when saved as null', () => {
    saveLastProfileId(42);
    saveLastProfileId(null);
    assert.equal(loadLastProfileId(), null);
    assert.ok(!Object.prototype.hasOwnProperty.call(ls, 's3b_last_profile_id'));
  });
});

describe('migrateProfilesFromLegacy', () => {
  test('creates a profile from flat credential keys', () => {
    ls['s3b_endpoint']  = 'https://s3.example.com';
    ls['s3b_bucket']    = 'my-bucket';
    ls['s3b_key_id']    = 'AKID';
    ls['s3b_provider']  = 'b2';
    migrateProfilesFromLegacy();
    const { profiles } = loadProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].endpoint, 'https://s3.example.com');
    assert.equal(profiles[0].bucket, 'my-bucket');
    assert.equal(profiles[0].name, 'B2 — my-bucket');
  });

  test('is idempotent — does not create a second profile on re-run', () => {
    ls['s3b_endpoint'] = 'https://s3.example.com';
    ls['s3b_bucket']   = 'my-bucket';
    ls['s3b_key_id']   = 'AKID';
    migrateProfilesFromLegacy();
    migrateProfilesFromLegacy();
    assert.equal(loadProfiles().profiles.length, 1);
  });

  test('does nothing when no flat credentials exist', () => {
    migrateProfilesFromLegacy();
    assert.deepEqual(loadProfiles().profiles, []);
  });

  test('skips migration when bucket is longer than 63 chars (corrupted data)', () => {
    ls['s3b_endpoint'] = 'https://s3.example.com';
    ls['s3b_bucket']   = 'KEY ID: 000A8794834EB7C000000001CSECRET KEY: K000RH9J5DROULDCCJ1CK88TZPETN5QUSE THE ABOVE CREDENTIALS TO LOGIN.';
    ls['s3b_key_id']   = 'AKID';
    migrateProfilesFromLegacy();
    assert.deepEqual(loadProfiles().profiles, []);
  });

  test('does nothing when profiles already exist', () => {
    saveProfile({ id: 1, name: 'Existing', endpoint: 'x', bucket: 'b', keyId: 'k', provider: null, regionOverride: '' });
    ls['s3b_endpoint'] = 'https://s3.example.com';
    ls['s3b_bucket']   = 'my-bucket';
    ls['s3b_key_id']   = 'AKID';
    migrateProfilesFromLegacy();
    assert.equal(loadProfiles().profiles.length, 1);
    assert.equal(loadProfiles().profiles[0].name, 'Existing');
  });
});

describe('loadAdaptiveMode / saveAdaptiveMode', () => {
  test('defaults to true when no value is stored', () => {
    assert.equal(loadAdaptiveMode(), true);
  });

  test('returns false after saveAdaptiveMode(false)', () => {
    saveAdaptiveMode(false);
    assert.equal(loadAdaptiveMode(), false);
  });

  test('returns true after saveAdaptiveMode(true)', () => {
    saveAdaptiveMode(false);
    saveAdaptiveMode(true);
    assert.equal(loadAdaptiveMode(), true);
  });
});

describe('loadFileMtimeAutoLoad / saveFileMtimeAutoLoad', () => {
  test('defaults to false when no value is stored', () => {
    assert.equal(loadFileMtimeAutoLoad(), false);
  });

  test('returns true after saveFileMtimeAutoLoad(true)', () => {
    saveFileMtimeAutoLoad(true);
    assert.equal(loadFileMtimeAutoLoad(), true);
  });

  test('returns false after saveFileMtimeAutoLoad(false)', () => {
    saveFileMtimeAutoLoad(true);
    saveFileMtimeAutoLoad(false);
    assert.equal(loadFileMtimeAutoLoad(), false);
  });
});

import { loadThemePref, saveThemePref } from '../src/lib/storage.js';

describe('loadThemePref / saveThemePref (#14)', () => {
  beforeEach(() => { delete ls['s3b_theme']; });

  test('defaults to system when unset', () => {
    assert.equal(loadThemePref(), 'system');
  });

  test('round-trips a saved preference', () => {
    saveThemePref('dark');
    assert.equal(loadThemePref(), 'dark');
    saveThemePref('light');
    assert.equal(loadThemePref(), 'light');
  });

  test('an invalid stored value falls back to system', () => {
    ls['s3b_theme'] = 'neon';
    assert.equal(loadThemePref(), 'system');
  });

  test('saving an invalid preference stores system', () => {
    saveThemePref('neon');
    assert.equal(loadThemePref(), 'system');
  });
});
