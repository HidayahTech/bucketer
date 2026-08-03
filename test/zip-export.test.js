// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-export.js — the single-download export step: turn a File (the
// finished OPFS staging file) into one browser download via an object URL and a
// transient anchor click.
//
// jsdom-free by design: `doc` and `urlImpl` are injected fakes, so this runs in plain
// Node like the rest of the zip-job unit tests.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { exportZip } from '../src/lib/zip-export.js';

function fakeDoc() {
  const appended = [];
  const removed = [];
  const created = [];
  return {
    created, appended, removed,
    createElement(tag) {
      const el = {
        tag,
        href: null,
        download: null,
        clicked: 0,
        click() { this.clicked += 1; },
      };
      created.push(el);
      return el;
    },
    body: {
      appendChild(el) { appended.push(el); },
      removeChild(el) { removed.push(el); },
    },
  };
}

function fakeUrl() {
  let n = 0;
  const created = [];
  const revoked = [];
  return {
    created, revoked,
    createObjectURL(file) {
      const url = `blob:fake-${n++}`;
      created.push({ url, file });
      return url;
    },
    revokeObjectURL(url) { revoked.push(url); },
  };
}

describe('exportZip', () => {
  test('creates an anchor with the object URL and the zip filename, clicks it, and cleans it up', async () => {
    const doc = fakeDoc();
    const urlImpl = fakeUrl();
    const file = { name: 'staged.bin' };

    await exportZip(async () => file, 'videos-20260803-1200.zip', doc, urlImpl);

    assert.equal(urlImpl.created.length, 1, 'createObjectURL must be called exactly once');
    assert.equal(urlImpl.created[0].file, file, 'the object URL must be built from the resolved file');

    assert.equal(doc.created.length, 1, 'exactly one anchor must be created');
    const anchor = doc.created[0];
    assert.equal(anchor.tag, 'a');
    assert.equal(anchor.href, urlImpl.created[0].url);
    assert.equal(anchor.download, 'videos-20260803-1200.zip');
    assert.equal(anchor.clicked, 1, 'the anchor must be clicked to trigger the download');

    assert.deepEqual(doc.appended, [anchor], 'the anchor must be appended to the document body');
    assert.deepEqual(doc.removed, [anchor], 'the anchor must be removed from the document body');
  });

  test('defers revokeObjectURL — revoking synchronously races the download start', async () => {
    const doc = fakeDoc();
    const urlImpl = fakeUrl();

    const originalSetTimeout = global.setTimeout;
    let capturedCallback = null;
    let capturedDelay = null;
    global.setTimeout = (cb, ms) => { capturedCallback = cb; capturedDelay = ms; return 0; };

    try {
      await exportZip(async () => ({ name: 'staged.bin' }), 'bucket-20260803-1200.zip', doc, urlImpl);

      assert.equal(urlImpl.revoked.length, 0, 'revokeObjectURL must not be called synchronously');
      assert.equal(capturedDelay, 10_000, 'the revoke must be deferred by 10 seconds');
      assert.equal(typeof capturedCallback, 'function');

      capturedCallback();
      assert.deepEqual(urlImpl.revoked, [urlImpl.created[0].url], 'revoking fires once the timer elapses');
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});
