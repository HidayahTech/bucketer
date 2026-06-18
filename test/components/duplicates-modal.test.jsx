// Tests for the duplicate-detection report UI (iteration 1: detection + verification +
// read-only actions, for UAT). The pure DuplicatesReport renders candidate/verified groups
// and wires the read-only actions and per-group keep-selection. Destructive actions
// (Delete/Move) must render only as DISABLED stubs in iteration 1 — they are enabled in
// iteration 2, after the detection/verification workflow passes human UAT, and even then
// only for byte-for-byte `verified` groups.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { DuplicatesReport, DuplicatesModal } from '../../src/components/DuplicatesModal.jsx';

const CAPS = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function group(id, keys, extra = {}) {
  return {
    id,
    size: 100,
    matchedBy: 'md5',
    confidence: 'candidate',
    verified: false,
    reclaimableBytes: 100 * (keys.length - 1),
    keeperKey: keys[0],
    members: keys.map((k) => ({ Key: k, Size: 100, LastModified: new Date('2026-01-01T00:00:00Z') })),
    ...extra,
  };
}

const noop = () => {};
const handlers = { onSelectKeeper: noop, onVerify: noop, onDownload: noop, onPreview: noop, onCopyLink: noop };
const tick = () => new Promise((r) => setTimeout(r, 0));

const savedRecord = (extra = {}) => ({
  scope: 'bucket', prefix: '', scannedAt: 1700000000000, objectCount: 30000,
  groups: [group('g0', ['a', 'b'])],
  ...extra,
});
const modalProps = (over = {}) => ({
  client: { send: () => Promise.resolve({}) },
  bucket: 'bk', endpoint: 'https://e', currentPrefix: '', provider: 'aws',
  capabilities: CAPS, onDeleteRequest: noop, onClose: noop, ...over,
});

describe('DuplicatesReport — empty', () => {
  test('shows a no-duplicates message when there are no groups', () => {
    const { text, cleanup } = mount(h(DuplicatesReport, { groups: [], capabilities: CAPS, ...handlers }));
    assert.ok(/no duplicate/i.test(text()));
    cleanup();
  });
});

describe('DuplicatesReport — groups', () => {
  test('summarizes group count and reclaimable bytes', () => {
    const groups = [group('g1', ['a', 'b']), group('g2', ['c', 'd', 'e'])];
    const { text, cleanup } = mount(h(DuplicatesReport, { groups, capabilities: CAPS, ...handlers }));
    assert.ok(text().includes('2 groups'), 'summary should mention 2 groups');
    cleanup();
  });

  test('renders one member row per object in a group', () => {
    const { queryAll, cleanup } = mount(h(DuplicatesReport, { groups: [group('g1', ['a', 'b', 'c'])], capabilities: CAPS, ...handlers }));
    assert.equal(queryAll('.dup-member').length, 3);
    cleanup();
  });

  test('marks the keeper radio checked and reports a keeper change', () => {
    let picked = null;
    const onSelectKeeper = (gid, key) => { picked = [gid, key]; };
    const { queryAll, cleanup } = mount(h(DuplicatesReport, { groups: [group('g1', ['a', 'b'])], capabilities: CAPS, ...handlers, onSelectKeeper }));
    const radios = queryAll('input[type="radio"]');
    assert.equal(radios.length, 2);
    assert.equal(radios[0].checked, true, 'oldest member is the default keeper');
    fire(radios[1], 'change');
    assert.deepEqual(picked, ['g1', 'b']);
    cleanup();
  });

  test('shows a candidate badge, and a verified badge once verified', () => {
    const candidate = mount(h(DuplicatesReport, { groups: [group('g1', ['a', 'b'])], capabilities: CAPS, ...handlers }));
    assert.ok(/candidate/i.test(candidate.text()));
    candidate.cleanup();

    const verified = mount(h(DuplicatesReport, { groups: [group('g2', ['a', 'b'], { confidence: 'verified', verified: true })], capabilities: CAPS, ...handlers }));
    assert.ok(/verified/i.test(verified.text()));
    verified.cleanup();
  });

  test('Verify reports the group id', () => {
    let verified = null;
    const onVerify = (gid) => { verified = gid; };
    const { query, cleanup } = mount(h(DuplicatesReport, { groups: [group('g1', ['a', 'b'])], capabilities: CAPS, ...handlers, onVerify }));
    fire(query('.dup-verify'), 'click');
    assert.equal(verified, 'g1');
    cleanup();
  });

  test('Delete and Move render as disabled stubs in iteration 1', () => {
    const { query, cleanup } = mount(h(DuplicatesReport, { groups: [group('g1', ['a', 'b'])], capabilities: CAPS, ...handlers }));
    assert.equal(query('.dup-delete').disabled, true, 'Delete others must be a disabled stub');
    assert.equal(query('.dup-move').disabled, true, 'Move others must be a disabled stub');
    cleanup();
  });

  test('download action is disabled when download capability is denied', () => {
    const caps = { ...CAPS, download: 'denied' };
    const { queryAll, cleanup } = mount(h(DuplicatesReport, { groups: [group('g1', ['a', 'b'])], capabilities: caps, ...handlers }));
    for (const btn of queryAll('.dup-download')) assert.equal(btn.disabled, true);
    cleanup();
  });
});

describe('DuplicatesModal — idle container', () => {
  test('renders scan controls before any scan', () => {
    const client = { send: () => Promise.resolve({}) };
    const { query, text, cleanup } = mount(h(DuplicatesModal, {
      client, bucket: 'bk', currentPrefix: '', provider: 'aws',
      capabilities: CAPS, onDeleteRequest: noop, onClose: noop,
    }));
    assert.ok(query('.dup-scan'), 'a Scan button must be present');
    assert.ok(/duplicate/i.test(text()), 'modal should be titled around duplicates');
    cleanup();
  });
});

describe('DuplicatesModal — durable results', () => {
  test('restores a previously saved scan when reopened (no re-scan needed)', async () => {
    const view = mount(h(DuplicatesModal, modalProps({ load: async () => savedRecord() })));
    await tick();
    assert.ok(/restored from cache/i.test(view.text()), 'shows the restored banner');
    assert.equal(view.queryAll('.dup-member').length, 2, 'restored group members render');
    assert.ok(view.query('.dup-clear'), 'a Clear saved control is offered');
    view.cleanup();
  });

  test('persists the result after a scan', async () => {
    let saved = null;
    const scan = async () => [group('g0', ['a', 'b'])];
    const view = mount(h(DuplicatesModal, modalProps({ load: async () => null, scan, save: async (rec) => { saved = rec; } })));
    await tick(); // initial (empty) restore settles
    fire(view.query('.dup-scan'), 'click');
    for (let i = 0; i < 20 && !saved; i++) await tick(); // scan resolves → render → persist effect
    assert.ok(saved, 'save must be called after a scan');
    assert.equal(saved.groups.length, 1);
    assert.equal(saved.bucket, 'bk');
    view.cleanup();
  });

  test('Clear saved discards the stored scan and returns to idle', async () => {
    let deleted = false;
    const view = mount(h(DuplicatesModal, modalProps({ load: async () => savedRecord(), save: async () => {}, del: async () => { deleted = true; } })));
    await tick();
    fire(view.query('.dup-clear'), 'click');
    await tick();
    assert.equal(deleted, true, 'delete must be called');
    assert.ok(!/restored from cache/i.test(view.text()), 'the restored banner is gone after clearing');
    view.cleanup();
  });
});
