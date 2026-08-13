// Browser floor enforcement for prefix-scoped keys (#60).
//
// The floor (credentials.basePrefix) must hold at every entry into navigation
// state: initial mount (with and without a URL-hash prefix), popstate, and the
// move-picker's own listing. The mock client records every ListObjectsV2 Prefix
// so out-of-floor requests are provable absences, not assumptions.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { Browser } from '../../src/components/Browser.jsx';

function recordingClient(requests) {
  return {
    send(cmd) {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        requests.push(cmd.input.Prefix ?? '');
        return Promise.resolve({
          Contents: [{ Key: (cmd.input.Prefix || '') + 'a.txt', Size: 5, ETag: '"a"', LastModified: new Date(1700000000000) }],
          IsTruncated: false,
          CommonPrefixes: [{ Prefix: (cmd.input.Prefix || '') + 'sub/' }],
        });
      }
      return Promise.reject(new Error('unexpected'));
    },
  };
}

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function mountScoped(requests, { basePrefix = 'team/alice/', isFirstMount = false } = {}) {
  return mount(h(Browser, {
    client: recordingClient(requests), bucket: 'b', provider: 'generic',
    credentials: { bucket: 'b', basePrefix },
    capabilities: caps, onCapabilityChange: () => {}, onDownloadRequest: () => {},
    onDeleteRequest: () => {}, onMoveRequest: () => {}, onUploadTargetChange: () => {},
    onInitialListFailed: () => {}, isFirstMount,
  }));
}

async function tick() { await new Promise(r => setTimeout(r, 20)); }

describe('Browser — base prefix floor (#60)', () => {
  test('scoped connect starts listing at the floor, never the root', async () => {
    const requests = [];
    const { cleanup } = mountScoped(requests);
    await tick();
    assert.equal(requests[0], 'team/alice/', 'initial listing must target the floor');
    assert.ok(!requests.includes(''), 'no root-level listing may ever be issued');
    cleanup();
  });

  test('unscoped connect still lists the root (regression anchor)', async () => {
    const requests = [];
    const { cleanup } = mountScoped(requests, { basePrefix: '' });
    await tick();
    assert.equal(requests[0], '', 'unscoped behavior must be unchanged');
    cleanup();
  });

  test('an initial hash prefix inside the floor is honored', async () => {
    window.location.hash = '#prefix=' + encodeURIComponent('team/alice/2026/');
    const requests = [];
    const { cleanup } = mountScoped(requests, { isFirstMount: true });
    try {
      await tick();
      assert.equal(requests[0], 'team/alice/2026/');
    } finally { cleanup(); window.location.hash = ''; }
  });

  test('an initial hash prefix outside the floor is clamped to the floor with a notice', async () => {
    window.location.hash = '#prefix=' + encodeURIComponent('team/bob/');
    const requests = [];
    const { text, cleanup } = mountScoped(requests, { isFirstMount: true });
    try {
      await tick();
      assert.equal(requests[0], 'team/alice/', 'out-of-floor deep link must clamp to the floor');
      assert.ok(!requests.includes('team/bob/'), 'the out-of-floor prefix must never be requested');
      assert.ok(text().includes('outside this connection’s base folder'),
        'the clamp must be said out loud, not silent');
    } finally { cleanup(); window.location.hash = ''; }
  });

  test('a popstate carrying an out-of-floor prefix is clamped', async () => {
    const requests = [];
    const { cleanup } = mountScoped(requests);
    try {
      await tick();
      const ev = new window.PopStateEvent('popstate', { state: { prefix: 'elsewhere/' } });
      window.dispatchEvent(ev);
      await tick();
      assert.ok(!requests.includes('elsewhere/'), 'popstate must not escape the floor');
      assert.equal(requests[requests.length - 1], 'team/alice/', 'clamped navigation lands on the floor');
    } finally { cleanup(); }
  });

  test('the breadcrumb is floor-pinned (no root crumb while scoped)', async () => {
    const requests = [];
    const { query, cleanup } = mountScoped(requests);
    await tick();
    const crumbText = query('.breadcrumb').textContent;
    assert.ok(crumbText.includes('alice'), 'floor leaf must label the breadcrumb');
    assert.ok(!crumbText.includes('root'), 'no root crumb while scoped');
    cleanup();
  });

  test('the move picker opens at the floor, not the bucket root', async () => {
    const requests = [];
    const { query, queryAll, cleanup } = mountScoped(requests);
    await tick();
    for (const cb of queryAll('tbody .col-check input[type="checkbox"]')) fire(cb, 'change');
    const moveBtn = Array.from(queryAll('.batch-bar button')).find(b => b.textContent.includes('Move'));
    fire(moveBtn, 'click');
    await tick();
    assert.ok(query('.modal-overlay') || query('.breadcrumb'), 'picker must render');
    assert.ok(!requests.includes(''), 'the picker must never list the bucket root while scoped');
    assert.equal(requests[requests.length - 1], 'team/alice/', 'picker listing targets the floor');
    cleanup();
  });
});
