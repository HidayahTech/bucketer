// Characterization test for the Browser FILE-rename flow (Copy + Delete), which had no
// component test. Protects the extraction of the rename cluster into a useRename hook.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { Browser } from '../../src/components/Browser.jsx';

// `remote` lists keys that exist in the bucket but are NOT on the loaded listing page
// (a later page, or created after the listing) — what the #73 collision check must see.
function makeClient(log, key = 'notes.txt', remote = []) {
  return {
    send(cmd) {
      const n = cmd.constructor.name;
      if (n === 'HeadObjectCommand') {
        log.push(['head', cmd.input]);
        if (cmd.input.Key === key || remote.includes(cmd.input.Key)) return Promise.resolve({});
        const err = new Error('NotFound');
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        return Promise.reject(err);
      }
      if (n === 'ListObjectsV2Command') {
        return Promise.resolve({
          Contents: [{ Key: key, Size: 5, LastModified: new Date().toISOString() }],
          IsTruncated: false,
          CommonPrefixes: [],
        });
      }
      if (n === 'CopyObjectCommand') {
        log.push(['copy', cmd.input]);
        return Promise.resolve({});
      }
      if (n === 'DeleteObjectCommand') {
        log.push(['delete', cmd.input]);
        return Promise.resolve({});
      }
      return Promise.reject(new Error('unexpected ' + n));
    },
  };
}

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function mountBrowser(log, key, remote) {
  return mount(
    h(Browser, {
      client: makeClient(log, key, remote),
      bucket: 'b',
      provider: 'generic',
      credentials: { bucket: 'b' },
      capabilities: caps,
      onCapabilityChange: () => {},
      onMoveRequest: () => {},
      onDeleteRequest: () => {},
      onUploadTargetChange: () => {},
      onInitialListFailed: () => {},
    }),
  );
}
async function tick() {
  await new Promise((r) => setTimeout(r, 20));
}

describe('Browser — file rename', () => {
  test('renaming a file copies to the new key, deletes the old, and updates the row', async () => {
    const log = [];
    const { query, queryAll, text, cleanup } = mountBrowser(log);
    await tick();
    fire(
      queryAll('[data-testid="file-row:notes.txt"] button').find((b) => b.title === 'Rename'),
      'click',
    );
    setInput(query('.rename-input'), 'renamed.txt');
    fire(
      queryAll('.rename-inline button').find((b) => b.getAttribute('aria-label') === 'Save name'),
      'click',
    );
    await tick();
    const copy = log.find(([op]) => op === 'copy');
    const del = log.find(([op]) => op === 'delete');
    assert.ok(
      copy && copy[1].Key === 'renamed.txt' && copy[1].CopySource === 'b/notes.txt',
      'copies to the new key from the old',
    );
    assert.ok(del && del[1].Key === 'notes.txt', 'deletes the old key');
    assert.ok(text().includes('renamed.txt'), 'the row shows the new name');
    cleanup();
  });

  test('renaming a file whose key has a char above U+00FF percent-encodes CopySource (BUG-062)', async () => {
    // A raw `${bucket}/${oldKey}` CopySource carries the literal U+FF5C, which the browser
    // Headers constructor (Latin-1 ByteString) rejects > U+00FF — the rename throws before
    // the request. copySource() from move-key.js percent-encodes each segment. Same class as
    // BUG-060 (fixed for MOVE, missed for inline file rename).
    const log = [];
    const { query, queryAll, cleanup } = mountBrowser(log, 'Anwar ｜ x.opus');
    await tick();
    fire(
      queryAll('button').find((b) => b.title === 'Rename'),
      'click',
    );
    setInput(query('.rename-input'), 'renamed.opus');
    fire(
      queryAll('.rename-inline button').find((b) => b.getAttribute('aria-label') === 'Save name'),
      'click',
    );
    await tick();
    const copy = log.find(([op]) => op === 'copy');
    assert.ok(copy, 'a copy is issued');
    assert.equal(copy[1].CopySource, 'b/Anwar%20%EF%BD%9C%20x.opus', 'CopySource is percent-encoded and Latin-1 safe');
    cleanup();
  });

  test('renaming onto an existing key that is not on the loaded page is refused (#73, R03)', async () => {
    // The loaded listing holds only notes.txt; z.txt exists remotely on a later page. The
    // pre-fix guard searched loaded rows only, then copied over z.txt and deleted notes.txt.
    const log = [];
    const { query, queryAll, cleanup } = mountBrowser(log, 'notes.txt', ['z.txt']);
    await tick();
    fire(
      queryAll('[data-testid="file-row:notes.txt"] button').find((b) => b.title === 'Rename'),
      'click',
    );
    setInput(query('.rename-input'), 'z.txt');
    fire(
      queryAll('.rename-inline button').find((b) => b.getAttribute('aria-label') === 'Save name'),
      'click',
    );
    await tick();
    const mutations = log.filter(([op]) => op === 'copy' || op === 'delete');
    assert.deepEqual(mutations, [], 'no copy over z.txt and no delete of notes.txt');
    assert.ok(query('.rename-error'), 'the collision is reported');
    cleanup();
  });

  test('an invalid (slash) name shows an error and does not copy', async () => {
    const log = [];
    const { query, queryAll, cleanup } = mountBrowser(log);
    await tick();
    fire(
      queryAll('[data-testid="file-row:notes.txt"] button').find((b) => b.title === 'Rename'),
      'click',
    );
    setInput(query('.rename-input'), 'a/b');
    fire(
      queryAll('.rename-inline button').find((b) => b.getAttribute('aria-label') === 'Save name'),
      'click',
    );
    await tick();
    assert.equal(log.length, 0, 'no copy/delete on an invalid name');
    assert.ok(query('.rename-error'), 'an error is shown');
    cleanup();
  });
});
