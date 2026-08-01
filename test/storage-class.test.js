// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isArchivedStorageClass } from '../src/lib/storage-class.js';
import { PROVIDERS } from '../src/lib/provider.js';

describe('isArchivedStorageClass', () => {
  test('flags GLACIER on AWS', () => {
    assert.equal(isArchivedStorageClass('GLACIER', PROVIDERS.AWS), true);
  });

  test('flags DEEP_ARCHIVE on AWS', () => {
    assert.equal(isArchivedStorageClass('DEEP_ARCHIVE', PROVIDERS.AWS), true);
  });

  // GLACIER_IR serves GETs directly — flagging it would refuse downloads that work.
  test('does NOT flag GLACIER_IR: instant retrieval serves a GET like any other class', () => {
    assert.equal(isArchivedStorageClass('GLACIER_IR', PROVIDERS.AWS), false);
  });

  // AWS reports the class as INTELLIGENT_TIERING whatever the internal tier, so the listing
  // cannot tell a readable object from an archived one. Guessing either way is wrong.
  test('does NOT flag INTELLIGENT_TIERING: the listing cannot tell readable from archived', () => {
    assert.equal(isArchivedStorageClass('INTELLIGENT_TIERING', PROVIDERS.AWS), false);
  });

  test('does not flag STANDARD', () => {
    assert.equal(isArchivedStorageClass('STANDARD', PROVIDERS.AWS), false);
  });

  // No other provider has a tier where a GET fails, and several reuse AWS class names.
  test('flags nothing on non-AWS providers, even for a GLACIER-named class', () => {
    for (const p of [PROVIDERS.R2, PROVIDERS.B2, PROVIDERS.WASABI, PROVIDERS.MINIO, PROVIDERS.GENERIC]) {
      assert.equal(isArchivedStorageClass('GLACIER', p), false, `${p} must not be flagged`);
    }
  });

  // Jobs enumerated before the provider was recorded have no provider. Degrading to
  // "flag nothing" keeps them downloadable; guessing AWS would refuse real files.
  test('flags nothing when the provider is unknown', () => {
    assert.equal(isArchivedStorageClass('GLACIER', undefined), false);
    assert.equal(isArchivedStorageClass('GLACIER', null), false);
    assert.equal(isArchivedStorageClass('GLACIER', ''), false);
  });

  test('handles a missing storage class', () => {
    assert.equal(isArchivedStorageClass(undefined, PROVIDERS.AWS), false);
    assert.equal(isArchivedStorageClass(null, PROVIDERS.AWS), false);
  });
});
