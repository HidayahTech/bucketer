// #13 — presigned preview/share GETs must disable browser caching of the
// signed, content-bearing response (ResponseCacheControl: no-store), so the
// bytes don't linger in the HTTP disk cache after the presigned URL expires.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presignGetParams, contentDispositionAttachment, presignDownloadParams } from '../src/lib/presign-params.js';
import { PRESIGN_EXPIRES, DOWNLOAD_PRESIGN_EXPIRES } from '../src/lib/constants.js';

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

// BUG-049 — the filename in Content-Disposition must survive the trip to disk.
//
// The old code wrote `filename="${encodeURIComponent(name)}"`. encodeURIComponent is for
// URL components; inside a quoted-string header parameter nothing decodes it, so
// "my file.jpg" reached the disk literally named "my%20file.jpg".
//
// This matters more than it looks: MDN states the `download` attribute "only works for
// same-origin URLs, or the blob: and data: schemes", and our presigned S3 URLs are
// cross-origin — so Content-Disposition is the ONLY thing naming these files.
describe('contentDispositionAttachment (BUG-049)', () => {
  test('leaves a plain ASCII name intact in both parameters', () => {
    const cd = contentDispositionAttachment('report.pdf');
    assert.equal(cd, `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  test('a space survives as a space, not %20', () => {
    const cd = contentDispositionAttachment('my file.jpg');
    assert.ok(cd.includes('filename="my file.jpg"'), 'ASCII fallback keeps the real space');
    assert.ok(cd.includes("filename*=UTF-8''my%20file.jpg"), 'ext-value percent-encodes it');
  });

  test('non-ASCII goes in the ext-value with an ASCII fallback', () => {
    const cd = contentDispositionAttachment('café.txt');
    assert.ok(cd.includes('filename="caf_.txt"'), 'fallback is ASCII-only');
    assert.ok(cd.includes("filename*=UTF-8''caf%C3%A9.txt"));
  });

  // RFC 5987 attr-char excludes * ' ( ) but encodeURIComponent leaves them alone.
  test('encodes the characters encodeURIComponent misses', () => {
    const cd = contentDispositionAttachment("a'b(c)*d.txt");
    const ext = cd.split("filename*=UTF-8''")[1];
    for (const ch of ["'", '(', ')', '*']) {
      assert.equal(ext.includes(ch), false, `${ch} must be percent-encoded in the ext-value`);
    }
  });

  test('SECURITY: a quote cannot terminate the filename parameter', () => {
    const cd = contentDispositionAttachment('evil".txt');
    const fallback = cd.match(/filename="([^"]*)"/)[1];
    assert.equal(fallback.includes('"'), false);
  });

  test('SECURITY: a backslash cannot escape out of the quoted string', () => {
    const cd = contentDispositionAttachment('a\\b.txt');
    const fallback = cd.match(/filename="([^"]*)"/)[1];
    assert.equal(fallback.includes('\\'), false);
  });

  test('SECURITY: CR/LF cannot inject a second header', () => {
    const cd = contentDispositionAttachment('a\r\nX-Evil: 1.txt');
    assert.equal(/[\r\n]/.test(cd), false);
  });

  test('an empty name still produces a valid header', () => {
    const cd = contentDispositionAttachment('');
    assert.ok(cd.startsWith('attachment;'));
  });
});

describe('presignDownloadParams', () => {
  test('carries the disposition and the no-store default', () => {
    const p = presignDownloadParams({ Bucket: 'b', Key: 'videos/a b.mp4', filename: 'a b.mp4' });
    assert.equal(p.Bucket, 'b');
    assert.equal(p.Key, 'videos/a b.mp4');
    assert.equal(p.ResponseCacheControl, 'no-store');
    assert.ok(p.ResponseContentDisposition.includes('filename="a b.mp4"'));
    assert.ok(p.ResponseContentDisposition.startsWith('attachment;'));
  });
});

describe('DOWNLOAD_PRESIGN_EXPIRES', () => {
  // A browser resuming an interrupted download re-requests the ORIGINAL URL — there is no
  // way to hand it a fresh signature, and AWS documents that a restart after expiry fails.
  // Presigned URLs cannot be revoked individually, so the lifetime IS the exposure window;
  // but what these URLs expose is a file already sitting unencrypted in the user's own
  // downloads folder, while a too-short expiry silently kills a multi-day transfer.
  test('is the 7-day SigV4 maximum', () => {
    assert.equal(DOWNLOAD_PRESIGN_EXPIRES, 7 * 24 * 60 * 60);
  });

  test('is longer than the short-lived preview/share expiry', () => {
    assert.ok(DOWNLOAD_PRESIGN_EXPIRES > PRESIGN_EXPIRES);
  });
});
