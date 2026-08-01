import '../helpers/with-dom.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { issueBrowserDownload, MAX_DOWNLOAD_FRAMES } from '../../src/lib/download-issue.js';

// SCOPE OF THIS FILE. These assertions are structural: they prove the frame pool is
// bounded, hidden, and never an anchor. They CANNOT prove downloads survive — jsdom does
// not navigate, so neither BUG-050 (top-frame navigation) nor BUG-053 (a pending
// navigation replaced by src reassignment) is reproducible here. The behavioural proof is
// test/e2e/browser/download-completion.test.mjs against the built bundle in real engines.
// A green run of this file is not that proof.

const frames = () => [...document.querySelectorAll('iframe')];

describe('issueBrowserDownload', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  // BUG-053: one reused frame meant every src assignment could cancel the previous file's
  // still-pending navigation. Consecutive issues must land in different frames.
  test('consecutive issues go to distinct frames', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');
    issueBrowserDownload('https://example.invalid/b', 'b.txt');
    issueBrowserDownload('https://example.invalid/c', 'c.txt');

    assert.deepEqual(frames().map(f => f.src), [
      'https://example.invalid/a',
      'https://example.invalid/b',
      'https://example.invalid/c',
    ], 'reusing a frame with a navigation in flight cancels that download');
  });

  test('the pool is bounded: a job of thousands of files stays at the cap', () => {
    for (let i = 0; i < MAX_DOWNLOAD_FRAMES * 3; i++) {
      issueBrowserDownload(`https://example.invalid/f${i}`, `f${i}.txt`);
    }

    assert.equal(frames().length, MAX_DOWNLOAD_FRAMES,
      'an element per file would be an unbounded DOM leak (the reason the old code shared one frame)');
  });

  test('recycling replaces the oldest frame, never a recent one', () => {
    for (let i = 0; i < MAX_DOWNLOAD_FRAMES + 1; i++) {
      issueBrowserDownload(`https://example.invalid/f${i}`, `f${i}.txt`);
    }

    const srcs = frames().map(f => f.src);
    assert.equal(srcs.includes('https://example.invalid/f0'), false,
      'f0 is the oldest navigation, the one most likely to have already resolved');
    assert.equal(srcs.includes(`https://example.invalid/f${MAX_DOWNLOAD_FRAMES}`), true);
    assert.equal(srcs.includes('https://example.invalid/f1'), true,
      'f1 must survive until the pool cycles again');
  });

  test('creates no anchor', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');

    assert.equal(document.querySelectorAll('a').length, 0,
      'an anchor pointed at an error response navigates the top frame — that is BUG-050');
  });

  test('the frames are hidden', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');

    const container = document.getElementById('bucketer-download-frames');
    assert.ok(container, 'frames live under one container, found by id');
    assert.equal(container.style.display, 'none');
  });

  test('recreates the container after it is removed from the document', () => {
    issueBrowserDownload('https://example.invalid/a', 'a.txt');
    document.getElementById('bucketer-download-frames').remove();

    issueBrowserDownload('https://example.invalid/b', 'b.txt');

    assert.equal(frames().length, 1, 'the pool must be re-created, not silently skipped');
    assert.equal(frames()[0].src, 'https://example.invalid/b');
  });
});
