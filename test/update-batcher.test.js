import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateBatcher } from '../src/lib/update-batcher.js';

// Test harness — synchronous schedule/cancel, no rAF needed
function makeHarness() {
  let items = [
    { id: 1, status: 'uploading', bytesUploaded: 0, speed: 0 },
    { id: 2, status: 'uploading', bytesUploaded: 0, speed: 0 },
    { id: 3, status: 'queued',    bytesUploaded: 0, speed: 0 },
  ];

  let pendingFlush = null;
  const cancelled = new Set();

  function setItems(updater) {
    items = updater(items);
  }

  function scheduleFlush(fn) {
    const handle = Symbol('rAF');
    pendingFlush = { handle, fn };
    return handle;
  }

  function cancelFlush(handle) {
    cancelled.add(handle);
    if (pendingFlush?.handle === handle) pendingFlush = null;
  }

  function triggerFlush() {
    const f = pendingFlush;
    pendingFlush = null;
    f?.fn();
  }

  const batcher = createUpdateBatcher(setItems, scheduleFlush, cancelFlush);
  return { batcher, getItems: () => items, triggerFlush, hasPending: () => pendingFlush !== null, cancelled };
}

describe('update-batcher — non-urgent accumulation', () => {
  it('does not apply patch immediately', () => {
    const { batcher, getItems } = makeHarness();
    batcher.update(1, { bytesUploaded: 500 });
    assert.equal(getItems()[0].bytesUploaded, 0, 'patch should not be applied yet');
  });

  it('applies patch when flush fires', () => {
    const { batcher, getItems, triggerFlush } = makeHarness();
    batcher.update(1, { bytesUploaded: 500 });
    triggerFlush();
    assert.equal(getItems()[0].bytesUploaded, 500);
  });

  it('schedules exactly one flush for multiple non-urgent patches', () => {
    const { batcher, hasPending } = makeHarness();
    batcher.update(1, { bytesUploaded: 100 });
    batcher.update(1, { bytesUploaded: 200 });
    batcher.update(2, { bytesUploaded: 50  });
    assert.ok(hasPending(), 'one flush should be scheduled');
  });

  it('merges patches for the same id — last write wins on overlapping fields', () => {
    const { batcher, getItems, triggerFlush } = makeHarness();
    batcher.update(1, { bytesUploaded: 100, speed: 50 });
    batcher.update(1, { bytesUploaded: 200, speed: 45 });
    triggerFlush();
    const item = getItems()[0];
    assert.equal(item.bytesUploaded, 200);
    assert.equal(item.speed, 45);
  });

  it('preserves fields from earlier patch not overwritten by later patch', () => {
    const { batcher, getItems, triggerFlush } = makeHarness();
    batcher.update(1, { bytesUploaded: 100, speed: 50 });
    batcher.update(1, { bytesUploaded: 200 }); // no speed field
    triggerFlush();
    assert.equal(getItems()[0].speed, 50, 'speed from first patch should survive');
  });

  it('applies patches for different ids in a single flush', () => {
    const { batcher, getItems, triggerFlush } = makeHarness();
    batcher.update(1, { bytesUploaded: 111 });
    batcher.update(2, { bytesUploaded: 222 });
    triggerFlush();
    assert.equal(getItems()[0].bytesUploaded, 111);
    assert.equal(getItems()[1].bytesUploaded, 222);
  });

  it('does not touch items with no pending patch', () => {
    const { batcher, getItems, triggerFlush } = makeHarness();
    batcher.update(1, { bytesUploaded: 99 });
    triggerFlush();
    assert.equal(getItems()[2].bytesUploaded, 0, 'item 3 should be untouched');
  });
});

describe('update-batcher — urgent flush', () => {
  it('applies patch immediately without waiting for flush', () => {
    const { batcher, getItems, hasPending } = makeHarness();
    batcher.update(1, { status: 'done' }, true);
    assert.equal(getItems()[0].status, 'done');
    assert.ok(!hasPending(), 'no pending flush after urgent update');
  });

  it('cancels the scheduled rAF before flushing urgently', () => {
    const { batcher, cancelled } = makeHarness();
    batcher.update(1, { bytesUploaded: 100 }); // schedules flush, returns handle
    const handles = [...cancelled]; // snapshot before urgent
    batcher.update(1, { status: 'done' }, true);
    assert.ok(cancelled.size > handles.length, 'scheduled flush handle should have been cancelled');
  });

  it('preserves accumulated bytes when urgent status patch arrives', () => {
    const { batcher, getItems } = makeHarness();
    batcher.update(1, { bytesUploaded: 999, speed: 100 }); // non-urgent, in accumulator
    batcher.update(1, { status: 'done' }, true);           // urgent — should merge
    const item = getItems()[0];
    assert.equal(item.status, 'done');
    assert.equal(item.bytesUploaded, 999, 'accumulated bytes should survive urgent flush');
  });

  it('flushes pending patches for other items when urgent patch arrives', () => {
    const { batcher, getItems } = makeHarness();
    batcher.update(2, { bytesUploaded: 777 }); // pending for item 2
    batcher.update(1, { status: 'error' }, true); // urgent for item 1
    assert.equal(getItems()[0].status, 'error');
    assert.equal(getItems()[1].bytesUploaded, 777, 'pending patch for item 2 flushed together');
  });

  it('allows new non-urgent patches to schedule a fresh flush after urgent flush', () => {
    const { batcher, hasPending } = makeHarness();
    batcher.update(1, { status: 'done' }, true); // urgent flush clears handle
    batcher.update(2, { bytesUploaded: 50 });    // should schedule a new flush
    assert.ok(hasPending(), 'new flush should be scheduled after urgent cleared the old one');
  });
});

describe('update-batcher — edge cases', () => {
  it('flush with empty pending map is a no-op', () => {
    const { batcher, getItems } = makeHarness();
    batcher.flush(); // nothing pending
    assert.deepEqual(getItems().map(i => i.bytesUploaded), [0, 0, 0]);
  });

  it('does not apply patch to item with unknown id', () => {
    const { batcher, getItems, triggerFlush } = makeHarness();
    batcher.update(999, { bytesUploaded: 500 }); // id 999 does not exist
    triggerFlush();
    assert.deepEqual(getItems().map(i => i.bytesUploaded), [0, 0, 0]);
  });
});
