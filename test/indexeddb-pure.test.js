import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage before importing the module.
// The tab-conflict functions read/write localStorage at call time, not import time.
const store = {};
global.localStorage = {
  getItem:  key      => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
  setItem:  (key, v) => { store[key] = String(v); },
  removeItem: key    => { delete store[key]; },
};

import {
  buildFileIdentity,
  fileIdentityMatches,
  markUploadActive,
  markUploadInactive,
  isUploadActiveElsewhere,
  uploadExpiryWarningMs,
} from '../src/lib/indexeddb.js';

const ACTIVE_KEY = 's3b_active_uploads';

// ── buildFileIdentity ─────────────────────────────────────────────────────────

describe('buildFileIdentity', () => {
  test('returns name, size, and lastModified from a File-like object', () => {
    const file = { name: 'photo.jpg', size: 204800, lastModified: 1700000000000 };
    assert.deepEqual(buildFileIdentity(file), {
      name: 'photo.jpg', size: 204800, lastModified: 1700000000000,
    });
  });

  test('does not include extraneous fields', () => {
    const file = { name: 'doc.pdf', size: 1024, lastModified: 0, type: 'application/pdf', extra: 'x' };
    const id = buildFileIdentity(file);
    assert.ok(!Object.prototype.hasOwnProperty.call(id, 'type'));
    assert.ok(!Object.prototype.hasOwnProperty.call(id, 'extra'));
  });
});

// ── fileIdentityMatches ───────────────────────────────────────────────────────

describe('fileIdentityMatches', () => {
  const identity = { name: 'video.mp4', size: 1073741824, lastModified: 1700000000000 };

  test('returns true when all three fields match', () => {
    const file = { name: 'video.mp4', size: 1073741824, lastModified: 1700000000000 };
    assert.equal(fileIdentityMatches(identity, file), true);
  });

  test('returns false when name differs', () => {
    assert.equal(fileIdentityMatches(identity, { name: 'video2.mp4', size: 1073741824, lastModified: 1700000000000 }), false);
  });

  test('returns false when size differs', () => {
    assert.equal(fileIdentityMatches(identity, { name: 'video.mp4', size: 1073741825, lastModified: 1700000000000 }), false);
  });

  test('returns false when lastModified differs', () => {
    assert.equal(fileIdentityMatches(identity, { name: 'video.mp4', size: 1073741824, lastModified: 1700000000001 }), false);
  });
});

// ── uploadExpiryWarningMs (BUG-015) ──────────────────────────────────────────

describe('uploadExpiryWarningMs', () => {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  // BUG-015: B2 sessions never auto-expire; showing a warning would be incorrect.
  test('b2 returns null — sessions do not expire automatically', () => {
    assert.equal(uploadExpiryWarningMs('b2'), null);
  });

  test('r2 returns 7 days', () => {
    assert.equal(uploadExpiryWarningMs('r2'), SEVEN_DAYS);
  });

  test('generic returns 7 days (conservative default)', () => {
    assert.equal(uploadExpiryWarningMs('generic'), SEVEN_DAYS);
  });

  test('aws returns 7 days', () => {
    assert.equal(uploadExpiryWarningMs('aws'), SEVEN_DAYS);
  });
});

// ── Tab conflict detection ────────────────────────────────────────────────────

describe('markUploadActive / markUploadInactive / isUploadActiveElsewhere', () => {
  beforeEach(() => {
    // Clear the active-uploads entry before each test.
    delete store[ACTIVE_KEY];
  });

  test('isUploadActiveElsewhere is false when no entry exists', () => {
    assert.equal(isUploadActiveElsewhere('uploads/file.txt'), false);
  });

  test('isUploadActiveElsewhere is false after this tab marks the key active', () => {
    markUploadActive('uploads/file.txt');
    assert.equal(isUploadActiveElsewhere('uploads/file.txt'), false);
  });

  test('isUploadActiveElsewhere is true when a different tab ID is registered', () => {
    // Simulate another tab writing its own ID before this tab acts.
    store[ACTIVE_KEY] = JSON.stringify({ 'uploads/file.txt': 'other-tab-xyz' });
    assert.equal(isUploadActiveElsewhere('uploads/file.txt'), true);
  });

  test('markUploadActive overwrites another tab — this tab now owns the key', () => {
    store[ACTIVE_KEY] = JSON.stringify({ 'uploads/file.txt': 'other-tab-xyz' });
    markUploadActive('uploads/file.txt');
    assert.equal(isUploadActiveElsewhere('uploads/file.txt'), false);
  });

  test('markUploadInactive removes the key when this tab owns it', () => {
    markUploadActive('uploads/file.txt');
    markUploadInactive('uploads/file.txt');
    const active = JSON.parse(store[ACTIVE_KEY] || '{}');
    assert.equal(Object.prototype.hasOwnProperty.call(active, 'uploads/file.txt'), false);
  });

  test('markUploadInactive does not remove the key when owned by another tab', () => {
    store[ACTIVE_KEY] = JSON.stringify({ 'uploads/file.txt': 'other-tab-xyz' });
    markUploadInactive('uploads/file.txt');
    const active = JSON.parse(store[ACTIVE_KEY] || '{}');
    // Another tab's entry must remain untouched.
    assert.equal(active['uploads/file.txt'], 'other-tab-xyz');
  });

  test('multiple keys are tracked independently', () => {
    markUploadActive('a/one.mp4');
    store[ACTIVE_KEY] = JSON.stringify({
      ...JSON.parse(store[ACTIVE_KEY] || '{}'),
      'b/two.mp4': 'other-tab-xyz',
    });
    assert.equal(isUploadActiveElsewhere('a/one.mp4'), false);
    assert.equal(isUploadActiveElsewhere('b/two.mp4'), true);
  });

  test('markUploadInactive leaves other keys intact', () => {
    markUploadActive('uploads/a.txt');
    markUploadActive('uploads/b.txt');
    markUploadInactive('uploads/a.txt');
    const active = JSON.parse(store[ACTIVE_KEY] || '{}');
    assert.ok(!Object.prototype.hasOwnProperty.call(active, 'uploads/a.txt'));
    assert.ok( Object.prototype.hasOwnProperty.call(active, 'uploads/b.txt'));
  });
});
