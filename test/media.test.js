import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mediaKind, mimeType, mimeKind } from '../src/lib/media.js';

describe('mediaKind', () => {
  // One representative per category — verifies the lookup table is wired up
  test('jpg → image', () => assert.equal(mediaKind('photo.jpg'), 'image'));
  test('mp3 → audio', () => assert.equal(mediaKind('track.mp3'), 'audio'));
  test('mp4 → video', () => assert.equal(mediaKind('video.mp4'), 'video'));
  test('pdf → pdf',   () => assert.equal(mediaKind('doc.pdf'), 'pdf'));
  test('txt → text',  () => assert.equal(mediaKind('readme.txt'), 'text'));

  // Security invariant: HTML and JS must resolve to 'text', never a rendered type.
  // Browser.jsx always forces ResponseContentType=text/plain for 'text' kind previews,
  // preventing uploaded HTML/script files from executing in the preview pane.
  test('html → text (not rendered)', () => assert.equal(mediaKind('page.html'), 'text'));
  test('js → text (not rendered)',   () => assert.equal(mediaKind('script.js'), 'text'));

  // Extension handling logic — these test code paths, not table entries
  test('extension is case-insensitive', () => assert.equal(mediaKind('photo.JPG'), 'image'));
  test('mixed-case extension', ()        => assert.equal(mediaKind('photo.Png'), 'image'));
  test('no extension → null',  ()        => assert.equal(mediaKind('Makefile'), null));
  test('empty string → null',  ()        => assert.equal(mediaKind(''), null));
  test('unknown extension → null', ()    => assert.equal(mediaKind('archive.zip'), null));

  // Path handling: only the final extension matters
  test('path prefix does not affect result', () => assert.equal(mediaKind('folder/photo.jpg'), 'image'));
  test('no-extension leaf in path → null', ()  => assert.equal(mediaKind('folder/Makefile'), null));
});

describe('mimeKind', () => {
  // Wildcard prefix matching (startsWith) — one representative per top-level type
  test('image/* → image', () => assert.equal(mimeKind('image/x-custom'), 'image'));
  test('audio/* → audio', () => assert.equal(mimeKind('audio/x-custom'), 'audio'));
  test('video/* → video', () => assert.equal(mimeKind('video/mp4'), 'video'));
  test('text/* → text',   () => assert.equal(mimeKind('text/plain'), 'text'));

  // Security invariant: text/html must resolve to 'text', not a rendered type
  test('text/html → text (not rendered)', () => assert.equal(mimeKind('text/html'), 'text'));

  // Specific application/* types that map to known kinds
  test('application/pdf → pdf',        () => assert.equal(mimeKind('application/pdf'), 'pdf'));
  test('application/json → text',      () => assert.equal(mimeKind('application/json'), 'text'));
  test('application/javascript → text',() => assert.equal(mimeKind('application/javascript'), 'text'));

  // Generic application types that have no previewable kind
  test('application/octet-stream → null', () => assert.equal(mimeKind('application/octet-stream'), null));
  test('application/zip → null',          () => assert.equal(mimeKind('application/zip'), null));

  // Parameters must be stripped before matching (HeadObject ContentType often includes charset)
  test('text/plain; charset=utf-8 → text', () => assert.equal(mimeKind('text/plain; charset=utf-8'), 'text'));
  test('image/jpeg; quality=80 → image',   () => assert.equal(mimeKind('image/jpeg; quality=80'), 'image'));

  // Edge cases
  test('null → null',      () => assert.equal(mimeKind(null), null));
  test('empty string → null', () => assert.equal(mimeKind(''), null));
  test('undefined → null', () => assert.equal(mimeKind(undefined), null));
});

describe('mimeType', () => {
  // Returns the MIME type string for a file path; used when setting Content-Type on upload.
  test('jpg → image/jpeg', () => assert.equal(mimeType('photo.jpg'), 'image/jpeg'));
  test('png → image/png',  () => assert.equal(mimeType('image.PNG'), 'image/png'));
  test('mp3 → audio/mpeg', () => assert.equal(mimeType('track.mp3'), 'audio/mpeg'));
  test('mp4 → video/mp4',  () => assert.equal(mimeType('clip.mp4'), 'video/mp4'));
  test('pdf → application/pdf', () => assert.equal(mimeType('doc.pdf'), 'application/pdf'));
  test('json → application/json', () => assert.equal(mimeType('data.json'), 'application/json'));
  test('txt → text/plain', () => assert.equal(mimeType('notes.txt'), 'text/plain'));
  test('extension is case-insensitive', () => assert.equal(mimeType('photo.JPEG'), 'image/jpeg'));
  test('unknown extension → null', () => assert.equal(mimeType('archive.zip'), null));
  test('no extension → null', () => assert.equal(mimeType('Makefile'), null));
  test('nested path → uses leaf extension', () => assert.equal(mimeType('docs/guide.pdf'), 'application/pdf'));
});
