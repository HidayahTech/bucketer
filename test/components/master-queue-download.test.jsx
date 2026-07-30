// Tests for the download row in MasterQueue.
//
// docs/intent/master-queue.md excluded downloads from the queue because "a queue row
// would be a lie — it would show 'running' with no real progress and a cancel button
// that can't work." A browser-managed download row is only honest if it says exactly
// what the app knows: how many files it handed to the browser. Never bytes, never a
// percentage, never an ETA, and a cancel that admits it only stops issuing.
//
// These tests exist to keep that property from eroding.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { MasterQueue } from '../../src/components/MasterQueue.jsx';
import { createTaskStore } from '../../src/lib/task-store.js';
import { createDownloadTask } from '../../src/lib/queue-tasks.js';

const makeStore = () => createTaskStore(fn => setTimeout(fn, 0), clearTimeout);

function addDownload(store, patch = {}) {
  const id = store.add(createDownloadTask({ fileCount: 412, bucket: 'b', capturedPrefix: 'videos/' }));
  if (Object.keys(patch).length) store.update(id, patch, true);
  return id;
}

describe('MasterQueue — download rows', () => {
  test('is labelled browser-managed so it cannot be read as a managed transfer', () => {
    const store = makeStore();
    addDownload(store);
    const { query, cleanup } = mount(h(MasterQueue, { store }));
    assert.notEqual(query('[data-testid="task-badge"]'), null);
    assert.ok(query('[data-testid="task-badge"]').textContent.includes('Browser-managed'));
    cleanup();
  });

  test('counts files handed over, not bytes downloaded', () => {
    const store = makeStore();
    // subPhase clears when enumeration ends and issuing begins.
    addDownload(store, { subPhase: null, current: 12, total: 412 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('12'));
    assert.ok(body.includes('412'));
    assert.ok(/browser/i.test(body), 'the row must say where the files went');
    cleanup();
  });

  test('HONESTY: shows no percentage, ETA, or transfer rate', () => {
    const store = makeStore();
    addDownload(store, { subPhase: null, current: 12, total: 412 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.equal(/\d+\s*%/.test(body), false, 'no percentage — the app cannot know it');
    assert.equal(/\bETA\b/i.test(body), false, 'no ETA — the app cannot know it');
    assert.equal(/\/s\b/.test(body), false, 'no transfer rate — the app cannot know it');
    assert.equal(/\bMB\b|\bGB\b|\bKiB\b|\bMiB\b/.test(body), false, 'no byte totals');
    cleanup();
  });

  test('HONESTY: never claims the files finished downloading', () => {
    const store = makeStore();
    addDownload(store, { status: 'done', current: 412, total: 412 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.equal(/\bDownloaded\b/.test(body), false, 'the app cannot observe completion');
    assert.ok(/sent|handed/i.test(body));
    cleanup();
  });

  test('shows the enumerating phase while the manifest is being built', () => {
    const store = makeStore();
    addDownload(store, { subPhase: 'enumerating' });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(/listing/i.test(text()));
    cleanup();
  });

  test('cancel is offered while running and reports what it actually does', () => {
    const store = makeStore();
    const id = addDownload(store, { current: 5, total: 412 });
    const { query, cleanup } = mount(h(MasterQueue, { store }));

    const btn = query('[data-testid="task-cancel"]');
    assert.notEqual(btn, null);
    fire(btn, 'click');
    assert.equal(store.isCancelRequested(id), true);
    cleanup();
  });

  test('a cancelled download says what was already handed over', () => {
    const store = makeStore();
    addDownload(store, { status: 'cancelled', current: 5, total: 412 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(/stopped|cancelled/i.test(body));
    assert.ok(body.includes('5'));
    cleanup();
  });

  test('failed keys still surface as errors', () => {
    const store = makeStore();
    addDownload(store, {
      status: 'done', current: 410, total: 412,
      errors: [{ key: 'videos/a.mp4', message: 'AccessDenied' }],
    });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('AccessDenied'));
    cleanup();
  });
});
