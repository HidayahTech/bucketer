import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatSpeed, formatEta, leafName, parentPrefix, isPermissionError, parseS3Error, isBlockedByExtension } from '../src/lib/format.js';

describe('formatBytes — invalid input returns em dash (T4-4)', () => {
  // formatBytes only guards for === 0. null/undefined/NaN/negative produce "NaN undefined"
  // or crash because Math.log(null) → -Infinity → units[undefined].
  test('null → em dash', () => assert.equal(formatBytes(null), '—'));
  test('undefined → em dash', () => assert.equal(formatBytes(undefined), '—'));
  test('NaN → em dash', () => assert.equal(formatBytes(NaN), '—'));
  test('negative → em dash', () => assert.equal(formatBytes(-1), '—'));
  test('Infinity → em dash', () => assert.equal(formatBytes(Infinity), '—'));
});

describe('formatBytes', () => {
  test('zero', () => assert.equal(formatBytes(0), '0 B'));
  test('1 byte', () => assert.equal(formatBytes(1), '1 B'));
  test('1023 bytes stays in B tier', () => assert.equal(formatBytes(1023), '1023 B'));
  test('1024 bytes is 1.0 KiB', () => assert.equal(formatBytes(1024), '1.0 KiB'));
  test('1536 bytes is 1.5 KiB', () => assert.equal(formatBytes(1536), '1.5 KiB'));
  test('1 MiB boundary', () => assert.equal(formatBytes(1024 * 1024), '1.0 MiB'));
  test('1 GiB boundary', () => assert.equal(formatBytes(1024 ** 3), '1.0 GiB'));
  test('1 TiB boundary', () => assert.equal(formatBytes(1024 ** 4), '1.0 TiB'));
  test('fractional KiB rounds to 1 decimal', () => assert.equal(formatBytes(1024 + 102), '1.1 KiB'));
});

describe('formatSpeed', () => {
  test('appends /s to formatBytes output', () => assert.equal(formatSpeed(1024), '1.0 KiB/s'));
  test('zero speed', () => assert.equal(formatSpeed(0), '0 B/s'));
});

describe('formatEta', () => {
  test('0 seconds', () => assert.equal(formatEta(0), '0s'));
  test('30 seconds', () => assert.equal(formatEta(30), '30s'));
  test('59 seconds', () => assert.equal(formatEta(59), '59s'));
  test('60 seconds → 1m 0s', () => assert.equal(formatEta(60), '1m 0s'));
  test('90 seconds → 1m 30s', () => assert.equal(formatEta(90), '1m 30s'));
  test('3600 seconds → 1h 0m', () => assert.equal(formatEta(3600), '1h 0m'));
  test('3661 seconds → 1h 1m', () => assert.equal(formatEta(3661), '1h 1m'));
  test('negative → em dash', () => assert.equal(formatEta(-1), '—'));
  test('Infinity → em dash', () => assert.equal(formatEta(Infinity), '—'));
  test('NaN → em dash', () => assert.equal(formatEta(NaN), '—'));
});

describe('leafName', () => {
  test('no slashes → whole string', () => assert.equal(leafName('file.txt'), 'file.txt'));
  test('single folder', () => assert.equal(leafName('folder/file.txt'), 'file.txt'));
  test('deeply nested', () => assert.equal(leafName('a/b/c/file.txt'), 'file.txt'));
  test('trailing slash → empty string', () => assert.equal(leafName('folder/'), ''));
  test('empty string', () => assert.equal(leafName(''), ''));
  test('key with many segments', () => assert.equal(leafName('a/b/c/d/e/f.jpg'), 'f.jpg'));
});

describe('parentPrefix', () => {
  test('no slashes → root (empty string)', () => assert.equal(parentPrefix('file.txt'), ''));
  test('single folder', () => assert.equal(parentPrefix('folder/file.txt'), 'folder/'));
  test('deeply nested', () => assert.equal(parentPrefix('a/b/c/file.txt'), 'a/b/c/'));
  test('trailing slash → keeps trailing slash', () => assert.equal(parentPrefix('folder/'), 'folder/'));
  test('empty string → root', () => assert.equal(parentPrefix(''), ''));
  test('always ends with / when non-empty (matches Browser cache key)', () => {
    for (const key of ['a/b.jpg', 'a/b/c.jpg', 'photos/2024/img.png']) {
      const p = parentPrefix(key);
      assert.ok(p === '' || p.endsWith('/'), `parentPrefix("${key}") = "${p}" must be '' or end with /`);
    }
  });
});

