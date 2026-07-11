import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateObjectName } from '../src/lib/validate-object-name.js';

describe('validateObjectName', () => {
  test('returns null for a valid name', () => {
    assert.equal(validateObjectName('file.txt'), null);
    assert.equal(validateObjectName('my-photo'), null);
    assert.equal(validateObjectName('archive.tar.gz'), null);
    assert.equal(validateObjectName('report 2026'), null);
  });

  test('returns a non-empty string error for empty string', () => {
    const err = validateObjectName('');
    assert.ok(err, 'should return an error');
    assert.equal(typeof err, 'string');
  });

  test('returns an error for whitespace-only string', () => {
    assert.ok(validateObjectName('   '));
    assert.ok(validateObjectName('\t'));
  });

  test('returns an error for a name containing a slash', () => {
    assert.ok(validateObjectName('foo/bar'));
    assert.ok(validateObjectName('/leadingslash'));
    assert.ok(validateObjectName('trailing/'));
  });

  test('returns an error for null or undefined', () => {
    assert.ok(validateObjectName(null));
    assert.ok(validateObjectName(undefined));
  });

  test('rename and folder-create use the same rules (no divergence)', () => {
    // Both code sites must call this function — this test documents that the
    // rules are shared. The source-invariants test confirms both import it.
    const validCases = ['file.txt', 'my folder', 'archive'];
    for (const name of validCases) {
      assert.equal(validateObjectName(name), null, `'${name}' should be valid`);
    }
  });

  // Security hardening: reject a name that is exactly '.' or '..' (a degenerate path
  // segment). S3 keys are opaque strings so this is NOT a filesystem traversal, but a
  // folder/file literally named '.' or '..' produces confusing keys. Names that merely
  // CONTAIN '..' (e.g. 'report..final.pdf') are legitimate and MUST stay valid.
  test('rejects a name that is exactly "." or ".."', () => {
    assert.ok(validateObjectName('.'), '"." must be rejected');
    assert.ok(validateObjectName('..'), '".." must be rejected');
    assert.ok(validateObjectName('  ..  '), 'trimmed ".." must be rejected');
  });

  test('allows legitimate names that merely contain ".." or dots', () => {
    assert.equal(validateObjectName('report..final.pdf'), null);
    assert.equal(validateObjectName('v1..2.txt'), null);
    assert.equal(validateObjectName('file.txt'), null);
    assert.equal(validateObjectName('...leading'), null);
  });
});
