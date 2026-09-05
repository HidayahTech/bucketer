// Tests for ConnectionTabs — the header quick-switch strip of recently-used buckets.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { ConnectionTabs } from '../../src/components/ConnectionTabs.jsx';

const TABS = [
  { id: 1, bucket: 'photos', provider: 'b2' },
  { id: 2, bucket: 'backups', provider: 'b2' },
  { id: 3, bucket: 'client-assets', provider: 'aws' },
];

function props(over = {}) {
  return { tabs: TABS, selectedId: 1, onSelect: () => {}, ...over };
}

describe('ConnectionTabs', () => {
  test('renders a tab per recent connection, showing the bucket', () => {
    const { queryAll, text, cleanup } = mount(h(ConnectionTabs, props()));
    assert.equal(queryAll('.connection-tab').length, 3);
    assert.ok(text().includes('photos'));
    assert.ok(text().includes('client-assets'));
    cleanup();
  });

  test('marks the active tab', () => {
    const { queryAll, cleanup } = mount(h(ConnectionTabs, props({ selectedId: 2 })));
    const active = queryAll('.connection-tab').filter(t => t.classList.contains('connection-tab-active'));
    assert.equal(active.length, 1);
    assert.ok(active[0].textContent.includes('backups'));
    cleanup();
  });

  test('clicking a tab calls onSelect with its connection id', () => {
    let picked = null;
    const { queryAll, cleanup } = mount(h(ConnectionTabs, props({ onSelect: id => { picked = id; } })));
    fire(queryAll('.connection-tab')[2], 'click'); // client-assets (id=3)
    assert.equal(picked, 3);
    cleanup();
  });

  test('renders nothing when there are no tabs', () => {
    const { query, cleanup } = mount(h(ConnectionTabs, props({ tabs: [] })));
    assert.equal(query('.connection-tabs'), null);
    cleanup();
  });
});
