// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-naming.js — turning arbitrary S3 keys into safe local names.
//
// S3 keys are arbitrary byte strings. They can contain "..", path separators, control
// characters, Windows-reserved device names, and characters no filesystem accepts. The
// WHATWG fs spec's own name check only covers "", ".", ".." and the separator and leaves
// the rest to the OS, so this module has to do the real work.
//
// The traversal cases below are the load-bearing ones: a key must never be able to place
// a file outside the directory the user chose.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSegment,
  segmentsForKey,
  isDirectoryMarker,
  flatNameForKey,
  NAMING_MODES,
} from '../src/lib/download-naming.js';

describe('sanitizeSegment', () => {
  test('leaves an ordinary name alone', () =>
    assert.equal(sanitizeSegment('report.pdf'), 'report.pdf'));

  test('SECURITY: dot segments cannot traverse', () => {
    assert.equal(sanitizeSegment('..'), '__');
    assert.equal(sanitizeSegment('.'), '_');
    assert.equal(sanitizeSegment('...'), '___');
  });

  test('SECURITY: path separators are neutralised', () => {
    assert.equal(sanitizeSegment('a/b'), 'a_b');
    assert.equal(sanitizeSegment('a\\b'), 'a_b');
  });

  test('replaces characters no Windows filesystem accepts', () =>
    assert.equal(sanitizeSegment('a:b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h'));

  test('strips control characters', () =>
    assert.equal(sanitizeSegment('a\u0000b\u001Fc'), 'abc'));

  test('escapes Windows reserved device names', () => {
    assert.equal(sanitizeSegment('CON'), 'CON_');
    assert.equal(sanitizeSegment('nul'), 'nul_');
    assert.equal(sanitizeSegment('COM1'), 'COM1_');
    assert.equal(sanitizeSegment('LPT9'), 'LPT9_');
  });

  // Windows reserves these even with an extension: CON.txt is still CON.
  test('escapes a reserved name that carries an extension', () =>
    assert.equal(sanitizeSegment('con.txt'), 'con_.txt'));

  test('does not escape a name that merely starts with a reserved word', () =>
    assert.equal(sanitizeSegment('console.log'), 'console.log'));

  test('strips trailing dots and spaces', () => {
    assert.equal(sanitizeSegment('name.'), 'name');
    assert.equal(sanitizeSegment('name   '), 'name');
    assert.equal(sanitizeSegment('name. . '), 'name');
  });

  test('falls back when nothing survives', () =>
    assert.equal(sanitizeSegment(''), '_'));

  test('normalises to NFC so macOS and Linux agree', () => {
    const nfd = 'café.txt';   // e + combining acute
    const nfc = 'café.txt';    // precomposed é
    assert.equal(sanitizeSegment(nfd), nfc);
  });

  test('truncates an over-long segment but keeps the extension', () => {
    const out = sanitizeSegment('a'.repeat(400) + '.mp4');
    assert.equal(Buffer.byteLength(out, 'utf8') <= 255, true);
    assert.equal(out.endsWith('.mp4'), true);
  });
});

describe('segmentsForKey', () => {
  test('splits a nested key', () =>
    assert.deepEqual(segmentsForKey('videos/2024/a.mp4'), ['videos', '2024', 'a.mp4']));

  test('drops leading and empty segments', () =>
    assert.deepEqual(segmentsForKey('/a//b/'), ['a', 'b']));

  test('SECURITY: a traversal key stays inside the destination', () =>
    assert.deepEqual(segmentsForKey('../../etc/passwd'), ['__', '__', 'etc', 'passwd']));

  test('SECURITY: an absolute-looking key is relative', () =>
    assert.deepEqual(segmentsForKey('/etc/passwd'), ['etc', 'passwd']));

  test('empty key yields no segments', () =>
    assert.deepEqual(segmentsForKey(''), []));
});

describe('isDirectoryMarker', () => {
  test('a key ending in a slash is a folder marker', () =>
    assert.equal(isDirectoryMarker('foo/'), true));
  test('an ordinary key is not', () =>
    assert.equal(isDirectoryMarker('foo/bar.txt'), false));
  test('an empty key is not', () =>
    assert.equal(isDirectoryMarker(''), false));
});

describe('flatNameForKey', () => {
  test('leaf mode keeps only the last segment', () =>
    assert.equal(flatNameForKey('videos/2024/a.mp4', NAMING_MODES.LEAF), 'a.mp4'));

  test('flatten mode joins the whole path', () =>
    assert.equal(flatNameForKey('videos/2024/a.mp4', NAMING_MODES.FLATTEN), 'videos__2024__a.mp4'));

  test('a top-level key is the same in both modes', () => {
    assert.equal(flatNameForKey('a.mp4', NAMING_MODES.LEAF), 'a.mp4');
    assert.equal(flatNameForKey('a.mp4', NAMING_MODES.FLATTEN), 'a.mp4');
  });

  // Each ".." segment becomes "__" and the joiner is also "__", so the leading run is
  // eight underscores. What matters is that no "." or "/" survives to traverse.
  test('SECURITY: traversal survives neither mode', () => {
    const out = flatNameForKey('../../etc/passwd', NAMING_MODES.FLATTEN);
    assert.equal(out, '________etc__passwd');
    assert.equal(out.includes('.'), false);
    assert.equal(out.includes('/'), false);
  });
});
