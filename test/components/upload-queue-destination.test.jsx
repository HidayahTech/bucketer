// UploadQueue destination-folder floor validation for prefix-scoped keys (#60).
// The free-text destination field is the one upload surface that can name an
// arbitrary path; while scoped it must refuse (visibly, no silent autocorrect)
// anything outside the connection's base prefix. Unscoped behavior unchanged.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, setInput } from '../helpers/render.js';
import { UploadQueue } from '../../src/components/UploadQueue.jsx';

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function mountQueue({ basePrefix = '', currentPrefix = '' } = {}) {
  return mount(h(UploadQueue, {
    client: { send: () => Promise.resolve({}) }, bucket: 'b', provider: 'generic',
    currentPrefix, credentials: { bucket: 'b', endpoint: 'https://e', basePrefix },
    capabilities: caps, onCapabilityChange: () => {}, onUploadsComplete: () => {},
    onLogEntry: () => {},
  }));
}

function destInput(query) {
  return query('input[placeholder="(root of bucket)"]') || query('.form-group input[type="text"]');
}

function chooseButtons(queryAll) {
  return Array.from(queryAll('button')).filter(b => /Choose (files|folder)/.test(b.textContent));
}

describe('UploadQueue — destination floor (#60)', () => {
  test('an out-of-floor destination shows an inline error and disables the pickers', () => {
    const { query, queryAll, cleanup } = mountQueue({ basePrefix: 'team/alice/', currentPrefix: 'team/alice/' });
    try {
      setInput(destInput(query), 'team/bob/');
      assert.ok(query('.field-error'), 'an inline error must render for an out-of-floor destination');
      for (const b of chooseButtons(queryAll)) assert.equal(b.disabled, true, `${b.textContent} must be disabled`);
    } finally { cleanup(); }
  });

  test('an in-floor destination is accepted', () => {
    const { query, queryAll, cleanup } = mountQueue({ basePrefix: 'team/alice/', currentPrefix: 'team/alice/' });
    try {
      setInput(destInput(query), 'team/alice/2026/');
      assert.ok(!query('.field-error'), 'no error for a destination under the floor');
      for (const b of chooseButtons(queryAll)) assert.equal(b.disabled, false);
    } finally { cleanup(); }
  });

  test('clearing the destination while scoped is out-of-floor (root is above the floor)', () => {
    const { query, cleanup } = mountQueue({ basePrefix: 'team/alice/', currentPrefix: 'team/alice/' });
    try {
      setInput(destInput(query), '');
      assert.ok(query('.field-error'), 'the bucket root is outside the floor while scoped');
    } finally { cleanup(); }
  });

  test('unscoped connections keep free-text destinations (regression anchor)', () => {
    const { query, queryAll, cleanup } = mountQueue();
    try {
      setInput(destInput(query), 'anywhere/at/all/');
      assert.ok(!query('.field-error'), 'no floor, no error');
      for (const b of chooseButtons(queryAll)) assert.equal(b.disabled, false);
    } finally { cleanup(); }
  });
});
