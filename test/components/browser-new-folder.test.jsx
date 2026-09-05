// Characterization test for the Browser new-folder flow (previously covered only by
// e2e). Protects the extraction of this cluster into a useNewFolder hook: behavior must
// be identical before and after.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { Browser } from '../../src/components/Browser.jsx';

function makeClient(puts) {
  return {
    send(cmd) {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return Promise.resolve({ Contents: [], IsTruncated: false, CommonPrefixes: [{ Prefix: 'photos/' }] });
      }
      if (cmd.constructor.name === 'PutObjectCommand') { puts.push(cmd.input); return Promise.resolve({}); }
      return Promise.reject(new Error('unexpected ' + cmd.constructor.name));
    },
  };
}

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function mountBrowser(puts) {
  return mount(h(Browser, {
    client: makeClient(puts), bucket: 'b', provider: 'generic', credentials: { bucket: 'b' },
    capabilities: caps, onCapabilityChange: () => {}, onMoveRequest: () => {},
    onDeleteRequest: () => {}, onUploadTargetChange: () => {}, onInitialListFailed: () => {},
  }));
}
async function tick() { await new Promise(r => setTimeout(r, 20)); }

describe('Browser — new folder', () => {
  test('creating a folder PUTs the marker key and shows the new folder', async () => {
    const puts = [];
    const { query, queryAll, text, cleanup } = mountBrowser(puts);
    await tick();
    fire(queryAll('button').find(b => b.title === 'Create a new folder'), 'click');
    setInput(query('input[placeholder="Folder name"]'), 'reports');
    fire(queryAll('.modal-actions button').find(b => b.textContent.includes('Create')), 'click');
    await tick();
    assert.equal(puts.length, 1, 'one PutObject for the folder marker');
    assert.equal(puts[0].Key, 'reports/', 'marker key is prefix + name + /');
    assert.ok(text().includes('reports'), 'the new folder appears in the listing');
    cleanup();
  });

  test('a name colliding with an existing folder shows an error and does not PUT', async () => {
    const puts = [];
    const { query, queryAll, cleanup } = mountBrowser(puts);
    await tick();
    fire(queryAll('button').find(b => b.title === 'Create a new folder'), 'click');
    setInput(query('input[placeholder="Folder name"]'), 'photos'); // 'photos/' already exists
    fire(queryAll('.modal-actions button').find(b => b.textContent.includes('Create')), 'click');
    await tick();
    assert.equal(puts.length, 0, 'no PUT on a colliding name');
    assert.ok(query('.modal-error'), 'a collision error is shown');
    cleanup();
  });
});
