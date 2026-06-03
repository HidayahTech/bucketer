// Tests for CredentialForm field validation (credentialErrors).
// credentialErrors is a pure function — no DOM required.
//
// The broader principle (BUG-016): machine-generated S3 credentials never
// contain spaces. A space in key ID, secret key, bucket, or region is
// unambiguous evidence of a paste accident and must block submission.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { credentialErrors, canSaveProfile } from '../src/lib/credential-validation.js';

const clean = { bucket: 'my-bucket', keyId: 'AKID123', secretKey: 'secret', regionOverride: '' };

describe('credentialErrors — bucket', () => {
  test('no error for a valid bucket name', () => {
    assert.equal(credentialErrors(clean).bucket, undefined);
  });

  test('error when bucket contains a space', () => {
    assert.ok(credentialErrors({ ...clean, bucket: 'my bucket' }).bucket);
  });

  test('error when bucket contains a tab', () => {
    assert.ok(credentialErrors({ ...clean, bucket: 'my\tbucket' }).bucket);
  });

  test('error when bucket exceeds 63 characters', () => {
    assert.ok(credentialErrors({ ...clean, bucket: 'a'.repeat(64) }).bucket);
  });

  test('no error for a 63-character bucket name', () => {
    assert.equal(credentialErrors({ ...clean, bucket: 'a'.repeat(63) }).bucket, undefined);
  });

  test('no error when bucket is empty (required handled elsewhere)', () => {
    assert.equal(credentialErrors({ ...clean, bucket: '' }).bucket, undefined);
  });
});

describe('credentialErrors — keyId', () => {
  test('no error for a valid key ID', () => {
    assert.equal(credentialErrors(clean).keyId, undefined);
  });

  test('error when key ID contains a space', () => {
    assert.ok(credentialErrors({ ...clean, keyId: 'AK ID 123' }).keyId);
  });

  test('error when key ID contains a newline', () => {
    assert.ok(credentialErrors({ ...clean, keyId: 'AKID\n123' }).keyId);
  });

  test('no error when key ID is empty', () => {
    assert.equal(credentialErrors({ ...clean, keyId: '' }).keyId, undefined);
  });
});

describe('credentialErrors — secretKey', () => {
  test('no error for a valid secret key', () => {
    assert.equal(credentialErrors(clean).secretKey, undefined);
  });

  test('error when secret key contains a space', () => {
    assert.ok(credentialErrors({ ...clean, secretKey: 'my secret key' }).secretKey);
  });

  test('no error when secret key is empty', () => {
    assert.equal(credentialErrors({ ...clean, secretKey: '' }).secretKey, undefined);
  });
});

describe('credentialErrors — regionOverride', () => {
  test('no error for a valid region', () => {
    assert.equal(credentialErrors({ ...clean, regionOverride: 'us-east-1' }).regionOverride, undefined);
  });

  test('error when region contains a space', () => {
    assert.ok(credentialErrors({ ...clean, regionOverride: 'us east 1' }).regionOverride);
  });

  test('no error when region is empty (field is optional)', () => {
    assert.equal(credentialErrors({ ...clean, regionOverride: '' }).regionOverride, undefined);
  });
});

describe('credentialErrors — clean form returns no errors', () => {
  test('empty errors object for fully valid input', () => {
    assert.deepEqual(credentialErrors(clean), {});
  });
});

const saveBase = { endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'my-bucket', keyId: 'AKID123' };

describe('canSaveProfile — valid input', () => {
  test('returns true for fully valid profile fields', () => {
    assert.equal(canSaveProfile(saveBase), true);
  });

  test('ignores secretKey — profiles never store it', () => {
    assert.equal(canSaveProfile({ ...saveBase, secretKey: '' }), true);
  });

  test('ignores provider and regionOverride — both are optional', () => {
    assert.equal(canSaveProfile({ ...saveBase, provider: '', regionOverride: '' }), true);
  });
});

describe('canSaveProfile — missing required fields', () => {
  test('returns false when endpoint is empty', () => {
    assert.equal(canSaveProfile({ ...saveBase, endpoint: '' }), false);
  });

  test('returns false when bucket is empty', () => {
    assert.equal(canSaveProfile({ ...saveBase, bucket: '' }), false);
  });

  test('returns false when keyId is empty', () => {
    assert.equal(canSaveProfile({ ...saveBase, keyId: '' }), false);
  });

  test('returns false for null/undefined formData', () => {
    assert.equal(canSaveProfile(null), false);
    assert.equal(canSaveProfile(undefined), false);
  });
});

describe('canSaveProfile — invalid endpoint', () => {
  test('returns false for endpoint without scheme', () => {
    assert.equal(canSaveProfile({ ...saveBase, endpoint: 's3.amazonaws.com' }), false);
  });

  test('returns false for completely malformed endpoint', () => {
    assert.equal(canSaveProfile({ ...saveBase, endpoint: 'not a url' }), false);
  });

  test('accepts http:// endpoints (non-TLS local/MinIO)', () => {
    assert.equal(canSaveProfile({ ...saveBase, endpoint: 'http://localhost:9000' }), true);
  });
});

describe('canSaveProfile — invalid bucket', () => {
  test('returns false when bucket contains a space', () => {
    assert.equal(canSaveProfile({ ...saveBase, bucket: 'my bucket' }), false);
  });

  test('returns false when bucket exceeds 63 characters', () => {
    assert.equal(canSaveProfile({ ...saveBase, bucket: 'a'.repeat(64) }), false);
  });
});

describe('canSaveProfile — invalid keyId', () => {
  test('returns false when key ID contains a space', () => {
    assert.equal(canSaveProfile({ ...saveBase, keyId: 'AK ID 123' }), false);
  });
});
