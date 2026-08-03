import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { Browser } from '../../src/components/Browser.jsx';

function listClient() {
  return {
    send(cmd) {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return Promise.resolve({
          Contents: [{ Key: 'a.txt', Size: 5, ETag: '"a"', LastModified: new Date(1700000000000) }],
          IsTruncated: false,
          CommonPrefixes: [{ Prefix: 'photos/' }],
        });
      }
      return Promise.reject(new Error('unexpected'));
    },
  };
}

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function mountBrowser(onDownloadRequest, capsOver = caps) {
  return mount(h(Browser, {
    client: listClient(), bucket: 'b', provider: 'generic', credentials: { bucket: 'b' },
    capabilities: capsOver, onCapabilityChange: () => {}, onDownloadRequest,
    onDeleteRequest: () => {}, onMoveRequest: () => {}, onUploadTargetChange: () => {},
    onInitialListFailed: () => {},
  }));
}

async function tick() { await new Promise(r => setTimeout(r, 20)); }

describe('Browser — download entry points', () => {
  test('toolbar button dispatches the current folder scope', async () => {
    let payload = null;
    const { query, cleanup } = mountBrowser(p => { payload = p; });
    await tick();
    fire(query('[data-testid="open-download-job"]'), 'click');
    assert.deepEqual(payload, { kind: 'folder', prefix: '' });
    cleanup();
  });

  test('folder-row button dispatches that subfolder without navigating', async () => {
    let payload = null;
    const { query, cleanup } = mountBrowser(p => { payload = p; });
    await tick();
    fire(query('[data-testid="download-folder:photos/"]'), 'click');
    assert.deepEqual(payload, { kind: 'folder', prefix: 'photos/' });
    cleanup();
  });

  test('batch bar dispatches the ticked files and folders with listing data intact', async () => {
    let payload = null;
    const { query, queryAll, cleanup } = mountBrowser(p => { payload = p; });
    await tick();
    // Tick the file and the folder via their row checkboxes. Scoped to tbody so the
    // thead "select all" checkbox (also .col-check input[type=checkbox]) isn't included —
    // firing it too would select-all then have the two row toggles immediately deselect
    // everything again.
    for (const cb of queryAll('tbody .col-check input[type="checkbox"]')) fire(cb, 'change');
    const btn = Array.from(queryAll('.batch-bar button')).find(b => b.textContent.includes('Download'));
    fire(btn, 'click');
    assert.equal(payload.kind, 'selection');
    assert.deepEqual(payload.prefixes, ['photos/']);
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].Key, 'a.txt');
    assert.equal(payload.files[0].Size, 5);          // raw listing object, not a projection
    assert.equal(payload.capturedPrefix, '');
    cleanup();
  });

  test('batch-bar download is disabled without download capability', async () => {
    const { queryAll, cleanup } = mountBrowser(() => {}, { ...caps, download: 'denied' });
    await tick();
    for (const cb of queryAll('tbody .col-check input[type="checkbox"]')) fire(cb, 'change');
    const btn = Array.from(queryAll('.batch-bar button')).find(b => b.textContent.includes('Download'));
    assert.equal(btn.disabled, true);
    cleanup();
  });
});
