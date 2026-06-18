// Tests for the streaming byte-for-byte verifier (duplicate detection — the deletion
// gate). This is the certainty mechanism: it compares the actual content of objects,
// so it is immune to MD5/SHA-1/SHA-256 collision weaknesses that make hash matches
// unsafe as a deletion criterion. It must:
//   - report identical content regardless of how the byte sources are chunked,
//   - reject a single differing byte and a length mismatch,
//   - abort early (not over-read) once a candidate has diverged.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { streamsIdentical, verifyAgainstReference } from '../src/lib/verify-bytes.js';

const enc = new TextEncoder();
const b = (s) => enc.encode(s);

// An async iterable of Uint8Array chunks, mimicking a fetch body ReadableStream
// with arbitrary (possibly misaligned) chunk boundaries.
async function* src(...chunks) {
  for (const c of chunks) yield typeof c === 'string' ? b(c) : c;
}

describe('streamsIdentical', () => {
  test('identical content with different chunk boundaries → true', async () => {
    const a = src('hel', 'lo wor', 'ld');
    const c = src('hello', ' ', 'world');
    assert.equal(await streamsIdentical(a, c), true);
  });

  test('a single differing byte in the middle → false', async () => {
    const a = src('hello world');
    const c = src('hello Xorld');
    assert.equal(await streamsIdentical(a, c), false);
  });

  test('different lengths → false (both orderings)', async () => {
    assert.equal(await streamsIdentical(src('hello'), src('hello world')), false);
    assert.equal(await streamsIdentical(src('hello world'), src('hello')), false);
  });

  test('two empty streams → true', async () => {
    assert.equal(await streamsIdentical(src(), src()), true);
    assert.equal(await streamsIdentical(src(''), src('')), true);
  });

  test('aborts early — does not read past a first-chunk mismatch', async () => {
    async function* throwsAfterFirst() {
      yield b('AAA');
      throw new Error('verifier kept reading after a mismatch');
    }
    // First chunks already differ ('XYZ' vs 'AAA'), so the throwing second pull
    // must never happen.
    assert.equal(await streamsIdentical(src('XYZ'), throwsAfterFirst()), false);
  });
});

describe('verifyAgainstReference', () => {
  test('marks each candidate identical/different against the keeper', async () => {
    const reference = src('the quick brown fox');
    const candidates = [
      src('the quick', ' brown fox'), // identical, different boundaries
      src('the quick brown FOX'),     // differs near the end
      src('the quick brown fox'),     // identical
    ];
    assert.deepEqual(await verifyAgainstReference(reference, candidates), [true, false, true]);
  });

  test('a candidate that is a prefix of the keeper → false', async () => {
    assert.deepEqual(
      await verifyAgainstReference(src('abcdef'), [src('abc'), src('abcdef'), src('abcdefg')]),
      [false, true, false],
    );
  });
});
