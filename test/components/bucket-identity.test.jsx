// The line under the bucket title says where this bucket lives (layout A, v1.67.0; was the header
// identity of accounts A, v1.66.0. REPORT C6: the bucket name appeared nowhere once connected;
// S4: a link could point at another host unseen).
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { BucketIdentity } from '../../src/components/BucketIdentity.jsx';

describe('BucketIdentity', () => {
  test('names the provider, the key ID tail, the storage address and the base folder', () => {
    const { query, cleanup } = mount(
      h(BucketIdentity, {
        bucket: 'family-photos',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        provider: 'b2',
        keyId: '0042abcd7f3a',
        basePrefix: '',
      }),
    );
    try {
      const text = query('.bucket-identity').textContent;
      assert.ok(text.includes('Backblaze B2'), text);
      assert.ok(text.includes('key …7f3a'), text);
      assert.ok(!text.includes('0042abcd7f3a'), 'never the full key ID');
      assert.equal(query('.bucket-identity-host').textContent, 's3.us-west-004.backblazeb2.com');
      assert.ok(text.includes('Base folder: none (whole bucket)'), text);
    } finally {
      cleanup();
    }
  });

  test('shows a base folder when the connection has one', () => {
    const { query, cleanup } = mount(
      h(BucketIdentity, {
        bucket: 'b',
        endpoint: 'http://minio.test:9000',
        provider: 'minio',
        keyId: 'k',
        basePrefix: 'team/a/',
      }),
    );
    try {
      assert.ok(query('.bucket-identity').textContent.includes('Base folder: team/a/'));
    } finally {
      cleanup();
    }
  });

  test('sets the tab title to the bucket and restores it on unmount', () => {
    document.title = 'Bucketer';
    const { cleanup } = mount(
      h(BucketIdentity, { bucket: 'b1', endpoint: 'http://minio.test:9000', provider: 'minio' }),
    );
    assert.equal(document.title, 'b1 — Bucketer');
    cleanup();
    assert.equal(document.title, 'Bucketer');
  });
});
