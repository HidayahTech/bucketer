// Tests for UploadQueue UI sub-components: BatchSummary, UploadItem, ErrorDetailsPanel.
// These are the rendering-layer components inside UploadQueue.jsx. Testing them directly
// (rather than through the full UploadQueue mount) avoids needing a real S3 client or
// IndexedDB — we pass controlled props and assert on DOM output.
//
// Test strategy: each sub-component is a pure function of its props. Tests cover every
// distinct status value, the callback wiring, and the provider-specific branches.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { BatchSummary } from '../../src/components/BatchSummary.jsx';
import { UploadItem } from '../../src/components/UploadItem.jsx';
import { ErrorDetailsPanel } from '../../src/components/ErrorDetailsPanel.jsx';

// ─── Shared item factories ────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    id: 1,
    name: 'photo.jpg',
    size: 1024,
    status: 'queued',
    bytesUploaded: 0,
    speed: 0,
    error: null,
    expiryWarning: false,
    resumeRecord: null,
    largeFileWarningDismissed: false,
    ...overrides,
  };
}

const NO_CALLBACKS = {
  onResume: () => {}, onRestart: () => {}, onCancel: () => {},
  onRemove: () => {}, onDismissLargeWarn: () => {},
};

const BATCH_NO_CALLBACKS = {
  onToggleCollapse: () => {}, onCollapse: () => {}, onExpand: () => {},
  onDismiss: () => {}, onCancelBatch: () => {}, onResume: () => {},
  onRestart: () => {}, onCancel: () => {}, onRemove: () => {},
  onDismissLargeWarn: () => {}, notifSuppressed: false, onToggleNotifs: () => {},
};

// ─── UploadItem ───────────────────────────────────────────────────────────────

describe('UploadItem — queued state', () => {
  test('shows the filename', () => {
    const { text, cleanup } = mount(h(UploadItem, { item: makeItem({ name: 'my-file.txt' }), provider: 'r2', ...NO_CALLBACKS }));
    assert.ok(text().includes('my-file.txt'), 'filename must appear');
    cleanup();
  });

  test('shows the file size', () => {
    const { text, cleanup } = mount(h(UploadItem, { item: makeItem({ size: 2048 }), provider: 'r2', ...NO_CALLBACKS }));
    assert.ok(text().includes('2') || text().includes('KB') || text().includes('B'), 'file size must appear');
    cleanup();
  });

  test('shows "Queued" status label', () => {
    const { text, cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'queued' }), provider: 'r2', ...NO_CALLBACKS }));
    assert.ok(text().includes('Queued'), '"Queued" status label must be shown');
    cleanup();
  });

  test('does NOT show a progress bar for queued items', () => {
    const { query, cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'queued' }), provider: 'r2', ...NO_CALLBACKS }));
    assert.equal(query('.progress-bar-wrap'), null, 'no progress bar for queued items');
    cleanup();
  });
});

describe('UploadItem — active state', () => {
  // status:'uploading' triggers useInterpolatedProgress's rAF loop, which conflicts with
  // jsdom's synchronous act() scheduling. We use status:'resuming' here — it exercises
  // the same Cancel button and progress bar branches (both checked via status in JSX)
  // without starting the animation loop (isActive = status === 'uploading', not resuming).
  test('shows "Resuming…" status label for resuming status', () => {
    const { text, cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'resuming' }), provider: 'r2', ...NO_CALLBACKS }));
    assert.ok(text().includes('Resuming'), '"Resuming…" must appear for resuming state');
    cleanup();
  });

  test('shows a Cancel button for active (uploading/resuming) items', () => {
    let cancelled = false;
    const { queryAll, cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'resuming' }),
      provider: 'r2', ...NO_CALLBACKS,
      onCancel: () => { cancelled = true; },
    }));
    const btn = queryAll('button').find(b => b.textContent.trim() === 'Cancel');
    assert.ok(btn, 'Cancel button must be present for active items');
    fire(btn, 'click');
    assert.ok(cancelled, 'onCancel must be called');
    cleanup();
  });

  test('shows a progress bar for active items', () => {
    const { query, cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'resuming' }), provider: 'r2', ...NO_CALLBACKS }));
    assert.ok(query('.progress-bar-wrap'), 'progress bar must appear while item is active');
    cleanup();
  });
});

