// Tests for CapabilityPanel.
// Each of the four S3 operations (list, download, upload, delete) can be
// 'permitted', 'denied', or 'unknown'. Each state must produce distinct DOM output
// so users can immediately see what they can and can't do.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { CapabilityPanel } from '../../src/components/CapabilityPanel.jsx';

const ALL_PERMITTED = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };
const ALL_DENIED    = { list: 'denied',    download: 'denied',    upload: 'denied',    delete: 'denied' };
const ALL_UNKNOWN   = { list: 'unknown',   download: 'unknown',   upload: 'unknown',   delete: 'unknown' };

describe('CapabilityPanel — permitted state', () => {
  test('shows the permitted checkmark (✓) for every permitted operation', () => {
    const { queryAll, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_PERMITTED, onRefresh: () => {} }));
    const icons = queryAll('.cap-permitted');
    assert.equal(icons.length, 4, 'all four operations should show cap-permitted');
    for (const icon of icons) assert.ok(icon.textContent.includes('✓'));
    cleanup();
  });

  test('does NOT show any denied icon when all are permitted', () => {
    const { queryAll, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_PERMITTED, onRefresh: () => {} }));
    assert.equal(queryAll('.cap-denied').length, 0, 'no cap-denied icons should be shown');
    cleanup();
  });

  test('does NOT show "denied" text when all are permitted', () => {
    const { text, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_PERMITTED, onRefresh: () => {} }));
    assert.ok(!text().includes('denied'), 'text "denied" should not appear when all are permitted');
    cleanup();
  });
});

describe('CapabilityPanel — denied state', () => {
  test('shows the denied icon (✕) for every denied operation', () => {
    const { queryAll, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_DENIED, onRefresh: () => {} }));
    // CapIcon renders .cap-denied for the icon, plus a second .cap-denied span for the word "denied"
    const deniedIcons = queryAll('.cap-denied');
    // Each denied op produces 2 .cap-denied spans: one for ✕, one for the "denied" label
    assert.ok(deniedIcons.length >= 4, 'should have at least 4 denied icon elements');
    cleanup();
  });

  test('shows the "denied" label text for each denied operation', () => {
    const { text, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_DENIED, onRefresh: () => {} }));
    assert.ok(text().includes('denied'), '"denied" text must appear for denied capabilities');
    cleanup();
  });

  test('shows denied only for the denied operation, not for permitted ones', () => {
    const mixed = { list: 'denied', download: 'permitted', upload: 'permitted', delete: 'permitted' };
    const { queryAll, cleanup } = mount(h(CapabilityPanel, { capabilities: mixed, onRefresh: () => {} }));
    // Exactly 1 CapIcon should be .cap-denied (for list), 3 should be .cap-permitted
    const permitted = queryAll('.cap-permitted');
    assert.equal(permitted.length, 3, 'three permitted icons for the three permitted ops');
    cleanup();
  });
});

describe('CapabilityPanel — unknown state', () => {
  test('shows the unknown icon (?) for unknown operations', () => {
    const { queryAll, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_UNKNOWN, onRefresh: () => {} }));
    const icons = queryAll('.cap-unknown');
    assert.equal(icons.length, 4, 'all four operations should show cap-unknown');
    for (const icon of icons) assert.ok(icon.textContent.includes('?'));
    cleanup();
  });

  test('does NOT show denied text for unknown operations', () => {
    const { text, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_UNKNOWN, onRefresh: () => {} }));
    assert.ok(!text().includes('denied'), '"denied" text must not appear for unknown capabilities');
    cleanup();
  });
});

describe('CapabilityPanel — mixed states', () => {
  test('each operation independently shows its own state icon', () => {
    const caps = { list: 'permitted', download: 'denied', upload: 'unknown', delete: 'permitted' };
    const { queryAll, cleanup } = mount(h(CapabilityPanel, { capabilities: caps, onRefresh: () => {} }));
    assert.equal(queryAll('.cap-permitted').length, 2, '2 permitted icons (list, delete)');
    assert.ok(queryAll('.cap-unknown').length >= 1, 'at least 1 unknown icon (upload)');
    cleanup();
  });
});

describe('CapabilityPanel — operation labels', () => {
  test('shows all four operation labels', () => {
    const { text, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_UNKNOWN, onRefresh: () => {} }));
    assert.ok(text().includes('Browse') || text().includes('List'));
    assert.ok(text().includes('Download'));
    assert.ok(text().includes('Upload'));
    assert.ok(text().includes('Delete'));
    cleanup();
  });
});

describe('CapabilityPanel — Refresh button', () => {
  test('clicking Refresh Permissions calls onRefresh', () => {
    let called = 0;
    const { query, cleanup } = mount(h(CapabilityPanel, { capabilities: ALL_PERMITTED, onRefresh: () => { called++; } }));
    const btn = query('button');
    assert.ok(btn, 'Refresh Permissions button must be present');
    fire(btn, 'click');
    assert.equal(called, 1, 'onRefresh must be called exactly once');
    cleanup();
  });
});
