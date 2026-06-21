// #13 — presigned preview/share GETs must disable browser caching of the
// signed, content-bearing response (ResponseCacheControl: no-store), so the
// bytes don't linger in the HTTP disk cache after the presigned URL expires.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presignGetParams } from '../src/lib/presign-params.js';

describe('presignGetParams (#13)', () => {
  test('defaults ResponseCacheControl to no-store', () => {
    const p = presignGetParams({ Bucket: 'b', Key: 'k' });
    assert.equal(p.ResponseCacheControl, 'no-store');
  });

  test('preserves Bucket, Key, and disposition / content-type fields', () => {
    const p = presignGetParams({
      Bucket: 'b', Key: 'k',
      ResponseContentDisposition: 'inline',
      ResponseContentType: 'text/plain; charset=utf-8',
    });
    assert.equal(p.Bucket, 'b');
    assert.equal(p.Key, 'k');
    assert.equal(p.ResponseContentDisposition, 'inline');
    assert.equal(p.ResponseContentType, 'text/plain; charset=utf-8');
    assert.equal(p.ResponseCacheControl, 'no-store');
  });

  test('an explicit ResponseCacheControl in params overrides the default', () => {
    const p = presignGetParams({ Bucket: 'b', Key: 'k', ResponseCacheControl: 'max-age=0' });
    assert.equal(p.ResponseCacheControl, 'max-age=0');
  });
});
