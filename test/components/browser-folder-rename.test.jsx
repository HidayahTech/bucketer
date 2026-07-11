import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { Browser } from '../../src/components/Browser.jsx';

// A client that lists exactly one folder ('photos/') plus one sibling folder ('archive/')
// at the root, so the collision case is testable. Only ListObjectsV2 is exercised here;
// rename dispatches through onMoveRequest (mocked), so no copy/delete occurs in this test.
function listClient() {
  return {
    send(cmd) {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return Promise.resolve({
          Contents: [], IsTruncated: false,
          CommonPrefixes: [{ Prefix: 'photos/' }, { Prefix: 'archive/' }],
        });
      }
      return Promise.reject(new Error('unexpected'));
    },
  };
}

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function mountBrowser(onMoveRequest) {
  return mount(h(Browser, {
    client: listClient(), bucket: 'b', provider: 'generic', credentials: { bucket: 'b' },
    capabilities: caps, onCapabilityChange: () => {}, onMoveRequest,
    onDeleteRequest: () => {}, onUploadTargetChange: () => {}, onInitialListFailed: () => {},
  }));
}

async function tick() { await new Promise(r => setTimeout(r, 20)); }

describe('Browser — folder rename', () => {
  test('committing a valid new name dispatches a rename onMoveRequest', async () => {
    let payload = null;
    const { query, queryAll, cleanup } = mountBrowser(p => { payload = p; });
    await tick();
    // Open the rename editor on the 'photos' folder row.
    const renameBtn = Array.from(queryAll('[data-testid="folder-row:photos"] button')).find(b => b.textContent.includes('✎'));
    fire(renameBtn, 'click');
    const input = query('.rename-input');
    setInput(input, 'pictures');
    const ok = Array.from(queryAll('.rename-inline button')).find(b => b.textContent.includes('✓'));
    fire(ok, 'click');
    assert.deepEqual(payload, { prefixes: ['photos/'], renameTo: 'pictures', mode: 'rename', capturedPrefix: '' });
    cleanup();
  });

  test('a name colliding with a visible sibling folder shows an error and does not dispatch', async () => {
    let dispatched = false;
    const { query, queryAll, cleanup } = mountBrowser(() => { dispatched = true; });
    await tick();
    const renameBtn = Array.from(queryAll('[data-testid="folder-row:photos"] button')).find(b => b.textContent.includes('✎'));
    fire(renameBtn, 'click');
    setInput(query('.rename-input'), 'archive');   // 'archive/' already exists
    const ok = Array.from(queryAll('.rename-inline button')).find(b => b.textContent.includes('✓'));
    fire(ok, 'click');
    assert.equal(dispatched, false);
    assert.ok(query('.rename-error'));
    cleanup();
  });

  test('an invalid name (contains slash) shows an error and does not dispatch', async () => {
    let dispatched = false;
    const { query, queryAll, cleanup } = mountBrowser(() => { dispatched = true; });
    await tick();
    const renameBtn = Array.from(queryAll('[data-testid="folder-row:photos"] button')).find(b => b.textContent.includes('✎'));
    fire(renameBtn, 'click');
    setInput(query('.rename-input'), 'a/b');
    const ok = Array.from(queryAll('.rename-inline button')).find(b => b.textContent.includes('✓'));
    fire(ok, 'click');
    assert.equal(dispatched, false);
    assert.ok(query('.rename-error'));
    cleanup();
  });
});
