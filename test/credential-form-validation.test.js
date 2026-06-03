// Tests for CredentialForm field validation (credentialErrors).
// credentialErrors is a pure function — no DOM required.
//
// The broader principle (BUG-016): machine-generated S3 credentials never
// contain spaces. A space in key ID, secret key, bucket, or region is
// unambiguous evidence of a paste accident and must block submission.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { credentialErrors } from '../src/lib/credential-validation.js';

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
