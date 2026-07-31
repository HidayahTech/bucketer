import '../helpers/with-dom.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { issueBrowserDownload } from '../../src/lib/download-issue.js';

// SCOPE OF THIS FILE. These assertions are structural: they prove one frame is reused, that
// it is hidden, and that no anchor is created. They CANNOT prove the defect is fixed —
// jsdom does not navigate, so the top-frame navigation this change exists to prevent is
// unreproducible here. The behavioural proof is loading the built bundle in a real engine
// and pointing a download at a URL that 403s. A green run of this file is not that proof.

describe('issueBrowserDownload', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('reuses a single frame across many downloads', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');
    issueBrowserDownload('https://example.invalid/b', 'b.txt');
    issueBrowserDownload('https://example.invalid/c', 'c.txt');

    assert.equal(document.querySelectorAll('iframe').length, 1,
      'a job of thousands of files must not accumulate one element per file');
  });

  test('points the frame at the requested url', () => {
    issueBrowserDownload('https://example.invalid/first', 'first.txt');
    issueBrowserDownload('https://example.invalid/second', 'second.txt');

    assert.equal(document.querySelector('iframe').src, 'https://example.invalid/second');
  });

  test('creates no anchor', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');

    assert.equal(document.querySelectorAll('a').length, 0,
      'an anchor pointed at an error response navigates the top frame — that is the defect');
  });

  test('hides the frame', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');

    assert.equal(document.querySelector('iframe').style.display, 'none');
  });

  test('recreates the frame after it is removed from the document', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');
    document.querySelector('iframe').remove();

    issueBrowserDownload('https://example.invalid/b', 'b.txt');

    const frames = document.querySelectorAll('iframe');
    assert.equal(frames.length, 1, 'the frame must be re-created, not silently skipped');
    assert.equal(frames[0].src, 'https://example.invalid/b');
  });
});
