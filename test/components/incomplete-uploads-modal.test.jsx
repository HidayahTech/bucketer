import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { mount, fire } from '../helpers/render.js';
import { IncompleteUploadsModal } from '../../src/components/IncompleteUploadsModal.jsx';

// Flush the async scan/discard promises and the Preact re-render they trigger, inside act().
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('IncompleteUploadsModal', () => {
  test('lists discovered uploads once the scan resolves', async () => {
    const scan = async () => [{ key: 'arch/big.bin', uploadId: 'u1', initiated: new Date().toISOString() }];
    const { text, query, cleanup } = mount(h(IncompleteUploadsModal, { scan, discard: async () => {}, onClose: () => {} }));
    await settle();
    assert.ok(text().includes('arch/big.bin'), text());
    assert.ok(query('[data-testid="discard:u1"]'));
    cleanup();
  });

  test('shows the empty state when nothing is found', async () => {
    const { query, cleanup } = mount(h(IncompleteUploadsModal, { scan: async () => [], discard: async () => {}, onClose: () => {} }));
    await settle();
    assert.ok(query('[data-testid="no-incomplete"]'));
    cleanup();
  });

  test('Discard calls discard(upload) and removes that row, keeping the others', async () => {
    let discarded = null;
    const scan = async () => [{ key: 'a', uploadId: 'u1', initiated: null }, { key: 'b', uploadId: 'u2', initiated: null }];
    const { query, cleanup } = mount(h(IncompleteUploadsModal, { scan, discard: async (u) => { discarded = u.uploadId; }, onClose: () => {} }));
    await settle();
    fire(query('[data-testid="discard:u1"]'), 'click');
    await settle();
    assert.equal(discarded, 'u1');
    assert.equal(query('[data-testid="incomplete-row:u1"]'), null, 'discarded row removed');
    assert.ok(query('[data-testid="incomplete-row:u2"]'), 'other row remains');
    cleanup();
  });

  test('surfaces a scan error', async () => {
    const { text, cleanup } = mount(h(IncompleteUploadsModal, { scan: async () => { throw new Error('boom'); }, discard: async () => {}, onClose: () => {} }));
    await settle();
    assert.ok(text().includes('boom'), text());
    cleanup();
  });
});