describe('UploadItem — failed state with resume record (BUG-034)', () => {
  const record = { uploadId: 'u1', partSize: 5, fileIdentity: {}, destinationKey: 'k' };

  test('offers Resume when a failed multipart item has a resume record', () => {
    const { text, cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'error', resumeRecord: record }), provider: 'b2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Resume'), 'a failed item with a resume record must offer Resume (upload only missing parts)');
    cleanup();
  });

  test('a failed item without a resume record shows only Retry', () => {
    const { text, cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'error', resumeRecord: null }), provider: 'b2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Retry'), 'failed item without a record still offers Retry');
    assert.ok(!text().includes('Resume'), 'no Resume without a resume record');
    cleanup();
  });
});

describe('UploadItem — done state', () => {
  test('shows "Done" status label', () => {
    const { text, cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'done', bytesUploaded: 1024 }), provider: 'r2', ...NO_CALLBACKS }));
    assert.ok(text().includes('Done'), '"Done" must appear for completed items');
    cleanup();
  });

  test('shows ✕ remove button for done items', () => {
    let removed = false;
    const { cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'done', bytesUploaded: 1024 }),
      provider: 'r2', ...NO_CALLBACKS,
      onRemove: () => { removed = true; },
    }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('✕'));
    assert.ok(btn, '✕ remove button must appear for done items');
    fire(btn, 'click');
    assert.ok(removed, 'onRemove must be called when ✕ is clicked');
    cleanup();
  });

  test('does NOT show a Cancel button for done items', () => {
    const { queryAll, cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'done', bytesUploaded: 1024 }), provider: 'r2', ...NO_CALLBACKS }));
    const cancelBtn = queryAll('button').find(b => b.textContent.trim() === 'Cancel');
    assert.equal(cancelBtn, undefined, 'Cancel must not appear for done items');
    cleanup();
  });
});

describe('UploadItem — paused state', () => {
  test('shows Resume and Restart buttons', () => {
    const { cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'paused', resumeRecord: { startedAt: Date.now() - 60000 } }),
      provider: 'r2', ...NO_CALLBACKS,
    }));
    const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
    assert.ok(buttons.includes('Resume'), 'Resume button must appear for paused items');
    assert.ok(buttons.includes('Restart'), 'Restart button must appear for paused items');
    cleanup();
  });

  test('Resume button calls onResume', () => {
    let resumed = false;
    const { cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'paused', resumeRecord: { startedAt: Date.now() } }),
      provider: 'r2', ...NO_CALLBACKS,
      onResume: () => { resumed = true; },
    }));
    fire([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Resume'), 'click');
    assert.ok(resumed, 'onResume must be called');
    cleanup();
  });
});

describe('UploadItem — error state', () => {
  test('shows "Failed" status label', () => {
    const { text, cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'error', error: new Error('AccessDenied') }),
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().includes('Failed'), '"Failed" status must appear for error items');
    cleanup();
  });

  test('shows Retry button for error items', () => {
    let retried = false;
    const { cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'error', error: new Error('oops') }),
      provider: 'r2', ...NO_CALLBACKS,
      onRestart: () => { retried = true; },
    }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Retry');
    assert.ok(btn, 'Retry button must appear for error items');
    fire(btn, 'click');
    assert.ok(retried, 'onRestart must be called when Retry is clicked');
    cleanup();
  });

  test('shows error details panel for error items', () => {
    const { query, cleanup } = mount(h(UploadItem, {
      item: makeItem({ status: 'error', error: new Error('AccessDenied') }),
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(query('.upload-error-detail'), 'error detail panel must appear for error items');
    cleanup();
  });
});

describe('UploadItem — aborted state', () => {
  test('shows "Cancelled" status label', () => {
    const { text, cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'aborted' }), provider: 'r2', ...NO_CALLBACKS }));
    assert.ok(text().includes('Cancelled'), '"Cancelled" must appear for aborted items');
    cleanup();
  });

  test('shows ✕ remove button for aborted items', () => {
    const { cleanup } = mount(h(UploadItem, { item: makeItem({ status: 'aborted' }), provider: 'r2', ...NO_CALLBACKS }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('✕'));
    assert.ok(btn, '✕ remove button must appear for aborted items');
    cleanup();
  });
});

