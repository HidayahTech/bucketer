// Tests for the upload object-metadata builder. Every upload stamps the original file
// mtime (existing behavior) and, when a content hash is available, Bucketer's content-hash
// stamp (new — a cheap candidate filter for duplicate detection). The hash key is omitted
// entirely when no hash could be computed (e.g. SubtleCrypto unavailable), since S3 custom
// metadata values must be strings.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildUploadMetadata } from '../src/lib/upload-metadata.js';

const file = { name: 'x.bin', size: 10, lastModified: Date.UTC(2026, 0, 2, 3, 4, 5) };

describe('buildUploadMetadata', () => {
  test('always stamps the file mtime as ISO 8601', () => {
    const meta = buildUploadMetadata(file, null);
    assert.equal(meta['file-mtime'], '2026-01-02T03:04:05.000Z');
  });

  test('adds the content-hash stamp when a value is provided', () => {
    const v = 'sha256-ht64k:' + 'a'.repeat(64);
    const meta = buildUploadMetadata(file, v);
    assert.equal(meta['bucketer-content-hash'], v);
  });

  test('omits the content-hash key when no value is available', () => {
    for (const v of [null, undefined, '']) {
      const meta = buildUploadMetadata(file, v);
      assert.equal('bucketer-content-hash' in meta, false);
    }
  });
});
