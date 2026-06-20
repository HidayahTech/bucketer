// Tests for MovePickerModal — the folder-tree destination picker for moves.
// The picker is the deliberate confirmation step: navigate to a destination folder,
// then "Move here" triggers the move. The structural guard (validateMove) must disable
// "Move here" with a visible reason when the destination is invalid (e.g. a folder into
// itself), so a user cannot start a no-op or self-destructive move.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { MovePickerModal } from '../../src/components/MovePickerModal.jsx';

const tick = () => new Promise((r) => setTimeout(r, 0));

// foldersByPrefix: Map<prefix, [childPrefix, ...]> drives ListObjectsV2 CommonPrefixes.
function mockClient(foldersByPrefix) {
  return {
    send(cmd) {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListObjectsV2Command') {
        const p = cmd.input.Prefix || '';
        const kids = foldersByPrefix.get(p) || [];
        return Promise.resolve({ CommonPrefixes: kids.map(Prefix => ({ Prefix })), IsTruncated: false });
      }
      return Promise.reject(new Error(`unexpected: ${name}`));
    },
  };
}

const NOOP = { onCancel: () => {}, onMove: () => {} };

describe('MovePickerModal — rendering', () => {
  test('shows the item count and a "Move here" button', async () => {
    const client = mockClient(new Map([['', ['photos/', 'docs/']]]));
    const { text, query, cleanup } = mount(h(MovePickerModal, {
      client, bucket: 'bk', selection: { files: [{ key: 'a.txt', size: 1 }], prefixes: [] }, ...NOOP,
    }));
    await tick();
    assert.match(text(), /Move 1 item/);
    assert.ok(query('.move-here'), 'a "Move here" action must render');
    cleanup();
  });

  test('lists subfolders of the current prefix', async () => {
    const client = mockClient(new Map([['', ['photos/', 'docs/']]]));
    const { queryAll, cleanup } = mount(h(MovePickerModal, {
      client, bucket: 'bk', selection: { files: [{ key: 'a.txt', size: 1 }], prefixes: [] }, ...NOOP,
    }));
    await tick();
    const labels = queryAll('.move-picker-folder').map(b => b.textContent);
    assert.equal(labels.length, 2);
    assert.ok(labels.some(l => l.includes('photos')));
    assert.ok(labels.some(l => l.includes('docs')));
    cleanup();
  });
});

describe('MovePickerModal — navigation', () => {
  test('clicking a folder drills into it and lists its children', async () => {
    const client = mockClient(new Map([
      ['', ['photos/']],
      ['photos/', ['photos/2024/']],
    ]));
    const { queryAll, query, text, cleanup } = mount(h(MovePickerModal, {
      client, bucket: 'bk', selection: { files: [{ key: 'a.txt', size: 1 }], prefixes: [] }, ...NOOP,
    }));
    await tick();
    fire(queryAll('.move-picker-folder')[0], 'click'); // into photos/
    await tick();
    assert.ok(text().includes('2024'), 'children of photos/ must be listed after drilling in');
    assert.ok(query('.move-here'), 'Move here remains available inside a folder');
    cleanup();
  });
});

describe('MovePickerModal — guard rails', () => {
  test('disables "Move here" with a reason when moving a folder into itself', async () => {
    const client = mockClient(new Map([['photos/', []]]));
    const { query, cleanup } = mount(h(MovePickerModal, {
      client, bucket: 'bk',
      selection: { files: [], prefixes: ['photos/'] },
      initialPrefix: 'photos/', // already inside the folder being moved → invalid destination
      ...NOOP,
    }));
    await tick();
    assert.ok(query('.move-here').disabled, '"Move here" must be disabled for an invalid destination');
    assert.ok(query('.move-picker-reason'), 'a reason explaining why must be shown');
    cleanup();
  });
});

describe('MovePickerModal — actions', () => {
  test('"Move here" calls onMove with the current destination prefix', async () => {
    let dest = null;
    const client = mockClient(new Map([['', ['photos/']], ['photos/', []]]));
    const { queryAll, query, cleanup } = mount(h(MovePickerModal, {
      client, bucket: 'bk',
      selection: { files: [{ key: 'reports/a.txt', size: 1 }], prefixes: [] },
      onCancel: () => {}, onMove: (d) => { dest = d; },
    }));
    await tick();
    fire(queryAll('.move-picker-folder')[0], 'click'); // into photos/
    await tick();
    fire(query('.move-here'), 'click');
    assert.equal(dest, 'photos/');
    cleanup();
  });

  test('Cancel calls onCancel', async () => {
    let cancelled = false;
    const client = mockClient(new Map([['', []]]));
    const { query, cleanup } = mount(h(MovePickerModal, {
      client, bucket: 'bk', selection: { files: [{ key: 'a.txt', size: 1 }], prefixes: [] },
      onCancel: () => { cancelled = true; }, onMove: () => {},
    }));
    await tick();
    const cancelBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel');
    fire(cancelBtn, 'click');
    assert.ok(cancelled);
    cleanup();
  });
});
