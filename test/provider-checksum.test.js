// Tests for the opportunistic provider-checksum adapters (duplicate detection).
//
// Provider checksums are inconsistent across S3-compatible services, so an adapter is a
// strict bonus, never a dependency. It must accept a checksum ONLY in an exact, known-good
// full-object shape, fall back to null otherwise (so detection drops to byte-for-byte
// verification), and fail LOUD on genuinely unexpected shapes/errors so they can be
// reported and the adapter refined. It must never throw into the scan.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { providerChecksumAdapter, parseAwsChecksum, awsAdapter } from '../src/lib/provider-checksum.js';
import { PROVIDERS } from '../src/lib/provider.js';

function capture() {
  const warnings = [];
  return { warn: (info) => warnings.push(info), warnings };
}

describe('providerChecksumAdapter', () => {
  test('returns an adapter for AWS only', () => {
    assert.equal(typeof providerChecksumAdapter(PROVIDERS.AWS), 'function');
  });

  test('returns null for providers without a confirmed adapter', () => {
    assert.equal(providerChecksumAdapter(PROVIDERS.R2), null);
    assert.equal(providerChecksumAdapter(PROVIDERS.WASABI), null);
    assert.equal(providerChecksumAdapter('something-else'), null);
  });
});

describe('parseAwsChecksum — strict acceptance', () => {
  test('accepts a FULL_OBJECT CRC64NVME checksum', () => {
    const { warn, warnings } = capture();
    const sig = parseAwsChecksum({ Checksum: { ChecksumCRC64NVME: 'uWdU3w7C/Yo=', ChecksumType: 'FULL_OBJECT' } }, { warn });
    assert.equal(sig, 'crc64nvme:uWdU3w7C/Yo=');
    assert.equal(warnings.length, 0);
  });

  test('accepts a FULL_OBJECT SHA256 checksum', () => {
    const sig = parseAwsChecksum({ Checksum: { ChecksumSHA256: 'abc123=', ChecksumType: 'FULL_OBJECT' } }, capture());
    assert.equal(sig, 'sha256:abc123=');
  });
});

describe('parseAwsChecksum — silent fall-through (routine, not unexpected)', () => {
  test('no checksum present → null, no warning', () => {
    const { warn, warnings } = capture();
    assert.equal(parseAwsChecksum({}, { warn }), null);
    assert.equal(parseAwsChecksum({ Checksum: undefined }, { warn }), null);
    assert.equal(warnings.length, 0);
  });

  test('COMPOSITE checksum (part-size dependent, not comparable) → null, no warning', () => {
    const { warn, warnings } = capture();
    const sig = parseAwsChecksum({ Checksum: { ChecksumSHA256: 'x', ChecksumType: 'COMPOSITE' } }, { warn });
    assert.equal(sig, null);
    assert.equal(warnings.length, 0);
  });
});

describe('parseAwsChecksum — fail loud on unexpected shapes', () => {
  test('FULL_OBJECT but no recognized algorithm → null + warning', () => {
    const { warn, warnings } = capture();
    assert.equal(parseAwsChecksum({ Checksum: { ChecksumType: 'FULL_OBJECT' } }, { warn, key: 'k' }), null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].provider, 'aws');
    assert.equal(warnings[0].key, 'k');
  });

  test('empty checksum value → null + warning', () => {
    const { warn, warnings } = capture();
    assert.equal(parseAwsChecksum({ Checksum: { ChecksumCRC32: '', ChecksumType: 'FULL_OBJECT' } }, { warn }), null);
    assert.equal(warnings.length, 1);
  });
});

describe('awsAdapter — integration', () => {
  test('returns the normalized signature from GetObjectAttributes', async () => {
    const client = { send: () => Promise.resolve({ Checksum: { ChecksumCRC64NVME: 'AAA=', ChecksumType: 'FULL_OBJECT' } }) };
    assert.equal(await awsAdapter(client, 'bk', 'k', {}), 'crc64nvme:AAA=');
  });

  test('on error returns null and warns — never throws into the scan', async () => {
    const { warn, warnings } = capture();
    const client = { send: () => Promise.reject(new Error('NotImplemented')) };
    const sig = await awsAdapter(client, 'bk', 'k', {}, { warn });
    assert.equal(sig, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].op, 'GetObjectAttributes');
  });
});
