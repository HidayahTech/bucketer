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
import { formatBytes } from '../../src/lib/format.js';

const makeStore = () => createTaskStore(fn => setTimeout(fn, 0), clearTimeout);

function addDownload(store, patch = {}) {
  const id = store.add(createDownloadTask({ fileCount: 412, bucket: 'b', capturedPrefix: 'videos/' }));
  if (Object.keys(patch).length) store.update(id, patch, true);
  return id;
}

function addZip(store, patch = {}) {
  const id = store.add(createDownloadTask({ fileCount: 412, bucket: 'b', capturedPrefix: 'videos/', delivery: 'zip' }));
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

describe('MasterQueue — zip delivery rows', () => {
  // Exact string, not a loose regex: a loose /zipping/i + separate includes('N')/includes('M')
  // check would pass even if N and M were transposed or unrelated to each other — which is
  // exactly the shape of the resume bug this guards (see the next test). The exact string
  // is the only assertion that actually ties current to total in the rendered order.
  test('while running, shows the exact "Zipping N of M…" label with the cumulative count', () => {
    const store = makeStore();
    addZip(store, { subPhase: null, current: 12, total: 412 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('Zipping 12 of 412…'));
    cleanup();
  });

  // Regression guard for the resume "N of M" bug (BUG-LOG): `current` is cumulative for a
  // zip job (zip-job.js's `completed` starts at the prior run's DONE count and climbs
  // through this run's completions), so on a resumed job `total` must be cumulative too
  // (App.jsx's handleZipStart now sums DONE + PENDING at task-creation time). Before that
  // fix, `total` was only the per-run PENDING count: a job with 5 DONE + 3 PENDING left
  // over rendered current climbing 5→8 against total=3 — "Zipping 5 of 3…", N > M. This
  // models that exact resumed shape (current already past what a fresh 3-item run could
  // ever show) and asserts the label the fixed total produces, not the broken one.
  test('REGRESSION: a resumed zip label never shows current exceeding total (N ≤ M)', () => {
    const store = makeStore();
    addZip(store, { subPhase: null, current: 5, total: 8 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('Zipping 5 of 8…'), 'total must be the cumulative (DONE + PENDING) figure');
    assert.equal(body.includes('Zipping 5 of 3…'), false, 'total must never be just the per-run PENDING remainder');
    cleanup();
  });

  test('HONESTY: a cancelled zip says it stopped zipping, never that anything was sent', () => {
    const store = makeStore();
    addZip(store, { status: 'cancelled', current: 5, total: 412 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('Stopped while zipping — 5 of 412'));
    assert.equal(/sent/i.test(body), false, 'a cancelled zip was never handed to the browser');
    cleanup();
  });

  test('an exported zip says it was handed to the browser, not that it was downloaded', () => {
    const store = makeStore();
    addZip(store, { status: 'done', current: 412, total: 412, finished: true, exported: true });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    assert.ok(text().includes('ZIP handed to your browser'));
    cleanup();
  });

  test('HONESTY: a finished-but-unexported zip offers to save it again, not a false completion claim', () => {
    // The save dialog can itself fail or be cancelled by the user after the zip finished
    // staging (App.jsx marks the job DONE before attempting export, exportedAt only on
    // success) — the row must offer recovery, not claim the file reached the browser.
    const store = makeStore();
    addZip(store, { status: 'done', current: 412, total: 412, finished: true, exported: false });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('ZIP ready — save it again'));
    assert.equal(body.includes('ZIP handed to your browser'), false);
    cleanup();
  });

  test('HONESTY: a paused zip with per-file failures says it is paused, not that it was sent', () => {
    const store = makeStore();
    addZip(store, { status: 'done', current: 8, total: 10, finished: false, failed: 2 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('Paused — 8 of 10 zipped, 2 failed'));
    assert.equal(/sent|handed/i.test(body), false, 'a paused zip was never handed to the browser');
    cleanup();
  });
});

describe('MasterQueue — zip progress (byte/speed/ETA parity, active-focused detail)', () => {
  test('a running zip task with bytesTotal renders the enriched files/byte lines and a progress bar at ~35%', () => {
    const store = makeStore();
    addZip(store, {
      status: 'running', current: 12, total: 4231,
      bytesDone: 1.2e9, bytesTotal: 3.4e9, failed: 1,
    });
    const { text, query, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();

    assert.ok(body.includes('Zipping · 12 of 4,231 files · 1 failed'), body);
    assert.ok(body.includes(`${formatBytes(1.2e9)} of ${formatBytes(3.4e9)}`), body);

    const bar = query('[data-testid="zip-progress-bar"]');
    assert.notEqual(bar, null, 'a progress bar element must render');
    const widthMatch = /width:\s*([\d.]+)%/.exec(bar.getAttribute('style') || '');
    assert.notEqual(widthMatch, null, 'the bar must set a width style');
    const pct = parseFloat(widthMatch[1]);
    assert.ok(Math.abs(pct - (1.2e9 / 3.4e9) * 100) < 1, `expected ~35%, got ${pct}%`);
    cleanup();
  });

  test('speed/ETA are absent on a fresh task (no rate sampled yet)', () => {
    const store = makeStore();
    addZip(store, {
      status: 'running', current: 1, total: 4231,
      bytesDone: 1000, bytesTotal: 3.4e9, failed: 0,
    });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.equal(/\/s\b/.test(body), false, 'no speed until the rate tracker has samples');
    assert.equal(/\bETA\b/.test(body), false, 'no ETA until the rate tracker has samples');
    cleanup();
  });

  test('bytesTotal falsy/zero falls back to the plain count-only "Zipping N of M…" line — no byte line, no bar', () => {
    const store = makeStore();
    addZip(store, { status: 'running', current: 5, total: 8 });
    const { text, query, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('Zipping 5 of 8…'));
    assert.equal(query('[data-testid="zip-progress-bar"]'), null, 'no bar without bytesTotal');
    cleanup();
  });

  test('the expand toggle is present while a zip task is running (today only settled+errors offers it)', () => {
    const store = makeStore();
    addZip(store, { status: 'running', current: 12, total: 4231, jobId: 'job-1' });
    const { query, cleanup } = mount(h(MasterQueue, { store }));
    assert.notEqual(query('[data-testid="task-expand-toggle"]'), null);
    cleanup();
  });

  test('expanding a running zip task reads the per-file detail and renders active/done/failed rows plus the queued/overflow footer', async () => {
    const store = makeStore();
    addZip(store, {
      status: 'running', current: 12, total: 4231, bytesDone: 1.2e9, bytesTotal: 3.4e9, failed: 1,
      jobId: 'job-1',
      active: { key: 'photos/2024/trip-4k.mov', bytes: 412 * 1024 * 1024, size: 900 * 1024 * 1024 },
    });
    const detail = {
      done: [{ key: 'photos/2024/b.jpg', size: 6_100_000 }, { key: 'photos/2024/a.jpg', size: 8_200_000 }],
      failed: [{ key: 'photos/2024/corrupt.raw' }],
      doneCount: 11,
      failedCount: 1,
    };
    let calledWith = null;
    const readZipDetail = (jobId) => { calledWith = jobId; return Promise.resolve(detail); };

    const { text, query, cleanup } = mount(h(MasterQueue, { store, readZipDetail }));
    // The running-zip detail is opt-in (Fix 3) — it does not auto-expand or auto-poll, so
    // the toggle must be clicked before the read fires.
    fire(query('[data-testid="task-expand-toggle"]'), 'click');
    await new Promise(r => setTimeout(r, 60)); // flush the async readZipDetail read + re-render

    assert.equal(calledWith, 'job-1');
    const body = text();
    assert.ok(body.includes(`▶ photos/2024/trip-4k.mov`), body);
    assert.ok(body.includes(`${formatBytes(412 * 1024 * 1024)} / ${formatBytes(900 * 1024 * 1024)}`), body);
    assert.ok(body.includes('(46%)'), body);
    assert.ok(body.includes(`✓ photos/2024/b.jpg`) && body.includes(formatBytes(6_100_000)), body);
    assert.ok(body.includes(`✓ photos/2024/a.jpg`) && body.includes(formatBytes(8_200_000)), body);
    // No matching task.errors entry for this key, so it falls back to the generic reason.
    assert.ok(body.includes('✗ photos/2024/corrupt.raw — failed'), body);
    // queued = total(4231) - doneCount(11) - failedCount(1) = 4219; overflow = doneCount(11) - done.length(2) = 9
    assert.ok(body.includes('…and 4,219 queued · 9 more done'), body);
    cleanup();
  });

  test('a running zip task does not auto-expand the per-file detail or poll readZipDetail until the toggle is clicked (Fix 3)', async () => {
    const store = makeStore();
    let callCount = 0;
    const readZipDetail = () => { callCount++; return Promise.resolve({ done: [], failed: [], doneCount: 0, failedCount: 0 }); };
    addZip(store, {
      status: 'running', current: 12, total: 4231, bytesDone: 1.2e9, bytesTotal: 3.4e9, failed: 0,
      jobId: 'job-3',
    });
    const { text, query, cleanup } = mount(h(MasterQueue, { store, readZipDetail }));
    await new Promise(r => setTimeout(r, 60));

    // The aggregate line + bar always show for a running zip, regardless of expand state.
    const bodyBefore = text();
    assert.ok(bodyBefore.includes('Zipping · 12 of 4,231 files'), bodyBefore);
    assert.notEqual(query('[data-testid="zip-progress-bar"]'), null, 'the bar must still show by default');

    // But the detail panel — and therefore the poll — is opt-in.
    assert.equal(query('[data-testid="zip-detail"]'), null, 'the detail must not auto-expand');
    assert.equal(callCount, 0, 'readZipDetail must not be called before the user expands the detail');

    const toggle = query('[data-testid="task-expand-toggle"]');
    assert.notEqual(toggle, null);
    assert.ok(toggle.textContent.includes('Show details'), 'closed by default, so the button offers to open it');
    fire(toggle, 'click');
    await new Promise(r => setTimeout(r, 60));

    assert.notEqual(query('[data-testid="zip-detail"]'), null, 'expanding must now render the detail');
    assert.ok(callCount >= 1, 'readZipDetail must be called once the detail is opened');
    cleanup();
  });

  test('a settled (paused) zip task with per-key errors shows the failure MESSAGE in the active-focused detail, not just "failed" (Fix 1)', async () => {
    const store = makeStore();
    const readZipDetail = () => Promise.resolve({
      done: [], failed: [{ key: 'a/x.raw' }], doneCount: 0, failedCount: 1,
    });
    addZip(store, {
      status: 'done', current: 8, total: 10, finished: false, failed: 1,
      jobId: 'job-2',
      errors: [{ key: 'a/x.raw', message: 'AccessDenied' }],
    });
    const { text, cleanup } = mount(h(MasterQueue, { store, readZipDetail }));
    await new Promise(r => setTimeout(r, 60)); // settled zip+errors auto-expands (unchanged pre-existing behavior)

    const body = text();
    assert.ok(body.includes('Paused — 8 of 10 zipped, 1 failed'), body);
    assert.ok(body.includes('✗ a/x.raw — AccessDenied'), body);
    assert.equal(body.includes('✗ a/x.raw — failed'), false, 'the real message must win over the generic fallback');
    cleanup();
  });

  test('REGRESSION: a non-zip (handoff) running task is unchanged by the zip progress work', () => {
    const store = makeStore();
    addDownload(store, { subPhase: null, current: 12, total: 412 });
    const { text, query, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.equal(query('[data-testid="zip-progress-bar"]'), null);
    assert.equal(query('[data-testid="task-expand-toggle"]'), null);
    assert.equal(/\d+\s*%/.test(body), false, 'still no percentage for a handoff download');
    cleanup();
  });

  test('REGRESSION: a delivery:zip PAUSED task still shows the honest "Paused — N of M zipped, K failed" label', () => {
    const store = makeStore();
    addZip(store, { status: 'done', current: 8, total: 10, finished: false, failed: 2 });
    const { text, cleanup } = mount(h(MasterQueue, { store }));
    const body = text();
    assert.ok(body.includes('Paused — 8 of 10 zipped, 2 failed'));
    cleanup();
  });
});
