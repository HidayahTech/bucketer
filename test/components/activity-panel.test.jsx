// Activity (layout A, v1.67.0): one line with a badge over the upload queue, task panel and
// upload history, collapsed by default so finishing work never pushes the file list down (W1).
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { ActivityPanel, activityLine } from '../../src/components/ActivityPanel.jsx';
import { createTaskStore } from '../../src/lib/task-store.js';

const NONE = { running: 0, queued: 0, failed: 0, done: 0, current: null };
const task = (over) => ({
  kind: 'delete',
  status: 'running',
  subject: '3 files',
  current: 1,
  total: 3,
  errors: [],
  ...over,
});

describe('activityLine', () => {
  test('nothing ever happened', () => {
    assert.equal(activityLine(NONE, []), 'Nothing running');
  });

  test('an upload in progress leads, with the queue behind it', () => {
    const line = activityLine(
      { ...NONE, running: 1, queued: 2, current: { name: 'trip/IMG_1.jpg', progress: 63.6 } },
      [],
    );
    assert.equal(line, 'Uploading IMG_1.jpg · 64 % · 2 queued');
  });

  test('a running task is described the way its panel row describes it', () => {
    const line = activityLine(NONE, [task()]);
    assert.ok(line.startsWith('Deleting'), line);
  });

  test('when everything is finished, it says so with a count', () => {
    assert.equal(activityLine({ ...NONE, done: 3 }, [task({ status: 'done' })]), 'All done · 4 finished');
  });

  test('failures and paused tasks are named', () => {
    const line = activityLine({ ...NONE, failed: 1 }, [task({ kind: 'move', status: 'paused' })]);
    assert.ok(line.includes('1 paused') && line.includes('1 failed'), line);
  });
});

describe('ActivityPanel', () => {
  const store = () =>
    createTaskStore(
      (fn) => fn(),
      () => {},
    );

  test('collapsed by default; the children stay mounted inside', () => {
    const { query, cleanup } = mount(h(ActivityPanel, { store: store() }, h('div', { class: 'kid' }, 'queue')));
    try {
      assert.equal(query('details.activity').open, false);
      assert.ok(query('.activity-body .kid'), 'the panels inside are mounted while closed');
    } finally {
      cleanup();
    }
  });

  test('the badge counts running uploads and running tasks; failures get their own badge', () => {
    const s = store();
    s.add(task());
    const { queryAll, cleanup } = mount(
      h(ActivityPanel, { store: s, uploads: { ...NONE, running: 1, failed: 1, current: { name: 'a', progress: 1 } } }),
    );
    try {
      const badges = queryAll('.activity-badge').map((b) => b.textContent);
      assert.deepEqual(badges, ['2 running', '1 need attention']);
    } finally {
      cleanup();
    }
  });
});