describe('isPermissionError', () => {
  // BUG-009 context: permission errors must be reliably detected to clean up multipart sessions
  test('403 status', () => assert.equal(isPermissionError({ $metadata: { httpStatusCode: 403 } }), true));
  test('401 status', () => assert.equal(isPermissionError({ $metadata: { httpStatusCode: 401 } }), true));
  test('500 status is not a permission error', () => assert.equal(isPermissionError({ $metadata: { httpStatusCode: 500 } }), false));
  test('AccessDenied Code', () => assert.equal(isPermissionError({ Code: 'AccessDenied' }), true));
  test('AccessDenied name', () => assert.equal(isPermissionError({ name: 'AccessDenied' }), true));
  test('NoSuchBucket is not a permission error', () => assert.equal(isPermissionError({ Code: 'NoSuchBucket' }), false));
  test('empty object', () => assert.equal(isPermissionError({}), false));
  test('null', () => assert.equal(isPermissionError(null), false));
  test('undefined', () => assert.equal(isPermissionError(undefined), false));
});

describe('parseS3Error', () => {
  test('full S3 error object', () => {
    const err = {
      message: 'Access Denied',
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403, requestId: 'abc123' },
    };
    const parsed = parseS3Error(err);
    assert.equal(parsed.message, 'Access Denied');
    assert.equal(parsed.code, 'AccessDenied');
    assert.equal(parsed.status, 403);
    assert.equal(parsed.requestId, 'abc123');
  });

  test('falls back to name when Code absent', () => {
    const err = { message: 'Not found', name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
    assert.equal(parseS3Error(err).code, 'NoSuchKey');
  });

  test('missing metadata fields become null', () => {
    const parsed = parseS3Error({ message: 'oops' });
    assert.equal(parsed.code, null);
    assert.equal(parsed.status, null);
    assert.equal(parsed.requestId, null);
  });

  test('string error', () => {
    const parsed = parseS3Error('something went wrong');
    assert.equal(parsed.message, 'something went wrong');
  });

  test('Code takes priority over name when both present', () => {
    const parsed = parseS3Error({ message: 'x', Code: 'AccessDenied', name: 'SomethingElse', $metadata: {} });
    assert.equal(parsed.code, 'AccessDenied');
  });
});

describe('isBlockedByExtension (BUG-025)', () => {
  // Firefox
  test('Firefox NetworkError TypeError', () => assert.equal(
    isBlockedByExtension(Object.assign(new TypeError('NetworkError when attempting to fetch resource.'), { name: 'TypeError' })),
    true
  ));
  // Chrome
  test('Chrome Failed to fetch TypeError', () => assert.equal(
    isBlockedByExtension(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' })),
    true
  ));
  // Safari
  test('Safari Load failed TypeError', () => assert.equal(
    isBlockedByExtension(Object.assign(new TypeError('Load failed'), { name: 'TypeError' })),
    true
  ));
  // Not a block — got an HTTP response
  test('TypeError with HTTP metadata is not a block', () => assert.equal(
    isBlockedByExtension(Object.assign(new TypeError('Failed to fetch'), { $metadata: { httpStatusCode: 500 } })),
    false
  ));
  // Not a block — different error type
  test('non-TypeError network error is not a block', () => assert.equal(
    isBlockedByExtension({ name: 'Error', message: 'Failed to fetch' }),
    false
  ));
  // S3 errors are not blocks
  test('S3 AccessDenied is not a block', () => assert.equal(
    isBlockedByExtension({ name: 'AccessDenied', message: 'Access Denied', $metadata: { httpStatusCode: 403 } }),
    false
  ));
  test('null', () => assert.equal(isBlockedByExtension(null), false));
  test('undefined', () => assert.equal(isBlockedByExtension(undefined), false));
});
