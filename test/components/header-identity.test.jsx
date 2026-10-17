// The connected header names the bucket and the storage address (accounts A, v1.66.0; REPORT C6:
// the bucket name appeared nowhere once connected; S4: a link could point at another host unseen).
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { HeaderIdentity } from '../../src/components/HeaderIdentity.jsx';

describe('HeaderIdentity', () => {
  test('shows the bucket and the endpoint host, with the provider in the tooltip', () => {
    const { query, cleanup } = mount(
      h(HeaderIdentity, {
        bucket: 'family-photos',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        provider: 'b2',
      }),
    );
    try {
      assert.equal(query('.header-bucket').textContent, 'family-photos');
      assert.equal(query('.header-host').textContent, 's3.us-west-004.backblazeb2.com');
      assert.ok(query('.header-identity').getAttribute('title').includes('Backblaze B2'));
    } finally {
      cleanup();
    }
  });

  test('sets the tab title to the bucket and restores it on unmount', () => {
    document.title = 'Bucketer';
    const { cleanup } = mount(
      h(HeaderIdentity, { bucket: 'b1', endpoint: 'http://minio.test:9000', provider: 'minio' }),
    );
    assert.equal(document.title, 'b1 — Bucketer');
    cleanup();
    assert.equal(document.title, 'Bucketer');
  });
});