describe('UploadItem — large file warning', () => {
  // LARGE_FILE_WARN = 50 GiB; use a value above that threshold
  const LARGE = 50 * 1024 * 1024 * 1024 + 1;

  test('shows large file warning for files above the threshold', () => {
    const { text, cleanup } = mount(h(UploadItem, {
      item: makeItem({ size: LARGE, status: 'queued', largeFileWarningDismissed: false }),
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(text().toLowerCase().includes('large file'), 'large file warning must appear');
    cleanup();
  });

  test('does NOT show warning when largeFileWarningDismissed is true', () => {
    const { text, cleanup } = mount(h(UploadItem, {
      item: makeItem({ size: LARGE, status: 'queued', largeFileWarningDismissed: true }),
      provider: 'r2', ...NO_CALLBACKS,
    }));
    assert.ok(!text().toLowerCase().includes('large file'), 'warning must be suppressed when dismissed');
    cleanup();
  });
});

// ─── ErrorDetailsPanel ────────────────────────────────────────────────────────

describe('ErrorDetailsPanel — basic rendering', () => {
  test('renders an error details disclosure element', () => {
    const { query, cleanup } = mount(h(ErrorDetailsPanel, {
      error: new Error('AccessDenied'), isMultipart: false, isError: true, provider: 'r2',
    }));
    assert.ok(query('details'), 'details element must be present');
    assert.ok(query('details summary').textContent.includes('Error details'));
    cleanup();
  });

  test('includes the error message in the details pre', () => {
    const err = Object.assign(new Error('AccessDenied'), { Code: 'AccessDenied' });
    const { query, cleanup } = mount(h(ErrorDetailsPanel, {
      error: err, isMultipart: false, isError: true, provider: 'r2',
    }));
    assert.ok(query('pre'), 'pre element with error JSON must be present');
    cleanup();
  });

  test('shows NoSuchUpload message when error code is NoSuchUpload', () => {
    const err = Object.assign(new Error('NoSuchUpload'), { Code: 'NoSuchUpload' });
    const { text, cleanup } = mount(h(ErrorDetailsPanel, {
      error: err, isMultipart: true, isError: true, provider: 'b2',
    }));
    assert.ok(
      text().toLowerCase().includes('expired') || text().includes('NoSuchUpload') || text().toLowerCase().includes('session'),
      'NoSuchUpload message must appear when the multipart session has expired'
    );
    cleanup();
  });

  test('shows MultipartFailureConsequence for multipart + error state', () => {
    const { text, cleanup } = mount(h(ErrorDetailsPanel, {
      error: new Error('oops'), isMultipart: true, isError: true, provider: 'r2',
    }));
    // MultipartFailureConsequence for R2 mentions "7 days"
    assert.ok(text().includes('7 days'), 'MultipartFailureConsequence must render for multipart errors');
    cleanup();
  });

  test('does NOT show MultipartFailureConsequence when isMultipart is false', () => {
    const { text, cleanup } = mount(h(ErrorDetailsPanel, {
      error: new Error('oops'), isMultipart: false, isError: true, provider: 'r2',
    }));
    assert.ok(!text().includes('7 days'), 'MultipartFailureConsequence must NOT render for single-part uploads');
    cleanup();
  });
});

// ─── BatchSummary ─────────────────────────────────────────────────────────────

describe('BatchSummary — item counts', () => {
  test('shows "N / M files" progress count', () => {
    const items = [
      makeItem({ id: 1, status: 'done', bytesUploaded: 1024 }),
      makeItem({ id: 2, status: 'queued' }),
      makeItem({ id: 3, status: 'queued' }),
    ];
    const { text, cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS }));
    assert.ok(text().includes('1 / 3'), '"1 / 3 files" must appear when one of three is done');
    cleanup();
  });

  test('shows failed count when there are error items', () => {
    const items = [
      makeItem({ id: 1, status: 'done', bytesUploaded: 1024 }),
      makeItem({ id: 2, status: 'error', error: new Error('oops') }),
    ];
    const { text, cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS }));
    assert.ok(text().includes('failed') || text().includes('1 failed'), 'failed count must appear for error items');
    cleanup();
  });

  test('shows ✓ all-done indicator when every item is done', () => {
    const items = [
      makeItem({ id: 1, status: 'done', bytesUploaded: 1024 }),
      makeItem({ id: 2, status: 'done', size: 512, bytesUploaded: 512 }),
    ];
    const { text, cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS }));
    assert.ok(text().includes('✓') || text().includes('All complete'), 'all-done ✓ indicator must appear when batch is complete');
    cleanup();
  });

  test('shows ✕ error indicator when batch is settled with errors', () => {
    const items = [
      makeItem({ id: 1, status: 'done', bytesUploaded: 1024 }),
      makeItem({ id: 2, status: 'error', error: new Error('fail') }),
    ];
    const { query, cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS }));
    assert.ok(query('.batch-status-err'), '✕ error indicator must appear when batch finishes with errors');
    cleanup();
  });
});

