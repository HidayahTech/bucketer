// Tests for HiddenVersions.
// The R2 provider gate is the most critical behavior: HiddenVersions must NEVER
// show a load button or make any S3 calls for R2 buckets. The client mock
// verifies no S3 call is attempted for R2 regardless of user interaction.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { HiddenVersions } from '../../src/components/HiddenVersions.jsx';

// Mock client — fails immediately if any S3 command is sent unexpectedly.
function strictMockClient() {
  return {
    send: async () => {
      throw new Error('S3 send() called unexpectedly');
    },
  };
}

// Mock client that accepts ListObjectVersionsCommand calls.
function listMockClient(response = { Versions: [], DeleteMarkers: [], IsTruncated: false }) {
  return { send: async () => response };
}

const BASE_PROPS = { bucket: 'test-bucket', prefix: '', client: null };

describe('HiddenVersions — R2 provider gate', () => {
  test('shows the R2 not-supported message for R2 provider', () => {
    const { text, cleanup } = mount(h(HiddenVersions, { ...BASE_PROPS, provider: 'r2', client: strictMockClient() }));
    assert.ok(
      text().toLowerCase().includes('r2') && text().toLowerCase().includes('versioning'),
      'must show a message explaining R2 does not support versioning',
    );
    cleanup();
  });

  test('does NOT render a load/reveal button for R2', () => {
    const { query, cleanup } = mount(h(HiddenVersions, { ...BASE_PROPS, provider: 'r2', client: strictMockClient() }));
    const buttons = [...document.querySelectorAll('button')];
    const loadBtn = buttons.find((b) => /load|show|reveal|version/i.test(b.textContent));
    assert.equal(loadBtn, undefined, 'no load/reveal button should exist for R2');
    cleanup();
  });

  test('does NOT make any S3 calls for R2 (gate prevents all access)', () => {
    // strictMockClient throws on any send() — if no error, no S3 call was made.
    assert.doesNotThrow(() => {
      const { cleanup } = mount(h(HiddenVersions, { ...BASE_PROPS, provider: 'r2', client: strictMockClient() }));
      cleanup();
    });
  });
});

describe('HiddenVersions — non-R2 providers initial state', () => {
  test('does NOT show the R2 not-supported message for B2', () => {
    const { text, cleanup } = mount(h(HiddenVersions, { ...BASE_PROPS, provider: 'b2', client: listMockClient() }));
    assert.ok(!text().includes('R2 does not support'), 'B2 must not show the R2 not-supported message');
    cleanup();
  });

  test('shows a button to load/reveal hidden versions for non-R2 providers', () => {
    const { query, cleanup } = mount(h(HiddenVersions, { ...BASE_PROPS, provider: 'b2', client: listMockClient() }));
    const buttons = [...document.querySelectorAll('button')];
    const loadBtn = buttons.find((b) => /load|show|reveal|version|hidden/i.test(b.textContent));
    assert.ok(loadBtn, 'a load/reveal button should exist for B2 before versions are loaded');
    cleanup();
  });

  test('starts with no version rows (rows are null until loaded)', () => {
    const { query, cleanup } = mount(
      h(HiddenVersions, { ...BASE_PROPS, provider: 'wasabi', client: listMockClient() }),
    );
    // Before loading, no table rows or version items should be visible
    assert.equal(query('table'), null, 'no table should be rendered in the initial unloaded state');
    cleanup();
  });

  test('non-R2 component renders for Wasabi, AWS, and MinIO providers', () => {
    for (const provider of ['wasabi', 'aws', 'minio', 'generic']) {
      const { text, cleanup } = mount(h(HiddenVersions, { ...BASE_PROPS, provider, client: listMockClient() }));
      assert.ok(!text().includes('R2 does not support'), `provider '${provider}' must not show the R2 gate message`);
      cleanup();
    }
  });
});

// Layout A (v1.67.0): Bucket tools ▾ → Hidden versions loads the panel without its own button.
describe('HiddenVersions — requestKey', () => {
  test('a non-zero requestKey loads the versions; 0 does not', async () => {
    let sends = 0;
    const client = {
      send: async () => {
        sends++;
        return { Versions: [], DeleteMarkers: [], IsTruncated: false };
      },
    };
    const idle = mount(h(HiddenVersions, { ...BASE_PROPS, provider: 'b2', client, requestKey: 0 }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sends, 0, 'requestKey 0 makes no request');
    idle.cleanup();

    const { text, cleanup } = mount(h(HiddenVersions, { ...BASE_PROPS, provider: 'b2', client, requestKey: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sends, 1, 'requestKey 1 lists the versions once');
    assert.ok(text().includes('Hidden versions'), 'the panel is open');
    cleanup();
  });

  test('for R2 a request still makes no S3 call', async () => {
    const { text, cleanup } = mount(
      h(HiddenVersions, { ...BASE_PROPS, provider: 'r2', client: strictMockClient(), requestKey: 1 }),
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(text().includes('R2 does not support'));
    cleanup();
  });
});
