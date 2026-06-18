// Tests for the Bucketer content-hash stamp value codec (duplicate detection).
//
// The stamp is written to object metadata as x-amz-meta-bucketer-content-hash with a
// self-describing value "<scheme>:<hex>". The scheme encodes algorithm + method so
// future schemes never cross-match, and an unknown/malformed value is rejected (null)
// rather than silently accepted — the dedup engine treats null as "no stamp signal".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildContentHashValue, parseContentHash } from '../src/lib/content-hash.js';

// A valid 64-char lowercase hex SHA-256 digest.
const HEX = 'a'.repeat(64);

describe('buildContentHashValue', () => {
  test('prefixes the current scheme', () => {
    assert.equal(buildContentHashValue(HEX), `sha256-ht64k:${HEX}`);
  });

  test('returns null when no hash is available (omit the stamp)', () => {
    assert.equal(buildContentHashValue(null), null);
    assert.equal(buildContentHashValue(undefined), null);
    assert.equal(buildContentHashValue(''), null);
  });
});

describe('parseContentHash', () => {
  test('parses a well-formed known-scheme value', () => {
    assert.deepEqual(parseContentHash(`sha256-ht64k:${HEX}`), { scheme: 'sha256-ht64k', hex: HEX });
  });

  test('rejects an unknown scheme (do not silently accept)', () => {
    assert.equal(parseContentHash(`sha256-full:${HEX}`), null);
    assert.equal(parseContentHash(`md5:${HEX}`), null);
  });

  test('rejects malformed hex (wrong length or non-hex chars)', () => {
    assert.equal(parseContentHash('sha256-ht64k:abc'), null);
    assert.equal(parseContentHash(`sha256-ht64k:${'g'.repeat(64)}`), null);
    assert.equal(parseContentHash(`sha256-ht64k:${'A'.repeat(64)}`), null); // uppercase not emitted
  });

  test('rejects non-string / missing separator', () => {
    assert.equal(parseContentHash(null), null);
    assert.equal(parseContentHash(undefined), null);
    assert.equal(parseContentHash(42), null);
    assert.equal(parseContentHash('sha256-ht64k'), null);
    assert.equal(parseContentHash(''), null);
  });

  test('round-trips through buildContentHashValue', () => {
    const parsed = parseContentHash(buildContentHashValue(HEX));
    assert.equal(parsed.hex, HEX);
    assert.equal(parsed.scheme, 'sha256-ht64k');
  });
});