describe('BatchSummary — controls', () => {
  test('shows Show/Hide toggle button', () => {
    const items = [makeItem({ id: 1, status: 'queued' })];
    const { cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Hide');
    assert.ok(btn, '"Hide" toggle button must be present when not collapsed');
    cleanup();
  });

  test('shows "Show" when collapsed', () => {
    const items = [makeItem({ id: 1, status: 'queued' })];
    const { cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: true, ...BATCH_NO_CALLBACKS }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Show');
    assert.ok(btn, '"Show" toggle button must be present when collapsed');
    cleanup();
  });

  test('Show/Hide click calls onToggleCollapse', () => {
    let toggled = false;
    const items = [makeItem({ id: 1, status: 'queued' })];
    const { cleanup } = mount(h(BatchSummary, {
      items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS,
      onToggleCollapse: () => { toggled = true; },
    }));
    fire([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Hide'), 'click');
    assert.ok(toggled, 'onToggleCollapse must be called');
    cleanup();
  });

  test('shows Dismiss button when batch is settled', () => {
    const items = [
      makeItem({ id: 1, status: 'done', bytesUploaded: 1024 }),
    ];
    const { cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Dismiss');
    assert.ok(btn, 'Dismiss button must appear when all items are settled');
    cleanup();
  });

  test('Dismiss button calls onDismiss', () => {
    let dismissed = false;
    const items = [makeItem({ id: 1, status: 'done', bytesUploaded: 1024 })];
    const { cleanup } = mount(h(BatchSummary, {
      items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS,
      onDismiss: () => { dismissed = true; },
    }));
    fire([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Dismiss'), 'click');
    assert.ok(dismissed, 'onDismiss must be called');
    cleanup();
  });

  test('renders a progress bar', () => {
    const items = [makeItem({ id: 1, status: 'queued' })];
    const { query, cleanup } = mount(h(BatchSummary, { items, provider: 'r2', collapsed: false, ...BATCH_NO_CALLBACKS }));
    assert.ok(query('.progress-bar-wrap'), 'progress bar must render in BatchSummary');
    cleanup();
  });
});
